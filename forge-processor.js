const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const params = {};
for (let i = 0; i < args.length; i += 2) {
    params[args[i].replace('--', '')] = args[i + 1];
}

const ROOT = params.root;
const LIBS = params.libs;
const MC_VER = params.mcver;
const FORGE_VER = params.forgever;
const LOG_FILE = path.join(ROOT, 'temp', 'forge-processor.log');
const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(LOG_FILE, line);
    process.stdout.write(line);
};

try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch (_) {}
fs.writeFileSync(LOG_FILE, '');

log(`ROOT=${ROOT}`);
log(`LIBS=${LIBS}`);
log(`MC_VER=${MC_VER}`);
log(`FORGE_VER=${FORGE_VER}`);

const versionDir = path.join(ROOT, 'versions', `${MC_VER}-forge-${FORGE_VER}`);
const installProfilePath = path.join(versionDir, 'install_profile.json');

if (!fs.existsSync(installProfilePath)) {
    log(`ERROR: install_profile.json not found at ${installProfilePath}`);
    process.exit(1);
}

const ip = JSON.parse(fs.readFileSync(installProfilePath, 'utf8'));
log(`processors: ${ip.processors?.length || 0}`);
log(`data keys: ${ip.data ? Object.keys(ip.data).join(', ') : 'none'}`);

if (!ip.processors || ip.processors.length === 0) {
    log(`No processors to run, exiting`);
    process.exit(0);
}

const mcJar = path.join(ROOT, 'versions', MC_VER, `${MC_VER}.jar`);
log(`mcJar: ${mcJar} exists=${fs.existsSync(mcJar)}`);

const binpatchDir = path.join(LIBS, 'net', 'minecraftforge', 'forge', FORGE_VER);
const clientLzma = path.join(binpatchDir, `forge-${FORGE_VER}-clientdata.lzma`);
log(`clientLzma: ${clientLzma} exists=${fs.existsSync(clientLzma)}`);

const installerJar = path.join(binpatchDir, `forge-${FORGE_VER}-installer.jar`);
log(`installerJar: ${installerJar} exists=${fs.existsSync(installerJar)}`);

const installertoolsJar = path.join(LIBS, 'net', 'neoforged', 'installertools', 'installertools', '4.0.12', 'installertools-4.0.12-fatjar.jar');
log(`installertoolsJar: ${installertoolsJar} exists=${fs.existsSync(installertoolsJar)}`);

const patchedDir = path.join(LIBS, 'net', 'minecraftforge', 'forge', FORGE_VER);
const patchedOut = path.join(patchedDir, `forge-${FORGE_VER}-client.jar`);
log(`patchedOut: ${patchedOut}`);

let javaPath = 'java';
try {
    const javaHome = process.env.JAVA_HOME;
    if (javaHome) {
        const jPath = path.join(javaHome, 'bin', 'java.exe');
        if (fs.existsSync(jPath)) javaPath = jPath;
    }
} catch (_) {}
log(`javaPath: ${javaPath} exists=${fs.existsSync(javaPath)}`);

if (fs.existsSync(clientLzma) && fs.existsSync(installertoolsJar) && fs.existsSync(mcJar)) {
    fs.mkdirSync(patchedDir, { recursive: true });
    if (fs.existsSync(patchedOut)) { try { fs.unlinkSync(patchedOut); } catch (_) {} }

    log(`\n=== Running Processor ===`);
    const procArgs = [
        '-cp', installertoolsJar,
        'net.neoforged.installertools.ConsoleTool',
        '--task', 'PROCESS_MINECRAFT_JAR',
        '--no-mod-manifest',
        '--input', mcJar,
        '--output', patchedOut,
        '--extract-libraries-to', LIBS,
        '--apply-patches', clientLzma
    ];
    log(`Command: ${javaPath} ${procArgs.join(' ')}`);

    const result = spawnSync(javaPath, procArgs, {
        timeout: 180000,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true
    });
    log(`stdout: ${result.stdout || ''}`);
    log(`stderr: ${(result.stderr || '').substring(0, 500)}`);
    log(`status: ${result.status}`);
    log(`error: ${result.error ? result.error.message : 'none'}`);

    if (fs.existsSync(patchedOut)) {
        log(`patched jar: ${fs.statSync(patchedOut).size} bytes`);

        let jarExe = null;
        const javaHome = process.env.JAVA_HOME;
        if (javaHome) {
            const candidate = path.join(javaHome, 'bin', 'jar.exe');
            if (fs.existsSync(candidate)) jarExe = candidate;
        }
        if (!jarExe) {
            const detectedJava = javaPath.replace(/java\.exe$/, '').replace(/javaw\.exe$/, '');
            if (detectedJava) {
                const candidate = path.join(detectedJava, 'jar.exe');
                if (fs.existsSync(candidate)) jarExe = candidate;
            }
        }
        log(`jar.exe: ${jarExe || 'NOT FOUND'}`);

        const manifestTempDir = path.join(ROOT, 'temp', 'manifest-patch');
        fs.mkdirSync(manifestTempDir, { recursive: true });
        try {
            if (!jarExe) {
                log('jar.exe not found, skipping manifest patch');
            } else {
                spawnSync(jarExe, ['xf', patchedOut, 'META-INF/MANIFEST.MF'], { cwd: manifestTempDir, encoding: 'utf8', timeout: 30000, windowsHide: true });
                const mfFile = path.join(manifestTempDir, 'META-INF', 'MANIFEST.MF');
                if (fs.existsSync(mfFile)) {
                    let mf = fs.readFileSync(mfFile, 'utf8');
                    if (!mf.includes('Minecraft-Dists')) {
                        if (mf.includes('Main-Class:')) {
                            mf = mf.replace(/(Main-Class:[^\r\n]+)/, '$1\r\nMinecraft-Dists: client');
                        } else {
                            mf += '\r\nMinecraft-Dists: client\r\n';
                        }
                        fs.writeFileSync(mfFile, mf, 'utf8');
                        spawnSync(jarExe, ['ufm', patchedOut, mfFile], { cwd: manifestTempDir, encoding: 'utf8', timeout: 30000, windowsHide: true });
                        log(`Added Minecraft-Dists to MANIFEST.MF`);
                    } else {
                        log(`MANIFEST.MF already has Minecraft-Dists`);
                    }
                }
            }
        } catch (e) {
            log(`Manifest patch error: ${e.message}`);
        } finally {
            try { fs.rmSync(manifestTempDir, { recursive: true, force: true }); } catch (_) {}
        }

        const versionDirJar = path.join(versionDir, `${MC_VER}-forge-${FORGE_VER}.jar`);
        try {
            fs.copyFileSync(patchedOut, versionDirJar);
            log(`Copied patched jar to: ${versionDirJar}`);
        } catch (e) {
            log(`Copy error: ${e.message}`);
        }

        const vjPath = path.join(versionDir, `${MC_VER}-forge-${FORGE_VER}.json`);
        if (fs.existsSync(vjPath)) {
            try {
                const vj = JSON.parse(fs.readFileSync(vjPath, 'utf8'));
                if (!(vj.libraries || []).find(l => l.name && l.name.includes('forge'))) {
                    vj.libraries = vj.libraries || [];
                    vj.libraries.push({
                        name: `net.minecraftforge:forge:${FORGE_VER}`,
                        downloads: {
                            artifact: {
                                path: `net/minecraftforge/forge/${FORGE_VER}/forge-${FORGE_VER}.jar`,
                                url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${FORGE_VER}/forge-${FORGE_VER}.jar`
                            }
                        }
                    });
                    fs.writeFileSync(vjPath, JSON.stringify(vj, null, 2));
                    log(`Added forge lib to version JSON`);
                }
            } catch (e) {
                log(`Version JSON error: ${e.message}`);
            }
        }

        log(`\n=== SUCCESS ===`);
    } else {
        log(`\n=== FAILED: patched jar not created ===`);
        process.exit(1);
    }
} else {
    log(`Missing required files:`);
    log(`  client.lzma: ${fs.existsSync(clientLzma)}`);
    log(`  installertools: ${fs.existsSync(installertoolsJar)}`);
    log(`  mcJar: ${fs.existsSync(mcJar)}`);
    process.exit(1);
}
