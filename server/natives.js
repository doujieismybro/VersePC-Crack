/**
 * server/natives.js - Natives 提取与离线皮肤注入模块
 * ============================================================================
 * 从 server.js 抽取的原生库（Natives）提取、Classpath 构建、离线皮肤注入/恢复等功能。
 * 通过 ctx (./context) 访问共享状态，通过 utils (./utils) 访问工具函数，
 * 通过 versions (./versions) 访问版本管理功能，通过 modloaders (./modloaders) 访问模组加载器功能。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ctx = require('./context');
const utils = require('./utils');
const versions = require('./versions');
const modloaders = require('./modloaders');

// ============================================================================
// 懒加载 server.js 中尚未抽取到子模块的函数 (避免循环依赖)
// ============================================================================
let _serverModule = null;
function _server() {
    if (_serverModule === null) {
        try { _serverModule = require('../server'); } catch (_) { _serverModule = {}; }
    }
    return _serverModule;
}

// ============================================================================
// Natives 目录三级回退，避免非ASCII路径导致 UnsatisfiedLinkError
// ============================================================================
function getNativesFolder(versionId) {
    const primary = path.join(ctx.dirs.VERSIONS_DIR, versionId, 'natives');
    const isAscii = /^[\x00-\x7F]*$/.test(primary);
    if (isAscii) return primary;

    const fallback1 = path.join(ctx.dirs.DATA_DIR, 'bin', 'natives');
    if (/^[\x00-\x7F]*$/.test(fallback1)) return fallback1;

    const fallback2 = path.join(os.homedir(), '.minecraft', 'bin', 'natives');
    if (/^[\x00-\x7F]*$/.test(fallback2)) return fallback2;

    const fallback3 = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'versepc-natives');
    return fallback3;
}

// ============================================================================
// Natives 提取
// ============================================================================
function extractNatives(versionJson, versionId, externalVersionDir = null) {
    const nativesDir = getNativesFolder(versionId);
    console.log(`[Natives] 目录: ${nativesDir}`);
    if (fs.existsSync(nativesDir)) {
        try { fs.rmSync(nativesDir, { recursive: true, force: true }); } catch (e) {}
    }
    fs.mkdirSync(nativesDir, { recursive: true });

    const nativeJars = [];

    const libraries = versionJson.libraries || [];
    const currentPlatform = process.platform === 'win32' ? 'windows' :
                             process.platform === 'darwin' ? 'osx' : 'linux';

    let externalRoot = null;
    if (externalVersionDir) {
        externalRoot = versions.findExternalRoot(externalVersionDir);
        if (!externalRoot) {
            externalRoot = path.dirname(path.dirname(externalVersionDir));
        }
    }

    const nativeSearchBases = [];
    if (externalRoot) {
        nativeSearchBases.push(path.join(externalRoot, 'libraries'));
    }
    nativeSearchBases.push(ctx.dirs.LIBRARIES_DIR);
    // 整合包的LWJGL natives可能来自用户已有的 .minecraft 目录
    const mcLibDir = path.join(ctx.dirs.MINECRAFT_DIR, 'libraries');
    if (mcLibDir !== ctx.dirs.LIBRARIES_DIR && fs.existsSync(mcLibDir)) {
        nativeSearchBases.push(mcLibDir);
    }

    function findNativeJar(baseHref) {
        for (const base of nativeSearchBases) {
            if (!base) continue;
            const p = path.join(base, baseHref);
            if (fs.existsSync(p)) return p;
        }
        return null;
    }

    function extractNativeJar(jarPath) {
        try {
            const AdmZip = require('adm-zip');
            const zip = new AdmZip(jarPath);
            const entries = zip.getEntries();
            let extracted = 0;
            for (const entry of entries) {
                const entryName = entry.entryName;
                if (entryName.startsWith('META-INF')) continue;
                if (entryName.startsWith('.')) continue;
                if (entryName.includes('/.git')) continue;
                if (entryName.endsWith('.gitkeep') || entryName.endsWith('.gitignore')) continue;
                if (entryName.endsWith('.sha1') || entryName.endsWith('.git')) continue;
                const ext = path.extname(entryName).toLowerCase();
                // 只解压原生二进制文件(.dll/.so/.dylib)，不解压配置文件
                // 配置文件冲突会导致模组加载异常
                const isNative = ext === '.dll' || ext === '.so' || ext === '.jnilib' || ext === '.dylib';
                if (isNative) {
                    const fileName = path.basename(entryName);
                    const destPath = path.join(nativesDir, fileName);
                    if (fs.existsSync(destPath)) {
                        try {
                            const existingStat = fs.statSync(destPath);
                            if (existingStat.size === entry.header.size) continue;
                        } catch (_) {}
                    }
                    try {
                        const data = entry.getData();
                        if (data && data.length > 0) {
                            fs.writeFileSync(destPath, data);
                            extracted++;
                            console.log(`[Natives] 解压: ${fileName} (${data.length} bytes)`);
                        }
                    } catch (writeErr) {
                        console.log(`[Natives] 写入失败 ${fileName}: ${writeErr.message}`);
                    }
                }
            }
            return extracted;
        } catch (e) {
            console.log(`[Natives] AdmZip失败: ${e.message}，尝试系统解压`);
            try {
                const tempDir = nativesDir + '_temp';
                if (fs.existsSync(tempDir)) {
                    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e2) {}
                }
                fs.mkdirSync(tempDir, { recursive: true });

                if (process.platform === 'win32') {
                    execSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
                        `Expand-Archive -Path '${jarPath.replace(/'/g, "''")}' -DestinationPath '${tempDir.replace(/'/g, "''")}' -Force`],
                        { stdio: 'pipe', timeout: 120000, windowsHide: true });
                } else {
                    execSync('unzip', ['-o', jarPath, '-d', tempDir, '-x', 'META-INF/*'], { stdio: 'pipe', timeout: 120000 });
                }

                let extracted = 0;
                function collectFiles(dir) {
                    const items = fs.readdirSync(dir);
                    for (const item of items) {
                        const itemPath = path.join(dir, item);
                        const stat = fs.statSync(itemPath);
                        if (stat.isDirectory()) {
                            collectFiles(itemPath);
                        } else {
                            const ext = path.extname(item).toLowerCase();
                            const isNative = ext === '.dll' || ext === '.so' || ext === '.jnilib' || ext === '.dylib';
                            if (isNative) {
                                const destPath = path.join(nativesDir, item);
                                fs.copyFileSync(itemPath, destPath);
                                extracted++;
                                console.log(`[Natives] 系统解压: ${item}`);
                            }
                        }
                    }
                }
                collectFiles(tempDir);

                try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e3) {}
                return extracted;
            } catch (e2) {
                console.log(`[Natives] 系统解压也失败: ${e2.message}`);
                return 0;
            }
        }
    }

    for (const lib of libraries) {
        if (lib.rules && !versions.evaluateRules(lib.rules)) continue;

        let nativePath = null;

        if (lib.natives) {
            const nativeKey = lib.natives[currentPlatform];
            if (!nativeKey) continue;

            const classifier = nativeKey.replace('${arch}', process.arch === 'x64' ? '64' : '32');
            const nativeDownload = lib.downloads?.classifiers?.[classifier];
            if (!nativeDownload) continue;

            nativePath = findNativeJar(nativeDownload.path);
        } else if (lib.name && lib.name.includes(':natives-')) {
            const nameParts = lib.name.split(':');
            const nativeSuffix = nameParts[nameParts.length - 1];

            if (!nativeSuffix.startsWith('natives-')) continue;

            const platformNative = nativeSuffix.replace('natives-', '');

            let isValidPlatform = false;
            if (process.arch === 'x64') {
                isValidPlatform = platformNative === currentPlatform || platformNative === currentPlatform + '-x64';
            } else if (process.arch === 'ia32') {
                isValidPlatform = platformNative === currentPlatform + '-x86' || platformNative === currentPlatform;
            } else if (process.arch === 'arm64') {
                isValidPlatform = platformNative === currentPlatform + '-arm64' || platformNative === currentPlatform;
            }

            if (!isValidPlatform) continue;

            if (lib.downloads?.artifact?.path) {
                nativePath = findNativeJar(lib.downloads.artifact.path);
            }
            if (!nativePath && lib.name) {
                const nparts = lib.name.split(':');
                if (nparts.length >= 4) {
                    const ngroupPath = nparts[0].replace(/\./g, path.sep);
                    const nname = nparts[1];
                    const nver = nparts[2];
                    const nclassifier = nparts[3];
                    const njarName = `${nname}-${nver}-${nclassifier}.jar`;
                    nativePath = findNativeJar(`${ngroupPath}${path.sep}${nname}${path.sep}${nver}${path.sep}${njarName}`);
                } else if (nparts.length >= 3) {
                    const ngroupPath = nparts[0].replace(/\./g, path.sep);
                    const nname = nparts[1];
                    const nver = nparts[2];
                    const njarName = `${nname}-${nver}.jar`;
                    nativePath = findNativeJar(`${ngroupPath}${path.sep}${nname}${path.sep}${nver}${path.sep}${njarName}`);
                }
            }
        }

        if (!nativePath || !fs.existsSync(nativePath)) continue;

        console.log(`[Natives] 提取: ${path.basename(nativePath)}`);
        nativeJars.push(nativePath);
        extractNativeJar(nativePath);
    }

    // === 合并 inheritsFrom 父版本 Natives ===
    const resolvedNativesParents = new Set();
    let currentNativesJson = versionJson;
    while (currentNativesJson.inheritsFrom && !resolvedNativesParents.has(currentNativesJson.inheritsFrom)) {
        resolvedNativesParents.add(currentNativesJson.inheritsFrom);
        const parentNativesPath = path.join(ctx.dirs.VERSIONS_DIR, currentNativesJson.inheritsFrom, `${currentNativesJson.inheritsFrom}.json`);
        if (!fs.existsSync(parentNativesPath)) {
            console.warn(`[Natives] 父版本JSON未找到(跳过natives): ${parentNativesPath}`);
            break;
        }
        try {
            const parentNativesJson = JSON.parse(fs.readFileSync(parentNativesPath, 'utf8'));
            currentNativesJson = parentNativesJson;
            const parentNativesLibs = (parentNativesJson.libraries || []).filter(lib => {
                if (lib.rules && !versions.evaluateRules(lib.rules)) return false;
                if (lib.natives) return true;
                if (lib.name && lib.name.includes(':natives-')) return true;
                return false;
            });
            if (parentNativesLibs.length > 0) {
                console.log(`[Natives] 从父版本 ${currentNativesJson.inheritsFrom || currentNativesJson.id} 合并 ${parentNativesLibs.length} 个 native 库`);
            }
            for (const lib of parentNativesLibs) {
                let nativePath = null;
                if (lib.natives) {
                    const nativeKey = lib.natives[currentPlatform];
                    if (!nativeKey) continue;
                    const classifier = nativeKey.replace('${arch}', process.arch === 'x64' ? '64' : '32');
                    const nativeDownload = lib.downloads?.classifiers?.[classifier];
                    if (!nativeDownload) continue;
                    nativePath = findNativeJar(nativeDownload.path);
                } else if (lib.name && lib.name.includes(':natives-')) {
                    const nameParts = lib.name.split(':');
                    const nativeSuffix = nameParts[nameParts.length - 1];
                    if (!nativeSuffix.startsWith('natives-')) continue;
                    const platformNative = nativeSuffix.replace('natives-', '');
                    let isValidPlatform = false;
                    if (process.arch === 'x64') {
                        isValidPlatform = platformNative === currentPlatform || platformNative === currentPlatform + '-x64';
                    } else if (process.arch === 'ia32') {
                        isValidPlatform = platformNative === currentPlatform + '-x86' || platformNative === currentPlatform;
                    } else if (process.arch === 'arm64') {
                        isValidPlatform = platformNative === currentPlatform + '-arm64' || platformNative === currentPlatform;
                    }
                    if (!isValidPlatform) continue;
                    if (lib.downloads?.artifact?.path) {
                        nativePath = findNativeJar(lib.downloads.artifact.path);
                    }
                    if (!nativePath && lib.name) {
                        const nparts = lib.name.split(':');
                        if (nparts.length >= 4) {
                            const ngroupPath = nparts[0].replace(/\./g, path.sep);
                            const njarName = `${nparts[1]}-${nparts[2]}-${nparts[3]}.jar`;
                            nativePath = findNativeJar(`${ngroupPath}${path.sep}${nparts[1]}${path.sep}${nparts[2]}${path.sep}${njarName}`);
                        } else if (nparts.length >= 3) {
                            const ngroupPath = nparts[0].replace(/\./g, path.sep);
                            const njarName = `${nparts[1]}-${nparts[2]}.jar`;
                            nativePath = findNativeJar(`${ngroupPath}${path.sep}${nparts[1]}${path.sep}${nparts[2]}${path.sep}${njarName}`);
                        }
                    }
                }
                if (!nativePath || !fs.existsSync(nativePath)) continue;
                console.log(`[Natives] 提取(父版本): ${path.basename(nativePath)}`);
                nativeJars.push(nativePath);
                extractNativeJar(nativePath);
            }
        } catch (e) { console.error(`[Natives] 父版本加载失败: ${e.message}`); break; }
    }

    const extractedFiles = fs.existsSync(nativesDir) ? fs.readdirSync(nativesDir) : [];
    console.log(`[Natives] 提取完成，共 ${extractedFiles.length} 个文件: ${extractedFiles.join(', ')}`);

    try {
        const AdmZipCleanup = require('adm-zip');
        const existingFiles = new Set();
        for (const nativeJar of nativeJars) {
            const zip = new AdmZipCleanup(nativeJar);
            for (const entry of zip.getEntries()) {
                if (entry.isDirectory) continue;
                const en = entry.entryName.toLowerCase();
                if (en.endsWith('.dll') || en.endsWith('.so') || en.endsWith('.dylib') || en.endsWith('.jnilib')) {
                    const fileName = path.basename(entry.entryName);
                    existingFiles.add(fileName.toLowerCase());
                }
            }
        }
        if (fs.existsSync(nativesDir)) {
            for (const f of fs.readdirSync(nativesDir)) {
                const fl = f.toLowerCase();
                if ((fl.endsWith('.dll') || fl.endsWith('.so') || fl.endsWith('.dylib') || fl.endsWith('.jnilib')) && !existingFiles.has(fl)) {
                    console.log('[Natives] Cleaned stale:', f);
                    try { fs.unlinkSync(path.join(nativesDir, f)); } catch (_) {}
                }
            }
        }
    } catch (_) {}

    return nativesDir;
}

// ============================================================================
// GC 参数检测
// ============================================================================
function hasGarbageCollectorArg(args) {
    const gcPatterns = [
        /-XX:\+Use[A-Z]\w*GC/,
        /-XX:-Use[A-Z]\w*GC/,
        /-XX:\+Use.*Collector/,
        /-XX:-Use.*Collector/
    ];
    return args.some(arg => gcPatterns.some(pattern => pattern.test(arg)));
}

// ============================================================================
// 离线皮肤注入/恢复
// ============================================================================
function injectOfflineSkin(versionJson, account, assetsRoot) {
    const backups = [];
    try {
        if (!account || account.type !== 'offline' || !account.skinFile) return backups;
        const skinPath = _server().resolveSkinPath(account.skinFile);
        if (!skinPath) return backups;
        const skinBuf = fs.readFileSync(skinPath);
        if (!skinBuf || skinBuf.length < 64) return backups;

        if (!assetsRoot) assetsRoot = ctx.dirs.ASSETS_DIR;

        const skinModel = account.skinModel || 'default';
        const isSlim = skinModel === 'slim';
        const primaryName = isSlim ? 'alex' : 'steve';
        const altName = isSlim ? 'steve' : 'alex';

        // Candidate skin paths across MC versions:
        // - Legacy (<=1.20.1): entity/<name>.png
        // - 1.20.2+: entity/player/<name>.png and entity/player/slim/<name>.png
        const primaryPaths = [
            `minecraft/textures/entity/${primaryName}.png`,
            `minecraft/textures/entity/player/${primaryName}.png`,
            `minecraft/textures/entity/player/slim/${primaryName}.png`,
        ];
        const altPaths = [
            `minecraft/textures/entity/${altName}.png`,
            `minecraft/textures/entity/player/${altName}.png`,
            `minecraft/textures/entity/player/slim/${altName}.png`,
        ];

        if (!fs.existsSync(ctx.dirs.SKIN_BACKUP_DIR)) fs.mkdirSync(ctx.dirs.SKIN_BACKUP_DIR, { recursive: true });

        const assetIndexId = versionJson.assetIndex?.id;
        if (assetIndexId) {
            let indexPath = path.join(assetsRoot, 'indexes', `${assetIndexId}.json`);
            if (!fs.existsSync(indexPath)) indexPath = path.join(ctx.dirs.ASSETS_DIR, 'indexes', `${assetIndexId}.json`);
            if (fs.existsSync(indexPath)) {
                const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

                for (const targetPath of primaryPaths) {
                    const obj = indexData.objects?.[targetPath];
                    if (obj && obj.hash) {
                        const hash = obj.hash;
                        const subDir = hash.substring(0, 2);
                        let objectPath = path.join(assetsRoot, 'objects', subDir, hash);
                        if (!fs.existsSync(objectPath)) objectPath = path.join(ctx.dirs.ASSETS_DIR, 'objects', subDir, hash);
                        if (fs.existsSync(objectPath)) {
                            const backupName = `${assetIndexId}_${hash}`;
                            const backupPath = path.join(ctx.dirs.SKIN_BACKUP_DIR, backupName);
                            if (!fs.existsSync(backupPath)) {
                                fs.copyFileSync(objectPath, backupPath);
                            }
                            fs.copyFileSync(skinPath, objectPath);
                            backups.push({ type: 'object', path: objectPath, backup: backupPath });
                            console.log(`[Skin] 已注入 ${targetPath} -> objects/${subDir}/${hash}`);
                        }
                    }
                }

                for (const altPath of altPaths) {
                    const altObj = indexData.objects?.[altPath];
                    if (altObj && altObj.hash) {
                        const altHash = altObj.hash;
                        const altSub = altHash.substring(0, 2);
                        let altObjectPath = path.join(assetsRoot, 'objects', altSub, altHash);
                        if (!fs.existsSync(altObjectPath)) altObjectPath = path.join(ctx.dirs.ASSETS_DIR, 'objects', altSub, altHash);
                        if (fs.existsSync(altObjectPath)) {
                            const altBackupName = `${assetIndexId}_${altHash}`;
                            const altBackupPath = path.join(ctx.dirs.SKIN_BACKUP_DIR, altBackupName);
                            if (!fs.existsSync(altBackupPath)) {
                                fs.copyFileSync(altObjectPath, altBackupPath);
                            }
                            backups.push({ type: 'object_no_replace', path: altObjectPath, backup: altBackupPath });
                        }
                    }
                }
            }
        }

        const virtualTargets = [];
        for (const targetPath of primaryPaths) {
            virtualTargets.push(path.join(assetsRoot, 'virtual', 'legacy', targetPath));
            virtualTargets.push(path.join(ctx.dirs.ASSETS_DIR, 'virtual', 'legacy', targetPath));
        }
        for (const vPath of virtualTargets) {
            if (fs.existsSync(vPath)) {
                const vBackup = path.join(ctx.dirs.SKIN_BACKUP_DIR, `virtual_${path.basename(vPath)}_${Date.now()}`);
                fs.copyFileSync(vPath, vBackup);
                fs.copyFileSync(skinPath, vPath);
                backups.push({ type: 'virtual', path: vPath, backup: vBackup });
                console.log(`[Skin] 已注入 virtual ${path.basename(vPath)}`);
            }
        }

        const gameDirBase = account.gameDir || '';
        const gameDirTargets = [];
        for (const targetPath of primaryPaths) {
            gameDirTargets.push(path.join(gameDirBase, 'resources', targetPath));
        }
        for (const gPath of gameDirTargets) {
            const gDir = path.dirname(gPath);
            if (fs.existsSync(path.dirname(gDir))) {
                if (!fs.existsSync(gDir)) fs.mkdirSync(gDir, { recursive: true });
                if (fs.existsSync(gPath)) {
                    const gBackup = path.join(ctx.dirs.SKIN_BACKUP_DIR, `gamedir_${path.basename(gPath)}_${Date.now()}`);
                    fs.copyFileSync(gPath, gBackup);
                    backups.push({ type: 'gamedir', path: gPath, backup: gBackup });
                }
                fs.copyFileSync(skinPath, gPath);
                backups.push({ type: 'gamedir_inject', path: gPath, backup: null });
                console.log(`[Skin] 已注入 gamedir ${path.basename(gPath)}`);
            }
        }
    } catch (e) {
        console.error('[Skin] 注入失败:', e.message);
    }
    return backups;
}

function restoreOfflineSkin(backups) {
    if (!backups || backups.length === 0) return;
    for (const b of backups) {
        try {
            if (b.type === 'object_no_replace') continue;
            if (b.backup && fs.existsSync(b.backup)) {
                fs.copyFileSync(b.backup, b.path);
            }
        } catch (e) {
            console.error('[Skin] 恢复失败:', b.path, e.message);
        }
    }
}

// ============================================================================
// Classpath 构建
// ============================================================================
function buildClasspath(versionJson, versionId, externalVersionDir = null) {
    const classpath = [];
    const libraries = versionJson.libraries || [];
    const isExternal = !!externalVersionDir;

    let externalRoot = null;
    if (isExternal) {
        externalRoot = versions.findExternalRoot(externalVersionDir);
        if (!externalRoot) {
            externalRoot = path.dirname(path.dirname(externalVersionDir));
        }
    }

    const searchBases = [];
    if (isExternal && externalRoot) {
        searchBases.push(path.join(externalRoot, 'libraries'));
    }
    searchBases.push(ctx.dirs.LIBRARIES_DIR);

    function mavenNameToPath(name) {
        const parts = name.split(':');
        if (parts.length < 3) return null;
        const groupPath = parts[0].replace(/\./g, '/');
        const artifactId = parts[1];
        const version = parts[2];
        const classifier = parts.length >= 4 ? `-${parts[3]}` : '';
        const jarName = `${artifactId}-${version}${classifier}.jar`;
        return `${groupPath}/${artifactId}/${version}/${jarName}`;
    }

    function findLibFile(relPath) {
        for (const base of searchBases) {
            if (!base) continue;
            const p = path.join(base, relPath);
            if (fs.existsSync(p)) return p;
        }
        return null;
    }

    function findLibByMavenName(name) {
        const relPath = mavenNameToPath(name);
        if (!relPath) return null;
        return findLibFile(relPath);
    }

    function findLibByFallback(name) {
        const parts = name.split(':');
        if (parts.length < 3) return null;
        const groupPath = parts[0].replace(/\./g, path.sep);
        const artifactId = parts[1];
        const version = parts[2];
        const classifier = parts.length >= 4 ? parts[3] : null;
        for (const base of searchBases) {
            if (!base) continue;
            const dir = path.join(base, groupPath, artifactId, version);
            if (!fs.existsSync(dir)) continue;
            try {
                const files = fs.readdirSync(dir).filter(f => f.endsWith('.jar') && !f.endsWith('-sources.jar') && !f.endsWith('-javadoc.jar'));
                if (files.length === 0) continue;
                if (classifier) {
                    const preferred = `${artifactId}-${version}-${classifier}.jar`;
                    const match = files.find(f => f === preferred);
                    if (match) return path.join(dir, match);
                }
                const preferred = `${artifactId}-${version}.jar`;
                const match = files.find(f => f === preferred);
                if (match) return path.join(dir, match);
                return path.join(dir, files[0]);
            } catch (e) {}
        }
        return null;
    }

    const currentPlatform = process.platform === 'win32' ? 'windows' :
                             process.platform === 'darwin' ? 'osx' : 'linux';

    let foundCount = 0;
    let missingCount = 0;
    let missingList = [];

    for (const lib of libraries) {
        if (lib.rules && !versions.evaluateRules(lib.rules)) continue;

        const libName = lib.name || '';
        const nameSuffix = libName ? libName.split(':').pop() : '';

        if (lib.natives) continue;

        if (nameSuffix.startsWith('natives-')) {
            const platformNative = nameSuffix.replace('natives-', '');
            let isValidPlatform = false;
            if (process.arch === 'x64') {
                isValidPlatform = platformNative === currentPlatform || platformNative === currentPlatform + '-x64';
            } else if (process.arch === 'ia32') {
                isValidPlatform = platformNative === currentPlatform + '-x86' || platformNative === currentPlatform;
            } else if (process.arch === 'arm64') {
                isValidPlatform = platformNative === currentPlatform + '-arm64' || platformNative === currentPlatform;
            }
            if (!isValidPlatform) continue;
        }

        let foundPath = null;

        if (lib.downloads?.artifact?.path) {
            foundPath = findLibFile(lib.downloads.artifact.path);
        }

        if (!foundPath && libName) {
            foundPath = findLibByMavenName(libName);
        }

        if (!foundPath && libName) {
            foundPath = findLibByFallback(libName);
        }

        if (foundPath) {
            classpath.push(foundPath);
            foundCount++;
        } else {
            missingCount++;
            missingList.push(libName);
        }
    }

    // === 合并 inheritsFrom 父版本库 ===
    const resolvedParents = new Set();
    let currentJson = versionJson;
    while (currentJson.inheritsFrom && !resolvedParents.has(currentJson.inheritsFrom)) {
        resolvedParents.add(currentJson.inheritsFrom);
        const parentJsonPath = path.join(ctx.dirs.VERSIONS_DIR, currentJson.inheritsFrom, `${currentJson.inheritsFrom}.json`);
        if (!fs.existsSync(parentJsonPath)) {
            console.warn(`[Classpath] 父版本JSON未找到: ${parentJsonPath}, 使用外部版本目录查找`);
            if (externalVersionDir) {
                const extVersionsDir = externalRoot ? path.join(externalRoot, 'versions') : path.dirname(path.dirname(externalVersionDir));
                const extParentPath = path.join(extVersionsDir, currentJson.inheritsFrom, `${currentJson.inheritsFrom}.json`);
                if (fs.existsSync(extParentPath)) {
                    try {
                        const parentJson = JSON.parse(fs.readFileSync(extParentPath, 'utf8'));
                        currentJson = parentJson;
                        const parentLibCount = (parentJson.libraries || []).length;
                        console.log(`[Classpath] 从外部目录加载父版本 ${currentJson.inheritsFrom}: ${parentLibCount} 库`);
                        for (const lib of (parentJson.libraries || [])) {
                            if (lib.rules && !versions.evaluateRules(lib.rules)) continue;
                            const libName = lib.name || '';
                            const nameSuffix = libName ? libName.split(':').pop() : '';
                            if (lib.natives) continue;
                            if (nameSuffix.startsWith('natives-')) {
                                let isValidPlatform = false;
                                const platformNative = nameSuffix.replace('natives-', '');
                                if (process.arch === 'x64') {
                                    isValidPlatform = platformNative === currentPlatform || platformNative === currentPlatform + '-x64';
                                } else if (process.arch === 'ia32') {
                                    isValidPlatform = platformNative === currentPlatform + '-x86' || platformNative === currentPlatform;
                                } else if (process.arch === 'arm64') {
                                    isValidPlatform = platformNative === currentPlatform + '-arm64' || platformNative === currentPlatform;
                                }
                                if (!isValidPlatform) continue;
                            }
                            // 去重: 检查是否已被子版本覆盖
                            const alreadyInCp = classpath.some(cp => {
                                if (!lib.name) return false;
                                const relPath = mavenNameToPath(lib.name);
                                return relPath && cp.endsWith(relPath);
                            });
                            if (alreadyInCp) continue;
                            let foundPath = null;
                            if (lib.downloads?.artifact?.path) foundPath = findLibFile(lib.downloads.artifact.path);
                            if (!foundPath && libName) foundPath = findLibByMavenName(libName);
                            if (!foundPath && libName) foundPath = findLibByFallback(libName);
                            if (foundPath) { classpath.push(foundPath); foundCount++; }
                            else { missingCount++; missingList.push(libName); }
                        }
                        continue;
                    } catch (e) { console.error(`[Classpath] 外部父版本加载失败: ${e.message}`); }
                }
            }
            console.warn(`[Classpath] 父版本缺失, 跳过继承: ${currentJson.inheritsFrom}`);
            break;
        }
        try {
            const parentJson = JSON.parse(fs.readFileSync(parentJsonPath, 'utf8'));
            currentJson = parentJson;
            const parentLibCount = (parentJson.libraries || []).length;
            console.log(`[Classpath] 合并父版本 ${currentJson.id || currentJson.inheritsFrom || '?'}: ${parentLibCount} 库`);
            for (const lib of (parentJson.libraries || [])) {
                if (lib.rules && !versions.evaluateRules(lib.rules)) continue;
                const libName = lib.name || '';
                const nameSuffix = libName ? libName.split(':').pop() : '';
                if (lib.natives) continue;
                if (nameSuffix.startsWith('natives-')) {
                    let isValidPlatform = false;
                    const platformNative = nameSuffix.replace('natives-', '');
                    if (process.arch === 'x64') {
                        isValidPlatform = platformNative === currentPlatform || platformNative === currentPlatform + '-x64';
                    } else if (process.arch === 'ia32') {
                        isValidPlatform = platformNative === currentPlatform + '-x86' || platformNative === currentPlatform;
                    } else if (process.arch === 'arm64') {
                        isValidPlatform = platformNative === currentPlatform + '-arm64' || platformNative === currentPlatform;
                    }
                    if (!isValidPlatform) continue;
                }
                // 去重: 检查是否已被子版本覆盖 (Forge版本库优先)
                const alreadyInCp = classpath.some(cp => {
                    if (!lib.name) return false;
                    const relPath = mavenNameToPath(lib.name);
                    return relPath && cp.endsWith(relPath);
                });
                if (alreadyInCp) continue;
                let foundPath = null;
                if (lib.downloads?.artifact?.path) foundPath = findLibFile(lib.downloads.artifact.path);
                if (!foundPath && libName) foundPath = findLibByMavenName(libName);
                if (!foundPath && libName) foundPath = findLibByFallback(libName);
                if (foundPath) { classpath.push(foundPath); foundCount++; }
                else { missingCount++; missingList.push(libName); }
            }
        } catch (e) { console.error(`[Classpath] 父版本加载失败 (${parentJsonPath}): ${e.message}`); break; }
    }

    // === Forge 核心 JAR 搜索 (Forge 1.13+) ===
    const forgeExtraJars = modloaders.findForgeCoreJars(versionJson, searchBases);
    for (const jar of forgeExtraJars) {
        classpath.push(jar);
        foundCount++;
    }

    const CORE_JAR_MARKERS = ['fmlcore', 'javafmllanguage', 'mclanguage', 'lowcodelanguage'];
    const hasAnyForgeCoreInCp = CORE_JAR_MARKERS.some(name => classpath.some(cp => cp.includes(name)));

    if (!hasAnyForgeCoreInCp && forgeExtraJars.length === 0) {
        const _gArgs = versionJson.arguments?.game || [];
        const _mainCls = versionJson.mainClass || '';
        const _isForge = _gArgs.some(a => typeof a === 'string' && a === 'forgeclient') ||
            _mainCls.toLowerCase().includes('bootstraplauncher');

        if (_isForge) {
            let _fv = '', _mv = '';
            const _fvi = _gArgs.findIndex(a => typeof a === 'string' && a === '--fml.forgeVersion');
            const _mvi = _gArgs.findIndex(a => typeof a === 'string' && a === '--fml.mcVersion');
            if (_fvi >= 0 && _fvi + 1 < _gArgs.length) _fv = _gArgs[_fvi + 1];
            if (_mvi >= 0 && _mvi + 1 < _gArgs.length) _mv = _gArgs[_mvi + 1];
            if (!_mv && versionJson.clientVersion) _mv = versionJson.clientVersion;

            if (!_fv || !_mv) {
                const _fl = libraries.find(l => l.name && (l.name.startsWith('net.minecraftforge:fmlloader:') || l.name.startsWith('net.minecraftforge:forge:')));
                if (_fl) {
                    const _p = _fl.name.split(':');
                    if (_p.length >= 3) {
                        const _di = _p[2].lastIndexOf('-');
                        if (_di > 0) { _mv = _p[2].substring(0, _di); _fv = _p[2].substring(_di + 1); }
                    }
                }
            }

            if (_fv && _mv) {
                const _vs = `${_mv}-${_fv}`;
                const _pfx = 'net/minecraftforge';
                const _coreArtifacts = [
                    { dir: `${_pfx}/fmlcore/${_vs}`, file: `fmlcore-${_vs}.jar`, name: 'fmlcore' },
                    { dir: `${_pfx}/javafmllanguage/${_vs}`, file: `javafmllanguage-${_vs}.jar`, name: 'javafmllanguage' },
                    { dir: `${_pfx}/mclanguage/${_vs}`, file: `mclanguage-${_vs}.jar`, name: 'mclanguage' },
                    { dir: `${_pfx}/lowcodelanguage/${_vs}`, file: `lowcodelanguage-${_vs}.jar`, name: 'lowcodelanguage' },
                ];
                const _missingNames = [];
                for (const artifact of _coreArtifacts) {
                    let found = false;
                    for (const base of searchBases) {
                        if (!base) continue;
                        if (fs.existsSync(path.join(base, artifact.dir, artifact.file))) { found = true; break; }
                    }
                    if (!found) {
                        _missingNames.push(artifact.name);
                    }
                }
                if (_missingNames.length > 0) {
                    console.warn(`[Classpath] Forge核心库缺失(不加入classpath): ${_missingNames.join(', ')} — JVM启动后Forge引导程序可能报Invalid paths argument，启动器将在启动前尝试自动补全`);
                }
            }
        }
    }

    if (missingList.length > 0) {
        console.warn(`[Classpath] 缺失库 (${missingList.length}): ${missingList.slice(0, 20).join(', ')}`);
    }

    const dedupedClasspath = [];
    const seenLibBases = new Map();
    for (const cp of classpath) {
        const baseName = path.basename(cp, '.jar');
        const dashParts = baseName.split('-');
        if (dashParts.length >= 2) {
            const libKey = dashParts.slice(0, -1).join('-');
            if (seenLibBases.has(libKey)) {
                const existingIdx = seenLibBases.get(libKey);
                const existingBase = path.basename(dedupedClasspath[existingIdx], '.jar');
                const existingVer = existingBase.split('-').pop();
                const newVer = dashParts[dashParts.length - 1];
                if (newVer > existingVer) {
                    dedupedClasspath[existingIdx] = cp;
                }
                continue;
            }
            seenLibBases.set(libKey, dedupedClasspath.length);
        }
        dedupedClasspath.push(cp);
    }

    const actualVersionId = versionId || versionJson.id || '';
    const jarPath = versions.findMainJar(versionJson, actualVersionId, externalVersionDir);

    const hasNeoforgeLib = dedupedClasspath.some(cp => cp.includes('neoforge') && cp.includes('universal'));
    if (!hasNeoforgeLib) {
        const isNeoForge = (versionJson.mainClass || '').includes('neoforge') || (versionJson.mainClass || '').includes('bootstraplauncher');
        if (isNeoForge || (versionJson.libraries || []).some(l => (l.name || '').includes('neoforged'))) {
            const neoforgeVersion = (versionJson.id || '').match(/NeoForge[_-]?([\d.]+)/i)?.[1] || '';
            if (neoforgeVersion) {
                for (const base of searchBases) {
                    const uniJar = path.join(base, 'net', 'neoforged', 'neoforge', neoforgeVersion, `neoforge-${neoforgeVersion}-universal.jar`);
                    if (fs.existsSync(uniJar)) {
                        dedupedClasspath.push(uniJar);
                        console.log(`[Classpath] 自动添加 NeoForge universal jar: ${uniJar}`);
                        break;
                    }
                }
            }
        }
    }

    if (jarPath && fs.existsSync(jarPath)) {
        dedupedClasspath.push(jarPath);
    } else {
        console.error(`[Classpath] 主JAR未找到: ${actualVersionId}, jar=${versionJson.jar || '无'}, inheritsFrom: ${versionJson.inheritsFrom || '无'}`);
    }

    console.log(`[Classpath] 构建: ${foundCount} 找到, ${missingCount} 缺失, 去重后: ${dedupedClasspath.length}`);
    return dedupedClasspath.join(process.platform === 'win32' ? ';' : ':');
}

module.exports = {
    getNativesFolder,
    extractNatives,
    hasGarbageCollectorArg,
    injectOfflineSkin,
    restoreOfflineSkin,
    buildClasspath,
};
