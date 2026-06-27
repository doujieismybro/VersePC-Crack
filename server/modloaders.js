/**
 * server/modloaders.js - 模组加载器安装功能模块
 * ============================================================================
 * 从 server.js 抽取的模组加载器（Forge/Fabric/NeoForge/OptiFine）安装相关函数。
 * 通过 ctx (./context) 访问共享状态，通过 utils (./utils) 访问工具函数，
 * 通过 http (./http-client) 访问 HTTP 请求功能，通过 versions (./versions) 访问版本管理，
 * 通过 java (./java) 访问 Java 检测，通过 dependencies (./dependencies) 访问依赖下载。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, exec, spawn } = require('child_process');

const ctx = require('./context');
const utils = require('./utils');
const http = require('./http-client');
const versions = require('./versions');
const java = require('./java');
const dependencies = require('./dependencies');

// ============================================================================
// 懒加载 server.js 中尚未抽取到子模块的函数 (避免循环依赖)
// 这些函数在 server.js 完成迁移后会通过 module.exports 暴露
// ============================================================================
let _serverModule = null;
function _server() {
    if (_serverModule === null) {
        try { _serverModule = require('../server'); } catch (_) { _serverModule = {}; }
    }
    return _serverModule;
}

// server.js 所在目录（用于查找 forge-installer.js 等资源文件）
const SERVER_DIR = path.join(__dirname, '..');

// ============================================================================
// Async curl download helper - non-blocking alternative to execSync(curl)
// ============================================================================
function _curlDownload(url, destPath) {
    return new Promise((resolve, reject) => {
        const cmd = `curl --silent --location --connect-timeout 10 --max-time 60 --output "${destPath}" "${url}"`;
        exec(cmd, { timeout: 90000, windowsHide: true, stdio: 'ignore' }, (err) => {
            if (err) { reject(err); return; }
            resolve();
        });
    });
}

// ============================================================================
// Forge 核心库下载
// ============================================================================

async function downloadForgeCoreLibsFromMaven(forgeVersionStr, onProgress) {
    const prefix = 'net/minecraftforge';
    const coreArtifacts = [
        { dir: `${prefix}/fmlcore/${forgeVersionStr}`, file: `fmlcore-${forgeVersionStr}.jar` },
        { dir: `${prefix}/javafmllanguage/${forgeVersionStr}`, file: `javafmllanguage-${forgeVersionStr}.jar` },
        { dir: `${prefix}/mclanguage/${forgeVersionStr}`, file: `mclanguage-${forgeVersionStr}.jar` },
        { dir: `${prefix}/lowcodelanguage/${forgeVersionStr}`, file: `lowcodelanguage-${forgeVersionStr}.jar` },
    ];

    let downloaded = 0;
    let failed = 0;

    for (const artifact of coreArtifacts) {
        const targetPath = path.join(ctx.dirs.LIBRARIES_DIR, artifact.dir, artifact.file);
        if (fs.existsSync(targetPath) && utils.isJarIntact(targetPath)) continue;

        let ok = false;
        for (const mavenBase of ctx.mirrors.FORGE_MAVEN_BASES) {
            const url = `${mavenBase}/${artifact.dir}/${artifact.file}`;
            try {
                if (!fs.existsSync(path.dirname(targetPath))) fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                await http.downloadFileWithMirror(url, targetPath);
                if (fs.existsSync(targetPath) && utils.isJarIntact(targetPath)) {
                    ok = true;
                    downloaded++;
                    console.log(`[Forge] Maven下载成功: ${artifact.file} (from ${mavenBase})`);
                    break;
                }
            } catch (_) {}
            try { if (fs.existsSync(targetPath) && !utils.isJarIntact(targetPath)) fs.unlinkSync(targetPath); } catch (_) {}
        }
        if (!ok) {
            failed++;
            console.warn(`[Forge] Maven下载失败: ${artifact.file}`);
        }
    }

    if (downloaded > 0 || failed === 0) {
        console.log(`[Forge] 核心库Maven补全: 下载${downloaded}个, 失败${failed}个`);
    } else {
        console.warn(`[Forge] 核心库Maven补全失败: ${failed}个文件无法下载`);
    }

    return { downloaded, failed, total: coreArtifacts.length };
}

async function downloadForgePatchingJars(mcVersion, forgeVersion, mcpVersion) {
    if (!mcVersion || !forgeVersion) return { ok: false, reason: '缺少版本号' };

    const verStr = `${mcVersion}-${forgeVersion}`;
    const forgeDir = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'minecraftforge', 'forge', verStr);
    const forgeClientJar = path.join(forgeDir, `forge-${verStr}-client.jar`);
    const forgeUniversalJar = path.join(forgeDir, `forge-${verStr}-universal.jar`);
    const hasForge = (fs.existsSync(forgeClientJar) && utils.isJarIntact(forgeClientJar)) ||
        (fs.existsSync(forgeUniversalJar) && utils.isJarIntact(forgeUniversalJar));

    const missing = [];

    if (!hasForge) {
        const forgePath = `net/minecraftforge/forge/${verStr}`;
        const candidates = [
            { dir: forgePath, file: `forge-${verStr}-client.jar` },
            { dir: forgePath, file: `forge-${verStr}-universal.jar` },
        ];
        let gotForge = false;
        const FORGE_JAR_DL_TIMEOUT = 20000;
        for (const art of candidates) {
            const targetPath = path.join(ctx.dirs.LIBRARIES_DIR, art.dir, art.file);
            if (fs.existsSync(targetPath) && utils.isJarIntact(targetPath)) { gotForge = true; break; }
            for (const mavenBase of ctx.mirrors.FORGE_MAVEN_BASES) {
                const url = `${mavenBase}/${art.dir}/${art.file}`;
                try {
                    if (!fs.existsSync(path.dirname(targetPath))) fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                    await http.downloadFileWithMirror(url, targetPath, null, 1, null, FORGE_JAR_DL_TIMEOUT);
                    if (fs.existsSync(targetPath) && utils.isJarIntact(targetPath)) {
                        console.log(`[Forge] Maven下载成功: ${art.file}`);
                        gotForge = true;
                        break;
                    }
                } catch (_) {}
                try { if (fs.existsSync(targetPath) && !utils.isJarIntact(targetPath)) fs.unlinkSync(targetPath); } catch (_) {}
            }
            if (gotForge) break;
        }
        if (!gotForge) missing.push(`forge-${verStr}-client.jar/universal.jar`);
    }

    if (mcpVersion) {
        const clientVerStr = `${mcVersion}-${mcpVersion}`;
        const clientDir = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'minecraft', 'client', clientVerStr);
        const clientJars = [
            `client-${clientVerStr}-srg.jar`,
            `client-${clientVerStr}-extra.jar`,
        ];
        for (const jarName of clientJars) {
            const targetPath = path.join(clientDir, jarName);
            if (fs.existsSync(targetPath) && utils.isJarIntact(targetPath)) continue;
            let ok = false;
            const clientPath = `net/minecraft/client/${clientVerStr}`;
            const PATCHING_DL_TIMEOUT = 15000;
            for (const mavenBase of ctx.mirrors.FORGE_MAVEN_BASES) {
                const url = `${mavenBase}/${clientPath}/${jarName}`;
                try {
                    if (!fs.existsSync(clientDir)) fs.mkdirSync(clientDir, { recursive: true });
                    await http.downloadFileWithMirror(url, targetPath, null, 1, null, PATCHING_DL_TIMEOUT);
                    if (fs.existsSync(targetPath) && utils.isJarIntact(targetPath)) {
                        console.log(`[Forge] Maven下载成功: ${jarName}`);
                        ok = true;
                        break;
                    }
                } catch (_) {}
                try { if (fs.existsSync(targetPath) && !utils.isJarIntact(targetPath)) fs.unlinkSync(targetPath); } catch (_) {}
            }
            if (!ok) missing.push(jarName);
        }
    }

    if (missing.length > 0) {
        console.warn(`[Forge] Forge关键JAR补全失败: ${missing.join(', ')}`);
        return { ok: false, reason: `缺失: ${missing.join(', ')}` };
    }
    console.log(`[Forge] Forge关键JAR补全检查通过`);
    return { ok: true, reason: 'Forge关键JAR已就绪' };
}

function findForgeCoreJars(versionJson, searchBases) {
    const gameArgs = versionJson.arguments?.game || [];
    const mainClass = versionJson.mainClass || '';
    const hasForgeLaunch = gameArgs.some(a => typeof a === 'string' && a === 'forgeclient');
    const isBootStrap = mainClass.includes('bootstraplauncher') || mainClass.includes('BootstrapLauncher');

    const isNeoForgeVersion = gameArgs.some(a => typeof a === 'string' && a === '--fml.neoForgeVersion') ||
        (versionJson.libraries || []).some(l => l.name && l.name.startsWith('net.neoforged.fancymodloader:loader'));
    const isForge = hasForgeLaunch || isBootStrap;

    console.log(`[findForgeCoreJars] versionId=${versionJson.id} isNeoForge=${isNeoForgeVersion} isForge=${isForge} gameArgsLen=${gameArgs.length} hasForgeLaunch=${hasForgeLaunch} isBootStrap=${isBootStrap}`);

    if (!isForge && !isNeoForgeVersion) return [];

    if (isNeoForgeVersion) {
        return findNeoForgeCoreJars(versionJson, searchBases, gameArgs);
    }

    let forgeVersion = '';
    let mcVersion = '';

    const forgeVerIdx = gameArgs.findIndex(a => typeof a === 'string' && a === '--fml.forgeVersion');
    const mcVerIdx = gameArgs.findIndex(a => typeof a === 'string' && a === '--fml.mcVersion');

    if (forgeVerIdx >= 0 && forgeVerIdx + 1 < gameArgs.length) {
        forgeVersion = gameArgs[forgeVerIdx + 1];
    }
    if (mcVerIdx >= 0 && mcVerIdx + 1 < gameArgs.length) {
        mcVersion = gameArgs[mcVerIdx + 1];
    }
    if (!mcVersion && versionJson.clientVersion) {
        mcVersion = versionJson.clientVersion;
    }

    if (!forgeVersion || !mcVersion) {
        const forgeLib = (versionJson.libraries || []).find(l =>
            l.name && (l.name.startsWith('net.minecraftforge:fmlloader:') || l.name.startsWith('net.minecraftforge:forge:'))
        );
        if (forgeLib) {
            const parts = forgeLib.name.split(':');
            if (parts.length >= 3) {
                const verPart = parts[2];
                const dashIdx = verPart.lastIndexOf('-');
                if (dashIdx > 0) {
                    mcVersion = verPart.substring(0, dashIdx);
                    forgeVersion = verPart.substring(dashIdx + 1);
                }
            }
        }
    }

    if (!forgeVersion || !mcVersion) return [];

    const verStr = `${mcVersion}-${forgeVersion}`;
    const prefix = 'net/minecraftforge';

    const coreArtifacts = [
        { dir: `${prefix}/fmlcore/${verStr}`, file: `fmlcore-${verStr}.jar` },
        { dir: `${prefix}/javafmllanguage/${verStr}`, file: `javafmllanguage-${verStr}.jar` },
        { dir: `${prefix}/mclanguage/${verStr}`, file: `mclanguage-${verStr}.jar` },
        { dir: `${prefix}/lowcodelanguage/${verStr}`, file: `lowcodelanguage-${verStr}.jar` },
    ];

    const result = [];

    for (const artifact of coreArtifacts) {
        for (const base of searchBases) {
            if (!base) continue;
            const jarPath = path.join(base, artifact.dir, artifact.file);
            if (fs.existsSync(jarPath)) {
                if (!result.some(r => path.basename(r) === path.basename(jarPath))) {
                    result.push(jarPath);
                }
                break;
            }
        }
    }

    {
        const forgeDir = `${prefix}/forge/${verStr}`;
        for (const base of searchBases) {
            if (!base) continue;
            const dirPath = path.join(base, forgeDir);
            if (!fs.existsSync(dirPath)) continue;
            const candidates = [
                `forge-${verStr}-universal.jar`,
                `forge-${verStr}-client.jar`,
                `forge-${verStr}.jar`,
            ];
            let found = false;
            for (const candidate of candidates) {
                const jarPath = path.join(dirPath, candidate);
                if (fs.existsSync(jarPath)) {
                    result.push(jarPath);
                    found = true;
                    break;
                }
            }
            if (!found) {
                try {
                    const files = fs.readdirSync(dirPath)
                        .filter(f => f.startsWith('forge-') && f.endsWith('.jar') && !f.endsWith('-sources.jar') && !f.endsWith('-javadoc.jar'));
                    if (files.length > 0) {
                        result.push(path.join(dirPath, files[0]));
                    }
                } catch (e) {}
            }
            break;
        }
    }

    if (result.length > 0) {
        console.log(`[Classpath] 自动添加Forge核心JAR (${result.length}): ${result.map(r => path.basename(r)).join(', ')}`);
    }

    return result;
}

function findNeoForgeCoreJars(versionJson, searchBases, gameArgs) {
    console.log(`[findNeoForgeCoreJars] called, versionId=${versionJson.id}, gameArgsLen=${gameArgs.length}, searchBasesLen=${searchBases.length}`);
    let neoForgeVersion = '';
    let mcVersion = '';

    const neoForgeVerIdx = gameArgs.findIndex(a => typeof a === 'string' && a === '--fml.neoForgeVersion');
    const mcVerIdx = gameArgs.findIndex(a => typeof a === 'string' && a === '--fml.mcVersion');

    console.log(`[findNeoForgeCoreJars] neoForgeVerIdx=${neoForgeVerIdx} mcVerIdx=${mcVerIdx}`);

    if (neoForgeVerIdx >= 0 && neoForgeVerIdx + 1 < gameArgs.length) {
        neoForgeVersion = gameArgs[neoForgeVerIdx + 1];
    }
    if (mcVerIdx >= 0 && mcVerIdx + 1 < gameArgs.length) {
        mcVersion = gameArgs[mcVerIdx + 1];
    }
    if (!mcVersion && versionJson.clientVersion) {
        mcVersion = versionJson.clientVersion;
    }

    if (!neoForgeVersion) {
        const neoLib = (versionJson.libraries || []).find(l =>
            l.name && l.name.startsWith('net.neoforged:neoforge:')
        );
        if (neoLib) {
            const parts = neoLib.name.split(':');
            if (parts.length >= 3) {
                neoForgeVersion = parts[2];
            }
        }
        if (!neoForgeVersion) {
            const versionDirName = versionJson.id || '';
            const neoMatch = versionDirName.match(/neoforge[_\-\s]*(\d+[\d.]*(?:\.\d+)*)/i);
            if (neoMatch) {
                neoForgeVersion = neoMatch[1];
            }
        }
        if (!neoForgeVersion) {
            const fmlLoaderLib = (versionJson.libraries || []).find(l =>
                l.name && l.name.startsWith('net.neoforged.fancymodloader:loader:')
            );
            if (fmlLoaderLib) {
                const parts = fmlLoaderLib.name.split(':');
                if (parts.length >= 3) {
                    neoForgeVersion = parts[2];
                }
            }
        }
    }

    if (!neoForgeVersion) {
        console.log(`[findNeoForgeCoreJars] neoForgeVersion empty, returning []`);
        return [];
    }

    console.log(`[findNeoForgeCoreJars] neoForgeVersion=${neoForgeVersion} mcVersion=${mcVersion}`);

    const result = [];
    const prefix = 'net/neoforged/neoforge';

    for (const base of searchBases) {
        if (!base) continue;
        const dirPath = path.join(base, prefix, neoForgeVersion);
        if (!fs.existsSync(dirPath)) continue;

        const candidates = [
            `neoforge-${neoForgeVersion}-universal.jar`,
            `neoforge-${neoForgeVersion}.jar`,
        ];
        let found = false;
        for (const candidate of candidates) {
            const jarPath = path.join(dirPath, candidate);
            if (fs.existsSync(jarPath)) {
                result.push(jarPath);
                found = true;
                break;
            }
        }
        if (!found) {
            try {
                const files = fs.readdirSync(dirPath)
                    .filter(f => f.startsWith('neoforge-') && f.endsWith('.jar') && !f.endsWith('-sources.jar') && !f.endsWith('-javadoc.jar'));
                if (files.length > 0) {
                    result.push(path.join(dirPath, files[0]));
                }
            } catch (e) {}
        }
        break;
    }

    if (result.length > 0) {
        console.log(`[Classpath] 自动添加NeoForge核心JAR (${result.length}): ${result.map(r => path.basename(r)).join(', ')}`);
    } else {
        console.log(`[findNeoForgeCoreJars] no JAR found in searchBases, returning []`);
    }

    return result;
}

// ============================================================================
// 基础版本安装
// ============================================================================

async function ensureBaseVersionInstalled(gameVersion, onProgress = null) {
    const baseLog = (msg) => { console.log(`[BaseVersion-DEBUG] ${msg}`); utils._writeImportLog(`[基础版本] ${msg}`); };
    baseLog(`ensureBaseVersionInstalled: ${gameVersion}`);
    const baseJsonPath = path.join(ctx.dirs.VERSIONS_DIR, gameVersion, `${gameVersion}.json`);
    const baseJarPath = path.join(ctx.dirs.VERSIONS_DIR, gameVersion, `${gameVersion}.jar`);
    baseLog(`baseJsonPath: ${baseJsonPath}, exists: ${fs.existsSync(baseJsonPath)}`);
    baseLog(`baseJarPath: ${baseJarPath}, exists: ${fs.existsSync(baseJarPath)}`);
    const report = onProgress || (() => {});

    if (fs.existsSync(baseJsonPath) && fs.existsSync(baseJarPath)) {
        baseLog(`Both files exist, verifying...`);
        try {
            const existingJson = JSON.parse(fs.readFileSync(baseJsonPath, 'utf-8'));
            if (existingJson.downloads?.client?.sha1) {
                baseLog(`Verifying JAR SHA1: ${existingJson.downloads.client.sha1}`);
                const sha1Ok = await utils.verifyFileSha1(baseJarPath, existingJson.downloads.client.sha1);
                if (!sha1Ok) {
                    baseLog(`JAR SHA1 verify failed, re-download`);
                    fs.unlinkSync(baseJarPath);
                } else {
                    let libsOk = true;
                    const libs = existingJson.libraries || [];
                    let checkedCount = 0;
                    for (const lib of libs) {
                        if (checkedCount >= 5) break;
                        if (lib.rules && !versions.evaluateRules(lib.rules)) continue;
                        const artifactPath = lib.downloads?.artifact?.path;
                        if (artifactPath) {
                            checkedCount++;
                            const libFile = path.join(ctx.dirs.LIBRARIES_DIR, artifactPath);
                            if (!fs.existsSync(libFile)) {
                                baseLog(`Lib missing: ${artifactPath}`);
                                libsOk = false;
                                break;
                            }
                        }
                    }
                    if (libsOk) {
                        baseLog(`${gameVersion} already installed (verified)`);
                        return { alreadyInstalled: true };
                    }
                    baseLog(`${gameVersion} libs incomplete, need re-download`);
                }
            } else {
                baseLog(`No sha1 to verify, checking libs...`);
                let libsOk = true;
                const libs = existingJson.libraries || [];
                for (const lib of libs.slice(0, 5)) {
                    const artifactPath = lib.downloads?.artifact?.path;
                    if (artifactPath && !fs.existsSync(path.join(ctx.dirs.LIBRARIES_DIR, artifactPath))) {
                        libsOk = false;
                        break;
                    }
                }
                if (libsOk) {
                    baseLog(`${gameVersion} already installed (no sha1 check)`);
                    return { alreadyInstalled: true };
                }
            }
        } catch (e) {
            baseLog(`Verify error: ${e.message}`);
        }
    }

    baseLog(`${gameVersion} not found or corrupted, installing...`);

    try {
        report('正在获取版本信息...', 15);
        const manifest = await versions.getVersionManifest();
        const versionInfo = manifest.versions.find(v => v.id === gameVersion);

        if (!versionInfo) {
            return { alreadyInstalled: false, error: `找不到版本 ${gameVersion}` };
        }

        report('正在下载版本 JSON...', 20);
        const versionDetails = await versions.getVersionDetails(versionInfo.url);
        const versionDir = path.join(ctx.dirs.VERSIONS_DIR, gameVersion);
        if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });

        const jsonPath = path.join(versionDir, `${gameVersion}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(versionDetails, null, 2));

        if (versionDetails.downloads?.client) {
            const clientInfo = versionDetails.downloads.client;
            const clientJarPath = path.join(versionDir, `${gameVersion}.jar`);

            if (!fs.existsSync(clientJarPath) || (clientInfo.sha1 && !(await utils.verifyFileSha1(clientJarPath, clientInfo.sha1)))) {
                report('正在下载客户端...', 25);
                console.log(`[BaseVersion] Downloading client JAR for ${gameVersion}...`);
                await http.downloadFileSyncAsync(clientInfo.url, clientJarPath);
                if (clientInfo.sha1 && !(await utils.verifyFileSha1(clientJarPath, clientInfo.sha1))) {
                    console.warn(`[BaseVersion] Client JAR SHA1 mismatch after download!`);
                }
            }
        }

        const libraries = versionDetails.libraries || [];
        const needDownloadLibs = [];
        for (const lib of libraries) {
            if (lib.rules && !versions.evaluateRules(lib.rules)) continue;
            if (lib.downloads?.artifact) {
                const libPath = utils.safeLibPath(lib.downloads.artifact.path);
                if (!libPath) continue;
                if (!fs.existsSync(libPath) || (lib.downloads.artifact.sha1 && !(await utils.verifyFileSha1(libPath, lib.downloads.artifact.sha1)))) {
                    needDownloadLibs.push(lib);
                }
            }
        }
        const totalLibs = needDownloadLibs.length;
        let downloadedLibs = 0;

        const _collectLibTasks = () => {
            const tasks = [];
            for (const lib of libraries) {
                if (lib.rules && !versions.evaluateRules(lib.rules)) continue;
                if (lib.downloads?.artifact) {
                    const libPath = utils.safeLibPath(lib.downloads.artifact.path);
                    if (!libPath) continue;
                    const needDownload = !fs.existsSync(libPath) ||
                        (lib.downloads.artifact.sha1 && !utils.verifyFileSha1Sync(libPath, lib.downloads.artifact.sha1));
                    if (needDownload && lib.downloads.artifact.url) {
                        tasks.push({ type: 'artifact', lib, libPath });
                    }
                } else if (lib.name) {
                    const parts = lib.name.split(':');
                    if (parts.length >= 3) {
                        const groupPath = parts[0].replace(/\./g, '/');
                        const lname = parts[1];
                        const lversion = parts[2];
                        const classifier = parts.length >= 4 ? parts[3] : '';
                        const jarName = classifier ? `${lname}-${lversion}-${classifier}.jar` : `${lname}-${lversion}.jar`;
                        const libFile = path.join(ctx.dirs.LIBRARIES_DIR, parts[0].replace(/\./g, path.sep), lname, lversion, jarName);
                        if (!fs.existsSync(libFile)) {
                            tasks.push({ type: 'name', lib, libFile, groupPath, lname, lversion, jarName });
                        }
                    }
                }
                if (lib.natives) {
                    const nativeKey = lib.natives[process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'];
                    if (nativeKey) {
                        const classifier = nativeKey.replace('${arch}', process.arch === 'x64' ? '64' : '32');
                        const nativeDownload = lib.downloads?.classifiers?.[classifier];
                        if (nativeDownload) {
                            const nativeFile = path.join(ctx.dirs.LIBRARIES_DIR, nativeDownload.path);
                            if (!fs.existsSync(nativeFile)) {
                                tasks.push({ type: 'native', lib, nativeDownload, nativeFile });
                            }
                        }
                    }
                }
            }
            return tasks;
        };

        const _allLibTasks = _collectLibTasks();
        const _libParallel = 32;
        if (_allLibTasks.length > 0) {
            let _libDone = 0;
            let _libActive = 0;
            let _libIdx = 0;
            let _libFinish = null;
            const _scheduleLib = () => {
                while (_libActive < _libParallel && _libIdx < _allLibTasks.length) {
                    const task = _allLibTasks[_libIdx++];
                    _libActive++;
                    (async () => {
                        if (task.type === 'artifact') {
                            try {
                                if (fs.existsSync(task.libPath)) fs.unlinkSync(task.libPath);
                                await http.downloadFileWithMirror(task.lib.downloads.artifact.url, task.libPath, null, 3, null, 60000);
                            } catch (e) {
                                console.log(`[BaseVersion] 下载库失败 ${task.lib.name}: ${e.message}, 尝试curl...`);
                                const _bmcl = task.lib.downloads.artifact.url.replace('https://libraries.minecraft.net/', 'https://bmclapi2.bangbang93.com/maven/');
                                const _fm = task.lib.downloads.artifact.url.replace('https://libraries.minecraft.net/', 'https://maven.minecraftforge.net/');
                                try { utils.ensureDirForFile(task.libPath); await _curlDownload(_bmcl, task.libPath); } catch (_) {}
                                if (!fs.existsSync(task.libPath) || fs.statSync(task.libPath).size < 100) {
                                    try { await _curlDownload(_fm, task.libPath); } catch (_) {}
                                }
                                if (!fs.existsSync(task.libPath) || fs.statSync(task.libPath).size < 100) {
                                    try { await _curlDownload(task.lib.downloads.artifact.url, task.libPath); } catch (_) {}
                                }
                            }
                        } else if (task.type === 'name') {
                            const baseUrl = task.lib.url || 'https://libraries.minecraft.net/';
                            const downloadUrl = `${baseUrl}${task.groupPath}/${task.lname}/${task.lversion}/${task.jarName}`;
                            try {
                                await http.downloadFileWithMirror(downloadUrl, task.libFile);
                            } catch (e) {
                                console.log(`[BaseVersion] 下载库失败 ${task.lib.name}: ${e.message}, 尝试curl...`);
                                const _bmcl2 = downloadUrl.replace('https://libraries.minecraft.net/', 'https://bmclapi2.bangbang93.com/maven/');
                                const _fm2 = downloadUrl.replace('https://libraries.minecraft.net/', 'https://maven.minecraftforge.net/');
                                try { utils.ensureDirForFile(task.libFile); await _curlDownload(_bmcl2, task.libFile); } catch (_) {}
                                if (!fs.existsSync(task.libFile) || fs.statSync(task.libFile).size < 100) {
                                    try { await _curlDownload(_fm2, task.libFile); } catch (_) {}
                                }
                                if (!fs.existsSync(task.libFile) || fs.statSync(task.libFile).size < 100) {
                                    try { await _curlDownload(downloadUrl, task.libFile); } catch (_) {}
                                }
                            }
                        } else if (task.type === 'native') {
                            try {
                                await http.downloadFileWithMirror(task.nativeDownload.url, task.nativeFile);
                            } catch (e) {
                                console.log(`[BaseVersion] Failed to download native ${path.basename(task.nativeDownload.path)}: ${e.message}`);
                            }
                        }
                    })().finally(() => {
                        _libActive--;
                        _libDone++;
                        downloadedLibs = _libDone;
                        if (totalLibs > 0) {
                            report(`正在下载库文件 (${downloadedLibs}/${totalLibs})...`, 30 + Math.round(downloadedLibs / totalLibs * 35));
                        }
                        if (_libActive === 0 && _libDone >= _allLibTasks.length && _libFinish) _libFinish();
                        else if (_libActive < _libParallel && _libIdx < _allLibTasks.length) _scheduleLib();
                    });
                }
            };
            await new Promise(resolve => { _libFinish = resolve; _scheduleLib(); });
        } else {
            for (const lib of libraries) {
                if (lib.natives) {
                    const nativeKey = lib.natives[process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'];
                    if (nativeKey) {
                        const classifier = nativeKey.replace('${arch}', process.arch === 'x64' ? '64' : '32');
                        const nativeDownload = lib.downloads?.classifiers?.[classifier];
                        if (nativeDownload) {
                            const nativeFile = path.join(ctx.dirs.LIBRARIES_DIR, nativeDownload.path);
                            if (!fs.existsSync(nativeFile)) {
                                try {
                                    await http.downloadFileWithMirror(nativeDownload.url, nativeFile);
                                } catch (e) {
                                    console.log(`[BaseVersion] Failed to download native ${path.basename(nativeDownload.path)}: ${e.message}`);
                                }
                            }
                        }
                    }
                }
            }
        }

        report('正在下载资源索引...', 68);
        if (versionDetails.assetIndex) {
            const assetIndexDir = path.join(ctx.dirs.ASSETS_DIR, 'indexes');
            if (!fs.existsSync(assetIndexDir)) fs.mkdirSync(assetIndexDir, { recursive: true });
            const assetIndexPath = path.join(assetIndexDir, `${versionDetails.assetIndex.id}.json`);
            if (!fs.existsSync(assetIndexPath) || (versionDetails.assetIndex.sha1 && !(await utils.verifyFileSha1(assetIndexPath, versionDetails.assetIndex.sha1)))) {
                if (fs.existsSync(assetIndexPath)) fs.unlinkSync(assetIndexPath);
                await http.downloadFileWithMirror(versionDetails.assetIndex.url, assetIndexPath);
            }
        }

        report('正在校验库文件...', 72);
        const missingLibs = [];
        const libsToVerify = (versionDetails.libraries || []).filter(l =>
            l.downloads?.artifact?.path && !(l.rules && !versions.evaluateRules(l.rules))
        );
        for (let i = 0; i < Math.min(5, libsToVerify.length); i++) {
            const lib = libsToVerify[i];
            const libFile = path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path);
            if (!fs.existsSync(libFile)) {
                missingLibs.push(lib.downloads.artifact.path);
            }
        }
        if (missingLibs.length > 0) {
            const msg = `基础版本 ${gameVersion} 库文件下载后仍缺失 (${missingLibs.length}个): ${missingLibs[0]}`;
            console.error(`[BaseVersion] ${msg}`);
            return { error: msg };
        }

        console.log(`[BaseVersion] ${gameVersion} installed successfully`);
        return { alreadyInstalled: false, success: true };
    } catch (e) {
        console.error(`[BaseVersion] Failed to install ${gameVersion}:`, e.message);
        try {
            const versionDir = path.join(ctx.dirs.VERSIONS_DIR, gameVersion);
            if (fs.existsSync(versionDir)) {
                fs.rmSync(versionDir, { recursive: true, force: true });
                console.log(`[BaseVersion] Cleaned up failed version directory: ${versionDir}`);
            }
        } catch (cleanupErr) {
            console.error(`[BaseVersion] Failed to cleanup version directory:`, cleanupErr.message);
        }
        return { alreadyInstalled: false, error: `基础版本 ${gameVersion} 安装失败: ${e.message}` };
    }
}

// ============================================================================
// Fabric 安装
// ============================================================================

async function installFabric(gameVersion, loaderVersion, onProgress = null) {
    const versionId = `fabric-loader-${loaderVersion}-${gameVersion}`;

    try {
        const baseResult = await ensureBaseVersionInstalled(gameVersion);
        if (baseResult.error) {
            return { success: false, error: baseResult.error };
        }

        const profileJsonUrl = `${ctx.urls.FABRIC_META_URL}/versions/loader/${gameVersion}/${loaderVersion}/profile/json`;
        const baseMetaUrl = `${ctx.urls.FABRIC_META_URL}/versions/loader/${gameVersion}/${loaderVersion}`;
        console.log(`[Fabric] Fetching profile/json from: ${profileJsonUrl}`);

        let fullProfile = null;
        try {
            fullProfile = await http.fetchJSON(profileJsonUrl);
            fullProfile.id = versionId;
            fullProfile.inheritsFrom = gameVersion;
            if (!fullProfile.time) fullProfile.time = fullProfile.releaseTime || new Date().toISOString();
            console.log(`[Fabric] profile/json returned ${fullProfile.libraries?.length || 0} libraries`);
        } catch (profileErr) {
            console.warn(`[Fabric] profile/json failed (${profileErr.message}), falling back to base endpoint`);
        }

        if (!fullProfile || !fullProfile.libraries || fullProfile.libraries.length === 0) {
            console.log(`[Fabric] Falling back to base endpoint: ${baseMetaUrl}`);
            const profileData = await http.fetchJSON(baseMetaUrl);
            console.log(`[Fabric] Profile data keys: ${Object.keys(profileData).join(', ')}`);

            fullProfile = {
                id: versionId,
                inheritsFrom: gameVersion,
                mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
                type: 'release',
                time: new Date().toISOString(),
                libraries: [],
                arguments: { game: [], jvm: [] }
            };

            if (profileData.launcherMeta) {
                const launcherMeta = profileData.launcherMeta;
                if (launcherMeta.libraries) {
                    const common = launcherMeta.libraries.common || [];
                    const client = launcherMeta.libraries.client || [];
                    fullProfile.libraries = [...common, ...client];
                    console.log(`[Fabric] Libraries from launcherMeta: ${fullProfile.libraries.length}`);
                }
                if (launcherMeta.mainClass) {
                    const metaMainClass = typeof launcherMeta.mainClass === 'string'
                        ? launcherMeta.mainClass
                        : launcherMeta.mainClass?.client;
                    if (metaMainClass && metaMainClass.includes('fabricmc')) {
                        fullProfile.mainClass = metaMainClass;
                    }
                }
            }

            if (profileData.loader?.mainClass) {
                fullProfile.mainClass = profileData.loader.mainClass;
            }
            if (profileData.mainClass) {
                if (typeof profileData.mainClass === 'string') {
                    fullProfile.mainClass = profileData.mainClass;
                } else if (profileData.mainClass.client) {
                    fullProfile.mainClass = profileData.mainClass.client;
                }
            }

            if (profileData.loader?.maven) {
                const loaderParts = profileData.loader.maven.split(':');
                if (loaderParts.length >= 3) {
                    fullProfile.libraries.push({
                        name: profileData.loader.maven,
                        url: 'https://maven.fabricmc.net/'
                    });
                    console.log(`[Fabric] Added fabric-loader library: ${profileData.loader.maven}`);
                }
            }
            if (profileData.intermediary?.maven) {
                const interParts = profileData.intermediary.maven.split(':');
                if (interParts.length >= 3) {
                    fullProfile.libraries.push({
                        name: profileData.intermediary.maven,
                        url: 'https://maven.fabricmc.net/'
                    });
                    console.log(`[Fabric] Added intermediary library: ${profileData.intermediary.maven}`);
                }
            }

            if (profileData.arguments) {
                for (const key of Object.keys(profileData.arguments)) {
                    if (Array.isArray(profileData.arguments[key])) {
                        fullProfile.arguments[key] = profileData.arguments[key];
                    }
                }
            }
            if (profileData.launcherMeta?.arguments) {
                for (const key of Object.keys(profileData.launcherMeta.arguments)) {
                    if (Array.isArray(profileData.launcherMeta.arguments[key])) {
                        fullProfile.arguments[key] = profileData.launcherMeta.arguments[key];
                    }
                }
            }
        }

        const versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
        if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });

        console.log(`[Fabric] Final mainClass: ${fullProfile.mainClass}`);
        console.log(`[Fabric] Final libraries count: ${fullProfile.libraries.length}`);

        const fabLibsToDownload = [];
        for (const lib of fullProfile.libraries) {
            if (lib.downloads?.artifact?.url) {
                const libPath = path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path);
                if (!utils.isJarIntact(libPath)) {
                    fabLibsToDownload.push({ lib, url: lib.downloads.artifact.url, libPath });
                }
            } else if (lib.name) {
                const parts = lib.name.split(':');
                if (parts.length >= 3) {
                    const mavenGroupPath = parts[0].replace(/\./g, '/');
                    const name = parts[1];
                    const ver = parts[2];
                    const classifier = parts.length >= 4 ? parts[3] : '';
                    const jarName = classifier ? `${name}-${ver}-${classifier}.jar` : `${name}-${ver}.jar`;
                    const localGroupPath = parts[0].replace(/\./g, path.sep);
                    const libPath = path.join(ctx.dirs.LIBRARIES_DIR, localGroupPath, name, ver, jarName);

                    if (!lib.downloads) lib.downloads = {};
                    if (!lib.downloads.artifact) {
                        lib.downloads.artifact = {
                            path: `${mavenGroupPath}/${name}/${ver}/${jarName}`,
                            sha1: '', size: 0, url: ''
                        };
                    }

                    if (!utils.isJarIntact(libPath)) {
                        const mavenBaseUrl = lib.url || 'https://maven.fabricmc.net/';
                        const downloadUrl = `${mavenBaseUrl}${mavenGroupPath}/${name}/${ver}/${jarName}`;
                        const altUrls = [];
                        if (mavenBaseUrl !== 'https://repo1.maven.org/maven2/') {
                            altUrls.push(`https://repo1.maven.org/maven2/${mavenGroupPath}/${name}/${ver}/${jarName}`);
                        }
                        if (mavenBaseUrl !== 'https://maven.fabricmc.net/') {
                            altUrls.push(`https://maven.fabricmc.net/${mavenGroupPath}/${name}/${ver}/${jarName}`);
                        }
                        fabLibsToDownload.push({ lib, url: downloadUrl, libPath, altUrls });
                    }
                }
            }
        }

        let fabLibFailures = 0;
        if (fabLibsToDownload.length > 0) {
            const settings = versions.loadSettingsCached();
            const FAB_PARALLEL = Math.min(parseInt(settings.maxThreads, 10) || 64, fabLibsToDownload.length);
            let completed = 0;
            let failed = 0;
            let active = 0;
            let done = null;

            const scheduleNext = () => {
                while (active < FAB_PARALLEL && completed + failed + active < fabLibsToDownload.length) {
                    const item = fabLibsToDownload[completed + failed + active];
                    active++;
                    (async () => {
                        const expectedSha1 = item.lib.downloads?.artifact?.sha1 || '';
                        const expectedSize = item.lib.downloads?.artifact?.size || 0;
                        if (fs.existsSync(item.libPath)) {
                            const stat = fs.statSync(item.libPath);
                            if (stat.size > 0 && (!expectedSize || stat.size === expectedSize)) {
                                if (!expectedSha1) {
                                    completed++;
                                    return;
                                }
                                try {
                                    const actual = await utils.calculateSHA1(item.libPath);
                                    if (actual === expectedSha1) { completed++; return; }
                                } catch (_) {}
                            }
                            try { fs.unlinkSync(item.libPath); } catch (_) {}
                        }
                        const urlsToTry = [item.url, ...(item.altUrls || [])];
                        let downloaded = false;
                        for (const tryUrl of urlsToTry) {
                            try {
                                await http.downloadFileWithMirror(tryUrl, item.libPath);
                                if (expectedSha1) {
                                    const actual = await utils.calculateSHA1(item.libPath);
                                    if (actual !== expectedSha1) {
                                        try { fs.unlinkSync(item.libPath); } catch (_) {}
                                        continue;
                                    }
                                }
                                downloaded = true;
                                break;
                            } catch (e) {
                                console.warn(`[Fabric] 下载失败 ${tryUrl}: ${e.message}`);
                                try { if (fs.existsSync(item.libPath)) fs.unlinkSync(item.libPath); } catch (_) {}
                            }
                        }
                        if (!downloaded) {
                            throw new Error(`所有下载源失败: ${path.basename(item.libPath)}`);
                        }
                    })().then(() => {
                        completed++;
                    }).catch((e) => {
                        fabLibFailures++;
                        console.log(`[Fabric] Failed to download ${item.lib.name}: ${e.message}`);
                        failed++;
                    }).finally(() => {
                        active--;
                        if (onProgress) {
                            onProgress((completed + failed) / fabLibsToDownload.length, `下载Fabric库 (${completed + failed}/${fabLibsToDownload.length})...`);
                        }
                        if (active === 0 && completed + failed >= fabLibsToDownload.length && done) done();
                        else if (active < FAB_PARALLEL && completed + failed + active < fabLibsToDownload.length) scheduleNext();
                    });
                }
            };

            await new Promise(resolve => { done = resolve; scheduleNext(); });
        }

        const fabCoreLibs = [];
        const fabMainLib = fullProfile.libraries.find(l => l.name && l.name.startsWith('net.fabricmc:fabric-loader:'));
        if (fabMainLib) {
            const fp = fabMainLib.name.split(':');
            const fj = `${fp[1]}-${fp[2]}.jar`;
            fabCoreLibs.push(path.join(ctx.dirs.LIBRARIES_DIR, fp[0].replace(/\./g, path.sep), fp[1], fp[2], fj));
        }
        const fabMissing = fabCoreLibs.filter(f => !fs.existsSync(f));
        if (fabMissing.length > 0) {
            console.warn(`[Fabric] 核心库文件暂缺 (${fabMissing.length}个): ${fabMissing.join(', ')}, 将由安装后验证补全`);
        }

        const jsonPath = path.join(versionDir, `${versionId}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(fullProfile, null, 2));

        console.log(`[Fabric] Installation complete: ${versionId}`);
        return { success: true, versionId: versionId, libsMissing: fabMissing.length };
    } catch (e) {
        console.error(`[Fabric] Installation failed: ${e.message}`);
        try {
            const versionDir = path.join(ctx.dirs.VERSIONS_DIR, `fabric-loader-${loaderVersion}-${gameVersion}`);
            if (fs.existsSync(versionDir)) {
                fs.rmSync(versionDir, { recursive: true, force: true });
                console.log(`[Fabric] Cleaned up failed version directory: ${versionDir}`);
            }
        } catch (cleanupErr) {
            console.error(`[Fabric] Failed to cleanup version directory:`, cleanupErr.message);
        }
        return { success: false, error: e.message };
    }
}

// ============================================================================
// 加载器库验证
// ============================================================================

function verifyLoaderLibs(versionId) {
    try {
        const mergedJson = versions.resolveVersionJson(versionId);
        if (!mergedJson) {
            const jsonPath = path.join(ctx.dirs.VERSIONS_DIR, versionId, `${versionId}.json`);
            if (!fs.existsSync(jsonPath)) return false;
            const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
            if (!data.libraries || data.libraries.length === 0) return false;
        }
        const libs = mergedJson ? (mergedJson.libraries || []) : [];
        let checked = 0, missing = 0;
        const missingPaths = [];
        for (const lib of libs) {
            if (lib.rules && !versions.evaluateRules(lib.rules)) continue;
            let libPath = null;
            if (lib.downloads?.artifact?.path) {
                libPath = path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path);
            } else if (lib.name) {
                const parts = lib.name.split(':');
                if (parts.length >= 3) {
                    const gp = parts[0].replace(/\./g, path.sep);
                    const nm = parts[1];
                    const vr = parts[2];
                    const cls = parts.length >= 4 ? parts[3] : '';
                    const jn = cls ? `${nm}-${vr}-${cls}.jar` : `${nm}-${vr}.jar`;
                    libPath = path.join(ctx.dirs.LIBRARIES_DIR, gp, nm, vr, jn);
                }
            }
            if (libPath) {
                checked++;
                if (!fs.existsSync(libPath)) {
                    missing++;
                    if (missingPaths.length < 3) missingPaths.push(lib.name || path.basename(libPath));
                }
            }
        }
        if (missing > 0) {
            console.log(`[verifyLoaderLibs] ${versionId}: ${checked}个库, ${missing}个缺失 (${missingPaths.join(', ')}...)`);
            return false;
        }

        const _vlLower = versionId.toLowerCase();
        const _isNeo = _vlLower.includes('neoforge') || _vlLower.includes('neoforged');
        const isForge = _vlLower.includes('forge') && !_isNeo;
        if (isForge && checked > 0) {
            const forgeCoreFiles = [];
            for (const lib of libs) {
                if (!lib.name) continue;
                if (lib.name.startsWith('net.minecraftforge:forge:') && lib.name.split(':').length >= 4) {
                    forgeCoreFiles.push(lib);
                }
                if (lib.name === 'net.minecraftforge:forge' || lib.name.startsWith('net.minecraftforge:forge:')) {
                    forgeCoreFiles.push(lib);
                }
                if (lib.name.startsWith('net.minecraft:client:') && (lib.name.endsWith(':srg') || lib.name.endsWith(':extra'))) {
                    forgeCoreFiles.push(lib);
                }
            }
            let forgeCoreMissing = 0;
            const missingForgeCores = [];
            for (const lib of forgeCoreFiles) {
                const parts = lib.name.split(':');
                const gp = parts[0].replace(/\./g, path.sep);
                const nm = parts[1];
                const vr = parts[2];
                const cl = parts.length >= 4 ? parts[3] : '';
                const jn = cl ? `${nm}-${vr}-${cl}.jar` : `${nm}-${vr}.jar`;
                const fp = path.join(ctx.dirs.LIBRARIES_DIR, gp, nm, vr, jn);
                if (!fs.existsSync(fp)) {
                    forgeCoreMissing++;
                    missingForgeCores.push(path.basename(fp));
                }
            }

            const mainJsonPath = path.join(ctx.dirs.VERSIONS_DIR, versionId, `${versionId}.json`);
            try {
                const mainJson = JSON.parse(fs.readFileSync(mainJsonPath, 'utf-8'));
                if (mainJson.mainClass && mainJson.mainClass.includes('bootstraplauncher')) {
                    const mcMatch = versionId.match(/^(\d+\.\d+(?:\.\d+)?)-forge-(.+)$/);
                    if (mcMatch) {
                        const mcV = mcMatch[1];
                        const fV = mcMatch[2];
                        const forgeVerStr = `${mcV}-${fV}`;
                        const forgeClientPath = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'minecraftforge', 'forge', forgeVerStr, `forge-${forgeVerStr}-client.jar`);
                        const forgeUniversalPath = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'minecraftforge', 'forge', forgeVerStr, `forge-${forgeVerStr}-universal.jar`);
                        const hasForgeJar = (fs.existsSync(forgeClientPath) && utils.isJarIntact(forgeClientPath)) ||
                            (fs.existsSync(forgeUniversalPath) && utils.isJarIntact(forgeUniversalPath));
                        if (!hasForgeJar) {
                            forgeCoreMissing++;
                            missingForgeCores.push(`forge-${forgeVerStr}-client.jar`);
                        }

                        const args = mainJson.arguments?.game || [];
                        const mcpIdx = args.findIndex(a => a === '--fml.mcpVersion');
                        if (mcpIdx >= 0 && mcpIdx + 1 < args.length) {
                            const mcpV = args[mcpIdx + 1];
                            const clientVerStr = `${mcV}-${mcpV}`;
                            for (const suffix of ['srg', 'extra']) {
                                const cp = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'minecraft', 'client', clientVerStr, `client-${clientVerStr}-${suffix}.jar`);
                                if (!fs.existsSync(cp) || !utils.isJarIntact(cp)) {
                                    forgeCoreMissing++;
                                    missingForgeCores.push(`client-${clientVerStr}-${suffix}.jar`);
                                }
                            }
                        }
                    }
                }
            } catch (_) {}

            if (forgeCoreMissing > 0) {
                console.log(`[verifyLoaderLibs] ${versionId}: 基础库存在但Forge核心文件缺失(${forgeCoreMissing}): ${missingForgeCores.join(', ')}`);
                return false;
            }
            console.log(`[verifyLoaderLibs] ${versionId}: 包含Forge核心文件(${forgeCoreFiles.length}个)全部存在`);
        }

        console.log(`[verifyLoaderLibs] ${versionId}: ${checked}个库全部存在`);
        return checked > 0;
    } catch (e) {
        console.log(`[verifyLoaderLibs] ${versionId}: error ${e.message}`);
        return false;
    }
}

// ============================================================================
// 版本比较与模组需求扫描
// ============================================================================

function compareSemver(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na > nb) return 1;
        if (na < nb) return -1;
    }
    return 0;
}

function parseVersionRequirement(req) {
    if (!req || typeof req !== 'string') return null;
    const m = req.match(/^([><=]+)\s*(.+)/);
    if (!m) return { op: '>=', version: req.trim() };
    return { op: m[1], version: m[2].trim() };
}

function scanModsForLoaderReqs(modsDir) {
    const result = { fabric: null, forge: null };
    if (!fs.existsSync(modsDir)) return result;
    let AdmZip;
    try { AdmZip = require('adm-zip'); } catch (_) { return result; }
    const files = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar'));
    for (const f of files) {
        try {
            const zip = new AdmZip(path.join(modsDir, f));
            let metaEntry = zip.getEntry('fabric.mod.json');
            let isQuilt = false;
            if (!metaEntry) { metaEntry = zip.getEntry('quilt.mod.json'); isQuilt = true; }
            if (!metaEntry) continue;
            const meta = JSON.parse(metaEntry.getData().toString('utf8'));
            const deps = isQuilt ? (meta.quilt_loader?.dependencies || {}) : (meta.depends || {});
            const fabricReq = deps.fabricloader || deps['fabric-loader'];
            if (fabricReq && typeof fabricReq === 'string') {
                const parsed = parseVersionRequirement(fabricReq);
                if (parsed && (parsed.op === '>=' || parsed.op === '=' || parsed.op === '==')) {
                    if (!result.fabric || compareSemver(parsed.version, result.fabric) > 0) {
                        result.fabric = parsed.version;
                    }
                }
            }
            const forgeReq = deps.forge;
            if (forgeReq && typeof forgeReq === 'string') {
                const parsed = parseVersionRequirement(forgeReq);
                if (parsed && (parsed.op === '>=' || parsed.op === '=' || parsed.op === '==')) {
                    if (!result.forge || compareSemver(parsed.version, result.forge) > 0) {
                        result.forge = parsed.version;
                    }
                }
            }
        } catch (_) {}
    }
    return result;
}

async function ensureLoaderCompat(versionId, versionDir, mcVersion, currentLoaderVer, loaderType, progress, abortSignal) {
    const modsDir = path.join(versionDir, 'mods');
    const reqs = scanModsForLoaderReqs(modsDir);
    const needed = loaderType === 'fabric' ? reqs.fabric : (loaderType === 'forge' ? reqs.forge : null);
    if (!needed || !currentLoaderVer) return { upgraded: false };
    if (compareSemver(needed, currentLoaderVer) <= 0) return { upgraded: false };
    console.log(`[Modpack] 模组需要 ${loaderType} ≥ ${needed}，当前安装 ${currentLoaderVer}，正在升级...`);
    progress('loader-upgrade', `正在升级 ${loaderType === 'fabric' ? 'Fabric' : 'Forge'} 加载器到 ${needed}...`, 88, [], '');
    let newLoaderVersionId;
    try {
        if (loaderType === 'fabric') {
            newLoaderVersionId = `fabric-loader-${needed}-${mcVersion}`;
            const ir = await installFabric(mcVersion, needed, (p, msg) => {
                progress('loader-upgrade', msg || `安装 Fabric ${needed}...`, 88 + Math.round(p * 2), [], '');
            });
            if (!ir.success) throw new Error(ir.error);
        } else {
            newLoaderVersionId = `${mcVersion}-forge-${needed}`;
            const ir = await installForge(mcVersion, needed, (p, msg) => {
                progress('loader-upgrade', msg || `安装 Forge ${needed}...`, 88 + Math.round(p * 2), [], '');
            });
            if (!ir.success) throw new Error(ir.error);
        }
        const oldJsonPath = path.join(versionDir, `${versionId}.json`);
        if (fs.existsSync(oldJsonPath)) {
            const oldJson = JSON.parse(fs.readFileSync(oldJsonPath, 'utf-8'));
            oldJson.inheritsFrom = newLoaderVersionId;
            let newMainClass = '';
            try {
                const lvJsonPath = path.join(ctx.dirs.VERSIONS_DIR, newLoaderVersionId, `${newLoaderVersionId}.json`);
                if (fs.existsSync(lvJsonPath)) {
                    const lvJson = JSON.parse(fs.readFileSync(lvJsonPath, 'utf-8'));
                    newMainClass = lvJson.mainClass || '';
                }
            } catch (_) {}
            if (newMainClass) oldJson.mainClass = newMainClass;
            fs.writeFileSync(oldJsonPath, JSON.stringify(oldJson, null, 2));
            console.log(`[Modpack] 版本JSON已更新: inheritsFrom → ${newLoaderVersionId}, mainClass → ${newMainClass || '未变更'}`);
        }
        progress('loader-upgrade', `${loaderType === 'fabric' ? 'Fabric' : 'Forge'} 已升级到 ${needed}`, 90, [], '');
        return { upgraded: true, newVersion: needed };
    } catch (e) {
        console.error(`[Modpack] ${loaderType} 升级失败: ${e.message}`);
        progress('loader-upgrade', `${loaderType} 升级失败: ${e.message}（使用原版本继续）`, 90, [], '');
        return { upgraded: false, error: e.message };
    }
}

// ============================================================================
// 导入库验证
// ============================================================================

async function verifyImportLibs(versionId, progress, abortSignal) {
    const mergedJson = versions.resolveVersionJson(versionId);
    const allLibs = mergedJson ? (mergedJson.libraries || []) : [];
    const currentPlatform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
    let libChecked = 0, coreLibMissing = 0, nonCoreLibMissing = 0;
    const coreMissingLibFiles = [];
    const nonCoreMissingLibFiles = [];
    const CORE_PREFIXES = ['net.minecraftforge', 'net.neoforged', 'cpw.mods', 'net.minecraft'];

    function isCoreLibrary(libName) {
        if (!libName) return false;
        const pkg = libName.split(':')[0];
        return CORE_PREFIXES.some(p => pkg.startsWith(p));
    }

    for (const lib of allLibs) {
        if (lib.rules && !versions.evaluateRules(lib.rules)) continue;
        if (lib.natives) continue;
        const nameSuffix = lib.name ? lib.name.split(':').pop() : '';
        if (nameSuffix.startsWith('natives-')) {
            let isValid = false;
            if (process.arch === 'x64') {
                const plat = nameSuffix.replace('natives-', '');
                isValid = plat === currentPlatform || plat === currentPlatform + '-x64';
            }
            if (!isValid) continue;
        }
        libChecked++;
        let libPath = null;
        if (lib.downloads?.artifact?.path) {
            libPath = path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path);
        } else if (lib.name) {
            const p = lib.name.split(':');
            if (p.length >= 3) {
                const gp = p[0].replace(/\./g, path.sep);
                const cl = p.length >= 4 ? `-${p[3]}` : '';
                const jn = `${p[1]}-${p[2]}${cl}.jar`;
                libPath = path.join(ctx.dirs.LIBRARIES_DIR, gp, p[1], p[2], jn);
            }
        }
        if (libPath && (!libPath.endsWith('.jar') ? !fs.existsSync(libPath) : !utils.isJarIntact(libPath))) {
            let dlUrl = lib.downloads?.artifact?.url || '';
            if (!dlUrl && lib.name) {
                const p = lib.name.split(':');
                if (p.length >= 3) {
                    const mg = p[0].replace(/\./g, '/');
                    const cl = p.length >= 4 ? `-${p[3]}` : '';
                    const jn = `${p[1]}-${p[2]}${cl}.jar`;
                    const base = lib.url || (p[0].includes('neoforged') ? 'https://maven.neoforged.net/'
                        : (p[0].includes('forge') || p[0].includes('minecraftforge') || p[0].includes('minecraft')
                        ? 'https://maven.minecraftforge.net/' : 'https://libraries.minecraft.net/'));
                    dlUrl = `${base}${mg}/${p[1]}/${p[2]}/${jn}`;
                }
            }
            const libEntry = {
                type: 'library', url: dlUrl || '', path: libPath,
                sha1: lib.downloads?.artifact?.sha1 || '',
                size: lib.downloads?.artifact?.size || 0,
                name: lib.name || path.basename(libPath)
            };
            if (isCoreLibrary(lib.name)) {
                coreLibMissing++;
                coreMissingLibFiles.push(libEntry);
            } else {
                nonCoreLibMissing++;
                nonCoreMissingLibFiles.push(libEntry);
            }
        }
    }
    console.log(`[verifyImport] ${versionId}: 检查${libChecked}个库, 核心缺失${coreLibMissing}个, 非核心缺失${nonCoreLibMissing}个`);

    if (coreLibMissing > 0) {
        if (progress) progress('verify', `正在补全 ${coreLibMissing} 个核心缺失库文件...`, 91, [], '');
        const dlResult = await dependencies.downloadMissingDependencies(coreMissingLibFiles, (p) => {
            if (progress && p.progress !== undefined) {
                const pct = 91 + Math.round((p.progress / 100) * 6);
                progress('verify', `补全核心依赖 (${(p.completed || 0) + (p.failed || 0)}/${coreLibMissing})`, Math.min(pct, 97), [], '');
            }
        }, mergedJson);
        console.log(`[verifyImport] 核心库补全结果: ${dlResult.completed}成功 ${dlResult.failed}失败`);
        if (dlResult.failed > 0) {
            return { ok: false, checked: libChecked, missing: dlResult.failed };
        }
    }

    if (nonCoreLibMissing > 0) {
        if (progress) progress('verify', `正在补全 ${nonCoreLibMissing} 个非核心缺失库文件...`, 91, [], '');
        const dlResult = await dependencies.downloadMissingDependencies(nonCoreMissingLibFiles, (p) => {
            if (progress && p.progress !== undefined) {
                const pct = 91 + Math.round((p.progress / 100) * 6);
                progress('verify', `补全非核心依赖 (${(p.completed || 0) + (p.failed || 0)}/${nonCoreLibMissing})`, Math.min(pct, 97), [], '');
            }
        }, mergedJson);
        console.log(`[verifyImport] 非核心库补全结果: ${dlResult.completed}成功 ${dlResult.failed}失败`);
        if (dlResult.failed > 0) {
            if (progress) progress('verify', `警告: ${dlResult.failed} 个非核心库补全失败，将继续导入`, 93, [], '');
            return { ok: true, checked: libChecked, missing: dlResult.failed, warning: `${dlResult.failed} 个非核心库文件缺失（如 org.apache、com.google 等），导入将继续但可能影响部分功能` };
        }
    }

    if (progress) progress('verify', '完整性检查通过', 93, [], '');
    return { ok: true, checked: libChecked, missing: 0 };
}

async function runForgeInstallerJar(installerJarPath, mcDir, onProgress = null, useNative = false) {
    const report = onProgress || (() => {});
    const isPackaged = SERVER_DIR.includes('app.asar');
    const resourcesBase = isPackaged
        ? path.join(SERVER_DIR.replace('app.asar', 'app.asar.unpacked'), 'resources')
        : path.join(SERVER_DIR, 'resources');
    const bundledJava = path.join(resourcesBase, 'jdk-8u432+62-jre', 'bin', 'java.exe');
    let javaPath = null;
    if (fs.existsSync(bundledJava)) {
        javaPath = bundledJava;
    } else {
        const bundledJdk = [...java.detectBundledJava(), ...java.detectSystemJava()];
        const suitable = bundledJdk.find(j => j.majorVersion >= 8);
        if (suitable) javaPath = suitable.path;
    }
    if (!javaPath) {
        throw new Error('未找到 Java 8 或更高版本，无法安装 Forge。请先在设置中安装或配置 Java。');
    }
    console.log(`[Forge] 使用 Java: ${javaPath}`);
    console.log(`[Forge] Forge installer: ${installerJarPath}`);
    console.log(`[Forge] Minecraft 目录: ${mcDir}`);
    console.log(`[Forge] 原生模式: ${useNative}`);

    let javaMajor = 8;
    try {
        const verOut = execSync(`"${javaPath}" -version 2>&1`, { encoding: 'utf8', timeout: 5000 });
        const m = verOut.match(/version "(\d+)/);
        if (m) javaMajor = parseInt(m[1]);
    } catch (_) {}

    let args;
    if (useNative) {
        args = `-jar "${installerJarPath}" --installClient "${mcDir}"`;
        if (javaMajor >= 9) {
            args = '--add-exports cpw.mods.bootstraplauncher/cpw.mods.bootstraplauncher=ALL-UNNAMED ' + args;
        }
    } else {
        const bundledInstaller = path.join(resourcesBase, 'forge-installer.jar');
        if (!fs.existsSync(bundledInstaller)) {
            throw new Error('forge-installer.jar 不存在: ' + bundledInstaller);
        }
        args = `-cp "${bundledInstaller};${installerJarPath}" com.bangbang93.ForgeInstaller "${mcDir}"`;
        if (javaMajor >= 9) {
            args = '--add-exports cpw.mods.bootstraplauncher/cpw.mods.bootstraplauncher=ALL-UNNAMED ' + args;
        }
    }

    return new Promise((resolve, reject) => {
        const cmd = `"${javaPath}" ${args}`;
        console.log(`[ForgeInstaller] 执行命令: ${cmd.slice(0, 200)}...`);

        exec(cmd, { timeout: 600000, maxBuffer: 1024 * 1024 * 10, windowsHide: true }, (error, stdout, stderr) => {
            console.log(`[ForgeInstaller] 进程完成`);
            if (stdout) console.log(`[ForgeInstaller] stdout (最后500字): ${stdout.slice(-500)}`);
            if (stderr) console.log(`[ForgeInstaller] stderr (最后500字): ${stderr.slice(-500)}`);

            const allOutput = (stdout || '') + (stderr || '');
            const outputLines = allOutput.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            if (allOutput.includes('Extracting json')) report('提取 JSON 配置...', 10);
            if (allOutput.includes('Downloading libraries')) report('下载依赖库...', 20);
            if (allOutput.includes('Building Processors')) report('构建处理器...', 30);
            if (allOutput.includes('Remapping final jar')) report('重映射 JAR...', 70);
            if (allOutput.includes('Injecting profile')) report('写入版本配置...', 90);

            if (error && error.killed) {
                resolve({ success: false, error: 'Forge 安装器执行超时（10分钟）' });
            } else if (!error || (error.code === 0)) {
                const hasTrue = outputLines.slice(-5).some(l => l === 'true');
                if (!useNative && !hasTrue) {
                    console.warn(`[ForgeInstaller] ⚠ 进程退出码0但输出中无 "true"，安装可能不完整`);
                    console.warn(`[ForgeInstaller] 最后5行: ${outputLines.slice(-5).join(' | ')}`);
                    resolve({ success: false, error: `安装器未输出true，最后输出: ${outputLines.slice(-3).join(' | ')}` });
                } else {
                    report('Forge 安装器完成，正在补全文件...', 80);
                    resolve({ success: true });
                }
            } else {
                resolve({ success: false, error: `Forge 安装器退出码 ${error.code}: ${(stderr || stdout || '').slice(-300)}` });
            }
        });
    });
}



/*
 * [CRITICAL FUNCTION - READ BEFORE MODIFYING]
 * ============================================
 * installForge — 安装 Forge 模组加载器
 *
 * 【参数说明】
 *   gameVersion     - MC 版本号，如 "26.2", "1.20.1"
 *   forgeVersion    - Forge 版本号，如 "65.0.0", "47.3.0"
 *   onProgress      - 进度回调 (percent, message)
 *   mirrorBaseUrl   - 镜像源 URL，null 则用 BMCLAPI
 *   targetVersionId - 【关键参数】目标版本目录名，如 "26.2-Forge-65.0.0"
 *                     如果不传，默认用小写 "26.2-forge-65.0.0"
 *
 * 【为什么需要 targetVersionId？】
 *   下载页面创建版本目录时用大写 Forge（如 "26.2-Forge-65.0.0"），但本函数内部
 *   默认用小写 forge（如 "26.2-forge-65.0.0"）。在 Windows NTFS 上：
 *   - 目录名大小写不敏感 → 两个路径指向同一目录
 *   - 但文件名中的大小写差异会导致 JSON/JAR 文件名不同
 *   - performInstallation 先写入原版 JSON（mainClass=net.minecraft.client.main.Main）
 *   - forge-installer.js 写入 Forge JSON（mainClass=net.minecraftforge.bootstrap.ForgeBootstrap）
 *   - 由于文件名大小写不同，写入时序混乱，最终文件内容可能是原版的
 *   - 结果：用户启动 Forge 版本却看到原版 MC
 *
 *   修复方案：由调用方传入 targetVersionId，确保 installForge 写入的文件路径
 *   与 performInstallation 创建的版本目录完全一致。
 *
 * 【调用方式】
 *   1. performInstallation（下载页面）：必须传 targetVersionId = versionId
 *      → 例：installForge("26.2", "65.0.0", progress, null, "26.2-Forge-65.0.0")
 *   2. 修复/重装场景：可以不传 targetVersionId，用默认小写格式
 *      → 例：installForge("26.2", "65.0.0", progress)
 *
 * [AI-AUTOGEN-WARNING]
 *   - 不要删除 targetVersionId 参数
 *   - 不要把 performInstallation 中的 installForge 调用改为不传 targetVersionId
 *   - 不要修改 versionId 的默认值格式（小写 forge）
 *   - 修改前请理解 Windows NTFS 大小写不敏感的文件系统特性
 */
async function installForge(gameVersion, forgeVersion, onProgress = null, mirrorBaseUrl = null, targetVersionId = null) {
    if (forgeVersion && forgeVersion.startsWith(gameVersion + '-')) {
        forgeVersion = forgeVersion.slice(gameVersion.length + 1);
    }

    /*
    [CRITICAL] mcMajor 计算 —— 必须取 split('.')[0]
    ================================================
    【问题原理】
      gameVersion 的格式是 "主版本.次版本"，如 "26.2"（MC 1.26.2 的简写）。
      split('.') 得到数组 ["26", "2"]，其中 [0]="26" 是主版本号，[1]="2" 是次版本号。

      代码需要判断 MC 版本是否 >= 20（即 1.20+），以决定是否需要路由到 NeoForge 安装器。
      如果取 [1]，"26.2" 得到 mcMajor=2，2 >= 20 为 false，NeoForge 路由永远不会触发。
      如果取 [0]，"26.2" 得到 mcMajor=26，26 >= 20 为 true，NeoForge 路由正常工作。

    【历史Bug】
      原代码用的是 parseInt(gameVersion.split('.')[1])，导致：
      - MC 26.2 的 Forge 65.0.02/65.0.03 安装器被当作旧版 Forge 处理
      - installForge 调用 forge-installer.js，该脚本无法解析 NeoForge 格式的安装器
      - 安装后版本 JSON 全是原版内容：mainClass 是 net.minecraft.client.main.Main（应为 NeoForge 的），
        没有任何 Forge/NeoForge 库文件，没有 install_profile.json
      - 用户启动后看到的是原版 Minecraft，不是 Forge 版本

    【修复】
      改为 parseInt(gameVersion.split('.')[0])，对 "26.2" 得到 26。

    [AI-AUTOGEN-WARNING] 请勿将 [0] 改为 [1] 或其他索引。如果需要修改 mcMajor 的计算方式，
    请确保对 "26.2" 得到 >= 20 的值，对 "1.20.1" 得到 >= 20 的值。
    */
    const mcMajor = parseInt(gameVersion.split('.')[0]);
    // [CRITICAL - 2026-06-20] 不要把 Forge 版本路由到 installNeoForge！
    // Forge 和 NeoForge 的版本号体系完全不同（Forge: 64.0.10, NeoForge: 26.2.0），
    // 错误路由会导致 NeoForge 安装器 URL 不存在，下载失败。
    // 只有当 forgeVersion 字符串明确包含 "neoforge" 或 "neoforged" 时才路由到 NeoForge。
    // Forge Maven 上确实存在 MC 26+ 的版本（如 26.1.2-64.0.10），必须走 Forge 安装路径。
    if (mcMajor >= 20 && forgeVersion.split('.').length >= 3) {
        const isNeoForgeInstall = forgeVersion.includes('neoforge') || forgeVersion.includes('neoforged');
        if (isNeoForgeInstall) {
            return await installNeoForge(gameVersion, forgeVersion, onProgress);
        }
    }

    // [CRITICAL - 2026-06-21] targetVersionId 防止大小写不一致导致 Forge 启动为原版
    // 详见函数顶部注释。不要删除 targetVersionId，不要修改默认值格式。
    const versionId = targetVersionId || `${gameVersion}-forge-${forgeVersion}`;
    const versionStr = `${gameVersion}-${forgeVersion}`;

    const baseResult = await ensureBaseVersionInstalled(gameVersion);
    if (baseResult.error) {
        return { success: false, error: baseResult.error };
    }

    const forgeMavenBase = mirrorBaseUrl || 'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge';
    const forgeMavenOfficial = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
    const installerPath = path.join(ctx.dirs.DATA_DIR, 'temp', `forge-installer-${versionStr}.jar`);
    fs.mkdirSync(path.dirname(installerPath), { recursive: true });

    if (onProgress) onProgress(0, 'Downloading Forge installer...');

    const installerUrls = [
        `${forgeMavenBase}/${versionStr}/forge-${versionStr}-installer.jar`,
        `${forgeMavenOfficial}/${versionStr}/forge-${versionStr}-installer.jar`
    ];
    let installerOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
        const dlUrl = installerUrls[attempt % installerUrls.length];
        try {
            await http.downloadFileWithMirror(dlUrl, installerPath, null, 3, null, 60000);
            const dlStat = fs.statSync(installerPath);
            if (dlStat.size < 64 * 1024) {
                try { fs.unlinkSync(installerPath); } catch (_) {}
                continue;
            }
            const fd = fs.openSync(installerPath, 'r');
            const buf = Buffer.alloc(4);
            fs.readSync(fd, buf, 0, 4, 0);
            fs.closeSync(fd);
            if (buf[0] !== 0x50 || buf[1] !== 0x4B || buf[2] !== 0x03 || buf[3] !== 0x04) {
                try { fs.unlinkSync(installerPath); } catch (_) {}
                continue;
            }
            installerOk = true;
            break;
        } catch (e) {
            try { fs.unlinkSync(installerPath); } catch (_) {}
        }
    }
    if (!installerOk) {
        return { success: false, error: 'Forge installer download/verify failed' };
    }

    if (onProgress) onProgress(0.1, 'Extracting Forge installer...');

    const versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
    fs.mkdirSync(versionDir, { recursive: true });

    const AdmZip = require('adm-zip');
    const zip = new AdmZip(installerPath);
    const entries = zip.getEntries().map(e => e.entryName);

    let ip = null;
    const profileEntry = zip.getEntry('install_profile.json');
    if (profileEntry) {
        ip = JSON.parse(profileEntry.getData().toString('utf8'));
    }
    if (!ip) {
        return { success: false, error: 'install_profile.json not found in installer' };
    }

    let vj = null;
    const vjEntry = zip.getEntry('version.json');
    if (vjEntry) {
        vj = JSON.parse(vjEntry.getData().toString('utf8'));
    } else if (ip.json) {
        if (typeof ip.json === 'object') vj = ip.json;
        else if (typeof ip.json === 'string') {
            const entry = zip.getEntry(ip.json.replace(/^\//, ''));
            if (entry) vj = JSON.parse(entry.getData().toString('utf8'));
        }
    }
    if (!vj) {
        return { success: false, error: 'version.json not found in installer' };
    }

    const mavenEntries = entries.filter(e => e.startsWith('maven/'));
    let extractedCount = 0;
    for (const entry of mavenEntries) {
        const relativePath = entry.replace('maven/', '');
        const destPath = path.join(ctx.dirs.LIBRARIES_DIR, relativePath);
        const dir = path.dirname(destPath);
        utils.ensureDir(destPath);
        if (fs.existsSync(destPath)) {
            const stat = fs.statSync(destPath);
            if (stat.isDirectory()) {
                try { fs.rmSync(destPath, { recursive: true, force: true }); } catch (_) {}
            }
        }
        if (!fs.existsSync(destPath)) {
            try {
                const entryObj = zip.getEntry(entry);
                fs.writeFileSync(destPath, entryObj.getData());
                extractedCount++;
            } catch (_) {}
        }
    }
    console.log(`[Forge] Extracted ${extractedCount} maven entries`);

    if (!ip.data) ip.data = {};
    ip.data.BINPATCH = ip.data.BINPATCH || { client: '', server: '' };

    const forgeVersionPath = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'minecraftforge', 'forge', versionStr);
    utils.ensureDir(path.join(forgeVersionPath, 'dummy'));

    if (zip.getEntry('data/client.lzma')) {
        const clientLzmaPath = path.join(forgeVersionPath, `forge-${versionStr}-clientdata.lzma`);
        const entryObj = zip.getEntry('data/client.lzma');
        fs.writeFileSync(clientLzmaPath, entryObj.getData());
        ip.data.BINPATCH.client = `[net.minecraftforge:forge:${versionStr}:clientdata@lzma]`;
    }
    if (zip.getEntry('data/server.lzma')) {
        const serverLzmaPath = path.join(forgeVersionPath, `forge-${versionStr}-serverdata.lzma`);
        const entryObj = zip.getEntry('data/server.lzma');
        fs.writeFileSync(serverLzmaPath, entryObj.getData());
        ip.data.BINPATCH.server = `[net.minecraftforge:forge:${versionStr}:serverdata@lzma]`;
    }
    ip.data.INSTALLER = {
        client: `[net.minecraftforge:forge:${versionStr}:installer]`,
        server: `[net.minecraftforge:forge:${versionStr}:installer]`
    };

    if (onProgress) onProgress(0.2, 'Preparing processors...');

    const processors = (ip.processors || [])
        .filter(proc => !proc.sides || proc.sides.indexOf('client') !== -1);

    const processorsInfo = [];
    for (const proc of processors) {
        let mainClass = '';
        const procJarParts = proc.jar ? proc.jar.split(':') : [];
        if (procJarParts.length >= 3) {
            const groupPath = procJarParts[0].replace(/\./g, '/');
            const classifier = procJarParts[3] || '';
            const jarName = classifier
                ? `${procJarParts[1]}-${procJarParts[2]}-${classifier}.jar`
                : `${procJarParts[1]}-${procJarParts[2]}.jar`;
            const jarPath = path.join(ctx.dirs.LIBRARIES_DIR, groupPath, procJarParts[1], procJarParts[2], jarName);
            if (fs.existsSync(jarPath)) {
                try {
                    const jarZip = new AdmZip(jarPath);
                    const manifestEntry = jarZip.getEntry('META-INF/MANIFEST.MF');
                    if (manifestEntry) {
                        const manifest = manifestEntry.getData().toString('utf8');
                        for (const line of manifest.split(/\r?\n/)) {
                            const trimmed = line.trim();
                            if (trimmed.startsWith('Main-Class:')) {
                                mainClass = trimmed.substring('Main-Class:'.length).trim();
                                break;
                            }
                        }
                    }
                } catch (_) {}
            }
        }

        const classpath = (proc.classpath || []).filter(Boolean);
        const resolvedArgs = (proc.args || []).map(a => a);
        const outputs = proc.outputs || {};

        processorsInfo.push({
            jar: proc.jar,
            mainClass,
            classpath,
            args: resolvedArgs,
            outputs,
        });
    }

    const configData = { installProfile: ip, versionJson: vj, processors: processorsInfo };
    const configPath = path.join(ctx.dirs.DATA_DIR, 'temp', `forge-config-${versionStr}.json`);
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));

    if (onProgress) onProgress(0.3, 'Running Forge processors...');

    const installerScriptSrc = path.join(SERVER_DIR, 'forge-installer.js');
    const installerScriptDst = path.join(ctx.dirs.DATA_DIR, 'temp', `forge-installer-${versionId}.js`);
    try {
        fs.mkdirSync(path.dirname(installerScriptDst), { recursive: true });
        if (fs.existsSync(installerScriptDst)) { try { fs.unlinkSync(installerScriptDst); } catch(_) {} }
        const _srcContent = fs.readFileSync(installerScriptSrc, 'utf8');
        fs.writeFileSync(installerScriptDst, _srcContent, 'utf8');
    } catch(_) {}

    let nodeExe = 'node';
    let nodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '' };
    if (SERVER_DIR.includes('app.asar') && process.platform === 'win32') {
        const possibleNode = path.join(path.dirname(process.execPath), 'node.exe');
        if (fs.existsSync(possibleNode)) {
            nodeExe = possibleNode;
        } else {
            // 用户机器上没有安装 Node.js 时，使用 Electron 自身作为 Node.js 运行时。
            // process.execPath 是 Electron 可执行文件，设置 ELECTRON_RUN_AS_NODE=1
            // 后它会以 Node.js 模式运行，功能等同于独立的 node 命令。
            nodeExe = process.execPath;
            nodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
        }
    }
    const args = [installerScriptDst,
        '--root', ctx.dirs.DATA_DIR,
        '--libs', ctx.dirs.LIBRARIES_DIR,
        '--verdir', versionDir,
        '--forgever', versionStr,
        '--gamever', gameVersion,
        '--config', configPath,
        '--appdir', path.resolve(SERVER_DIR)
    ];

    return new Promise((resolve) => {
        const proc = spawn(nodeExe, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: nodeEnv
        });
        let stdout = '', stderr = '', doneMsg = null;
        const parse = (line) => {
            if (!line || !line.startsWith('{')) return;
            try {
                const msg = JSON.parse(line);
                if (msg.type === 'progress' && onProgress) onProgress(msg.percent, msg.message);
                if (msg.type === 'done') {
                    doneMsg = msg;
                    if (msg.success) {
                        versions._invalidateResolvedJsonCache(versionId);
                    }
                }
            } catch (_) {}
        };
        proc.stdout.on('data', (data) => {
            stdout += data.toString();
            const lines = stdout.split('\n');
            stdout = lines.pop();
            for (const line of lines) parse(line.trim());
        });
        proc.stderr.on('data', (data) => {
            stderr += data.toString();
            const lines = stderr.split('\n');
            stderr = lines.pop();
            for (const line of lines) parse(line.trim());
        });
        proc.on('close', async (code) => {
            if (stdout.trim()) parse(stdout.trim());
            if (stderr.trim()) parse(stderr.trim());
            if (!doneMsg) {
                if (code === 0) {
                    versions._invalidateResolvedJsonCache(versionId);
                    doneMsg = { success: true, versionId };
                } else {
                    const errMsg = stderr.trim() || stdout.trim() || `Exit code ${code}`;
                    try { if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true }); } catch (_) {}
                    try { if (fs.existsSync(installerPath)) fs.unlinkSync(installerPath); } catch (_) {}
                    try { if (fs.existsSync(configPath)) fs.unlinkSync(configPath); } catch (_) {}
                    try { if (fs.existsSync(installerScriptDst)) fs.unlinkSync(installerScriptDst); } catch (_) {}
                    resolve({ success: false, error: `forge-installer.js exited with code ${code}: ${errMsg.slice(-300)}` });
                    return;
                }
            }
            if (doneMsg && doneMsg.success) {
                try {
                    const vJsonPath = path.join(versionDir, `${versionId}.json`);
                    if (fs.existsSync(vJsonPath)) {
                        const vJson = JSON.parse(fs.readFileSync(vJsonPath, 'utf8'));

                        if (vJson.inheritsFrom) {
                            const vanillaId = vJson.inheritsFrom;
                            const vanillaPath = path.join(path.dirname(versionDir), vanillaId, `${vanillaId}.json`);
                            if (fs.existsSync(vanillaPath)) {
                                const vanillaJson = JSON.parse(fs.readFileSync(vanillaPath, 'utf8'));
                                const seen = new Set((vJson.libraries || []).map(l => l.name).filter(Boolean));
                                for (const vl of (vanillaJson.libraries || [])) {
                                    if (vl.name && !seen.has(vl.name)) {
                                        vJson.libraries = vJson.libraries || [];
                                        vJson.libraries.push(vl);
                                        seen.add(vl.name);
                                    }
                                }
                                if (!vJson.arguments && vanillaJson.arguments) vJson.arguments = vanillaJson.arguments;
                            }
                            delete vJson.inheritsFrom;
                            fs.writeFileSync(vJsonPath, JSON.stringify(vJson, null, 2));
                        }

                        const libs = vJson.libraries || [];
                        const missing = [];
                        for (const lib of libs) {
                            const dl = lib.downloads && lib.downloads.artifact;
                            if (dl && dl.path) {
                                const lp = path.join(ctx.dirs.LIBRARIES_DIR, dl.path);
                                if (!fs.existsSync(lp) || (dl.sha1 && !isLibValid(lp, dl.size, dl.sha1))) {
                                    missing.push(lib);
                                }
                            } else if (lib.name && !(lib.downloads && lib.downloads.artifact)) {
                                const parts = lib.name.split(':');
                                if (parts.length >= 3) {
                                    const gPath = parts[0].replace(/\./g, '/');
                                    const atIdx = parts[2].indexOf('@');
                                    const ext = atIdx >= 0 ? parts[2].substring(atIdx + 1) : 'jar';
                                    const ver = atIdx >= 0 ? parts[2].substring(0, atIdx) : parts[2];
                                    let classifier = '';
                                    let extOverride = '';
                                    if (parts[3]) {
                                        const atIdx3 = parts[3].indexOf('@');
                                        if (atIdx3 >= 0) { classifier = parts[3].substring(0, atIdx3); extOverride = parts[3].substring(atIdx3 + 1); }
                                        else classifier = parts[3];
                                    }
                                    const finalExt = extOverride || ext;
                                    const fName = classifier ? `${parts[1]}-${ver}-${classifier}.${finalExt}` : `${parts[1]}-${ver}.${finalExt}`;
                                    const rPath = `${gPath}/${parts[1]}/${ver}/${fName}`;
                                    const lp = path.join(ctx.dirs.LIBRARIES_DIR, rPath);
                                    if (!fs.existsSync(lp)) {
                                        missing.push({ ...lib, _mavenPath: rPath, _mavenName: lib.name, _url: lib.url || null });
                                    }
                                }
                            }
                        }
                        if (missing.length > 0 && onProgress) onProgress(0.95, `下载 Forge 库文件 (0/${missing.length})...`);
                        if (missing.length > 0) {
                            const FORGE_LIB_PARALLEL = 32;
                            let completed = 0;
                            let failed = 0;
                            let active = 0;
                            let done = null;

                            const scheduleNext = () => {
                                while (active < FORGE_LIB_PARALLEL && completed + failed + active < missing.length) {
                                    const lib = missing[completed + failed + active];
                                    active++;
                                    (async () => {
                                        if (lib._mavenPath) {
                                            const lp = path.join(ctx.dirs.LIBRARIES_DIR, lib._mavenPath);
                                            utils.ensureDir(path.join(lp, 'dummy'));
                                            const urls = [];
                                            if (lib._url) urls.push(lib._url.replace(/\/$/, '') + '/' + lib._mavenPath.split('/').pop());
                                            urls.push(
                                                `https://maven.minecraftforge.net/${lib._mavenPath}`,
                                                `https://libraries.minecraft.net/${lib._mavenPath}`,
                                                `https://bmclapi2.bangbang93.com/maven/${lib._mavenPath}`,
                                            );
                                            let ok = false;
                                            for (const u of urls) {
                                                try {
                                                    await http.downloadFileWithMirror(u, lp, null, 1, null, 60000);
                                                    ok = true;
                                                    break;
                                                } catch (dlErr) {
                                                    console.warn(`[installForge] 下载 ${lib.name} 从 ${u} 失败: ${dlErr.message}`);
                                                }
                                            }
                                            if (!ok) throw new Error('所有下载源均失败');
                                        } else {
                                            const dl = lib.downloads.artifact;
                                            const lp = path.join(ctx.dirs.LIBRARIES_DIR, dl.path);
                                            utils.ensureDir(path.join(lp, 'dummy'));
                                            await http.downloadFileWithMirror(dl.url, lp, null, 2, null, 60000);
                                        }
                                    })().then(() => {
                                        completed++;
                                    }).catch((e) => {
                                        console.warn(`[installForge] 下载库 ${lib.name} 失败: ${e.message}`);
                                        failed++;
                                    }).finally(() => {
                                        active--;
                                        if (onProgress) onProgress(0.95 + Math.min((completed + failed) / missing.length, 1) * 0.05, `下载 Forge 库文件 (${completed + failed}/${missing.length})...`);
                                        if (active === 0 && completed + failed >= missing.length && done) done();
                                        else if (active < FORGE_LIB_PARALLEL && completed + failed + active < missing.length) scheduleNext();
                                    });
                                }
                            };
                            await new Promise(resolve => { done = resolve; scheduleNext(); });
                        }
                    }
                } catch (e) {
                    console.warn(`[installForge] 下载库失败: ${e.message}`);
                }
            }
            resolve(doneMsg || { success: code === 0, versionId });
        });
        proc.on('error', (err) => {
            try { if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true }); } catch (_) {}
            try { if (fs.existsSync(installerPath)) fs.unlinkSync(installerPath); } catch (_) {}
            try { if (fs.existsSync(configPath)) fs.unlinkSync(configPath); } catch (_) {}
            try { if (fs.existsSync(installerScriptDst)) fs.unlinkSync(installerScriptDst); } catch (_) {}
            resolve({ success: false, error: `Failed to start forge-installer.js: ${err.message}` });
        });
    });
}

function isLibValid(libPath, expectedSize, expectedSha1) {
    if (!fs.existsSync(libPath)) return false;
    try {
        const stat = fs.statSync(libPath);
        if (stat.size === 0) return false;
        if (expectedSize > 0 && stat.size !== expectedSize) return false;
        if (expectedSha1 && typeof expectedSha1 === 'string' && expectedSha1.length === 40) {
            const crypto = require('crypto');
            const content = fs.readFileSync(libPath);
            const hash = crypto.createHash('sha1').update(content).digest('hex');
            return hash === expectedSha1;
        }
        return stat.size > 1024;
    } catch (e) {
        return false;
    }
}

function getNeoLibMirrorUrl(originalUrl) {
    if (!originalUrl) return originalUrl;
    return originalUrl
        .replace('https://maven.neoforged.net/releases/', 'https://bmclapi2.bangbang93.com/maven/')
        .replace('https://maven.neoforged.net/', 'https://bmclapi2.bangbang93.com/maven/')
        .replace('https://maven.minecraftforge.net/', 'https://bmclapi2.bangbang93.com/maven/')
        .replace('https://libraries.minecraft.net/', 'https://bmclapi2.bangbang93.com/libraries/');
}

async function installNeoForge(gameVersion, neoVersion, onProgress = null) {
    const isLegacy = neoVersion.startsWith('1.20.1-');
    const packageName = isLegacy ? 'forge' : 'neoforge';
    const versionId = `${gameVersion}-NeoForge-${neoVersion}`;

    try {
        // 1. 确保原版已安装
        const baseResult = await ensureBaseVersionInstalled(gameVersion);
        if (baseResult.error) {
            return { success: false, error: baseResult.error };
        }

        const versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
        fs.mkdirSync(versionDir, { recursive: true });

        // 2. 下载安装器 JAR
        const installerPath = path.join(ctx.dirs.DATA_DIR, 'temp', `neoforge-installer-${neoVersion}.jar`);
        fs.mkdirSync(path.dirname(installerPath), { recursive: true });

        if (onProgress) onProgress(0, '正在下载NeoForge安装包...');

        const neoforgeMavenOfficial = 'https://maven.neoforged.net/releases/net/neoforged';
        const installerUrls = [
            `https://bmclapi2.bangbang93.com/maven/net/neoforged/${packageName}/${neoVersion}/${packageName}-${neoVersion}-installer.jar`,
            `${neoforgeMavenOfficial}/${packageName}/${neoVersion}/${packageName}-${neoVersion}-installer.jar`
        ];
        console.log(`[NeoForge] Downloading installer: ${installerUrls[0]}`);

        let installerOk = false;
        for (let attempt = 0; attempt < 3; attempt++) {
            const dlUrl = installerUrls[attempt % installerUrls.length];
            try {
                await http.downloadFileWithMirror(dlUrl, installerPath);
                const dlStat = fs.statSync(installerPath);
                if (dlStat.size < 64 * 1024) {
                    console.error(`[NeoForge] Installer too small (${dlStat.size} bytes), retrying...`);
                    try { fs.unlinkSync(installerPath); } catch (_) {}
                    continue;
                }
                const fd = fs.openSync(installerPath, 'r');
                const buf = Buffer.alloc(4);
                fs.readSync(fd, buf, 0, 4, 0);
                fs.closeSync(fd);
                if (buf[0] !== 0x50 || buf[1] !== 0x4B || buf[2] !== 0x03 || buf[3] !== 0x04) {
                    console.error(`[NeoForge] Installer ZIP magic invalid, retrying...`);
                    try { fs.unlinkSync(installerPath); } catch (_) {}
                    continue;
                }
                installerOk = true;
                break;
            } catch (e) {
                console.error(`[NeoForge] Installer download failed: ${e.message}`);
                try { fs.unlinkSync(installerPath); } catch (_) {}
            }
        }
        if (!installerOk) {
            throw new Error('NeoForge安装器下载失败，请检查网络');
        }

        if (onProgress) onProgress(0.1, '正在解包 NeoForge 安装器...');

        // 3. 直接从 JAR 中解压版本信息（像 XMCL 一样，不跑 Java 安装器）
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(installerPath);

        // 提取 install_profile.json
        let installProfile = null;
        try {
            const profileEntry = zip.getEntry('install_profile.json');
            if (profileEntry) installProfile = JSON.parse(profileEntry.getData().toString('utf8'));
        } catch (e) {
            console.warn(`[NeoForge] 读取 install_profile.json 失败: ${e.message}`);
        }

        // 提取 version.json（安装器自带的目标版本配置）
        let versionJsonData = null;
        try {
            const versionEntry = zip.getEntry('version.json');
            if (versionEntry) {
                versionJsonData = JSON.parse(versionEntry.getData().toString('utf8'));
                console.log(`[NeoForge] 从 installer 中读取 version.json, mainClass=${versionJsonData.mainClass}`);
            }
        } catch (e) {}

        // 如果 version.json 不在根目录，尝试从 installProfile.json 里找
        if (!versionJsonData && installProfile) {
            if (typeof installProfile.json === 'object' && installProfile.json !== null) {
                versionJsonData = installProfile.json;
            } else if (typeof installProfile.json === 'string' && installProfile.json) {
                const jsonFileName = installProfile.json.replace(/^\//, '');
                const jsonEntry = zip.getEntry(jsonFileName);
                if (jsonEntry) {
                    try { versionJsonData = JSON.parse(jsonEntry.getData().toString('utf8')); } catch (e) {}
                }
            }
        }

        if (!versionJsonData) {
            throw new Error('NeoForge安装器中未找到 version.json，安装器可能已损坏');
        }

        // 4. 提取 client.lzma 作为 BINPATCH 数据（处理器需要用它来打补丁）
        const isLegacyPkg = neoVersion.startsWith('1.20.1-');
        const pkg = isLegacyPkg ? 'forge' : 'neoforge';
        const binpatchDir = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'neoforged', pkg, neoVersion);
        const binpatchPath = path.join(binpatchDir, `${pkg}-${neoVersion}-clientdata.lzma`);
        let clientLzmaExtracted = false;
        try {
            const clientLzma = zip.getEntry('data/client.lzma');
            if (clientLzma) {
                if (!fs.existsSync(binpatchPath)) {
                    fs.mkdirSync(binpatchDir, { recursive: true });
                    fs.writeFileSync(binpatchPath, clientLzma.getData());
                    console.log(`[NeoForge] 提取 client.lzma → ${binpatchPath}`);
                    clientLzmaExtracted = true;
                } else {
                    console.log(`[NeoForge] client.lzma 已存在: ${binpatchPath}`);
                    clientLzmaExtracted = true;
                }
            } else {
                console.warn(`[NeoForge] 安装器中未找到 data/client.lzma`);
            }
        } catch (e) {
            console.warn(`[NeoForge] 提取 client.lzma 失败（非致命）: ${e.message}`);
        }

        // 5. Save install_profile.json with correct data paths for processors
        if (installProfile) {
            const installerLibDir = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'neoforged', pkg, neoVersion);
            const installerLibPath = path.join(installerLibDir, `${pkg}-${neoVersion}-installer.jar`);
            if (!fs.existsSync(installerLibPath) && fs.existsSync(installerPath)) {
                fs.mkdirSync(installerLibDir, { recursive: true });
                fs.copyFileSync(installerPath, installerLibPath);
                console.log(`[NeoForge] Copied installer -> ${installerLibPath}`);
            }

            if (!installProfile.data) installProfile.data = {};

            // BINPATCH: use actual file path so processors can find client.lzma directly
            const effectiveLzmaPath = clientLzmaExtracted ? binpatchPath
                : (fs.existsSync(binpatchPath) ? binpatchPath : null);
            if (effectiveLzmaPath) {
                installProfile.data.BINPATCH = {
                    client: effectiveLzmaPath,
                    server: effectiveLzmaPath
                };
                console.log(`[NeoForge] BINPATCH set to: ${effectiveLzmaPath}`);
            } else {
                console.warn(`[NeoForge] WARNING: client.lzma not found at ${binpatchPath}`);
            }

            // INSTALLER: use actual file path
            const effectiveInstallerPath = fs.existsSync(installerLibPath) ? installerLibPath
                : (fs.existsSync(installerPath) ? installerPath : null);
            if (effectiveInstallerPath) {
                installProfile.data.INSTALLER = {
                    client: effectiveInstallerPath,
                    server: effectiveInstallerPath
                };
            }

            // PATCHED: use actual output path
            const patchedMavenPath = `net/neoforged/minecraft-client-patched/${neoVersion}/minecraft-client-patched-${neoVersion}.jar`;
            const patchedFullPath = path.join(ctx.dirs.LIBRARIES_DIR, patchedMavenPath);
            installProfile.data.PATCHED = {
                client: patchedFullPath,
                server: patchedFullPath
            };

            try {
                fs.writeFileSync(path.join(versionDir, 'install_profile.json'), JSON.stringify(installProfile, null, 2));
                console.log(`[NeoForge] install_profile.json updated with correct paths`);
            } catch (_) {}
        }

        // 6. 预下载 MOJMAPS（Forge/NeoForge 的处理器依赖此文件）
        if (installProfile && installProfile.data && installProfile.data.MOJMAPS) {
            try {
                const mojmapsRaw = installProfile.data.MOJMAPS.client;
                const mojmapsRef = typeof mojmapsRaw === 'string' ? mojmapsRaw
                    : (Array.isArray(mojmapsRaw) ? mojmapsRaw[0] : (mojmapsRaw?.value || ''));
                const clean = mojmapsRef.replace(/[\[\]]/g, '');
                const parts = clean.split(':');
                if (parts.length >= 4) {
                    const groupId = parts[0];
                    const artifactId = parts[1];
                    const libVersion = parts[2];
                    const ext = parts.length > 4 ? parts[4] : (parts[3].includes('@') ? parts[3].split('@')[1] : 'txt');
                    const groupPath = groupId.replace(/\./g, '/');
                    const mappingsFileName = `${artifactId}-${libVersion}-mappings.${ext}`;
                    const mappingsDir = path.join(ctx.dirs.LIBRARIES_DIR, groupPath, artifactId, libVersion);
                    const mappingsPath = path.join(mappingsDir, mappingsFileName);

                    if (!fs.existsSync(mappingsPath)) {
                        console.log(`[NeoForge] 预下载 MOJMAPS: ${mappingsFileName}`);
                        if (onProgress) onProgress(0.15, '正在下载 MOJMAPS 映射文件...');
                        const mcVer = installProfile.version || gameVersion;
                        const manifestBody = await http.httpGet('https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json');
                        const manifest = JSON.parse(manifestBody);
                        const verEntry = manifest.versions.find(v => v.id === mcVer);
                        if (verEntry) {
                            const verJsonUrl = verEntry.url.replace('https://piston-meta.mojang.com/', 'https://bmclapi2.bangbang93.com/');
                            const mcVerJson = JSON.parse(await http.httpGet(verJsonUrl));
                            const cm = mcVerJson.downloads?.client_mappings;
                            if (cm) {
                                let cmUrl = cm.url.replace('https://piston-data.mojang.com/', 'https://bmclapi2.bangbang93.com/');
                                fs.mkdirSync(mappingsDir, { recursive: true });
                                await http.downloadFileWithMirror(cmUrl, mappingsPath);
                                console.log(`[NeoForge] MOJMAPS 下载完成: ${mappingsPath}`);
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn(`[NeoForge] MOJMAPS 预下载失败: ${e.message}`);
            }
        }

        // 7. 合并版本 JSON：version.json (来自 installer) + install_profile 中的额外 libraries
        const versionJsonPath = path.join(versionDir, `${versionId}.json`);

        if (installProfile) {
            const profileLibs = installProfile.libraries || [];
            const versionLibs = versionJsonData.libraries || [];
            const existingNames = new Set(versionLibs.map(l => l.name).filter(Boolean));
            for (const lib of profileLibs) {
                if (lib.name && !existingNames.has(lib.name)) {
                    versionLibs.push(lib);
                    existingNames.add(lib.name);
                }
            }
            versionJsonData.libraries = versionLibs;
            if (installProfile.mainClass && !versionJsonData.mainClass) {
                versionJsonData.mainClass = installProfile.mainClass;
            }
        }

        // 去掉自引用（installer 里的 net.neoforged:neoforge:xxx 是给 installer 自己用的，不需要出现在版本库里）
        const neoForgeMainPattern = new RegExp(`^net\\.neoforged:(neoforge|forge):${neoVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
        versionJsonData.libraries = (versionJsonData.libraries || []).filter(lib => {
            if (!lib.name) return true;
            return !neoForgeMainPattern.test(lib.name);
        });

        // 确保有必要的参数
        if (!versionJsonData.arguments) versionJsonData.arguments = {};
        if (!versionJsonData.arguments.game || versionJsonData.arguments.game.length === 0) {
            versionJsonData.arguments.game = ['--launchTarget', 'neoforgeclient', '--fml.neoForgeVersion', neoVersion, '--fml.mcVersion', gameVersion];
        }

        // [CRITICAL FIX - 2026-06-20] inheritsFrom 必须从 versionId 提取纯MC版本号（如 "26.2"），
        // 不能直接用 gameVersion 参数！因为 gameVersion 可能被前端传入 "26.2-forge-65.0.0" 这样的值，
        // 导致 inheritsFrom 指向错误的基础版本，NeoForge 启动时 AccessTransformerEngine 找不到方法。
        // 如果此段代码被修改导致 NeoForge 启动报 NoSuchMethodError，请优先检查 inheritsFrom 的值。
        const mcVerFromId = versionId.match(/^(\d+\.\d+(?:\.\d+)?)/);
        const cleanMcVer = mcVerFromId ? mcVerFromId[1] : gameVersion.split('.')[0] + '.' + (gameVersion.split('.')[1] || '0');
        const versionJson = {
            id: versionId,
            inheritsFrom: cleanMcVer,
            mainClass: versionJsonData.mainClass || 'cpw.mods.bootstraplauncher.BootstrapLauncher',
            type: 'release',
            libraries: [...versionJsonData.libraries],
            arguments: versionJsonData.arguments
        };

        // 8. 下载库文件
        if (onProgress) onProgress(0.3, '正在下载NeoForge库文件...');

        const neoLibsToDownload = [];
        for (const lib of (versionJson.libraries || [])) {
            const parts = lib.name ? lib.name.split(':') : [];
            let libPath = null;
            let expectedSha1 = null;

            if (lib.downloads?.artifact?.path) {
                libPath = path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path);
                expectedSha1 = lib.downloads.artifact.sha1 || null;
            } else if (lib.name && parts.length >= 3) {
                const groupPath = parts[0].replace(/\./g, path.sep);
                const lname = parts[1];
                const lver = parts[2];
                const classifier = parts.length >= 4 ? parts[3] : '';
                const jarName = classifier ? `${lname}-${lver}-${classifier}.jar` : `${lname}-${lver}.jar`;
                libPath = path.join(ctx.dirs.LIBRARIES_DIR, groupPath, lname, lver, jarName);
            }

            if (!libPath || isLibValid(libPath, -1, expectedSha1)) continue;

            if (lib.downloads?.artifact?.url) {
                const mirrorUrl = getNeoLibMirrorUrl(lib.downloads.artifact.url);
                neoLibsToDownload.push({ lib, url: mirrorUrl, fallbackUrl: lib.downloads.artifact.url, libPath, expectedSha1 });
            } else if (parts.length >= 3) {
                const mavenGroup = parts[0].replace(/\./g, '/');
                const lname = parts[1];
                const lver = parts[2];
                const classifier = parts.length >= 4 ? parts[3] : '';
                const jarName = classifier ? `${lname}-${lver}-${classifier}.jar` : `${lname}-${lver}.jar`;
                const isNeoLib = parts[0].includes('neoforged') || parts[0].includes('fancymodloader') || parts[0].includes('mixin');
                const officialUrl = lib.url || (isNeoLib ? 'https://maven.neoforged.net/releases/' : 'https://libraries.minecraft.net/');
                const dlUrl = `${officialUrl}${mavenGroup}/${lname}/${lver}/${jarName}`;
                const mirrorUrl = getNeoLibMirrorUrl(dlUrl);
                neoLibsToDownload.push({ lib, url: mirrorUrl, fallbackUrl: dlUrl, libPath, expectedSha1: null });
            }
        }

        let neoLibFailures = 0;
        if (neoLibsToDownload.length > 0) {
            const NEO_PARALLEL = 8;
            let completed = 0;
            let failed = 0;
            let active = 0;
            let done = null;

            const scheduleNext = () => {
                while (active < NEO_PARALLEL && completed + failed + active < neoLibsToDownload.length) {
                    const item = neoLibsToDownload[completed + failed + active];
                    active++;
                    (async () => {
                        let success = false;
                        for (let retry = 0; retry < 3; retry++) {
                            try {
                                if (isLibValid(item.libPath, -1, item.expectedSha1)) { success = true; break; }
                                if (fs.existsSync(item.libPath)) fs.unlinkSync(item.libPath);
                                const dlUrl = retry === 0 ? item.url : item.fallbackUrl;
                                await http.downloadFileWithMirror(dlUrl, item.libPath);
                                if (isLibValid(item.libPath, -1, item.expectedSha1)) { success = true; break; }
                                if (retry < 2) {
                                    try { fs.unlinkSync(item.libPath); } catch (_) {}
                                    await new Promise(r => setTimeout(r, 3000 + retry * 2000));
                                }
                            } catch (e) {
                                if (retry < 2) {
                                    await new Promise(r => setTimeout(r, 3000 + retry * 2000));
                                } else {
                                    console.log(`[NeoForge] Failed to download ${item.lib.name}: ${e.message}`);
                                }
                            }
                        }
                        if (!success) neoLibFailures++;
                    })().then(() => { completed++; }).catch(() => { failed++; }).finally(() => {
                        active--;
                        if (active === 0 && completed + failed >= neoLibsToDownload.length && done) done();
                        else if (active < NEO_PARALLEL && completed + failed + active < neoLibsToDownload.length) scheduleNext();
                    });
                }
            };
            await new Promise(resolve => { done = resolve; scheduleNext(); });
        }

        // 9. 写入版本 JSON
        fs.writeFileSync(versionJsonPath, JSON.stringify(versionJson, null, 2));
        versions._invalidateResolvedJsonCache(versionId);
        console.log(`[NeoForge] 版本JSON已生成: ${versionJsonPath}, libs=${(versionJson.libraries||[]).length}, dlFailed=${neoLibFailures}`);

        // 10. 补全库 + 运行处理器（merge 函数还会下载缺失的库和执行二进制补丁）
        if (onProgress) onProgress(0.7, '补全 NeoForge 库和参数...');
        if (!fs.existsSync(binpatchPath)) {
            console.warn(`[NeoForge] clientdata.lzma 缺失 (${binpatchPath}), 尝试重新提取...`);
            let reextracted = false;
            if (fs.existsSync(installerPath)) {
                try {
                    const retryZip = new AdmZip(installerPath);
                    const retryEntry = retryZip.getEntry('data/client.lzma');
                    if (retryEntry) {
                        fs.mkdirSync(binpatchDir, { recursive: true });
                        fs.writeFileSync(binpatchPath, retryEntry.getData());
                        console.log(`[NeoForge] 重新提取成功: ${binpatchPath} (${fs.statSync(binpatchPath).size} bytes)`);
                        reextracted = true;
                    } else {
                        console.warn(`[NeoForge] 安装器中无 data/client.lzma entry`);
                    }
                } catch (e) { console.warn(`[NeoForge] 重新提取失败: ${e.message}`); }
            } else {
                console.warn(`[NeoForge] 安装器 JAR 也不存在: ${installerPath}`);
            }
            if (!reextracted) {
                const errMsg = `NeoForge 安装失败: clientdata.lzma 提取失败，请检查网络后重试安装`;
                if (onProgress) onProgress(1, errMsg);
                return { success: false, error: errMsg };
            }
        }
        const installerLibPath2 = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'neoforged', pkg, neoVersion, `${pkg}-${neoVersion}-installer.jar`);
        if (!fs.existsSync(installerLibPath2) && fs.existsSync(installerPath)) {
            try {
                // [CRITICAL] ENOTDIR 修复 — 同 ensureDir，清理路径中的文件冲突。
                {
                    const _d = path.dirname(installerLibPath2);
                    for (const _p of _d.split(path.sep).map((_, _i, _a) => _a.slice(0, _i + 1).join(path.sep))) {
                        if (_p) { try { const _s = fs.statSync(_p); if (!_s.isDirectory()) fs.unlinkSync(_p); } catch (_) {} }
                    }
                }
                fs.mkdirSync(path.dirname(installerLibPath2), { recursive: true });
                fs.copyFileSync(installerPath, installerLibPath2);
                console.log(`[NeoForge] 复制 installer → ${installerLibPath2}`);
            } catch (_) {}
        }
        try { await mergeNeoForgeLoaderToVersion(versionId, gameVersion, neoVersion, onProgress); } catch (mergeErr) {
            console.warn(`[NeoForge] merge 补全失败: ${mergeErr.message}`);
        }

        const neoCoreJarRel = `net/neoforged/neoforge/${neoVersion}/neoforge-${neoVersion}-universal.jar`;
        const neoCoreJarPath = path.join(ctx.dirs.LIBRARIES_DIR, neoCoreJarRel);
        if (!fs.existsSync(neoCoreJarPath) || (await fs.promises.stat(neoCoreJarPath).catch(() => ({ size: 0 })).then(s => s.size)) < 1024) {
            console.warn(`[NeoForge] 核心jar缺失或无效，尝试补下载: ${neoCoreJarPath}`);
            if (onProgress) onProgress(0.85, '补下载NeoForge核心文件...');
            const neoCoreUrls = [
                `https://maven.neoforged.net/releases/${neoCoreJarRel}`,
                `https://bmclapi2.bangbang93.com/maven/${neoCoreJarRel}`
            ];
            let coreOk = false;
            for (const url of neoCoreUrls) {
                try {
                    fs.mkdirSync(path.dirname(neoCoreJarPath), { recursive: true });
                    await http.downloadFile(url, neoCoreJarPath);
                    if (fs.existsSync(neoCoreJarPath) && utils.isJarIntact(neoCoreJarPath)) {
                        console.log(`[NeoForge] 核心jar补下载成功: ${url}`);
                        coreOk = true;
                        break;
                    }
                    console.warn(`[NeoForge] 下载后JAR无效: ${url}`);
                    try { fs.unlinkSync(neoCoreJarPath); } catch (_) {}
                } catch (e) {
                    console.warn(`[NeoForge] 核心jar下载失败: ${url} - ${e.message}`);
                }
            }
            if (!coreOk) {
                console.warn(`[NeoForge] 核心jar补下载全部失败`);
            } else {
                neoLibFailures = Math.max(0, neoLibFailures - 1);
            }
        }

        const patchedJarRel = `net/neoforged/minecraft-client-patched/${neoVersion}/minecraft-client-patched-${neoVersion}.jar`;
        const patchedJarLibPath = path.join(ctx.dirs.LIBRARIES_DIR, patchedJarRel);
        const patchedJarVerPath = path.join(versionDir, `${versionId}.jar`);
        if (!fs.existsSync(patchedJarLibPath) || (await fs.promises.stat(patchedJarLibPath).catch(() => ({ size: 0 })).then(s => s.size)) < 1024) {
            if (fs.existsSync(patchedJarVerPath)) {
                try {
                    // [CRITICAL] ENOTDIR 修复 — 同 ensureDir，清理路径中的文件冲突。
                    {
                        const _d = path.dirname(patchedJarLibPath);
                        for (const _p of _d.split(path.sep).map((_, _i, _a) => _a.slice(0, _i + 1).join(path.sep))) {
                            if (_p) { try { const _s = fs.statSync(_p); if (!_s.isDirectory()) fs.unlinkSync(_p); } catch (_) {} }
                        }
                    }
                    fs.mkdirSync(path.dirname(patchedJarLibPath), { recursive: true });
                    fs.copyFileSync(patchedJarVerPath, patchedJarLibPath);
                    console.log(`[NeoForge] Patched JAR已复制到libraries: ${path.basename(patchedJarLibPath)}`);
                } catch (e) {
                    console.warn(`[NeoForge] 复制patched JAR失败: ${e.message}`);
                }
            } else {
                console.warn(`[NeoForge] Patched JAR缺失: ${patchedJarLibPath} 且版本目录也无`);
            }
        }

        try { fs.unlinkSync(installerPath); } catch (_) {}

        // [CRITICAL FIX - 2026-06-20] 必须从文件重新读取最终版本 JSON，不能用上面的 versionJson 对象直接写入！
        // 因为 mergeNeoForgeLoaderToVersion 等后续函数可能已经修改了文件中的 JSON，
        // 但这里的 versionJson 变量还是旧的引用，直接写入会覆盖掉那些修改。
        try {
            const finalJson = JSON.parse(fs.readFileSync(path.join(versionDir, `${versionId}.json`), 'utf-8'));
            fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(finalJson, null, 2));
            console.log(`[NeoForge] Final version JSON written, libs=${(finalJson.libraries||[]).length}`);
        } catch (_) {}

        if (onProgress) onProgress(1, 'NeoForge 安装完成');
        return { success: true, versionId: versionId, libsMissing: neoLibFailures };
    } catch (e) {
        console.error(`[NeoForge] Installation failed: ${e.message}`);
        try {
            const vDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
            if (fs.existsSync(vDir)) {
                fs.rmSync(vDir, { recursive: true, force: true });
                console.log(`[NeoForge] Cleaned up failed version directory: ${vDir}`);
            }
        } catch (cleanupErr) {
            console.error(`[NeoForge] Failed to cleanup version directory:`, cleanupErr.message);
        }
        return { success: false, error: e.message };
    }
}

async function mergeFabricLoaderToVersion(versionId, gameVersion, loaderVersion, onProgress = null) {
    const versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
    const jsonPath = path.join(versionDir, `${versionId}.json`);

    const metaUrl = `${ctx.urls.FABRIC_META_URL}/versions/loader/${gameVersion}/${loaderVersion}`;
    console.log(`[Fabric] Fetching profile for merge: ${metaUrl}`);
    let profileData;
    try {
        profileData = await http.fetchJSON(metaUrl);
    } catch (e) {
        const mirrorMetaUrl = `https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/${gameVersion}/${loaderVersion}`;
        console.log(`[Fabric] Retrying with mirror: ${mirrorMetaUrl}`);
        profileData = await http.fetchJSON(mirrorMetaUrl);
    }

    const versionJson = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

    if (profileData.launcherMeta) {
        const launcherMeta = profileData.launcherMeta;
        if (launcherMeta.mainClass) {
            versionJson.mainClass = typeof launcherMeta.mainClass === 'string'
                ? launcherMeta.mainClass
                : (launcherMeta.mainClass.client || versionJson.mainClass);
        }
        if (launcherMeta.libraries) {
            const common = launcherMeta.libraries.common || [];
            const client = launcherMeta.libraries.client || [];
            const fabricLibs = [...common, ...client];
            for (const lib of fabricLibs) {
                if (!lib.downloads || !lib.downloads.artifact || !lib.downloads.artifact.path) {
                    if (lib.name) {
                        const parts = lib.name.split(':');
                        if (parts.length >= 3) {
                            const groupPath = parts[0].replace(/\./g, '/');
                            const name = parts[1];
                            const ver = parts[2];
                            lib.downloads = lib.downloads || {};
                            lib.downloads.artifact = lib.downloads.artifact || {};
                            lib.downloads.artifact.path = `${groupPath}/${name}/${ver}/${name}-${ver}.jar`;
                            const baseUrl = lib.url || 'https://maven.fabricmc.net/';
                            lib.downloads.artifact.url = `${baseUrl}${groupPath}/${name}/${ver}/${name}-${ver}.jar`;
                            console.log(`[Fabric] 构造库URL: ${lib.name} -> ${lib.downloads.artifact.url}`);
                        }
                    }
                } else if (lib.downloads?.artifact?.url) {
                    console.log(`[Fabric] 库已有URL: ${lib.name} -> ${lib.downloads.artifact.url}`);
                }
            }
            versionJson.libraries = [...(versionJson.libraries || []), ...fabricLibs];
            console.log(`[Fabric] 添加了 ${fabricLibs.length} 个库到版本 ${versionId}`);

            if (profileData.loader && profileData.loader.maven) {
                const loaderMavenParts = profileData.loader.maven.split(':');
                if (loaderMavenParts.length >= 3) {
                    const loaderGroup = loaderMavenParts[0].replace(/\./g, '/');
                    const loaderName = loaderMavenParts[1];
                    const loaderVer = loaderMavenParts[2];
                    const loaderJarName = `${loaderName}-${loaderVer}.jar`;
                    versionJson.libraries.push({
                        name: profileData.loader.maven,
                        url: 'https://maven.fabricmc.net/',
                        downloads: {
                            artifact: {
                                path: `${loaderGroup}/${loaderName}/${loaderVer}/${loaderJarName}`,
                                url: `https://maven.fabricmc.net/${loaderGroup}/${loaderName}/${loaderVer}/${loaderJarName}`,
                                sha1: '',
                                size: 0
                            }
                        }
                    });
                    console.log(`[Fabric] 添加 fabric-loader: ${profileData.loader.maven}`);
                }
            }

            if (profileData.intermediary && profileData.intermediary.maven && profileData.intermediary.version !== '0.0.0') {
                const interMavenParts = profileData.intermediary.maven.split(':');
                if (interMavenParts.length >= 3) {
                    const interGroup = interMavenParts[0].replace(/\./g, '/');
                    const interName = interMavenParts[1];
                    const interVer = interMavenParts[2];
                    const interJarName = `${interName}-${interVer}.jar`;
                    versionJson.libraries.push({
                        name: profileData.intermediary.maven,
                        url: 'https://maven.fabricmc.net/',
                        downloads: {
                            artifact: {
                                path: `${interGroup}/${interName}/${interVer}/${interJarName}`,
                                url: `https://maven.fabricmc.net/${interGroup}/${interName}/${interVer}/${interJarName}`,
                                sha1: '',
                                size: 0
                            }
                        }
                    });
                    console.log(`[Fabric] 添加 intermediary: ${profileData.intermediary.maven}`);
                }
            }
        }
    }

    if (profileData.loader) {
        if (profileData.loader.mainClass && !versionJson.mainClass) {
            versionJson.mainClass = profileData.loader.mainClass;
        }
    }

    if (!versionJson.mainClass) {
        versionJson.mainClass = 'net.fabricmc.loader.impl.launch.knot.KnotClient';
    }

    console.log(`[Fabric] 主类: ${versionJson.mainClass}`);
    console.log(`[Fabric] 开始下载库文件...`);

    const libsToDownload = (versionJson.libraries || []).filter(lib => {
        if (lib.rules && !versions.evaluateRules(lib.rules)) return false;
        if (!lib.downloads?.artifact?.path) return false;
        const libPath = path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path);
        return !fs.existsSync(libPath);
    });

    const downloadErrors = [];
    if (libsToDownload.length > 0) {
        const settings = versions.loadSettingsCached();
        const FABRIC_PARALLEL = Math.min(parseInt(settings.maxThreads, 10) || 64, libsToDownload.length);
        let completed = 0;
        let failed = 0;
        let active = 0;
        let done = null;

        const scheduleNext = () => {
            while (active < FABRIC_PARALLEL && completed + failed + active < libsToDownload.length) {
                const lib = libsToDownload[completed + failed + active];
                active++;
                (async () => {
                    const libPath = path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path);
                    const libUrl = lib.downloads.artifact.url
                        || `https://maven.fabricmc.net/${lib.downloads.artifact.path}`;
                    console.log(`[Fabric] 下载库: ${lib.name || lib.downloads.artifact.path}`);
                    await http.downloadFileWithMirror(libUrl, libPath);
                    console.log(`[Fabric] 下载成功: ${lib.name}`);
                })().then(() => {
                    completed++;
                }).catch((e) => {
                    console.error(`[Fabric] 下载失败: ${lib.name} - ${e.message}`);
                    downloadErrors.push({ name: lib.name, url: lib.downloads.artifact.url, error: e.message });
                    failed++;
                }).finally(() => {
                    active--;
                    if (onProgress) {
                        onProgress((completed + failed) / libsToDownload.length, `下载Fabric库 (${completed + failed}/${libsToDownload.length})...`);
                    }
                    if (active === 0 && completed + failed >= libsToDownload.length && done) done();
                    else if (active < FABRIC_PARALLEL && completed + failed + active < libsToDownload.length) scheduleNext();
                });
            }
        };

        await new Promise(resolve => { done = resolve; scheduleNext(); });
    }

    if (downloadErrors.length > 0) {
        console.error(`[Fabric] 有 ${downloadErrors.length} 个库下载失败:`);
        for (const err of downloadErrors) {
            console.error(`  - ${err.name}: ${err.url} (${err.error})`);
        }
    }

    fs.writeFileSync(jsonPath, JSON.stringify(versionJson, null, 2));
    versions._invalidateResolvedJsonCache(versionId);
    console.log(`[Fabric] Loader merged into version: ${versionId}`);
}

async function mergeForgeLoaderToVersion(versionId, gameVersion, forgeVersion) {
    const mergeLogFile = path.join(ctx.dirs.DATA_DIR, 'temp', 'forge-merge.log');
    const mergeLog = (msg) => {
        const line = `[${new Date().toISOString()}] ${msg}\n`;
        try { fs.appendFileSync(mergeLogFile, line); } catch(_) {}
        console.log(`[Forge-MERGE] ${msg}`);
    };
    try { fs.mkdirSync(path.dirname(mergeLogFile), { recursive: true }); } catch(_) {}
    try { fs.writeFileSync(mergeLogFile, ''); } catch(_) {}
    mergeLog(`mergeForgeLoaderToVersion: versionId=${versionId}, gameVersion=${gameVersion}, forgeVersion=${forgeVersion}`);
    const versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
    const jsonPath = path.join(versionDir, `${versionId}.json`);
    const AdmZip = require('adm-zip');

    const installerUrl = `${ctx.urls.FORGE_MAVEN_URL}/${gameVersion}-${forgeVersion}/forge-${gameVersion}-${forgeVersion}-installer.jar`;
    const installerPath = path.join(ctx.dirs.DATA_DIR, 'temp', `forge-installer-${gameVersion}-${forgeVersion}.jar`);
    if (!fs.existsSync(path.dirname(installerPath))) fs.mkdirSync(path.dirname(installerPath), { recursive: true });

    mergeLog(`Downloading installer: ${installerUrl}`);
    await http.downloadFileWithMirror(installerUrl, installerPath);
    mergeLog(`Installer downloaded: ${fs.statSync(installerPath).size} bytes`);

    const zip = new AdmZip(installerPath);
    const versionEntry = zip.getEntry('version.json') || zip.getEntry(`${gameVersion}-forge-${forgeVersion}.json`);
    mergeLog(`version.json entry: ${versionEntry ? 'FOUND' : 'NOT FOUND'}`);

    if (versionEntry) {
        const forgeJson = JSON.parse(versionEntry.getData().toString('utf8'));
        forgeJson.id = versionId;
        forgeJson.inheritsFrom = gameVersion;
        if (!forgeJson.type) forgeJson.type = 'release';

        const currentJson = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        versions.mergeVersionJson(currentJson, forgeJson);

        fs.writeFileSync(jsonPath, JSON.stringify(currentJson, null, 2));

        const mavenEntries2 = zip.getEntries().filter(e => e.entryName.startsWith('maven/'));
        console.log(`[Forge-merge] 先提取 maven 文件: ${mavenEntries2.length} entries`);
        let mergeYieldCounter = 0;
        for (const entry of mavenEntries2) {
            const relativePath = entry.entryName.replace('maven/', '');
            const extractPath = path.join(ctx.dirs.LIBRARIES_DIR, relativePath);
            if (!fs.existsSync(extractPath)) {
                await utils.asyncEnsureDir(path.join(extractPath, 'dummy.txt'));
                try { await fs.promises.writeFile(extractPath, entry.getData()); } catch (e) {
                    console.error(`[Forge-merge] 解压Maven文件失败: ${relativePath} - ${e.message}`);
                }
            } else if (extractPath.endsWith('.jar') && !utils.isJarIntact(extractPath)) {
                try { await fs.promises.unlink(extractPath); } catch (_) {}
                await utils.asyncEnsureDir(path.join(extractPath, 'dummy.txt'));
                try { await fs.promises.writeFile(extractPath, entry.getData()); } catch (e) {
                    console.error(`[Forge-merge] 重写损坏Maven文件失败: ${relativePath} - ${e.message}`);
                }
            }
            if (++mergeYieldCounter % 30 === 0) await utils.yieldToEventLoop();
        }

        for (const lib of (currentJson.libraries || [])) {
            if (lib.rules && !versions.evaluateRules(lib.rules)) continue;
            if (lib.downloads?.artifact?.path) {
                const libPath = path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path);
                if (!fs.existsSync(libPath) && lib.downloads.artifact.url) {
                    try {
                        await http.downloadFileWithMirror(lib.downloads.artifact.url, libPath);
                        if (libPath.endsWith('.jar') && !utils.isJarIntact(libPath)) {
                            throw new Error(`下载后JAR损坏: ${path.basename(libPath)}`);
                        }
                    } catch (e) {
                        console.error(`[Forge-merge] 库下载失败: ${lib.downloads.artifact.path} - ${e.message}`);
                        try { fs.unlinkSync(libPath); } catch (_) {}
                    }
                }
            }
        }
    } else {
        mergeLog(`version.json NOT found, using fallback mainClass`);
        const versionJson = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        versionJson.mainClass = 'cpw.mods.modlauncher.Launcher';
        versionJson.arguments = versionJson.arguments || {};
        versionJson.arguments.game = versionJson.arguments.game || [];
        versionJson.arguments.game.push('--fml.forgeVersion', forgeVersion, '--fml.mcVersion', gameVersion, '--fml.forgeGroup', 'net.minecraftforge');
        versionJson.libraries = versionJson.libraries || [];
        fs.writeFileSync(jsonPath, JSON.stringify(versionJson, null, 2));
        versions._invalidateResolvedJsonCache(versionId);
    }

    try { fs.unlinkSync(installerPath); } catch (e) {}

    const ipPath = path.join(versionDir, 'install_profile.json');
    mergeLog(`install_profile.json exists: ${fs.existsSync(ipPath)}`);
    if (fs.existsSync(ipPath)) {
        try {
            const ipData = JSON.parse(fs.readFileSync(ipPath, 'utf8'));
            mergeLog(`install_profile.json: processors=${ipData.processors?.length || 0}, data keys=${ipData.data ? Object.keys(ipData.data).join(', ') : 'none'}`);
            if (ipData.processors && ipData.processors.length > 0) {
                mergeLog(`Found ${ipData.processors.length} processors, executing...`);
                try {
                    const _scriptSrc = path.join(SERVER_DIR, 'forge-processor.js');
                    const _scriptDst = path.join(ctx.dirs.DATA_DIR, 'temp', 'forge-processor.js');
                    fs.mkdirSync(path.dirname(_scriptDst), { recursive: true });
                    if (fs.existsSync(_scriptDst)) { try { fs.unlinkSync(_scriptDst); } catch(_) {} }
                    const _srcContent = fs.readFileSync(_scriptSrc, 'utf8');
                    fs.writeFileSync(_scriptDst, _srcContent, 'utf8');
                    mergeLog(`Script written to: ${_scriptDst}`);
                    const _cmd = `node "${_scriptDst}" --root "${ctx.dirs.DATA_DIR}" --libs "${ctx.dirs.LIBRARIES_DIR}" --mcver "${gameVersion}" --forgever "${forgeVersion}"`;
                    mergeLog(`Running: ${_cmd}`);
                    await new Promise((resolve, reject) => {
                        exec(_cmd, { timeout: 240000, encoding: 'utf8', maxBuffer: 10*1024*1024, windowsHide: true }, (err, stdout, stderr) => {
                            if (stdout) mergeLog(`Script output:\n${stdout}`);
                            if (stderr) console.warn(`[Forge-DEBUG] Script stderr:\n${stderr}`);
                            if (err) {
                                mergeLog(`[ERROR] Script failed: ${err.message}`);
                                resolve();
                            } else {
                                mergeLog(`Script completed successfully`);
                                resolve();
                            }
                        });
                    });
                } catch (_procErr) {
                    mergeLog(`[ERROR] Script error: ${_procErr.message}`);
                }
            }
        } catch (e) {
            mergeLog(`[ERROR] Failed to read install_profile.json: ${e.message}`);
        }
    }

    mergeLog(`Loader merged into version: ${versionId}`);
}

// ============================================================================
// 模组加载器版本合并 - 将加载器特有的配置合并到版本JSON中
// ============================================================================


async function mergeNeoForgeLoaderToVersion(versionId, gameVersion, neoVersion, onProgress = null) {
    const versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
    const jsonPath = path.join(versionDir, `${versionId}.json`);
    const versionJson = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

    // [CRITICAL FIX - 2026-06-20] 同样从 versionId 提取纯净的 MC 版本号。
    // 这个函数在 installNeoForge 之后被调用，负责合并 install_profile.json 中的运行时库。
    // 如果 inheritsFrom 写错（如 "26.2-forge-65.0.0"），launcher 会继承错误的基础版本，
    // 导致 NeoForge 的 access-transformers、earlydisplay 等关键库缺失，启动直接崩溃。
    const correctGameVersion = gameVersion.match(/^\d+\.\d+/) ? gameVersion.split('.')[0] + '.' + gameVersion.split('.').slice(1).find(p => /^\d+$/.test(p) && parseInt(p) < 100) || gameVersion.split('.')[0] + '.' + (gameVersion.split('.')[1] || '0') : gameVersion;
    const mcVerMatch = versionId.match(/^(\d+\.\d+(?:\.\d+)?)/);
    const mcVer = mcVerMatch ? mcVerMatch[1] : (versionJson.inheritsFrom && versionJson.inheritsFrom.match(/^\d+\.\d+/) ? versionJson.inheritsFrom : correctGameVersion);
    versionJson.inheritsFrom = mcVer;
    console.log(`[NeoForge] inheritsFrom set to: ${mcVer} (gameVersion was: ${gameVersion})`);

    let profileLibs = [];
    let profileData = null;
    let installerMainClass = null;
    let installerArgs = null;

    if (onProgress) onProgress(0.1, '提取 NeoForge 安装器数据...');

    const ipPath = path.join(versionDir, 'install_profile.json');
    if (fs.existsSync(ipPath)) {
        try {
            const ipData = JSON.parse(fs.readFileSync(ipPath, 'utf-8'));
            profileLibs = ipData.libraries || [];
            profileData = ipData.data || null;
            console.log(`[NeoForge] read install_profile.json: libs=${profileLibs.length}, dataKeys=${profileData ? Object.keys(profileData).join(',') : 'none'}`);
        } catch (_) {}
    }

    if (profileLibs.length === 0) {
        const isLegacy = neoVersion.startsWith('1.20.1-');
        const pkg = isLegacy ? 'forge' : 'neoforge';
        const installerUrls = [
            `https://bmclapi2.bangbang93.com/maven/net/neoforged/${pkg}/${neoVersion}/${pkg}-${neoVersion}-installer.jar`,
            `https://maven.neoforged.net/releases/net/neoforged/${pkg}/${neoVersion}/${pkg}-${neoVersion}-installer.jar`
        ];
        const installerPath = path.join(ctx.dirs.DATA_DIR, 'temp', `neoforge-merge-${neoVersion}.jar`);
        fs.mkdirSync(path.dirname(installerPath), { recursive: true });

        let downloaded = false;
        for (const url of installerUrls) {
            try {
                if (onProgress) onProgress(0.15, `下载 NeoForge 安装器...`);
                await http.downloadFileWithMirror(url, installerPath, (p) => {
                    if (onProgress && p) onProgress(0.15 + (p.progress || 0) * 0.1, `下载 NeoForge 安装器: ${p.progress || 0}%`);
                }, 3, null, 60000);
                downloaded = true;
                break;
            } catch (_) {}
        }

        if (downloaded) {
            try {
                const AdmZip = require('adm-zip');
                const zip = new AdmZip(installerPath);
                const profileEntry = zip.getEntry('install_profile.json');
                if (profileEntry) {
                    const ipData = JSON.parse(profileEntry.getData().toString('utf8'));
                    profileLibs = ipData.libraries || [];
                    profileData = ipData.data || null;
                    try { fs.writeFileSync(ipPath, JSON.stringify(ipData, null, 2)); } catch (_) {}
                }
                const versionEntry = zip.getEntry('version.json');
                if (versionEntry) {
                    const vData = JSON.parse(versionEntry.getData().toString('utf8'));
                    installerMainClass = vData.mainClass || null;
                    installerArgs = vData.arguments || null;
                }
                const clientLzmaEntry = zip.getEntry('data/client.lzma');
                if (clientLzmaEntry) {
                    const isLegacy = neoVersion.startsWith('1.20.1-');
                    const pkg = isLegacy ? 'forge' : 'neoforge';
                    const clDir = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'neoforged', pkg, neoVersion);
                    const clPath = path.join(clDir, `${pkg}-${neoVersion}-clientdata.lzma`);
                    if (!fs.existsSync(clPath)) {
                        fs.mkdirSync(clDir, { recursive: true });
                        fs.writeFileSync(clPath, clientLzmaEntry.getData());
                        console.log(`[NeoForge] 提取 clientdata.lzma → ${clPath} (${fs.statSync(clPath).size} bytes)`);
                    }
                } else {
                    console.warn(`[NeoForge] 安装器中无 data/client.lzma`);
                }
            } catch (zipErr) {
                console.warn(`[NeoForge] 解压安装器失败: ${zipErr.message}`);
            }
            try { fs.unlinkSync(installerPath); } catch (_) {}
        }
    }

    if (profileLibs.length === 0) {
        try {
            const neoUrl = `${ctx.urls.NEOFORGE_API_URL}/versions/${encodeURIComponent(`net.neoforged:neoforge:${neoVersion}`)}?type=json`;
            let neoData;
            try {
                neoData = await http.fetchJSON(neoUrl, 3, 10000);
            } catch (e) {
                const mirrorNeoUrl = `https://bmclapi2.bangbang93.com/maven/api/maven/versions/${encodeURIComponent(`net.neoforged:neoforge:${neoVersion}`)}?type=json`;
                neoData = await http.fetchJSON(mirrorNeoUrl, 3, 10000);
            }
            installerMainClass = neoData.mainClass || installerMainClass;
            installerArgs = neoData.arguments || installerArgs;
            profileLibs = neoData.libraries || profileLibs;
        } catch (e) {
            console.warn(`[NeoForge] API也失败: ${e.message}`);
        }
    }

    versionJson.mainClass = installerMainClass || versionJson.mainClass || 'cpw.mods.bootstraplauncher.BootstrapLauncher';

    // XMCL: do NOT add data to version JSON
    // Keep data in install_profile.json only (used by processors, not needed at runtime)

    versionJson.arguments = versionJson.arguments || {};
    versionJson.arguments.game = versionJson.arguments.game || [];
    const hasFmlArgs = versionJson.arguments.game.some(a => a === '--fml.neoForgeVersion');
    if (!hasFmlArgs) {
        if (installerArgs?.game) {
            versionJson.arguments.game.push(...installerArgs.game);
        } else {
            versionJson.arguments.game.push('--launchTarget', 'neoforgeclient', '--fml.neoForgeVersion', neoVersion, '--fml.mcVersion', gameVersion);
        }
    }
    if (installerArgs?.jvm) {
        const existingJvm = new Set(versionJson.arguments.jvm || []);
        for (const jvmArg of installerArgs.jvm) {
            if (!existingJvm.has(jvmArg)) {
                versionJson.arguments.jvm = versionJson.arguments.jvm || [];
                versionJson.arguments.jvm.push(jvmArg);
                existingJvm.add(jvmArg);
            }
        }
    }

    // [CRITICAL FIX - 2026-06-20] 将 install_profile.json 中的运行时库合并到版本 JSON 的 libraries 中。
    // NeoForge 的关键运行时库（如 net.neoforged:accesstransformers, earlydisplay, asm 等）
    // 只存在于 install_profile.json 的 libraries 里，不会自动出现在版本 JSON 中。
    // 如果删掉这段合并逻辑，NeoForge 启动时会报 NoSuchMethodError: AccessTransformerEngine.newEngine()
    if (profileLibs.length > 0) {
        const existingLibNames = new Set((versionJson.libraries || []).map(l => l.name).filter(Boolean));
        let added = 0;
        for (const lib of profileLibs) {
            if (lib.name && !existingLibNames.has(lib.name)) {
                versionJson.libraries = versionJson.libraries || [];
                versionJson.libraries.push(lib);
                existingLibNames.add(lib.name);
                added++;
            }
        }
        console.log(`[NeoForge] 合并 install_profile 库: +${added}, total=${versionJson.libraries.length}`);
    }

    if (onProgress) onProgress(0.5, '下载 NeoForge 库文件...');

    const libsToDownload = (versionJson.libraries || []).filter(lib => {
        if (lib.downloads?.artifact?.url) {
            const libPath = path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path);
            if (!fs.existsSync(libPath)) return true;
            const expectedSha1 = lib.downloads.artifact.sha1;
            const expectedSize = lib.downloads.artifact.size;
            if (expectedSize && fs.existsSync(libPath)) {
                try { if (fs.statSync(libPath).size === expectedSize) return false; } catch (_) {}
            }
            if (!expectedSha1) return false;
            return true;
        }
        if (lib.name) {
            const parts = lib.name.split(':');
            if (parts.length >= 3) {
                const gPath = parts[0].replace(/\./g, '/');
                const atIdx = parts[2].indexOf('@');
                const ext = atIdx >= 0 ? parts[2].substring(atIdx + 1) : 'jar';
                const ver = atIdx >= 0 ? parts[2].substring(0, atIdx) : parts[2];
                let classifier = '';
                if (parts[3]) {
                    const atIdx3 = parts[3].indexOf('@');
                    classifier = atIdx3 >= 0 ? parts[3].substring(0, atIdx3) : parts[3];
                }
                const fName = classifier ? `${parts[1]}-${ver}-${classifier}.${ext}` : `${parts[1]}-${ver}.${ext}`;
                const rPath = `${gPath}/${parts[1]}/${ver}/${fName}`;
                const lp = path.join(ctx.dirs.LIBRARIES_DIR, rPath);
                if (!fs.existsSync(lp)) {
                    lib._mavenPath = rPath;
                    lib._url = lib.url || null;
                    return true;
                }
            }
        }
        return false;
    });

    if (libsToDownload.length > 0) {
        const settings = versions.loadSettingsCached();
        const NEO_PARALLEL = Math.min(parseInt(settings.maxThreads, 10) || 64, libsToDownload.length);
        let completed = 0;
        let failed = 0;
        let active = 0;
        let done = null;

        const scheduleNext = () => {
            while (active < NEO_PARALLEL && completed + failed + active < libsToDownload.length) {
                const lib = libsToDownload[completed + failed + active];
                active++;
                (async () => {
                    let libPath, libUrls;
                    if (lib._mavenPath) {
                        libPath = path.join(ctx.dirs.LIBRARIES_DIR, lib._mavenPath);
                        libUrls = [];
                        if (lib._url) libUrls.push(lib._url.replace(/\/$/, '') + '/' + lib._mavenPath.split('/').pop());
                        libUrls.push(
                            `https://maven.neoforged.net/releases/${lib._mavenPath}`,
                            `https://maven.minecraftforge.net/${lib._mavenPath}`,
                            `https://libraries.minecraft.net/${lib._mavenPath}`,
                            `https://bmclapi2.bangbang93.com/maven/${lib._mavenPath}`
                        );
                    } else {
                        libPath = path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path);
                        libUrls = [lib.downloads.artifact.url];
                    }
                    const dir = path.dirname(libPath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    let ok = false;
                    for (const u of libUrls) {
                        try { await http.downloadFileWithMirror(u, libPath, null, 2, null, 60000); ok = true; break; } catch (_) {}
                    }
                    if (!ok) throw new Error(`所有镜像源均失败: ${lib._mavenPath || lib.downloads?.artifact?.path}`);
                    if (libPath.endsWith('.jar') && !utils.isJarIntact(libPath)) {
                        throw new Error(`下载后JAR损坏: ${path.basename(libPath)}`);
                    }
                })().then(() => {
                    completed++;
                }).catch((e) => {
                    const libId = lib._mavenPath || lib.downloads?.artifact?.path || lib.name;
                    console.error(`[NeoForge] 库下载失败: ${libId} - ${e.message}`);
                    try { if (lib._mavenPath) fs.unlinkSync(path.join(ctx.dirs.LIBRARIES_DIR, lib._mavenPath)); else fs.unlinkSync(path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path)); } catch (_) {}
                    failed++;
                }).finally(() => {
                    active--;
                    if (onProgress) {
                        onProgress(0.5 + 0.5 * (completed + failed) / libsToDownload.length, `下载NeoForge库 (${completed + failed}/${libsToDownload.length})...`);
                    }
                    if (active === 0 && completed + failed >= libsToDownload.length && done) done();
                    else if (active < NEO_PARALLEL && completed + failed + active < libsToDownload.length) scheduleNext();
                });
            }
        };

        await new Promise(resolve => { done = resolve; scheduleNext(); });
    }

    if (onProgress) onProgress(0.9, '执行 NeoForge 处理器...');

    const _isLegacy = neoVersion.startsWith('1.20.1-');
    const _pkg = _isLegacy ? 'forge' : 'neoforge';
    const _clientdataPath = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'neoforged', _pkg, neoVersion, `${_pkg}-${neoVersion}-clientdata.lzma`);
    if (!fs.existsSync(_clientdataPath)) {
        const _errMsg = `NeoForge 安装失败: clientdata.lzma 缺失 (${_clientdataPath})，请检查网络后重试`;
        console.error(`[NeoForge] ${_errMsg}`);
        if (onProgress) onProgress(1, _errMsg);
        throw new Error(_errMsg);
    }

    try {
        if (onProgress) onProgress(0.92, '打补丁中...');

        const _scriptSrc = path.join(SERVER_DIR, 'neoforge-processor.js');
        const _scriptDst = path.join(ctx.dirs.DATA_DIR, 'temp', 'neoforge-processor.js');
        try {
            fs.mkdirSync(path.dirname(_scriptDst), { recursive: true });
            if (fs.existsSync(_scriptDst)) { try { fs.unlinkSync(_scriptDst); } catch(_) {} }
            const _srcContent = fs.readFileSync(_scriptSrc, 'utf8');
            fs.writeFileSync(_scriptDst, _srcContent, 'utf8');
        } catch(_) {}

        await new Promise((resolveProc) => {
            const _args = [_scriptDst, '--root', ctx.dirs.DATA_DIR, '--libs', ctx.dirs.LIBRARIES_DIR, '--mcver', gameVersion, '--neover', neoVersion];
            console.log(`[NeoForge] Running: node ${_args.join(' ')}`);
            const _child = spawn('node', _args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
            let _stdout = '', _stderr = '';
            const _progressMap = [
                ['Running Processor', 0.93], ['Command:', 0.93],
                ['DOWNLOAD_MOJMAPS', 0.94], ['MERGE_MAPPING', 0.95],
                ['Splitting:', 0.96], ['Processing', 0.96],
                ['Sorting', 0.97], ['Remapping', 0.98],
                ['Injecting', 0.99], ['SUCCESS', 0.995],
            ];
            const _parseLine = (line) => {
                console.log(`[NeoForge] ${line}`);
                for (const [keyword, pct] of _progressMap) {
                    if (line.includes(keyword)) {
                        if (onProgress) onProgress(pct, line.substring(0, 80));
                        break;
                    }
                }
            };
            _child.stdout.on('data', (data) => {
                _stdout += data.toString();
                const lines = _stdout.split('\n');
                _stdout = lines.pop();
                for (const line of lines) _parseLine(line.trim());
            });
            _child.stderr.on('data', (data) => {
                _stderr += data.toString();
                const lines = _stderr.split('\n');
                _stderr = lines.pop();
                for (const line of lines) _parseLine(line.trim());
            });
            const _killTimer = setTimeout(() => { try { _child.kill('SIGKILL'); } catch(_){} }, 240000);
            _child.on('close', (code) => {
                clearTimeout(_killTimer);
                if (_stdout.trim()) _parseLine(_stdout.trim());
                if (code !== 0) console.error(`[NeoForge] Script exited with code ${code}`);
                resolveProc();
            });
            _child.on('error', (err) => {
                clearTimeout(_killTimer);
                console.error(`[NeoForge] Script spawn error: ${err.message}`);
                resolveProc();
            });
        });

        const _logFile = path.join(ctx.dirs.DATA_DIR, 'temp', 'neoforge-processor.log');
        if (fs.existsSync(_logFile)) {
            try { console.log(`[NeoForge] Log:\n${fs.readFileSync(_logFile, 'utf8')}`); } catch(_) {}
        }

        const _patchedJar = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'neoforged', 'minecraft-client-patched', neoVersion, `minecraft-client-patched-${neoVersion}.jar`);
        if (fs.existsSync(_patchedJar)) {
            const _verJar = path.join(versionDir, `${versionId}.jar`);
            try { fs.copyFileSync(_patchedJar, _verJar); console.log(`[NeoForge] Copied patched JAR`); } catch(_) {}

            const _existingPatched = (versionJson.libraries || []).some(l => l.name && l.name.includes('minecraft-client-patched'));
            if (!_existingPatched) {
                versionJson.libraries = versionJson.libraries || [];
                versionJson.libraries.push({
                    name: `net.neoforged:minecraft-client-patched:${neoVersion}`,
                    downloads: { artifact: { path: `net/neoforged/minecraft-client-patched/${neoVersion}/minecraft-client-patched-${neoVersion}.jar`, url: `https://maven.neoforged.net/releases/net/neoforged/minecraft-client-patched/${neoVersion}/minecraft-client-patched-${neoVersion}.jar` } }
                });
            }
        } else {
            console.warn(`[NeoForge] Patched JAR not found: ${_patchedJar}`);
        }
    } catch (procErr) {
        console.error(`[NeoForge] Processor异常: ${procErr.message}`);
    }

    fs.writeFileSync(jsonPath, JSON.stringify(versionJson, null, 2));
    versions._invalidateResolvedJsonCache(versionId);
    console.log(`[NeoForge] Loader merged: ${versionId}, libs=${(versionJson.libraries || []).length}, mainClass=${versionJson.mainClass}`);
}

async function mergeOptiFineToVersion(versionId, gameVersion, optiFineVersion, onProgress = null) {
    const versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
    const jsonPath = path.join(versionDir, `${versionId}.json`);

    try {
        if (onProgress) onProgress(0, '下载OptiFine...');
        const optiFineApiUrl = `https://optifine.net/downloadx?f=OptiFine_${gameVersion}_${optiFineVersion}.jar&x=${Date.now()}`;
        const optiFinePath = path.join(ctx.dirs.DATA_DIR, 'temp', `OptiFine-${gameVersion}-${optiFineVersion}.jar`);
        if (!fs.existsSync(path.dirname(optiFinePath))) fs.mkdirSync(path.dirname(optiFinePath), { recursive: true });

        await http.downloadFileWithMirror(optiFineApiUrl, optiFinePath);
        if (onProgress) onProgress(1, 'OptiFine下载完成');

        const versionJson = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        versionJson.libraries = versionJson.libraries || [];
        const optiFineLib = {
            name: `optifine:OptiFine:${gameVersion}_${optiFineVersion}`,
            downloads: {
                artifact: {
                    path: `optifine/OptiFine/${gameVersion}_${optiFineVersion}/OptiFine-${gameVersion}_${optiFineVersion}.jar`,
                    sha1: '',
                    size: 0,
                    url: ''
                }
            }
        };

        const targetLibPath = path.join(ctx.dirs.LIBRARIES_DIR, optiFineLib.downloads.artifact.path);
        if (!fs.existsSync(path.dirname(targetLibPath))) {
            // [CRITICAL] ENOTDIR 修复 — 同 ensureDir，清理路径中的文件冲突。
            {
                const _d = path.dirname(targetLibPath);
                for (const _p of _d.split(path.sep).map((_, _i, _a) => _a.slice(0, _i + 1).join(path.sep))) {
                    if (_p) { try { const _s = fs.statSync(_p); if (!_s.isDirectory()) fs.unlinkSync(_p); } catch (_) {} }
                }
            }
            fs.mkdirSync(path.dirname(targetLibPath), { recursive: true });
        }
        fs.copyFileSync(optiFinePath, targetLibPath);
        try { fs.unlinkSync(optiFinePath); } catch (e) {}

        if (!versionJson.libraries.some(l => l.name === optiFineLib.name)) {
            versionJson.libraries.unshift(optiFineLib);
        }

        fs.writeFileSync(jsonPath, JSON.stringify(versionJson, null, 2));
        versions._invalidateResolvedJsonCache(versionId);
        console.log(`[OptiFine] Installed into version: ${versionId}`);
    } catch (e) {
        console.log(`[OptiFine] Install failed: ${e.message}`);
    }
}

async function getFabricLoaderVersions() {
    try {
        const data = await http.fetchWithRacing([
            {
                fetchFn: () => http.fetchJSON(`${ctx.urls.FABRIC_META_URL}/versions/loader`),
                label: '[Racing] Fabric Meta API'
            },
            {
                fetchFn: () => http.fetchJSON('https://bmclapi2.bangbang93.com/fabric-meta/versions/loader'),
                label: '[Racing] BMCLAPI Fabric Meta'
            }
        ]);
        console.log('[Racing] getFabricLoaderVersions 成功');
        return data.map(v => ({
            version: v.version,
            stable: v.stable
        }));
    } catch (e) {
        console.warn(`[Racing] getFabricLoaderVersions 所有源失败: ${e.message}`);
        return [];
    }
}

async function getFabricLoaderVersionsForGame(gameVersion) {
    try {
        const data = await http.fetchWithRacing([
            {
                fetchFn: () => http.fetchJSON(`${ctx.urls.FABRIC_META_URL}/versions/loader/${gameVersion}`),
                label: `[Racing] Fabric Meta API (${gameVersion})`
            },
            {
                fetchFn: () => http.fetchJSON(`https://bmclapi2.bangbang93.com/fabric-meta/versions/loader/${gameVersion}`),
                label: `[Racing] BMCLAPI Fabric Meta (${gameVersion})`
            }
        ]);
        console.log(`[Racing] getFabricLoaderVersionsForGame(${gameVersion}) 成功`);
        return data.map(v => ({
            version: v.loader.version,
            stable: v.loader.stable
        }));
    } catch (e) {
        console.warn(`[Racing] getFabricLoaderVersionsForGame(${gameVersion}) 所有源失败: ${e.message}`);
        return [];
    }
}

async function getNeoForgeVersionsForGame(gameVersion) {
    const p = gameVersion.split('.');
    const mcMajor = parseInt(p[0], 10) || 0;
    const mcMinor = parseInt(p[1], 10) || 0;
    const neoPrefix = mcMajor + '.' + mcMinor;

    let allNeoForgeVersions = [];
    let allForgeVersions = [];
    let lastError = null;

    const fetchXmlVersions = async (url) => {
        const xml = await http.fetchText(url, 15000);
        const matches = xml.match(/<version>([^<]+)<\/version>/g) || [];
        return matches.map(v => v.replace(/<\/?version>/g, ''));
    };

    try {
        const [neoVersions, forgeVersions] = await Promise.allSettled([
            fetchXmlVersions('https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/maven-metadata.xml'),
            fetchXmlVersions('https://bmclapi2.bangbang93.com/maven/net/neoforged/forge/maven-metadata.xml')
        ]);
        if (neoVersions.status === 'fulfilled') allNeoForgeVersions = neoVersions.value;
        if (forgeVersions.status === 'fulfilled') allForgeVersions = forgeVersions.value;
    } catch (e) {
        lastError = e.message;
    }

    if (allNeoForgeVersions.length === 0 && allForgeVersions.length === 0) {
        try {
            const data = await http.fetchJSON('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge', 15000);
            allNeoForgeVersions = data.versions || [];
        } catch (e) {
            lastError = e.message;
            console.warn(`[NeoForge] primary API failed: ${e.message}`);
        }
    }

    if (allNeoForgeVersions.length === 0 && allForgeVersions.length === 0) {
        console.error(`[NeoForge] 所有源均不可达，最后错误: ${lastError}`);
        return [];
    }

    const neoForgePrefix = /^\d+\.\d+/;
    const matched = [];
    const fallback = [];
    for (const ver of allNeoForgeVersions) {
        if (typeof ver !== 'string') continue;
        if (ver.startsWith(neoPrefix + '.')) {
            matched.push(ver);
        }
        if (!ver.includes('-beta') && !ver.includes('-alpha')) {
            fallback.push(ver);
        }
    }

    const forgeMatched = [];
    for (const ver of allForgeVersions) {
        if (typeof ver !== 'string') continue;
        if (ver.startsWith(gameVersion + '-') || ver.startsWith(gameVersion + '.')) {
            forgeMatched.push(ver);
        }
    }

    let result = matched.length > 0 ? matched : fallback.slice(-10);
    if (forgeMatched.length > 0) {
        for (const fv of forgeMatched) {
            if (!result.includes(fv)) result.push(fv);
        }
    }
    result = [...new Set(result)].filter(v => typeof v === 'string').reverse();
    if (result.length > 0) {
        const stable = result.find(v => !v.includes('-beta') && !v.includes('-alpha'));
        if (stable) {
            result = result.filter(v => v !== stable);
            result.unshift(stable);
        }
        result[0] = { version: result[0], gameVersion, type: '推荐' };
    }
    const finalVersions = result.slice(0, 10).map((v, i) => {
        if (typeof v === 'string') return { version: v, gameVersion, type: i === 0 ? '推荐' : '' };
        return v;
    });

    console.log(`[NeoForge] Found ${finalVersions.length} versions for MC ${gameVersion}, prefix: ${neoPrefix}`);
    return finalVersions;
}

async function autoDownloadFabricApi(gameVersion, versionId, onProgress = null) {
    try {
        if (onProgress) onProgress(0, '正在获取最新 Fabric API...');
        console.log(`[FabricAPI] 搜索兼容 MC ${gameVersion} 的 Fabric API...`);

        const searchUrl = `${ctx.urls.MODRINTH_API}/project/fabric-api/version?loaders=["fabric"]&game_versions=["${gameVersion}"]`;
        let versions;
        try {
            versions = await http.fetchJSON(searchUrl);
        } catch (e) {
            const mirrorUrl = `${ctx.urls.MODRINTH_API_MIRROR}/project/fabric-api/version?loaders=["fabric"]&game_versions=["${gameVersion}"]`;
            console.log(`[FabricAPI] 主API失败，尝试镜像: ${e.message}`);
            versions = await http.fetchJSON(mirrorUrl);
        }

        if (!versions || versions.length === 0) {
            console.log(`[FabricAPI] 未找到兼容 MC ${gameVersion} 的 Fabric API 版本`);
            return { success: false, message: '未找到兼容版本' };
        }

        const latestVersion = versions[0];
        const primaryFile = latestVersion.files?.find(f => f.primary) || latestVersion.files?.[0];
        if (!primaryFile) {
            console.log(`[FabricAPI] 版本 ${latestVersion.version_number} 没有可下载文件`);
            return { success: false, message: '无可下载文件' };
        }

        const modsDir = versions.getVersionModsDir(versionId);
        if (!modsDir) {
            console.log(`[FabricAPI] 无法确定版本 ${versionId} 的 mods 目录`);
            return { success: false, message: '无法确定mods目录' };
        }
        if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });

        const destPath = path.join(modsDir, primaryFile.filename);
        if (fs.existsSync(destPath)) {
            console.log(`[FabricAPI] ${primaryFile.filename} 已存在，跳过下载`);
            return { success: true, message: '已存在', fileName: primaryFile.filename };
        }

        if (onProgress) onProgress(0.3, `下载 Fabric API ${latestVersion.version_number}...`);
        console.log(`[FabricAPI] 下载: ${primaryFile.filename} (${primaryFile.url})`);

        await http.downloadFileWithMirror(primaryFile.url, destPath, (p) => {
            if (onProgress) onProgress(0.3 + p.progress * 0.007, `下载 Fabric API...`);
        });

        console.log(`[FabricAPI] 下载完成: ${primaryFile.filename}`);
        if (onProgress) onProgress(1, `Fabric API 安装完成`);
        return { success: true, fileName: primaryFile.filename, version: latestVersion.version_number };
    } catch (e) {
        console.error(`[FabricAPI] 自动下载失败: ${e.message}`);
        return { success: false, message: e.message };
    }
}

async function performInstallation(sessionId, versionDetails) {
    while (ctx._installMutex) {
        try { await ctx._installMutex; } catch (_) {}
    }
    let releaseMutex;
    ctx._installMutex = new Promise(resolve => { releaseMutex = resolve; });

    const session = ctx.sessions.installSessions.get(sessionId);
    if (!session) { releaseMutex(); ctx._installMutex = null; return; }

    const isAborted = () => {
        return session.status === 'cancelled' || (session._abortController && session._abortController.signal.aborted);
    };
    const abortCleanup = () => {
        if (speedSyncTimer) clearInterval(speedSyncTimer);
        const vd = path.join(ctx.dirs.VERSIONS_DIR, versionDetails.id);
        fs.promises.rm(vd, { recursive: true, force: true }).then(() => {
            console.log(`[Install] 已清理中止的安装: ${versionDetails.id}`);
        }).catch(() => {});
    };

    if (isAborted()) { abortCleanup(); return; }

    const STAGE_WEIGHTS = { version_json: 1, client_jar: 5, libraries: 15, natives: 1, assets: 20, loader: 10, finalizing: 1 };
    const TOTAL_WEIGHT = Object.values(STAGE_WEIGHTS).reduce((a, b) => a + b, 0);
    const calcProgress = (stage, stagePct) => {
        const stageNames = Object.keys(STAGE_WEIGHTS);
        let prevWeight = 0;
        for (const s of stageNames) {
            if (s === stage) break;
            prevWeight += STAGE_WEIGHTS[s];
        }
        return Math.min(99, Math.round(((prevWeight + stagePct * STAGE_WEIGHTS[stage]) / TOTAL_WEIGHT) * 100));
    };

    const versionId = versionDetails.id;
    const versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
    const backupDir = versionDir + '.backup';
    let hasBackup = false;

    if (fs.existsSync(versionDir)) {
        try {
            if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
            fs.renameSync(versionDir, backupDir);
            hasBackup = true;
            console.log(`[Install] Backed up existing version: ${versionId}`);
        } catch (e) {
            console.warn(`[Install] Failed to backup version: ${e.message}`);
        }
    }
    if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });

    try {
        if (isAborted()) { abortCleanup(); return; }
        session.status = 'downloading';
        session.stage = 'version_json';
        session.message = '下载版本信息...';
        session.progress = calcProgress('version_json', 0.5);

        var speedSyncTimer = setInterval(() => {
            if (session.status === 'downloading') {
                session.speed = ctx.DownloadManager.getSpeed();
            }
        }, 200);

        const versionJsonPath = path.join(versionDir, `${versionId}.json`);
        fs.writeFileSync(versionJsonPath, JSON.stringify(versionDetails, null, 2));
        versions._invalidateResolvedJsonCache(versionId);

        if (isAborted()) { abortCleanup(); return; }
        session.stage = 'client_jar';
        session.message = '下载游戏客户端..';
        session.progress = calcProgress('client_jar', 0);

        if (versionDetails.downloads?.client) {
            const clientInfo = versionDetails.downloads.client;
            const clientJarPath = path.join(versionDir, `${versionId}.jar`);

            if (!fs.existsSync(clientJarPath) || fs.statSync(clientJarPath).size !== clientInfo.size) {
                await http.downloadFileWithMirror(clientInfo.url, clientJarPath, (p) => {
                    session.progress = calcProgress('client_jar', p.progress / 100);
                    session.speed = p.speed;
                    session.bytesDownloaded = p.bytesDownloaded;
                    session.totalBytes = p.totalBytes;
                    session.currentFile = `${versionId}.jar`;
                    session.message = `下载客户端 ${utils.formatSize(p.bytesDownloaded)}/${utils.formatSize(p.totalBytes)}`;
                });

                if (clientInfo.sha1) {
                    session.message = '校验客户端文件..';
                    const sha1 = await utils.calculateSHA1(clientJarPath);
                    if (sha1 !== clientInfo.sha1) {
                        throw new Error(`客户端文件校验失败: SHA1不匹配`);
                    }
                }
            }
        }

        session.stage = 'libraries';
        session.message = '下载依赖库文件..';
        session.progress = calcProgress('libraries', 0);
        session.currentFile = '';
        session.speed = 0;

        const libraries = versionDetails.libraries || [];
        const validLibraries = libraries.filter(lib => {
            if (lib.rules) {
                return versions.evaluateRules(lib.rules);
            }
            return true;
        });

        session.totalFiles = validLibraries.length;
        session.completedFiles = 0;

        const settings = versions.loadSettingsCached();
        const LIB_PARALLEL = Math.min(parseInt(settings.maxThreads, 10) || 64, validLibraries.length);
        let libCompleted = 0;

        const downloadOneLib = async (lib, idx) => {
            if (isAborted()) return;

            if (lib.downloads?.artifact) {
                const artifact = lib.downloads.artifact;
                const libPath = artifact.path;
                let libUrl = artifact.url;
                if (!libUrl && lib.url) {
                    libUrl = lib.url + (lib.url.endsWith('/') ? '' : '/') + libPath;
                }
                const libFile = path.join(ctx.dirs.LIBRARIES_DIR, libPath);

                if (!fs.existsSync(libFile) || (artifact.size && fs.statSync(libFile).size !== artifact.size)) {
                    try {
                        await http.downloadFileWithMirror(libUrl, libFile, (p) => {
                            const libDone = (idx + p.progress / 100) / validLibraries.length;
                            session.progress = calcProgress('libraries', libDone);
                            session.speed = p.speed || ctx.DownloadManager.getSpeed();
                            session.bytesDownloaded = p.bytesDownloaded;
                            session.totalBytes = p.totalBytes;
                            session.message = `下载库文件 (${idx + 1}/${validLibraries.length}): ${path.basename(libPath)}`;
                        });

                        if (artifact.sha1) {
                            const sha1 = await utils.calculateSHA1(libFile);
                            if (sha1 !== artifact.sha1) {
                                console.warn(`Library SHA1 mismatch: ${libPath}`);
                                try { fs.unlinkSync(libFile); } catch (_) {}
                                session.errors.push(`库文件校验失败: ${libPath}`);
                            }
                        } else if (libFile.endsWith('.jar') && !utils.isJarIntact(libFile)) {
                            console.warn(`Library JAR corrupt after download: ${lib.name || libPath}`);
                            try { fs.unlinkSync(libFile); } catch (_) {}
                            session.errors.push(`库文件损坏: ${lib.name || libPath}`);
                        }
                    } catch (e) {
                        console.warn(`Failed to download library ${libPath}: ${e.message}`);
                        session.errors.push(`库文件下载失败: ${libPath}`);
                    }
                }
            } else if (lib.name) {
                const parts = lib.name.split(':');
                const libNameSuffix = parts.length >= 4 ? parts[3] : '';
                if (libNameSuffix.startsWith('natives-')) {
                    const currentPlatform = process.platform === 'win32' ? 'windows' :
                                           process.platform === 'darwin' ? 'osx' : 'linux';
                    const platformNative = libNameSuffix.replace('natives-', '');
                    let isValidPlatform = false;
                    if (process.arch === 'x64') {
                        isValidPlatform = platformNative === currentPlatform || platformNative === currentPlatform + '-x64';
                    } else if (process.arch === 'ia32') {
                        isValidPlatform = platformNative === currentPlatform + '-x86' || platformNative === currentPlatform;
                    } else if (process.arch === 'arm64') {
                        isValidPlatform = platformNative === currentPlatform + '-arm64' || platformNative === currentPlatform;
                    }
                    if (isValidPlatform && parts.length >= 4) {
                        const nGroupPath = parts[0].replace(/\./g, '/');
                        const nName = parts[1];
                        const nVer = parts[2];
                        const nClassifier = parts[3];
                        const nJarName = `${nName}-${nVer}-${nClassifier}.jar`;
                        const nativeFile = path.join(ctx.dirs.LIBRARIES_DIR, parts[0].replace(/\./g, path.sep), nName, nVer, nJarName);
                        if (!fs.existsSync(nativeFile)) {
                            const baseUrl = lib.url || 'https://libraries.minecraft.net/';
                            const nativeUrl = `${baseUrl}${nGroupPath}/${nName}/${nVer}/${nJarName}`;
                            try {
                                await http.downloadFileWithMirror(nativeUrl, nativeFile, (p) => {
                                    session.message = `下载原生库: ${nJarName}`;
                                });
                            } catch (e) {
                                console.warn(`Failed to download native ${lib.name}: ${e.message}`);
                                session.errors.push(`原生库下载失败: ${lib.name}`);
                            }
                        }
                    }
                } else if (parts.length >= 3) {
                    const groupPath = parts[0].replace(/\./g, '/');
                    const lname = parts[1];
                    const lversion = parts[2];
                    const classifier = parts.length >= 4 ? parts[3] : '';
                    const jarName = classifier ? `${lname}-${lversion}-${classifier}.jar` : `${lname}-${lversion}.jar`;
                    const libFile = path.join(ctx.dirs.LIBRARIES_DIR, parts[0].replace(/\./g, path.sep), lname, lversion, jarName);

                    if (!fs.existsSync(libFile)) {
                        const isNeoForgeLib = parts[0].includes('neoforged');
                        const isForgeLib = parts[0].includes('forge') || parts[0].includes('minecraftforge') || (parts[0] === 'net.minecraft' && lname !== 'client' && lname !== 'server');
                        const baseUrl = lib.url || (isNeoForgeLib ? 'https://maven.neoforged.net/' : (isForgeLib ? 'https://maven.minecraftforge.net/' : 'https://libraries.minecraft.net/'));
                        const downloadUrl = `${baseUrl}${groupPath}/${lname}/${lversion}/${jarName}`;

                        try {
                            await http.downloadFileWithMirror(downloadUrl, libFile, (p) => {
                                const libDone = (idx + p.progress / 100) / validLibraries.length;
                                session.progress = calcProgress('libraries', libDone);
                                session.message = `下载库文件 (${idx + 1}/${validLibraries.length}): ${jarName}`;
                            });
                            if (libFile.endsWith('.jar') && !utils.isJarIntact(libFile)) {
                                console.warn(`Library JAR corrupt after download: ${lib.name}`);
                                try { fs.unlinkSync(libFile); } catch (_) {}
                                session.errors.push(`库文件损坏: ${lib.name}`);
                            }
                        } catch (e) {
                            console.warn(`Failed to download library ${lib.name}: ${e.message}`);
                            session.errors.push(`库文件下载失败: ${lib.name}`);
                        }
                    }
                }
            }

            if (lib.natives) {
                const nativeKey = lib.natives[process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'];
                if (nativeKey) {
                    const classifier = nativeKey.replace('${arch}', process.arch === 'x64' ? '64' : '32');
                    const nativeDownload = lib.downloads?.classifiers?.[classifier];
                    if (nativeDownload) {
                        const nativeFile = path.join(ctx.dirs.LIBRARIES_DIR, nativeDownload.path);
                        if (!fs.existsSync(nativeFile)) {
                            try {
                                await http.downloadFileWithMirror(nativeDownload.url, nativeFile, (p) => {
                                    session.speed = p.speed || ctx.DownloadManager.getSpeed();
                                    session.bytesDownloaded = p.bytesDownloaded;
                                    session.totalBytes = p.totalBytes;
                                    session.message = `下载原生库: ${path.basename(nativeDownload.path)}`;
                                });
                            } catch (e) {
                                console.warn(`Failed to download native ${nativeDownload.path}: ${e.message}`);
                                session.errors.push(`原生库下载失败: ${path.basename(nativeDownload.path)}`);
                            }
                        }
                    }
                }
            }
        };

        {
            let libIndex = 0;
            let libActive = 0;
            let libDone = null;

            const scheduleNext = () => {
                while (libActive < LIB_PARALLEL && libIndex < validLibraries.length) {
                    if (isAborted()) break;
                    const curIdx = libIndex++;
                    libActive++;
                    session.currentFile = validLibraries[curIdx].name || 'unknown';
                    downloadOneLib(validLibraries[curIdx], curIdx).then(() => {
                        libCompleted++;
                        session.completedFiles = libCompleted;
                    }).catch(() => {}).finally(() => {
                        libActive--;
                        if (libActive === 0 && libIndex >= validLibraries.length && libDone) libDone();
                        else if (libActive < LIB_PARALLEL && libIndex < validLibraries.length) scheduleNext();
                    });
                }
            };

            await new Promise((resolve) => { libDone = resolve; scheduleNext(); });
        }

        session.completedFiles = validLibraries.length;

        session.stage = 'assets';
        session.message = '下载资源索引...';
        session.progress = calcProgress('assets', 0);
        session.currentFile = '';
        session.speed = 0;

        if (versionDetails.assetIndex) {
            const assetIndexInfo = versionDetails.assetIndex;
            const assetIndexDir = path.join(ctx.dirs.ASSETS_DIR, 'indexes');
            if (!fs.existsSync(assetIndexDir)) fs.mkdirSync(assetIndexDir, { recursive: true });

            const assetIndexPath = path.join(assetIndexDir, `${assetIndexInfo.id}.json`);

            if (!fs.existsSync(assetIndexPath) || (assetIndexInfo.sha1 && !(await utils.verifyFileSha1(assetIndexPath, assetIndexInfo.sha1)))) {
                if (fs.existsSync(assetIndexPath)) fs.unlinkSync(assetIndexPath);
                await http.downloadFileWithMirror(assetIndexInfo.url, assetIndexPath);
            }

            session.message = '解析资源文件列表...';
            session.progress = calcProgress('assets', 0.1);

            let assetIndexData;
            try {
                assetIndexData = JSON.parse(fs.readFileSync(assetIndexPath, 'utf-8'));
            } catch (e) {
                throw new Error('无法解析资源索引文件');
            }

            const assetObjects = assetIndexData.objects || {};
            const assetEntries = Object.entries(assetObjects);
            const totalAssets = assetEntries.length;

            const assetSubDirs = new Set();
            for (const [, info] of assetEntries) {
                assetSubDirs.add(info.hash.substring(0, 2));
            }
            for (const sub of assetSubDirs) {
                await fs.promises.mkdir(path.join(ctx.dirs.ASSETS_DIR, 'objects', sub), { recursive: true });
            }

            session.totalFiles = totalAssets;
            session.completedFiles = 0;
            session.message = `下载资源文件 (0/${totalAssets})...`;

            const ASSET_PARALLEL = Math.min(parseInt(settings.maxThreads, 10) || 64, 64);
            let assetIndex = 0;
            let assetActive = 0;
            let assetDone = null;
            let processedCount = 0;

            const scheduleNextAsset = () => {
                while (assetActive < ASSET_PARALLEL && assetIndex < assetEntries.length) {
                    if (isAborted()) break;
                    const [name, info] = assetEntries[assetIndex++];
                    assetActive++;
                    (async () => {
                        const hash = info.hash;
                        const subDir = hash.substring(0, 2);
                        const assetPath = path.join(ctx.dirs.ASSETS_DIR, 'objects', subDir, hash);
                        const assetUrl = `https://resources.download.minecraft.net/${subDir}/${hash}`;
                        let needDownload = false;
                        try {
                            const st = await fs.promises.stat(assetPath);
                            if (info.size && st.size !== info.size) needDownload = true;
                        } catch (e) {
                            needDownload = true;
                        }
                        if (needDownload) {
                            try {
                                await http.downloadFileWithMirror(assetUrl, assetPath, (p) => {
                                    session.speed = p.speed || ctx.DownloadManager.getSpeed();
                                    session.bytesDownloaded = p.bytesDownloaded;
                                    session.totalBytes = p.totalBytes;
                                });
                            } catch (e) {
                                session.errors.push(`资源下载失败: ${name}`);
                            }
                        }
                    })().then(() => {
                        processedCount++;
                        session.completedFiles = Math.min(processedCount, totalAssets);
                        const assetDone = processedCount / Math.max(totalAssets, 1);
                        session.progress = calcProgress('assets', 0.1 + assetDone * 0.9);
                        session.currentFile = `资源 ${processedCount}/${totalAssets}`;
                    }).catch(() => {}).finally(() => {
                        assetActive--;
                        if (assetActive === 0 && assetIndex >= assetEntries.length && assetDone) assetDone();
                        else if (assetActive < ASSET_PARALLEL && assetIndex < assetEntries.length) scheduleNextAsset();
                    });
                }
            };

            await new Promise((resolve) => { assetDone = resolve; scheduleNextAsset(); });
            session.message = `下载资源文件 (${processedCount}/${totalAssets})...`;

            if (assetIndexData.map_to_resources) {
                const resourcesDir = path.join(ctx.dirs.ASSETS_DIR, 'resources');
                if (!fs.existsSync(resourcesDir)) fs.mkdirSync(resourcesDir, { recursive: true });
                session.message = '映射资源文件到resources目录...';
                let mappedCount = 0;
                for (const [name, info] of assetEntries) {
                    const hash = info.hash;
                    const subDir = hash.substring(0, 2);
                    const sourcePath = path.join(ctx.dirs.ASSETS_DIR, 'objects', subDir, hash);
                    const destPath = path.join(resourcesDir, name);
                    if (fs.existsSync(sourcePath)) {
                        const destDir = path.dirname(destPath);
                        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                        try {
                            if (!fs.existsSync(destPath)) {
                                fs.copyFileSync(sourcePath, destPath);
                            }
                            mappedCount++;
                        } catch (e) {
                            console.warn(`[Assets] 映射资源失败: ${name}: ${e.message}`);
                        }
                    }
                }
                console.log(`[Assets] map_to_resources: 映射了 ${mappedCount} 个资源文件`);
            }

            if (assetIndexData.virtual) {
                const virtualDir = path.join(ctx.dirs.ASSETS_DIR, 'virtual', 'legacy');
                if (!fs.existsSync(virtualDir)) fs.mkdirSync(virtualDir, { recursive: true });
                session.message = '映射资源文件到virtual目录...';
                let virtualCount = 0;
                for (const [name, info] of assetEntries) {
                    const hash = info.hash;
                    const subDir = hash.substring(0, 2);
                    const sourcePath = path.join(ctx.dirs.ASSETS_DIR, 'objects', subDir, hash);
                    const destPath = path.join(virtualDir, name);
                    if (fs.existsSync(sourcePath)) {
                        const destDir = path.dirname(destPath);
                        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                        try {
                            if (!fs.existsSync(destPath)) {
                                fs.copyFileSync(sourcePath, destPath);
                            }
                            virtualCount++;
                        } catch (e) {
                            console.warn(`[Assets] 映射虚拟资源失败: ${name}: ${e.message}`);
                        }
                    }
                }
                console.log(`[Assets] virtual: 映射了 ${virtualCount} 个虚拟资源文件`);
            }
        }

        session.stage = 'natives';
        session.message = '提取原生库..';
        session.progress = calcProgress('natives', 0.5);
        session.currentFile = '';

        _server().extractNatives(versionDetails, versionId);

        session.stage = 'loader';
        session.message = '完成安装...';
        session.progress = calcProgress('loader', 0);

        await utils.sleep(300);

        if (session.loaderInfo && session.loaderInfo.type && session.loaderInfo.version) {
            if (session.status === 'cancelled') return;

            const gameVersion = versionDetails.inheritsFrom || versionId;
            session.stage = 'loader';
            session.message = '安装基础版本...';
            session.progress = calcProgress('loader', 0.1);

            try {
                const baseResult = await ensureBaseVersionInstalled(gameVersion);
                if (baseResult.error) {
                    session.errors.push(`基础版本安装失败: ${baseResult.error}`);
                }
            } catch (baseErr) {
                session.errors.push(`基础版本安装失败: ${baseErr.message}`);
            }

            if (session.status === 'cancelled') return;

            const loaderType = session.loaderInfo.type;
            const loaderVersion = session.loaderInfo.version;
            const forgeVersionId = `${gameVersion}-${loaderType}-${loaderVersion}`;

            session.progress = calcProgress('loader', 0.3);
            session.message = `正在安装${loaderType === 'neoforge' ? 'NeoForge' : loaderType.charAt(0).toUpperCase() + loaderType.slice(1)}模组加载器...`;

            try {
                let loaderResult = { success: true };
                const loaderProgress = (p, msg) => {
                    if (session.status === 'cancelled') return;
                    session.progress = calcProgress('loader', 0.3 + p * 0.65);
                    if (msg) session.message = msg;
                };

                if (loaderType === 'fabric') {
                    await mergeFabricLoaderToVersion(versionId, gameVersion, loaderVersion, loaderProgress);
                } else if (loaderType === 'forge') {
                    // [CRITICAL - 2026-06-21] 必须传 versionId 作为 targetVersionId！
                    // download 页面创建的版本目录用大写 Forge（如 "26.2-Forge-65.0.0"），
                    // installForge 默认用小写 forge（如 "26.2-forge-65.0.0"）。
                    // Windows NTFS 大小写不敏感，目录相同但文件名不同，会导致 JSON 被覆盖为原版。
                    // 传入 versionId 确保 installForge 写入正确的文件路径。
                    // 详见 installForge 函数顶部注释。
                    // [AI-AUTOGEN-WARNING] 不要删除 ", null, versionId"，否则 Forge 版本会启动为原版。
                    loaderResult = await installForge(gameVersion, loaderVersion, (p, msg) => {
                        if (session.status === 'cancelled') return;
                        session.progress = Math.min(94 + p * 4, 98);
                        session.message = msg || `正在安装Forge ${loaderVersion}...`;
                    }, null, versionId);
                    if (loaderResult.success && loaderResult.versionId) {
                        const versionJsonPath = path.join(ctx.dirs.VERSIONS_DIR, versionId, `${versionId}.json`);
                        if (fs.existsSync(versionJsonPath)) {
                            const vj = JSON.parse(fs.readFileSync(versionJsonPath, 'utf-8'));
                            vj.inheritsFrom = gameVersion;
                            fs.writeFileSync(versionJsonPath, JSON.stringify(vj, null, 2));
                            versions._invalidateResolvedJsonCache(versionId);
                        }
                    }
                } else if (loaderType === 'neoforge') {
                    await mergeNeoForgeLoaderToVersion(versionId, gameVersion, loaderVersion, loaderProgress);
                } else if (loaderType === 'optifine') {
                    await mergeOptiFineToVersion(versionId, gameVersion, loaderVersion, loaderProgress);
                }

                if (!loaderResult.success) {
                    session.status = 'failed';
                    session.stage = 'failed';
                    session.message = `Forge安装失败: ${loaderResult.error}`;
                    session.errors.push(loaderResult.error);
                    console.error(`[API-install] Forge安装失败: ${loaderResult.error}`);
                    return;
                }

                session.progress = calcProgress('loader', 0.95);
                session.message = '模组加载器安装完成';
            } catch (loaderErr) {
                session.status = 'failed';
                session.stage = 'failed';
                session.message = `模组加载器安装失败: ${loaderErr.message}`;
                session.errors.push(loaderErr.message);
                console.error(`[Loader] install failed:`, loaderErr.message);
                return;
            }

            const mergedJson = versions.resolveVersionJson(versionId);
            if (mergedJson) {
                _server().extractNatives(mergedJson, versionId);
            }
        }

        if (session.loaderInfo && session.loaderInfo.type === 'fabric') {
            if (session.status === 'cancelled') return;
            const gameVersionForApi = versionDetails.inheritsFrom || versionId.replace(/-.+$/, '');
            session.stage = 'finalizing';
            session.message = '正在下载 Fabric API...';
            session.progress = calcProgress('finalizing', 0.5);

            try {
                const apiResult = await autoDownloadFabricApi(gameVersionForApi, versionId, (p, msg) => {
                    if (session.status === 'cancelled') return;
                    session.progress = calcProgress('finalizing', 0.5 + p * 0.45);
                    if (msg) session.message = msg;
                });
                if (apiResult.success && apiResult.fileName) {
                    console.log(`[Install] Fabric API 已安装: ${apiResult.fileName}`);
                }
            } catch (apiErr) {
                console.warn(`[Install] Fabric API 自动下载失败 (非致命): ${apiErr.message}`);
            }
        }

        session.status = 'completed';
        session.stage = 'completed';
        session.message = `${versionId} 安装完成！`;
        session.progress = 100;
        session.speed = 0;
        if (speedSyncTimer) clearInterval(speedSyncTimer);

        if (hasBackup) {
            try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch (_) {}
        }

        ctx.caches._versionsCache = null;
        ctx.caches._versionsCacheTime = 0;

        console.log(`Installation completed: ${versionId}`);

    } catch (e) {
        if (speedSyncTimer) clearInterval(speedSyncTimer);
        session.status = 'failed';
        session.stage = 'failed';
        session.message = `安装失败: ${e.message}`;
        session.errors.push(e.message);
        console.error(`Installation failed for ${versionId}:`, e.message);

        try {
            const failedDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
            if (hasBackup && fs.existsSync(backupDir)) {
                if (fs.existsSync(failedDir)) fs.rmSync(failedDir, { recursive: true, force: true });
                fs.renameSync(backupDir, failedDir);
                console.log(`[Install] Restored backup for: ${versionId}`);
            } else if (fs.existsSync(failedDir)) {
                fs.rmSync(failedDir, { recursive: true, force: true });
                console.log(`[Install] Cleaned up failed version directory: ${failedDir}`);
            }
        } catch (cleanupErr) {
            console.error(`[Install] Failed to cleanup/restore:`, cleanupErr.message);
        }
    } finally {
        releaseMutex();
        ctx._installMutex = null;
    }
}

// ============================================================================
// 模块导出
// ============================================================================
module.exports = {
    // Forge core libs / patching
    downloadForgeCoreLibsFromMaven,
    downloadForgePatchingJars,
    findForgeCoreJars,
    findNeoForgeCoreJars,

    // Base version
    ensureBaseVersionInstalled,

    // Fabric
    installFabric,
    mergeFabricLoaderToVersion,
    getFabricLoaderVersions,
    getFabricLoaderVersionsForGame,
    autoDownloadFabricApi,

    // Loader verification / compat
    verifyLoaderLibs,
    compareSemver,
    parseVersionRequirement,
    scanModsForLoaderReqs,
    ensureLoaderCompat,
    verifyImportLibs,

    // Forge
    runForgeInstallerJar,
    installForge,
    mergeForgeLoaderToVersion,

    // Library helpers
    isLibValid,
    getNeoLibMirrorUrl,

    // NeoForge
    installNeoForge,
    mergeNeoForgeLoaderToVersion,
    getNeoForgeVersionsForGame,

    // OptiFine
    mergeOptiFineToVersion,

    // Installation orchestrator
    performInstallation,
};
