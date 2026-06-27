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
const NEO_VER = params.neover;
const LOG_FILE = path.join(ROOT, 'temp', 'neoforge-processor.log');
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
log(`NEO_VER=${NEO_VER}`);

const mcJar = path.join(ROOT, 'versions', MC_VER, `${MC_VER}.jar`);
const isLegacy = NEO_VER.startsWith('1.20.1-');
const pkg = isLegacy ? 'forge' : 'neoforge';

const installerJar = path.join(LIBS, 'net', 'neoforged', pkg, NEO_VER, `${pkg}-${NEO_VER}-installer.jar`);
const clientLzma = path.join(LIBS, 'net', 'neoforged', pkg, NEO_VER, `${pkg}-${NEO_VER}-clientdata.lzma`);
const installertoolsJar = path.join(LIBS, 'net', 'neoforged', 'installertools', 'installertools', '4.0.12', 'installertools-4.0.12-fatjar.jar');
const patchedDir = path.join(LIBS, 'net', 'neoforged', 'minecraft-client-patched', NEO_VER);
const patchedOut = path.join(patchedDir, `minecraft-client-patched-${NEO_VER}.jar`);
const versionDir = path.join(ROOT, 'versions', `${MC_VER}-NeoForge-${NEO_VER}`);
const installProfilePath = path.join(versionDir, 'install_profile.json');

log(`mcJar=${mcJar} exists=${fs.existsSync(mcJar)}`);
log(`installerJar=${installerJar} exists=${fs.existsSync(installerJar)}`);
log(`clientLzma=${clientLzma} exists=${fs.existsSync(clientLzma)}`);
log(`installertoolsJar=${installertoolsJar} exists=${fs.existsSync(installertoolsJar)}`);

if (!fs.existsSync(clientLzma) && fs.existsSync(installerJar)) {
    log(`Extracting client.lzma from installer JAR...`);
    try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(installerJar);
        const entry = zip.getEntry('data/client.lzma');
        if (entry) {
            const data = entry.getData();
            fs.mkdirSync(path.dirname(clientLzma), { recursive: true });
            fs.writeFileSync(clientLzma, data);
            log(`Extracted client.lzma: ${data.length} bytes`);
        } else {
            log(`ERROR: data/client.lzma not found in installer JAR`);
        }
    } catch (e) {
        log(`ERROR extracting client.lzma: ${e.message}`);
    }
}

let javaPath = 'java';
try {
    const javaHome = process.env.JAVA_HOME;
    if (javaHome) {
        const jPath = path.join(javaHome, 'bin', 'java.exe');
        if (fs.existsSync(jPath)) javaPath = jPath;
    }
} catch (_) {}

log(`JAVA_HOME=${process.env.JAVA_HOME}`);
log(`javaPath=${javaPath} exists=${fs.existsSync(javaPath)}`);

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
    const jarCandidates = [];
    const javaHome = process.env.JAVA_HOME;
    if (javaHome) {
        jarCandidates.push(path.join(javaHome, 'bin', 'jar.exe'));
    }
    const detectedJava = javaPath.replace(/java\.exe$/, '').replace(/javaw\.exe$/, '');
    if (detectedJava) {
        jarCandidates.push(path.join(detectedJava, 'jar.exe'));
    }
    jarCandidates.push('C:\\Program Files\\Java\\jdk-17\\bin\\jar.exe');
    jarCandidates.push('C:\\Program Files\\Java\\jdk-21\\bin\\jar.exe');
    for (const c of jarCandidates) {
        if (c && fs.existsSync(c)) { jarExe = c; break; }
    }
    log(`jar.exe candidates: ${jarCandidates.join(', ')}`);
    log(`jar.exe resolved: ${jarExe || 'NOT FOUND'}`);

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

    const versionDirJar = path.join(versionDir, `${MC_VER}-NeoForge-${NEO_VER}.jar`);
    try {
        fs.copyFileSync(patchedOut, versionDirJar);
        log(`Copied patched jar to: ${versionDirJar}`);
    } catch (e) {
        log(`Copy error: ${e.message}`);
    }

    const vjPath = path.join(versionDir, `${MC_VER}-NeoForge-${NEO_VER}.json`);
    if (fs.existsSync(vjPath)) {
        try {
            const vj = JSON.parse(fs.readFileSync(vjPath, 'utf8'));
            if (!(vj.libraries || []).find(l => l.name && l.name.includes('minecraft-client-patched'))) {
                vj.libraries = vj.libraries || [];
                vj.libraries.push({
                    name: `net.neoforged:minecraft-client-patched:${NEO_VER}`,
                    downloads: {
                        artifact: {
                            path: `net/neoforged/minecraft-client-patched/${NEO_VER}/minecraft-client-patched-${NEO_VER}.jar`,
                            url: `https://maven.neoforged.net/releases/net/neoforged/minecraft-client-patched/${NEO_VER}/minecraft-client-patched-${NEO_VER}.jar`
                        }
                    }
                });
                fs.writeFileSync(vjPath, JSON.stringify(vj, null, 2));
                log(`Added patched lib to version JSON`);
            }
        } catch (e) {
            log(`Version JSON error: ${e.message}`);
        }
    }

    if (fs.existsSync(installProfilePath)) {
        try {
            const ip = JSON.parse(fs.readFileSync(installProfilePath, 'utf8'));
            if (!ip.data) ip.data = {};
            ip.data.BINPATCH = { client: clientLzma, server: clientLzma };
            ip.data.PATCHED = { client: patchedOut, server: patchedOut };
            if (fs.existsSync(installerJar)) {
                ip.data.INSTALLER = { client: installerJar, server: installerJar };
            }
            fs.writeFileSync(installProfilePath, JSON.stringify(ip, null, 2));
            log(`Fixed install_profile.json`);
        } catch (e) {
            log(`install_profile.json error: ${e.message}`);
        }
    }

    log(`\n=== SUCCESS ===`);
} else {
    log(`\n=== FAILED: patched jar not created ===`);
    process.exit(1);
}
