/**
 * server/versions.js - 版本管理功能模块
 * ============================================================================
 * 从 server.js 抽取的版本管理相关函数。
 * 通过 ctx (./context) 访问共享状态，通过 utils (./utils) 访问工具函数，
 * 通过 http (./http-client) 访问 HTTP 请求功能。
 */

const fs = require('fs');
const path = require('path');

const ctx = require('./context');
const utils = require('./utils');
const http = require('./http-client');

// ============================================================================
// 本地状态
// ============================================================================
let _versionsDirWatcher = null;

// ============================================================================
// 内部辅助函数 (不导出)
// ============================================================================

function loadSettingsCached() {
    const now = Date.now();
    if (ctx.caches._settingsCache && (now - ctx.caches._settingsCacheTime) < ctx.caches.SETTINGS_CACHE_TTL) {
        return ctx.caches._settingsCache;
    }
    const defaults = {
        javaPath: '',
        maxMemory: 4096,
        minMemory: 1024,
        gameDir: ctx.dirs.DATA_DIR,
        versionIsolation: true,
        javaArgs: '',
        fullscreen: false,
        resolution: '1920x1080',
        autoUpdate: true,
        closeOnLaunch: false,
        selectedVersion: '',
        selectedAccount: '',

        downloadSource: 'auto',
        versionSource: 'auto',
        maxThreads: 16,
        enableChunkDownload: true,
        maxChunksPerFile: 32,
        speedLimit: 0,
        targetDir: '',
        sslVerify: false,

        modSource: 'modrinth',
        filenameFormat: 'default',
        modStyle: 'title',
        ignoreQuilt: false,

        accentColor: '#4a9eff',
        blurBg: true,
        backgroundImage: '',
        avatarImage: '',
        autoSetChinese: true,
        jvmPreheat: true,
        enableCds: true
    };

    const saved = utils.safeReadJsonFile(ctx.dirs.SETTINGS_FILE, null);
    ctx.caches._settingsCache = saved ? { ...defaults, ...saved } : defaults;
    ctx.caches._settingsCacheTime = now;
    return ctx.caches._settingsCache;
}

function saveDiskCache() {
    try {
        const dir = path.dirname(ctx.dirs.DISK_CACHE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(ctx.dirs.DISK_CACHE_PATH, JSON.stringify({ data: ctx.caches.versionCache, timestamp: ctx.caches.versionCacheTime }));
    } catch (e) {}
}

function _invalidateResolvedJsonCache(versionId) {
    ctx.caches._resolvedJsonCache.delete(versionId);
    ctx.caches._resolvedJsonCacheTime.delete(versionId);
}

function findVersionJson(versionDir) {
    if (!fs.existsSync(versionDir) || !fs.statSync(versionDir).isDirectory()) return null;
    const dirName = path.basename(versionDir);
    const primaryJson = path.join(versionDir, `${dirName}.json`);
    if (fs.existsSync(primaryJson)) {
        try {
            const data = JSON.parse(fs.readFileSync(primaryJson, 'utf-8'));
            if (data.id || data.mainClass || data.inheritsFrom || data.libraries || data.minecraftArguments || data.arguments) {
                return primaryJson;
            }
        } catch (e) {}
    }
    try {
        const jsonFiles = fs.readdirSync(versionDir).filter(f => f.endsWith('.json'));
        for (const jsonFile of jsonFiles) {
            const fullPath = path.join(versionDir, jsonFile);
            try {
                const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
                if (!data.id && !data.inheritsFrom) continue;
                if (data.mainClass || data.libraries || data.inheritsFrom || data.minecraftArguments || data.arguments) {
                    return fullPath;
                }
            } catch (e) { continue; }
        }
    } catch (e) {}
    const packInfoPath = path.join(versionDir, 'pack-info.json');
    if (fs.existsSync(packInfoPath)) {
        try {
            const packInfo = JSON.parse(fs.readFileSync(packInfoPath, 'utf-8'));
            if (packInfo.mcVersion || packInfo.name) {
                let inheritsFrom = packInfo.mcVersion;
                if (packInfo.forgeVersion) inheritsFrom = `${packInfo.mcVersion}-forge-${packInfo.forgeVersion}`;
                else if (packInfo.neoforgeVersion) inheritsFrom = `${packInfo.mcVersion}-neoforge-${packInfo.neoforgeVersion}`;
                else if (packInfo.fabricVersion) inheritsFrom = `fabric-loader-${packInfo.fabricVersion}-${packInfo.mcVersion}`;
                const versionJson = {
                    id: dirName,
                    inheritsFrom: inheritsFrom || undefined,
                    type: 'release',
                    mainClass: inheritsFrom ? undefined : 'net.minecraft.client.main.Main',
                    time: packInfo.importedAt || new Date().toISOString(),
                    releaseTime: packInfo.importedAt || new Date().toISOString()
                };
                const vjPath = path.join(versionDir, `${dirName}.json`);
                fs.writeFileSync(vjPath, JSON.stringify(versionJson, null, 2));
                _invalidateResolvedJsonCache(dirName);
                console.log(`[findVersionJson] 从 pack-info.json 补建版本JSON: ${dirName}.json inheritsFrom=${inheritsFrom}`);
                return vjPath;
            }
        } catch (e) {}
    }
    return null;
}

function _findVersionJsonInAnyDir(versionId) {
    const internalPath = path.join(ctx.dirs.VERSIONS_DIR, versionId, `${versionId}.json`);
    if (fs.existsSync(internalPath)) return internalPath;
    try {
        const externalFolders = loadExternalFolders();
        for (const folder of externalFolders) {
            if (!fs.existsSync(folder.path)) continue;
            const extPath = path.join(folder.path, 'versions', versionId, `${versionId}.json`);
            if (fs.existsSync(extPath)) return extPath;
            const extDir = path.join(folder.path, 'versions', versionId);
            const altJson = findVersionJson(extDir);
            if (altJson) return altJson;
        }
    } catch (_) {}
    return null;
}

function _mergeInheritsChain(data, dirName) {
    const merged = { ...data };
    const visited = new Set();
    visited.add(data.id || dirName);
    let current = data;
    let depth = 0;
    while (current.inheritsFrom && depth < 10) {
        const parentId = current.inheritsFrom;
        if (visited.has(parentId)) break;
        visited.add(parentId);
        const parentJsonPath = _findVersionJsonInAnyDir(parentId);
        if (!parentJsonPath || !fs.existsSync(parentJsonPath)) break;
        try {
            const parentData = JSON.parse(fs.readFileSync(parentJsonPath, 'utf-8'));
            for (const key of Object.keys(parentData)) {
                if (key === 'id' || key === 'inheritsFrom' || key === 'type') continue;
                if (merged[key] === undefined) {
                    merged[key] = parentData[key];
                } else if (key === 'libraries' && Array.isArray(parentData[key])) {
                    merged.libraries = [...parentData[key], ...(merged.libraries || [])];
                } else if (key === 'arguments' && typeof parentData[key] === 'object') {
                    merged.arguments = merged.arguments || {};
                    if (parentData[key].game && (!merged.arguments.game || merged.arguments.game.length === 0)) merged.arguments.game = parentData[key].game;
                    if (parentData[key].jvm && (!merged.arguments.jvm || merged.arguments.jvm.length === 0)) merged.arguments.jvm = parentData[key].jvm;
                }
            }
            current = parentData;
        } catch (_) { break; }
        depth++;
    }
    return merged;
}

function detectVersionInfo(data, dirName) {
    const merged = _mergeInheritsChain(data, dirName);
    const versionIdLower = (data.id || dirName).toLowerCase();
    const mainClassLower = (merged.mainClass || '').toLowerCase();
    const librariesStr = JSON.stringify(merged.libraries || []).toLowerCase();
    const gameArgsStr = JSON.stringify(merged.arguments?.game || []).toLowerCase();
    const isBootStrap = mainClassLower.includes('bootstraplauncher');
    const hasNeoForgeGameArg = gameArgsStr.includes('--fml.neoforgeversion');
    const hasForgeGameArg = gameArgsStr.includes('--fml.forgeversion');
    const isFabric = mainClassLower.includes('fabric') || versionIdLower.includes('fabric') ||
        librariesStr.includes('net.fabricmc:fabric-loader') || librariesStr.includes('org.quiltmc:quilt-loader');
    const isForge = (mainClassLower.includes('forge') || mainClassLower.includes('modlauncher') || versionIdLower.includes('forge') ||
        librariesStr.includes('minecraftforge') ||
        (isBootStrap && (hasForgeGameArg || librariesStr.includes('net.minecraftforge')))) &&
        !versionIdLower.includes('neoforge') && !librariesStr.includes('net.neoforge') && !hasNeoForgeGameArg;
    const isNeoForge = versionIdLower.includes('neoforge') || librariesStr.includes('net.neoforge') ||
        hasNeoForgeGameArg || (isBootStrap && librariesStr.includes('neoforged')) ||
        (isBootStrap && hasForgeGameArg && (librariesStr.includes('neoforge') || gameArgsStr.includes('neoforge')));
    const isOptiFine = versionIdLower.includes('optifine') || librariesStr.includes('optifine:optifine');
    const isLiteLoader = versionIdLower.includes('liteloader') || librariesStr.includes('liteloader');
    const isAprilFools = ctx.constants.APRIL_FOOLS_IDS.has(versionIdLower);

    const bareMcPattern = /^\d+\.\d+(\.\d+)?(-\d+)?$/;
    const loaderIdPattern = /^(?:fabric-loader-\d|quilt-loader-\d|\d+\.\d+(?:\.\d+)?-(?:forge|neoforge)-\d)/;
    const versionId = data.id || dirName;
    const hasNoLoaderFlags = !isFabric && !isForge && !isNeoForge && !isOptiFine && !isLiteLoader;
    const hasInheritsFrom = !!data.inheritsFrom;
    const inheritsFromNonMc = hasInheritsFrom && !bareMcPattern.test(data.inheritsFrom);
    const isContentVanilla = hasNoLoaderFlags && !isBootStrap && !hasForgeGameArg && !hasNeoForgeGameArg &&
        (mainClassLower.includes('net.minecraft.client.main') || mainClassLower === '') &&
        !librariesStr.includes('net.minecraftforge') && !librariesStr.includes('net.fabricmc') && !librariesStr.includes('net.neoforge');
    const isModpack = !bareMcPattern.test(versionId) && !loaderIdPattern.test(versionId) && (!isContentVanilla || inheritsFromNonMc);

    if (isModpack) {
        let loaderType = '';
        if (isForge) loaderType = 'Forge';
        else if (isFabric) loaderType = 'Fabric';
        else if (isNeoForge) loaderType = 'NeoForge';
        let resolvedIsForge = isForge, resolvedIsFabric = isFabric, resolvedIsNeoForge = isNeoForge;
        let resolvedIsOptiFine = isOptiFine, resolvedIsLiteLoader = isLiteLoader;
        if (!loaderType && data.inheritsFrom) {
            const parentJsonPath = _findVersionJsonInAnyDir(data.inheritsFrom);
            if (parentJsonPath) {
                try {
                    const parentData = JSON.parse(fs.readFileSync(parentJsonPath, 'utf-8'));
                    const parentInfo = detectVersionInfo(parentData, data.inheritsFrom);
                    if (parentInfo.isForge) { loaderType = 'Forge'; resolvedIsForge = true; }
                    else if (parentInfo.isFabric) { loaderType = 'Fabric'; resolvedIsFabric = true; }
                    else if (parentInfo.isNeoForge) { loaderType = 'NeoForge'; resolvedIsNeoForge = true; }
                    if (parentInfo.isOptiFine) resolvedIsOptiFine = true;
                    if (parentInfo.isLiteLoader) resolvedIsLiteLoader = true;
                } catch (_) {}
            }
        }
        let baseVersion = data.inheritsFrom || '';
        if (data.inheritsFrom) {
            const parentJsonPath2 = _findVersionJsonInAnyDir(data.inheritsFrom);
            if (parentJsonPath2 && fs.existsSync(parentJsonPath2)) {
                try {
                    const parentData = JSON.parse(fs.readFileSync(parentJsonPath2, 'utf-8'));
                    if (parentData.inheritsFrom && bareMcPattern.test(parentData.inheritsFrom)) {
                        baseVersion = parentData.inheritsFrom;
                    }
                } catch (_) {}
            }
        }
        if (!baseVersion) {
            const mcVersionPattern = /(\d+\.\d+(?:\.\d+)?)/;
            if (isForge || isNeoForge) {
                const forgeMatch = librariesStr.match(/net\.minecraftforge:(?:forge|fmlloader):(\d+\.\d+(?:\.\d+)?)/);
                if (forgeMatch) baseVersion = forgeMatch[1];
                else {
                    const fmlMatch = data.arguments?.game?.find(a => typeof a === 'string' && a.startsWith('--fml.mcVersion'));
                    if (fmlMatch) {
                        const idx = data.arguments.game.indexOf(fmlMatch);
                        if (idx >= 0 && idx + 1 < data.arguments.game.length) baseVersion = data.arguments.game[idx + 1];
                    }
                }
            } else if (isFabric) {
                const fabricMatch = librariesStr.match(/net\.fabricmc:(?:fabric-loader|intermediary):(\d+\.\d+(?:\.\d+)?)/);
                if (fabricMatch) baseVersion = fabricMatch[1];
            }
            if (!baseVersion) {
                const idMatch = versionId.match(mcVersionPattern);
                if (idMatch) baseVersion = idMatch[1];
            }
        }
        return { isFabric: resolvedIsFabric, isForge: resolvedIsForge, isNeoForge: resolvedIsNeoForge, isOptiFine: resolvedIsOptiFine, isLiteLoader: resolvedIsLiteLoader, isModpack, modpackLoader: loaderType, baseVersion, isAprilFools };
    }

    if (data.inheritsFrom && !isFabric && !isForge && !isNeoForge && !isOptiFine && !isLiteLoader) {
        const parentJsonPath = path.join(ctx.dirs.VERSIONS_DIR, data.inheritsFrom, `${data.inheritsFrom}.json`);
        if (fs.existsSync(parentJsonPath)) {
            try {
                const parentData = JSON.parse(fs.readFileSync(parentJsonPath, 'utf-8'));
                const parentInfo = detectVersionInfo(parentData, data.inheritsFrom);
                if (parentInfo.isForge || parentInfo.isFabric || parentInfo.isNeoForge || parentInfo.isOptiFine || parentInfo.isLiteLoader) {
                    return { ...parentInfo, baseVersion: parentInfo.baseVersion || data.inheritsFrom, isAprilFools: parentInfo.isAprilFools || isAprilFools };
                }
            } catch (_) {}
        }
    }

    let baseVersion = data.inheritsFrom || data.id || dirName;
    if (!data.inheritsFrom) {
        const mcVersionPattern = /(\d+\.\d+(?:\.\d+)?(?:[_-]pre\d*|[-_]rc\d*|[-_]snapshot[-_]?\d*w\d*a?)?)/i;
        if (isForge || isNeoForge) {
            const forgeMatch = librariesStr.match(/net\.minecraftforge:(?:forge|fmlloader):(\d+\.\d+(?:\.\d+)?)/);
            if (forgeMatch) baseVersion = forgeMatch[1];
            else {
                const fmlMatch = data.arguments?.game?.find(a => typeof a === 'string' && a.startsWith('--fml.mcVersion'));
                if (fmlMatch) {
                    const idx = data.arguments.game.indexOf(fmlMatch);
                    if (idx >= 0 && idx + 1 < data.arguments.game.length) baseVersion = data.arguments.game[idx + 1];
                }
            }
        } else if (isFabric) {
            const fabricMatch = librariesStr.match(/net\.fabricmc:(?:fabric-loader|intermediary):(\d+\.\d+(?:\.\d+)?)/);
            if (fabricMatch) baseVersion = fabricMatch[1];
        }
        if (baseVersion === data.id || baseVersion === dirName) {
            const idMatch = (data.id || dirName).match(mcVersionPattern);
            if (idMatch) baseVersion = idMatch[1];
        }
    }
    return { isFabric, isForge, isNeoForge, isOptiFine, isLiteLoader, isModpack: false, modpackLoader: '', baseVersion, isAprilFools };
}

function findExternalRoot(versionDir) {
    let dir = versionDir;
    for (let i = 0; i < 8; i++) {
        if (fs.existsSync(path.join(dir, 'versions')) && fs.existsSync(path.join(dir, 'libraries'))) {
            return dir;
        }
        if (fs.existsSync(path.join(dir, 'versions')) && fs.existsSync(path.join(dir, 'assets'))) {
            return dir;
        }
        if (fs.existsSync(path.join(dir, 'versions'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

function findMainJar(versionJson, versionId, externalVersionDir = null, _visited = null) {
    const actualVersionId = versionId || versionJson.id || '';
    const jarName = versionJson.jar || versionJson.inheritsFrom || actualVersionId;

    const isExternal = !!externalVersionDir;
    let externalRoot = null;
    if (isExternal) {
        externalRoot = findExternalRoot(externalVersionDir);
        if (!externalRoot) externalRoot = path.dirname(path.dirname(externalVersionDir));
    }

    const searchPaths = [];

    if (versionJson.jar) {
        if (isExternal && externalRoot) {
            searchPaths.push(path.join(externalRoot, 'versions', versionJson.jar, `${versionJson.jar}.jar`));
        }
        searchPaths.push(path.join(ctx.dirs.VERSIONS_DIR, versionJson.jar, `${versionJson.jar}.jar`));
    }

    if (isExternal) {
        if (externalRoot) {
            searchPaths.push(path.join(externalRoot, 'versions', actualVersionId, `${actualVersionId}.jar`));
        }
        searchPaths.push(path.join(externalVersionDir, `${actualVersionId}.jar`));
        const dirName = path.basename(externalVersionDir);
        searchPaths.push(path.join(externalVersionDir, `${dirName}.jar`));
        if (externalRoot && dirName !== actualVersionId) {
            searchPaths.push(path.join(externalRoot, 'versions', dirName, `${dirName}.jar`));
        }
    }

    searchPaths.push(path.join(ctx.dirs.VERSIONS_DIR, actualVersionId, `${actualVersionId}.jar`));

    if (versionJson.inheritsFrom) {
        if (isExternal && externalRoot) {
            searchPaths.push(path.join(externalRoot, 'versions', versionJson.inheritsFrom, `${versionJson.inheritsFrom}.jar`));
            searchPaths.push(path.join(path.dirname(externalVersionDir), versionJson.inheritsFrom, `${versionJson.inheritsFrom}.jar`));
        }
        searchPaths.push(path.join(ctx.dirs.VERSIONS_DIR, versionJson.inheritsFrom, `${versionJson.inheritsFrom}.jar`));
    }

    for (const p of searchPaths) {
        if (fs.existsSync(p)) return p;
    }

    if (isExternal && externalRoot) {
        for (const jarId of [versionJson.jar, versionJson.inheritsFrom, actualVersionId]) {
            if (!jarId) continue;
            const verDir = path.join(externalRoot, 'versions', jarId);
            if (fs.existsSync(verDir)) {
                try {
                    const jars = fs.readdirSync(verDir).filter(f => f.endsWith('.jar'));
                    if (jars.length > 0) return path.join(verDir, jars[0]);
                } catch (e) {}
            }
        }
    }

    // Follow inheritsFrom chain recursively
    if (versionJson.inheritsFrom) {
        if (!_visited) _visited = new Set();
        if (_visited.has(versionJson.inheritsFrom)) {
            console.warn(`[FindMainJar] 继承链循环: ${[..._visited].join(' -> ')} -> ${versionJson.inheritsFrom}`);
            return null;
        }
        _visited.add(versionJson.inheritsFrom);

        const parentJsonPath = _findVersionJsonInAnyDir(versionJson.inheritsFrom);
        if (parentJsonPath && fs.existsSync(parentJsonPath)) {
            const parentBaseDir = path.dirname(parentJsonPath);
            try {
                const parentJson = JSON.parse(fs.readFileSync(parentJsonPath, 'utf-8'));
                const parentJar = findMainJar(parentJson, versionJson.inheritsFrom, parentBaseDir, _visited);
                if (parentJar) return parentJar;
            } catch (e) {}
            try {
                const jars = fs.readdirSync(parentBaseDir).filter(f => f.endsWith('.jar') && !f.endsWith('-sources.jar'));
                if (jars.length > 0) return path.join(parentBaseDir, jars[0]);
            } catch (e) {}
        }
    }

    // Final fallback: scan all version dirs for a base client jar
    {
        const allDirs = [
            path.join(ctx.dirs.VERSIONS_DIR, actualVersionId),
            ...(versionJson.inheritsFrom ? [path.join(ctx.dirs.VERSIONS_DIR, versionJson.inheritsFrom)] : [])
        ];
        if (isExternal && externalVersionDir) {
            allDirs.push(externalVersionDir);
            if (versionJson.inheritsFrom) {
                const parentJson = _findVersionJsonInAnyDir(versionJson.inheritsFrom);
                if (parentJson) allDirs.push(path.dirname(parentJson));
            }
        }
        const visitedParents = _visited || new Set();
        for (const d of allDirs) {
            if (visitedParents.has(path.basename(d))) continue;
            if (!fs.existsSync(d)) continue;
            try {
                const jsonFiles = fs.readdirSync(d).filter(f => f.endsWith('.json'));
                for (const jf of jsonFiles) {
                    try {
                        const jData = JSON.parse(fs.readFileSync(path.join(d, jf), 'utf-8'));
                        if (jData.downloads?.client?.url) {
                            const clientPath = path.join(d, jf.replace('.json', '.jar'));
                            if (fs.existsSync(clientPath)) return clientPath;
                            const innerJars = fs.readdirSync(d).filter(f => f.endsWith('.jar') && !f.endsWith('-sources.jar'));
                            if (innerJars.length > 0) return path.join(d, innerJars[0]);
                        }
                    } catch (_) {}
                }
            } catch (_) {}
        }
    }

    console.warn(`[FindMainJar] 未找到主JAR: versionId=${actualVersionId}, jar=${versionJson.jar || '无'}, inheritsFrom=${versionJson.inheritsFrom || '无'}, extDir=${externalVersionDir || '无'}`);
    console.warn(`[FindMainJar] 搜索路径:`, searchPaths.map(p => `${p}(${fs.existsSync(p)})`).join(', '));
    return null;
}

function detectModLoaderParent(data, externalVersionDir) {
    try {
    const versionId = data.id || '';

    if (versionId.toLowerCase().includes('neoforge') || versionId.toLowerCase().includes('neoforged')) {
        const m = versionId.match(/^(\d+\.\d+(?:\.\d+)?)/);
        if (m) return m[1];
    }

    if (versionId.toLowerCase().includes('forge') && !versionId.toLowerCase().includes('neoforge')) {
        const m = versionId.match(/^(\d+\.\d+(?:\.\d+)?)/);
        if (m) return m[1];
    }

    return null;
    } catch (e) {
        console.error('[DetectParent] 异常:', e.message);
        return null;
    }
}

function deduplicateJvmArgs(args) {
    if (!args || !Array.isArray(args) || args.length === 0) {
        return args || [];
    }

    const MULTI_VALUE_FLAGS = new Set(['--add-opens', '--add-exports', '--add-reads', '--add-modules']);
    const expanded = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (typeof arg === 'string' && MULTI_VALUE_FLAGS.has(arg)) {
            const values = [];
            while (i + 1 < args.length && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('-')) {
                i++;
                values.push(args[i]);
            }
            if (values.length === 0) {
                expanded.push(arg);
            } else {
                for (const v of values) { expanded.push(arg, v); }
            }
        } else {
            expanded.push(arg);
        }
    }

    const seenStringArgs = new Set();
    const result = [];

    for (let i = 0; i < expanded.length; i++) {
        const arg = expanded[i];

        if (typeof arg !== 'string') {
            result.push(arg);
            continue;
        }

        if (arg.startsWith('-D') || arg.startsWith('-X') || arg.startsWith('-XX')) {
            if (seenStringArgs.has(arg)) continue;
            seenStringArgs.add(arg);
            result.push(arg);
        } else {
            result.push(arg);
        }
    }

    const removedCount = args.length - result.length;
    if (removedCount > 0) {
        console.log(`[Dedup] Removed ${removedCount} duplicate JVM arguments`);
    }

    return result;
}

function deduplicateGameArgs(args) {
    if (!args || !Array.isArray(args) || args.length === 0) {
        return args || [];
    }

    const SINGLE_VALUE_OPTIONS = new Set([
        '--version', '--username', '--uuid', '--accessToken',
        '--userType', '--versionType', '--gameDir', '--assetsDir',
        '--assetIndex', '--width', '--height', '--server', '--port',
        '--xuid', '--clientId',
        '--launchTarget', '--fml.forgeVersion', '--fml.mcVersion',
        '--fml.forgeGroup', '--fml.mcpVersion', '--fml.neoForgeVersion',
        '--fml.neoFormVersion', '--fml.fmlVersion', '--fml.mcVersion'
    ]);

    const result = [];
    const seenOptions = new Set();

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (typeof arg !== 'string') {
            result.push(arg);
            continue;
        }

        if (SINGLE_VALUE_OPTIONS.has(arg)) {
            if (seenOptions.has(arg)) {
                if (i + 1 < args.length && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('--')) {
                    i++;
                }
                continue;
            }
            seenOptions.add(arg);
            result.push(arg);
            if (i + 1 < args.length && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('--')) {
                result.push(args[i + 1]);
                i++;
            }
        } else {
            result.push(arg);
        }
    }

    const removedCount = args.length - result.length;
    if (removedCount > 0) {
        console.log(`[Dedup] Removed ${removedCount} duplicate game arguments`);
    }

    return result;
}

function mergeVersionJson(parent, child) {
    const merged = { ...parent };
    const childKeys = Object.keys(child);

    for (const key of childKeys) {
        if (key === 'libraries') continue;
        if (key === 'arguments') continue;
        if (key === 'minecraftArguments') continue;
        if (key === 'downloads') continue;
        if (key === 'assetIndex') continue;
        if (key === 'javaVersion') {
            if (child[key] && child[key].majorVersion) {
                merged[key] = child[key];
            }
            continue;
        }
        if (child[key] !== undefined && child[key] !== null) {
            merged[key] = child[key];
        }
    }

    if (child.inheritsFrom) {
        merged.inheritsFrom = child.inheritsFrom;
    }
    if (child.id) {
        merged.id = child.id;
    }

    const childLibs = child.libraries || [];
    const parentLibs = parent.libraries || [];
    const childLibKeys = new Set();
    for (const lib of childLibs) {
        if (lib.name) {
            const parts = lib.name.split(':');
            if (parts.length >= 2) childLibKeys.add(parts[0] + ':' + parts[1]);
        }
    }
    // 过滤父版本库：如果子版本已有相同 group:artifact 的库则跳过
    // 同时处理命名变体（如 bootstraplauncher vs bootstrapslauncher 带/不带 s）
    const normalizedChildKeys = new Set();
    for (const key of childLibKeys) {
        normalizedChildKeys.add(key);
        // 生成规范化 key（去掉尾部 s 变体，如 bootstraplauncher↔bootstrapslauncher）
        const parts = key.split(':');
        if (parts.length >= 2) {
            const base = parts[1].replace(/s$/, ''); // 去掉末尾的 s
            normalizedChildKeys.add(`${parts[0]}:${base}`);
            normalizedChildKeys.add(`${parts[0]}:${base}s`); // 加回 s
        }
    }

    const filteredParentLibs = parentLibs.filter(lib => {
        if (!lib.name) return true;
        const parts = lib.name.split(':');
        if (parts.length >= 2 && normalizedChildKeys.has(parts[0] + ':' + parts[1])) return false;
        // 也检查规范化后的名称
        if (parts.length >= 2) {
            const base = parts[1].replace(/s$/, '');
            if (normalizedChildKeys.has(`${parts[0]}:${base}`)) return false;
        }
        return true;
    });
    merged.libraries = [...childLibs, ...filteredParentLibs];

    merged.arguments = merged.arguments || {};
    const childJvm = child.arguments?.jvm || [];
    const parentJvm = parent.arguments?.jvm || [];
    const childGame = child.arguments?.game || [];
    const parentGame = parent.arguments?.game || [];

    if (child.minecraftArguments && !child.arguments?.jvm && !child.arguments?.game) {
        merged.arguments.jvm = parentJvm;
        merged.arguments.game = parentGame;
    } else {
        if (childJvm.length > 0 || parentJvm.length > 0) {
            merged.arguments.jvm = deduplicateJvmArgs([...childJvm, ...parentJvm]);
        }
        if (childGame.length > 0 || parentGame.length > 0) {
            merged.arguments.game = deduplicateGameArgs([...childGame, ...parentGame]);
        }
    }

    // Also merge Fabric/NeoForge non-standard argument groups
    for (const argGroupKey of ['default-user-jvm', 'default-user-game', 'default-jvm', 'default-game']) {
        const childGroup = child.arguments?.[argGroupKey] || [];
        const parentGroup = parent.arguments?.[argGroupKey] || [];
        if (childGroup.length > 0 || parentGroup.length > 0) {
            merged.arguments[argGroupKey] = [...childGroup, ...parentGroup];
        }
    }

    if (child.minecraftArguments) {
        merged.minecraftArguments = child.minecraftArguments;
    } else if (parent.minecraftArguments) {
        merged.minecraftArguments = parent.minecraftArguments;
    }

    if (child.mainClass) {
        merged.mainClass = child.mainClass;
    }

    if (child.downloads) {
        merged.downloads = { ...parent.downloads, ...child.downloads };
    }
    if (child.assetIndex) {
        merged.assetIndex = child.assetIndex;
    } else if (parent.assetIndex) {
        merged.assetIndex = parent.assetIndex;
    }
    if (child.javaVersion) {
        merged.javaVersion = child.javaVersion;
    } else if (parent.javaVersion) {
        merged.javaVersion = parent.javaVersion;
    }
    if (child.jar) {
        merged.jar = child.jar;
    } else if (parent.jar) {
        merged.jar = parent.jar;
    }
    if (child.assets) {
        merged.assets = child.assets;
    } else if (parent.assets) {
        merged.assets = parent.assets;
    }
    if (child.type) {
        merged.type = child.type;
    }

    if (merged.mainClass && merged.mainClass.startsWith('net.fabricmc')) {
        const libs = merged.libraries || [];
        const hasFabricLoader = libs.some(l => l.name && l.name.startsWith('net.fabricmc:fabric-loader'));
        const hasIntermediary = libs.some(l => l.name && l.name.startsWith('net.fabricmc:intermediary'));
        if (!hasFabricLoader || !hasIntermediary) {
            const versionId = child.id || merged.id || '';
            let loaderVer = '0.16.10';
            let mcVer = '';
            const versePcMatch = versionId.match(/fabric-loader-(\d+\.\d+\.\d+)-(.+)/);
            const pcl2Match = versionId.match(/-Fabric-(\d+\.\d+\.\d+)/);
            if (versePcMatch) { loaderVer = versePcMatch[1]; mcVer = versePcMatch[2]; }
            else if (pcl2Match) { loaderVer = pcl2Match[1]; }
            if (!mcVer) {
                const mcMatch = (merged.inheritsFrom || versionId).match(/(\d+\.\d+(?:\.\d+)?)/);
                if (mcMatch) mcVer = mcMatch[1];
            }
            const newLibs = [];
            if (!hasFabricLoader) {
                const loaderJarName = `fabric-loader-${loaderVer}.jar`;
                console.log(`[MergeJson] 自动修复: 添加 fabric-loader ${loaderVer}`);
                newLibs.push({
                    name: `net.fabricmc:fabric-loader:${loaderVer}`,
                    url: 'https://maven.fabricmc.net/',
                    downloads: {
                        artifact: {
                            path: `net/fabricmc/fabric-loader/${loaderVer}/${loaderJarName}`,
                            url: `https://maven.fabricmc.net/net/fabricmc/fabric-loader/${loaderVer}/${loaderJarName}`
                        }
                    }
                });
            }
            if (!hasIntermediary && mcVer) {
                const interJarName = `intermediary-${mcVer}.jar`;
                console.log(`[MergeJson] 自动修复: 添加 intermediary ${mcVer}`);
                newLibs.push({
                    name: `net.fabricmc:intermediary:${mcVer}`,
                    url: 'https://maven.fabricmc.net/',
                    downloads: {
                        artifact: {
                            path: `net/fabricmc/intermediary/${mcVer}/${interJarName}`,
                            url: `https://maven.fabricmc.net/net/fabricmc/intermediary/${mcVer}/${interJarName}`
                        }
                    }
                });
            }
            if (newLibs.length > 0) {
                merged.libraries = [...newLibs, ...libs];
            }
        }
    }

    return merged;
}

function resolveVersionJson(versionId, externalVersionDir = null, visited = null) {
    if (!visited) visited = new Set();
    if (visited.has(versionId)) return null;
    visited.add(versionId);

    const cached = ctx.caches._resolvedJsonCache.get(versionId);
    const cachedTime = ctx.caches._resolvedJsonCacheTime.get(versionId);
    if (cached && cachedTime && (Date.now() - cachedTime < ctx.caches.RESOLVED_JSON_CACHE_TTL)) {
        return JSON.parse(JSON.stringify(cached));
    }

    let versionDir, jsonFile;
    if (externalVersionDir) {
        versionDir = externalVersionDir;
        jsonFile = findVersionJson(versionDir);
    } else {
        versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
        jsonFile = findVersionJson(versionDir);
    }
    if (!jsonFile || !fs.existsSync(jsonFile)) return null;

    const data = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
    if (!data.inheritsFrom) {
        const detectedParent = detectModLoaderParent(data, externalVersionDir);
        if (detectedParent) {
            data.inheritsFrom = detectedParent;
            console.log(`[ResolveJson] 内存修正 ${versionId} 的 inheritsFrom: ${detectedParent}（不写回磁盘）`);
        }
    }
    if (data.inheritsFrom) {
        let parentVersionDir = null;
        const searchPaths = [];
        if (externalVersionDir) {
            const externalRoot = findExternalRoot(externalVersionDir);
            if (externalRoot) {
                searchPaths.push(path.join(externalRoot, 'versions', data.inheritsFrom));
            }
            searchPaths.push(path.join(path.dirname(externalVersionDir), data.inheritsFrom));
            const externalFolders = loadExternalFolders();
            for (const folder of externalFolders) {
                if (!fs.existsSync(folder.path)) continue;
                const candidate = path.join(folder.path, 'versions', data.inheritsFrom);
                if (!searchPaths.includes(candidate)) searchPaths.push(candidate);
            }
        }
        searchPaths.push(path.join(ctx.dirs.VERSIONS_DIR, data.inheritsFrom));

        for (const searchDir of searchPaths) {
            if (findVersionJson(searchDir)) {
                parentVersionDir = searchDir;
                break;
            }
        }

        if (parentVersionDir) {
            const isParentExternal = parentVersionDir !== path.join(ctx.dirs.VERSIONS_DIR, data.inheritsFrom);
            const parentJson = resolveVersionJson(data.inheritsFrom, isParentExternal ? parentVersionDir : null, visited);
            if (parentJson) {
                const result = mergeVersionJson(parentJson, data);
                if (result && !result.error) {
                    ctx.caches._resolvedJsonCache.set(versionId, JSON.parse(JSON.stringify(result)));
                    ctx.caches._resolvedJsonCacheTime.set(versionId, Date.now());
                }
                return result;
            }
        }

        console.warn(`[ResolveVersion] Parent version not found: ${data.inheritsFrom}`);
    }
    if (data && !data.error) {
        if (data.arguments?.jvm) {
            data.arguments.jvm = deduplicateJvmArgs(data.arguments.jvm);
        }
        ctx.caches._resolvedJsonCache.set(versionId, JSON.parse(JSON.stringify(data)));
        ctx.caches._resolvedJsonCacheTime.set(versionId, Date.now());
    }
    return data;
}

// ============================================================================
// 导出函数
// ============================================================================

function watchVersionsDir() {
    if (_versionsDirWatcher) return;
    if (!fs.existsSync(ctx.dirs.VERSIONS_DIR)) return;
    try {
        _versionsDirWatcher = fs.watch(ctx.dirs.VERSIONS_DIR, { persistent: false }, (eventType) => {
            ctx.caches._versionsCache = null;
            ctx.caches._versionsCacheTime = 0;
        });
        _versionsDirWatcher.on('error', () => {
            _versionsDirWatcher = null;
            setTimeout(watchVersionsDir, 10000);
        });
    } catch (e) {}
}

function loadVersions() {
    try {
        if (fs.existsSync(ctx.dirs.VERSIONS_DATA_FILE)) {
            return JSON.parse(fs.readFileSync(ctx.dirs.VERSIONS_DATA_FILE, 'utf-8'));
        }
    } catch (e) {}
    return [];
}

function saveVersions(versionsData) {
    fs.writeFileSync(ctx.dirs.VERSIONS_DATA_FILE, JSON.stringify(versionsData, null, 2));
}

function findVersionChain(versionId) {
    const chain = [];
    const visited = new Set();

    const addWithParents = (id) => {
        if (visited.has(id)) return;
        visited.add(id);
        chain.push(id);
        const dir = path.join(ctx.dirs.VERSIONS_DIR, id);
        const jp = findVersionJson(dir);
        if (!jp) return;
        try {
            const data = JSON.parse(fs.readFileSync(jp, 'utf-8'));
            if (data.inheritsFrom && !visited.has(data.inheritsFrom)) {
                addWithParents(data.inheritsFrom);
            }
        } catch (_) {}
    };

    addWithParents(versionId);

    if (!fs.existsSync(ctx.dirs.VERSIONS_DIR)) return chain;
    try {
        const allDirs = fs.readdirSync(ctx.dirs.VERSIONS_DIR);
        for (const dir of allDirs) {
            if (visited.has(dir)) continue;
            const verDir = path.join(ctx.dirs.VERSIONS_DIR, dir);
            try { if (!fs.statSync(verDir).isDirectory()) continue; } catch (_) { continue; }
            const jp = findVersionJson(verDir);
            if (!jp) continue;
            try {
                const data = JSON.parse(fs.readFileSync(jp, 'utf-8'));
                const parentId = data.inheritsFrom;
                if (parentId) {
                    let ancestor = parentId;
                    let depth = 0;
                    const ancestors = new Set();
                    while (ancestor && depth < 10) {
                        ancestors.add(ancestor);
                        if (visited.has(ancestor)) {
                            visited.add(dir);
                            chain.push(dir);
                            break;
                        }
                        const aDir = path.join(ctx.dirs.VERSIONS_DIR, ancestor);
                        const aJp = findVersionJson(aDir);
                        if (!aJp) break;
                        try {
                            const aData = JSON.parse(fs.readFileSync(aJp, 'utf-8'));
                            ancestor = aData.inheritsFrom || null;
                        } catch (_) { break; }
                        depth++;
                    }
                }
            } catch (_) {}
        }
    } catch (_) {}

    return chain;
}

function cleanupVersionChain(versionId) {
    const chain = findVersionChain(versionId);
    const vanillaPattern = /^\d+\.\d+(\.\d+)?(-rc\d+|-pre\d+|-snapshot.*)?$/i;
    const toDelete = [];
    for (const id of chain) {
        if (vanillaPattern.test(id) && id !== versionId) {
            console.log(`[Cleanup] 跳过原版版本: ${id}`);
            continue;
        }
        toDelete.push(id);
    }
    if (!toDelete.includes(versionId)) toDelete.push(versionId);

    console.log(`[Cleanup] 版本链: ${chain.join(' → ')}`);
    console.log(`[Cleanup] 将删除: ${toDelete.join(', ')}`);

    const results = [];
    for (const id of toDelete) {
        const dir = path.join(ctx.dirs.VERSIONS_DIR, id);
        if (!fs.existsSync(dir)) {
            results.push({ id, deleted: true, reason: '目录不存在' });
            continue;
        }
        let deleted = false;
        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
                console.log(`[Cleanup] 已删除: ${id}`);
                deleted = true;
                break;
            } catch (e) {
                console.error(`[Cleanup] 删除 ${id} 失败 (第${attempt}次): ${e.message}`);
                if (attempt < 5) {
                    const delayMs = attempt * 1000;
                    const start = Date.now();
                    while (Date.now() - start < delayMs) {}
                }
            }
        }
        results.push({ id, deleted, reason: deleted ? '' : '文件可能被占用，请关闭游戏后重试' });
    }

    console.log(`[Cleanup] 完成: ${toDelete.join(', ')}`);
    return { toDelete, results };
}

function cleanupIncompleteVersion(versionDir) {
    if (!fs.existsSync(versionDir)) return;
    try {
        fs.rmSync(versionDir, { recursive: true, force: true });
        console.log(`[Cleanup] 删除不完整版本目录: ${path.basename(versionDir)}`);
    } catch (e) {
        console.error(`[Cleanup] 删除失败: ${versionDir} - ${e.message}`);
    }
}

function isVersionComplete(versionId) {
    const versionJson = resolveVersionJson(versionId);
    if (!versionJson) return false;

    if (versionJson.inheritsFrom) {
        const extFolders = loadExternalFolders();
        let parentJsonFound = false;
        const parentJsonSearchPaths = [];
        for (const folder of extFolders) {
            if (fs.existsSync(path.join(folder.path, 'versions', versionJson.inheritsFrom, `${versionJson.inheritsFrom}.json`))) {
                parentJsonSearchPaths.push(path.join(folder.path, 'versions', versionJson.inheritsFrom, `${versionJson.inheritsFrom}.json`));
            }
        }
        parentJsonSearchPaths.push(path.join(ctx.dirs.VERSIONS_DIR, versionJson.inheritsFrom, `${versionJson.inheritsFrom}.json`));
        for (const p of parentJsonSearchPaths) {
            if (fs.existsSync(p)) { parentJsonFound = true; break; }
        }
        if (!parentJsonFound) return false;

        if (!versionJson.jar) {
            const mainJarPath = findMainJar(versionJson, versionId);
            if (!mainJarPath || !fs.existsSync(mainJarPath)) return false;
        }
    }

    const mainJarPath = path.join(ctx.dirs.VERSIONS_DIR, versionId, `${versionId}.jar`);
    if (!versionJson.inheritsFrom && !fs.existsSync(mainJarPath)) return false;

    const _vLower = versionId.toLowerCase();
    const _isNeoForge = _vLower.includes('neoforge') || _vLower.includes('neoforged');
    const isForgeChain = (_vLower.includes('forge') && !_isNeoForge) ||
        (versionJson.inheritsFrom && versionJson.inheritsFrom.toLowerCase().includes('forge') && !versionJson.inheritsFrom.toLowerCase().includes('neoforge'));
    if (isForgeChain && versionJson.libraries) {
        let forgeCoreMissing = 0;
        const mcVer = versionJson.inheritsFrom || '';
        const mcMajor = parseInt((mcVer.split('.')[1] || '0'), 10);
        const isNewForgeFormat = mcMajor >= 20;
        for (const lib of versionJson.libraries) {
            if (!lib.name) continue;
            const fp = lib.name.split(':');
            if (fp.length < 3) continue;
            const gp = fp[0].replace(/\./g, path.sep);
            const cl = fp.length >= 4 ? `-${fp[3]}` : '';
            const jn = `${fp[1]}-${fp[2]}${cl}.jar`;
            const localPath = path.join(ctx.dirs.LIBRARIES_DIR, gp, fp[1], fp[2], jn);
            let found = fs.existsSync(localPath);
            if (!found) {
                const extFolders = loadExternalFolders();
                for (const folder of extFolders) {
                    const extPath = path.join(folder.path, 'libraries', gp, fp[1], fp[2], jn);
                    if (fs.existsSync(extPath)) { found = true; break; }
                }
            }
            const isOldFormatSrgOrExtra = fp[0] === 'net.minecraft' && fp[1] === 'client' && (fp[3] === 'srg' || fp[3] === 'extra');
            if (isNewForgeFormat && isOldFormatSrgOrExtra) continue;
            const isForgeCore = (
                (fp[0] === 'net.minecraftforge' && fp[1] === 'forge') ||
                isOldFormatSrgOrExtra
            );
            if (isForgeCore && !found) {
                forgeCoreMissing++;
                console.log(`[isVersionComplete] ${versionId}: Forge核心库缺失: ${jn}`);
            }
        }
        if (forgeCoreMissing > 0) {
            console.log(`[isVersionComplete] ${versionId}: ${forgeCoreMissing}个Forge核心库缺失，标记为不完整`);
            return false;
        }
    }

    return true;
}

function validateInstalledVersions() {
    console.log('[Startup] 验证已安装版本完整性...');
    if (!fs.existsSync(ctx.dirs.VERSIONS_DIR)) return;

    const issues = [];
    try {
        const dirs = fs.readdirSync(ctx.dirs.VERSIONS_DIR);
        for (const dir of dirs) {
            const versionDir = path.join(ctx.dirs.VERSIONS_DIR, dir);
            try {
                if (!fs.statSync(versionDir).isDirectory()) continue;
            } catch (e) { continue; }

            const jsonFile = findVersionJson(versionDir);
            if (!jsonFile) {
                issues.push({ dir, reason: '版本 JSON 文件缺失' });
                continue;
            }

            try {
                JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
            } catch (e) {
                issues.push({ dir, reason: `版本 JSON 损坏: ${e.message}` });
            }
        }
    } catch (e) {
        console.error(`[Startup] 版本扫描失败: ${e.message}`);
    }

    if (issues.length > 0) {
        console.log(`[Startup] 发现 ${issues.length} 个问题版本: ${issues.map(i => i.dir).join(', ')}`);
    }
}

async function getVersionManifest(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && ctx.caches.versionCache && (now - ctx.caches.versionCacheTime) < ctx.caches.CACHE_DURATION) {
        return ctx.caches.versionCache;
    }

    const urls = [
        ctx.urls.VERSION_MANIFEST_MIRROR,
        'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
        'https://bmclapi2.bangbang93.com/mc/game/version_manifest.json',
        ctx.urls.VERSION_MANIFEST_URL
    ];

    const fetchWithValidation = async (url) => {
        const manifest = await http.fetchJSON(url);
        if (manifest && manifest.versions && manifest.versions.length > 0) {
            return manifest;
        }
        throw new Error('Invalid manifest from ' + url);
    };

    try {
        const manifest = await Promise.any(urls.map(url =>
            fetchWithValidation(url).catch(() => { throw new Error(url + ' failed'); })
        ));
        ctx.caches.versionCache = manifest;
        ctx.caches.versionCacheTime = now;
        saveDiskCache();
        return manifest;
    } catch (e) {
        console.error('All version manifest sources failed');
    }

    if (!forceRefresh && ctx.caches.versionCache) return ctx.caches.versionCache;

    try {
        if (fs.existsSync(ctx.dirs.DISK_CACHE_PATH)) {
            const cached = JSON.parse(fs.readFileSync(ctx.dirs.DISK_CACHE_PATH, 'utf8'));
            if (cached && cached.data && cached.data.versions && cached.data.versions.length > 0) {
                ctx.caches.versionCache = cached.data;
                ctx.caches.versionCacheTime = cached.timestamp || 0;
                console.log('[VersionManifest] Using disk cache as fallback');
                return ctx.caches.versionCache;
            }
        }
    } catch (e) {}

    throw new Error('无法获取版本列表，请检查网络连接');
}

async function getVersionDetails(versionUrl) {
    if (ctx.caches.versionDetailsCache[versionUrl]) {
        return ctx.caches.versionDetailsCache[versionUrl];
    }
    try {
        const details = await http.fetchJSON(versionUrl);
        ctx.caches.versionDetailsCache[versionUrl] = details;
        return details;
    } catch (e) {
        console.error('Failed to fetch version details:', e.message);
        throw e;
    }
}

function fixModpackInheritsFrom(installed, loaderIdPattern) {
    const bareMcVersionPattern = /^\d+\.\d+(\.\d+)?$/;
    for (const v of installed) {
        if (!v.inheritsFrom || v.isExternal) continue;
        if (loaderIdPattern.test(v.id)) continue;
        if (!bareMcVersionPattern.test(v.inheritsFrom)) continue;
        const baseMcId = v.inheritsFrom;
        const candidates = installed.filter(l =>
            l.inheritsFrom === baseMcId &&
            !l.isExternal &&
            l.id !== v.id &&
            (l.isForge || l.isFabric || l.isNeoForge || l.isOptiFine || l.isLiteLoader)
        );
        if (candidates.length === 0) continue;
        let parentLoader = candidates[0];
        if (candidates.length > 1) {
            const modpackJsonPath = path.join(ctx.dirs.VERSIONS_DIR, v.id, `${v.id}.json`);
            if (fs.existsSync(modpackJsonPath)) {
                try {
                    const modpackData = JSON.parse(fs.readFileSync(modpackJsonPath, 'utf-8'));
                    const libsStr = JSON.stringify(modpackData.libraries || []);
                    const mainClass = modpackData.mainClass || '';
                    const gameArgs = JSON.stringify(modpackData.arguments?.game || []);
                    const isFabricModpack = libsStr.includes('net.fabricmc') || mainClass.includes('fabric') || gameArgs.includes('fabric');
                    const isForgeModpack = libsStr.includes('net.minecraftforge') || mainClass.includes('forge') || gameArgs.includes('forge');
                    const isNeoForgeModpack = libsStr.includes('net.neoforged') || mainClass.includes('neoforged') || gameArgs.includes('neoforge');
                    if (isFabricModpack) {
                        const fabricCandidate = candidates.find(c => c.isFabric);
                        if (fabricCandidate) parentLoader = fabricCandidate;
                    } else if (isNeoForgeModpack) {
                        const neoCandidate = candidates.find(c => c.isNeoForge);
                        if (neoCandidate) parentLoader = neoCandidate;
                    } else if (isForgeModpack) {
                        const forgeCandidate = candidates.find(c => c.isForge);
                        if (forgeCandidate) parentLoader = forgeCandidate;
                    }
                } catch (e) {}
            }
        }
        const modpackJsonPath = path.join(ctx.dirs.VERSIONS_DIR, v.id, `${v.id}.json`);
        if (!fs.existsSync(modpackJsonPath)) continue;
        try {
            const modpackData = JSON.parse(fs.readFileSync(modpackJsonPath, 'utf-8'));
            if (modpackData.inheritsFrom === baseMcId) {
                modpackData.inheritsFrom = parentLoader.id;
                fs.writeFileSync(modpackJsonPath, JSON.stringify(modpackData, null, 2));
                v.inheritsFrom = parentLoader.id;
            }
        } catch (e) {}
    }
}

function correctVersionType(v) {
    const id = v.id || '';
    const idLower = id.toLowerCase();
    const type = v.type || 'release';

    if (ctx.constants.APRIL_FOOLS_IDS.has(idLower)) {
        return 'special';
    }

    if (type === 'snapshot' || type === 'pending') {
        if (id.startsWith('1.') &&
            !idLower.includes('combat') &&
            !idLower.includes('rc') &&
            !idLower.includes('experimental') &&
            !idLower.includes('pre') &&
            idLower !== '1.2') {
            return 'release';
        }
    }

    if (type === 'snapshot' || type === 'pending') {
        if (v.releaseTime) {
            try {
                const d = new Date(v.releaseTime);
                const utc2 = new Date(d.getTime() + 2 * 3600 * 1000);
                if (utc2.getUTCMonth() === 3 && utc2.getUTCDate() === 1) {
                    return 'special';
                }
            } catch (_) {}
        }
    }

    return type;
}

function getInstalledVersions(forceRefresh) {
    const now = Date.now();
    if (!forceRefresh && ctx.caches._versionsCache && (now - ctx.caches._versionsCacheTime) < ctx.caches.VERSIONS_CACHE_TTL) {
        return ctx.caches._versionsCache;
    }
    const installed = [];
    if (!fs.existsSync(ctx.dirs.VERSIONS_DIR)) return installed;
    const skipFolders = new Set(['cache', 'blclient', 'pcl', 'temp']);
    try {
        const dirs = fs.readdirSync(ctx.dirs.VERSIONS_DIR);
        for (const dir of dirs) {
            const versionDir = path.join(ctx.dirs.VERSIONS_DIR, dir);
            try {
                if (!fs.statSync(versionDir).isDirectory()) continue;
                if (skipFolders.has(dir.toLowerCase())) continue;
            } catch (e) { continue; }
            const jsonFile = findVersionJson(versionDir);
            if (jsonFile) {
                try {
                    const data = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
                    const info = detectVersionInfo(data, dir);
                    let inheritsFrom = data.inheritsFrom || null;
                    if (!inheritsFrom && (info.isNeoForge || info.isForge)) {
                        const m = (data.id || dir).match(/^(\d+\.\d+(?:\.\d+)?(?:-rc\d+|-pre\d+|-snapshot.*)?)/i);
                        if (m) inheritsFrom = m[1];
                    }
                    if (inheritsFrom && !data.inheritsFrom) data.inheritsFrom = inheritsFrom;
                    installed.push({
                        id: data.id || dir,
                        type: info.isAprilFools ? 'special' : (data.type || 'release'),
                        releaseTime: data.releaseTime || '',
                        mainClass: data.mainClass || '',
                        installed: true,
                        inheritsFrom: inheritsFrom,
                        isFabric: info.isFabric,
                        isForge: info.isForge,
                        isNeoForge: info.isNeoForge,
                        isOptiFine: info.isOptiFine,
                        isLiteLoader: info.isLiteLoader,
                        isModpack: info.isModpack,
                        modpackLoader: info.modpackLoader,
                        baseVersion: info.baseVersion,
                        isAprilFools: info.isAprilFools || false,
                        isExternal: false,
                        isolation: true,
                        hasMods: false,
                        hasSaves: false,
                        hasResourcepacks: false,
                        error: false,
                        errorReason: '',
                        customName: '',
                        description: ''
                    });
                } catch (e) {
                    console.log(`[Versions] 跳过无效版本目录 ${dir}: ${e.message}`);
                }
            } else {
                console.log(`[Versions] 跳过无JSON的目录 ${dir}`);
            }
        }
    } catch (e) {}

    const externalFolders = loadExternalFolders();
    for (const folder of externalFolders) {
        if (!fs.existsSync(folder.path)) continue;
        const externalVersions = scanExternalFolder(folder.path);
        for (const ev of externalVersions) {
            const existingIdx = installed.findIndex(v => v.id === ev.id);
            if (existingIdx >= 0) {
                let suffix = 2;
                let newId = ev.id + ' [外部' + (suffix > 1 ? suffix : '') + ']';
                while (installed.some(v => v.id === newId)) {
                    suffix++;
                    newId = ev.id + ' [外部' + suffix + ']';
                }
                ev.id = newId;
                ev.originalId = ev.id.replace(/ \[外部\d*\]/, '');
            }
            installed.push(ev);
        }
    }

    const loaderIdPattern = /^(?:fabric-loader-\d|quilt-loader-\d|\d+\.\d+(?:\.\d+)?-(?:forge|neoforge)-\d)/;

    fixModpackInheritsFrom(installed, loaderIdPattern);

    const installedMap = new Map();
    for (const v of installed) {
        installedMap.set(v.id, v);
        if (v.isExternal && v.id.includes(' [外部')) {
            installedMap.set(v.id.replace(/ \[外部\d*\]/, ''), v);
        }
    }

    const inheritsFromIds = new Set();
    for (const v of installed) {
        if (!v.inheritsFrom) continue;
        let parentId = v.inheritsFrom;
        while (parentId) {
            if (inheritsFromIds.has(parentId)) break;
            inheritsFromIds.add(parentId);
            const parent = installedMap.get(parentId);
            if (!parent || !parent.inheritsFrom) break;
            parentId = parent.inheritsFrom;
        }
    }

    const externalIdMap = new Map();
    for (const v of installed) {
        if (v.isExternal && v.id.includes(' [外部')) {
            externalIdMap.set(v.id.replace(/ \[外部\d*\]/, ''), v.id);
        }
    }
    for (const baseId of [...inheritsFromIds]) {
        const externalId = externalIdMap.get(baseId);
        if (externalId) inheritsFromIds.add(externalId);
    }

    // [CRITICAL - 2026-06-21] 只隐藏纯原版基础版本，不隐藏加载器版本
    // 旧逻辑：隐藏所有被 inheritsFrom 引用的版本（包括 Forge/Fabric 版本）
    // 问题：用户安装整合包后，fixModpackInheritsFrom 把整合包的 inheritsFrom 指向 Forge 版本，
    //       导致 Forge 版本被隐藏（"版本消失"），但文件夹还在。
    // 修复：只隐藏没有加载器的原版基础版本（如 "26.2", "1.20.1"），
    //       加载器版本（Forge/Fabric/NeoForge）永远显示。
    // [AI-AUTOGEN-WARNING] 不要改回旧的过滤逻辑，否则用户安装整合包后加载器版本会消失。
    const result = installed.filter(v => {
        if (v.error) return true;
        if (!inheritsFromIds.has(v.id)) return true;
        if (v.isForge || v.isFabric || v.isNeoForge || v.isOptiFine || v.isLiteLoader) return true;
        if (loaderIdPattern.test(v.id)) return true;
        return false;
    });

    ctx.caches._versionsCache = result;
    ctx.caches._versionsCacheTime = Date.now();
    return result;
}

function getVersionLocalDetails(versionId) {
    const cleanId = versionId.replace(/ \[外部\d*\]/, '');
    const isExternal = versionId.includes(' [外部');

    let versionDir;
    if (isExternal) {
        const extFolders = loadExternalFolders();
        const extFolder = extFolders.find(f => fs.existsSync(path.join(f.path, 'versions', cleanId)));
        if (extFolder) {
            versionDir = path.join(extFolder.path, 'versions', cleanId);
        }
    }
    if (!versionDir) {
        versionDir = path.join(ctx.dirs.VERSIONS_DIR, cleanId);
    }

    const hasMods = fs.existsSync(path.join(versionDir, 'mods'));
    const hasSaves = fs.existsSync(path.join(versionDir, 'saves'));
    const hasResourcepacks = fs.existsSync(path.join(versionDir, 'resourcepacks'));

    let error = false;
    let errorReason = '';
    const jsonFile = findVersionJson(versionDir);
    if (jsonFile) {
        try {
            const data = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
            const inheritsFrom = data.inheritsFrom;
            if (inheritsFrom) {
                const parentDir = path.join(ctx.dirs.VERSIONS_DIR, inheritsFrom);
                const parentJson = findVersionJson(parentDir);
                if (!parentJson) {
                    let foundInExternal = false;
                    const extFolders = loadExternalFolders();
                    for (const ef of extFolders) {
                        if (!fs.existsSync(ef.path)) continue;
                        const extParentDir = path.join(ef.path, 'versions', inheritsFrom);
                        if (findVersionJson(extParentDir)) { foundInExternal = true; break; }
                    }
                    if (!foundInExternal) {
                        const hasMainClass = !!data.mainClass;
                        const hasLibraries = Array.isArray(data.libraries) && data.libraries.length > 0;
                        const hasForgeLibs = hasLibraries && data.libraries.some(l => l.name && (
                            l.name.includes('net.minecraftforge') || l.name.includes('fancymodloader') ||
                            l.name.includes('net.neoforged') || l.name.includes('fabric-loader')
                        ));
                        const info = detectVersionInfo(data, cleanId);
                        if ((info.isForge || info.isNeoForge) && (hasMainClass || hasForgeLibs)) {
                            console.log(`[Versions] 外部Forge版本 ${cleanId} 缺少前置 ${inheritsFrom}，但自身包含完整配置，视为可用`);
                        } else {
                            error = true;
                            errorReason = `需要安装 ${inheritsFrom} 作为前置版本`;
                        }
                    }
                }
            }
        } catch (e) {}
    }

    let customName = '';
    let description = '';
    try {
        const vs = loadVersionSettings(cleanId);
        customName = vs.customName || '';
        description = vs.description || '';
    } catch (e) {}

    return { hasMods, hasSaves, hasResourcepacks, error, errorReason, customName, description };
}

function resolveVersionIsolation(versionId) {
    if (!versionId || versionId.includes(' [外部')) return !!versionId;

    const settings = loadSettingsCached();
    const verSettings = loadVersionSettings(versionId);

    let effectiveIsolation;
    if (verSettings.isolation === 'on') {
        effectiveIsolation = true;
    } else if (verSettings.isolation === 'off') {
        effectiveIsolation = false;
    } else {
        effectiveIsolation = settings.versionIsolation !== false;
    }

    if (!effectiveIsolation) {
        const versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
        const modsDir = path.join(versionDir, 'mods');
        const savesDir = path.join(versionDir, 'saves');
        const modsHasFiles = fs.existsSync(modsDir) && fs.readdirSync(modsDir).some(f => !f.startsWith('.'));
        const savesHasDirs = fs.existsSync(savesDir) && fs.readdirSync(savesDir).some(f => {
            try { return fs.statSync(path.join(savesDir, f)).isDirectory(); } catch { return false; }
        });
        if (modsHasFiles || savesHasDirs) {
            effectiveIsolation = true;
        }
    }

    return effectiveIsolation;
}

function resolveExternalVersionDir(versionId) {
    if (!versionId) return null;
    const installed = getInstalledVersions();
    if (versionId.includes('[外部')) {
        const ext = installed.find(v => v.id === versionId && v.isExternal);
        if (ext && ext.externalVersionDir) return ext.externalVersionDir;
        const cleanId = versionId.replace(/\s*\[外部\d*\]/, '');
        const ext2 = installed.find(v => v.id === cleanId && v.isExternal);
        if (ext2 && ext2.externalVersionDir) return ext2.externalVersionDir;
    }
    const ext3 = installed.find(v => v.id === versionId && v.isExternal && v.externalVersionDir);
    if (ext3) return ext3.externalVersionDir;
    return null;
}

function getVersionGameDir(versionId) {
    if (!versionId) {
        const settings = loadSettingsCached();
        versionId = settings.selectedVersion || '';
    }
    if (!versionId) return null;

    const extDir = resolveExternalVersionDir(versionId);
    if (extDir) return extDir;

    if (resolveVersionIsolation(versionId)) {
        return path.join(ctx.dirs.VERSIONS_DIR, versionId);
    }

    const settings = loadSettingsCached();
    return settings.gameDir || ctx.dirs.DATA_DIR;
}

function getVersionModsDir(versionId) {
    const baseDir = getVersionGameDir(versionId);
    if (!baseDir) return null;
    return path.join(baseDir, 'mods');
}

function getVersionSubDir(versionId, subfolder) {
    const baseDir = getVersionGameDir(versionId);
    if (!baseDir) return null;
    return path.join(baseDir, subfolder);
}

function loadExternalFolders() {
    try {
        if (fs.existsSync(ctx.dirs.EXTERNAL_FOLDERS_FILE)) {
            return JSON.parse(fs.readFileSync(ctx.dirs.EXTERNAL_FOLDERS_FILE, 'utf-8'));
        }
    } catch (e) {}
    return [];
}

function saveExternalFolders(folders) {
    fs.writeFileSync(ctx.dirs.EXTERNAL_FOLDERS_FILE, JSON.stringify(folders, null, 2));
}

function scanExternalFolder(folderPath) {
    const versions = [];
    const versionsDir = path.join(folderPath, 'versions');
    if (!fs.existsSync(versionsDir)) return versions;
    const skipFolders = new Set(['cache', 'blclient', 'pcl', 'temp']);
    try {
        const dirs = fs.readdirSync(versionsDir);
        for (const dir of dirs) {
            const versionDir = path.join(versionsDir, dir);
            try {
                if (!fs.statSync(versionDir).isDirectory()) continue;
                if (skipFolders.has(dir.toLowerCase())) continue;
                const hasAnyFile = fs.readdirSync(versionDir).some(f => !f.startsWith('.'));
                if (!hasAnyFile) continue;
            } catch (e) { continue; }
            const jsonFile = findVersionJson(versionDir);
            if (!jsonFile) {
                versions.push({
                    id: dir, type: 'release', installed: true,
                    externalPath: folderPath, externalVersionDir: versionDir, isExternal: true,
                    error: true, errorReason: '版本 JSON 文件缺失',
                    inheritsFrom: null, isFabric: false, isForge: false, isNeoForge: false,
                    isOptiFine: false, isLiteLoader: false, isModpack: false, modpackLoader: '',
                    baseVersion: '', isAprilFools: false, hasMods: false, hasSaves: false, hasResourcepacks: false,
                    customName: '', description: ''
                });
                continue;
            }
            try {
                const data = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
                const info = detectVersionInfo(data, dir);
                let inheritsFrom = data.inheritsFrom || null;
                if (!inheritsFrom && (info.isNeoForge || info.isForge)) {
                    const m = (data.id || dir).match(/^(\d+\.\d+(?:\.\d+)?(?:-rc\d+|-pre\d+|-snapshot.*)?)/i);
                    if (m) inheritsFrom = m[1];
                }
                if (inheritsFrom && !data.inheritsFrom) data.inheritsFrom = inheritsFrom;
                let error = false;
                let errorReason = '';
                if (inheritsFrom) {
                    const parentJson = _findVersionJsonInAnyDir(inheritsFrom);
                    if (!parentJson) {
                        const hasMainClass = !!data.mainClass;
                        const hasLibraries = Array.isArray(data.libraries) && data.libraries.length > 0;
                        const hasForgeLibs = hasLibraries && data.libraries.some(l => l.name && (
                            l.name.includes('net.minecraftforge') || l.name.includes('fancymodloader') ||
                            l.name.includes('net.neoforged') || l.name.includes('fabric-loader')
                        ));
                        if ((info.isForge || info.isNeoForge) && (hasMainClass || hasForgeLibs)) {
                            console.log(`[Versions] 外部Forge版本 ${dir} 缺少前置 ${inheritsFrom}，但自身包含完整配置，视为可用`);
                        } else {
                            error = true;
                            errorReason = `需要安装 ${inheritsFrom} 作为前置版本`;
                        }
                    }
                }
                if (!error && !data.mainClass && (!data.libraries || !Array.isArray(data.libraries) || data.libraries.length === 0)) {
                    error = true;
                    errorReason = `无法识别：初始化版本 JSON 时失败 (${dir})`;
                }
                const hasModsDir = fs.existsSync(path.join(versionDir, 'mods'));
                const hasSavesDir = fs.existsSync(path.join(versionDir, 'saves'));
                const hasResourcepacksDir = fs.existsSync(path.join(versionDir, 'resourcepacks'));
                versions.push({
                    id: data.id || dir,
                    type: info.isAprilFools ? 'special' : (data.type || 'release'),
                    releaseTime: data.releaseTime || '',
                    mainClass: data.mainClass || '',
                    installed: true,
                    inheritsFrom: inheritsFrom,
                    isFabric: info.isFabric,
                    isForge: info.isForge,
                    isNeoForge: info.isNeoForge,
                    isOptiFine: info.isOptiFine,
                    isLiteLoader: info.isLiteLoader,
                    isModpack: info.isModpack,
                    modpackLoader: info.modpackLoader,
                    baseVersion: info.baseVersion,
                    isAprilFools: info.isAprilFools || false,
                    externalPath: folderPath,
                    externalVersionDir: versionDir,
                    isExternal: true,
                    isolation: true,
                    hasMods: hasModsDir,
                    hasSaves: hasSavesDir,
                    hasResourcepacks: hasResourcepacksDir,
                    error: error,
                    errorReason: errorReason,
                    ...(function() {
                        try {
                            const vs = loadVersionSettings(data.id || dir);
                            return { customName: vs.customName || '', description: vs.description || '' };
                        } catch (e) { return {}; }
                    })()
                });
            } catch (e) {
                versions.push({
                    id: dir, type: 'release', installed: true,
                    externalPath: folderPath, externalVersionDir: versionDir, isExternal: true,
                    error: true, errorReason: `版本 JSON 损坏: ${e.message}`,
                    inheritsFrom: null, isFabric: false, isForge: false, isNeoForge: false,
                    isOptiFine: false, isLiteLoader: false, isModpack: false, modpackLoader: '',
                    baseVersion: '', isAprilFools: false, hasMods: false, hasSaves: false, hasResourcepacks: false,
                    customName: '', description: ''
                });
            }
        }
    } catch (e) {}
    return versions;
}

function loadVersionSettings(versionId) {
    const cleanId = versionId.replace(/ \[外部\d*\]/, '');
    const isExternal = versionId.includes(' [外部');
    let settingsFile;
    if (isExternal) {
        const externalSettingsDir = path.join(ctx.dirs.DATA_DIR, 'external-settings');
        if (!fs.existsSync(externalSettingsDir)) fs.mkdirSync(externalSettingsDir, { recursive: true });
        settingsFile = path.join(externalSettingsDir, `${cleanId.replace(/[/\\?%*:|"<>]/g, '_')}-settings.json`);
    } else {
        if (cleanId.includes('..') || cleanId.includes('/') || cleanId.includes('\\')) {
            return { versionId, customName: '', description: '', icon: 'auto', category: 'auto', favorite: false };
        }
        settingsFile = path.join(ctx.dirs.VERSIONS_DIR, cleanId, 'version-settings.json');
    }
    const defaults = {
        versionId: versionId,
        customName: '',
        description: '',
        icon: 'auto',
        category: 'auto',
        favorite: false,
        isolation: isExternal ? 'on' : 'global',
        windowTitle: '',
        customInfo: '',
        javaPath: 'global',
        memoryMode: 'global',
        memoryValue: 4096,
        memOptimize: 'global',
        jvmArgs: '',
        gameArgs: '',
        customMainClass: '',
        beforeLaunchCommand: '',
        afterLaunchCommand: '',
        fullscreen: 'global',
        resolution: ''
    };
    try {
        if (fs.existsSync(settingsFile)) {
            const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
            return { ...defaults, ...saved };
        }
    } catch (e) {}
    return defaults;
}

function saveVersionSettings(versionId, settings) {
    const cleanId = versionId.replace(/ \[外部\d*\]/, '');
    const isExternal = versionId.includes(' [外部');
    let settingsFile;
    if (isExternal) {
        const externalSettingsDir = path.join(ctx.dirs.DATA_DIR, 'external-settings');
        if (!fs.existsSync(externalSettingsDir)) fs.mkdirSync(externalSettingsDir, { recursive: true });
        settingsFile = path.join(externalSettingsDir, `${cleanId.replace(/[/\\?%*:|"<>]/g, '_')}-settings.json`);
    } else {
        if (cleanId.includes('..') || cleanId.includes('/') || cleanId.includes('\\')) {
            throw new Error('Invalid versionId');
        }
        const versionDir = path.join(ctx.dirs.VERSIONS_DIR, cleanId);
        if (!fs.existsSync(versionDir)) throw new Error(`版本目录不存在: ${cleanId}`);
        settingsFile = path.join(versionDir, 'version-settings.json');
    }
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

// ============================================================================
// 规则评估 (从 server.js 抽取，供 modloaders 等模块使用)
// ============================================================================

function evaluateRules(rules, extraVars = {}) {
    if (!rules || rules.length === 0) return true;
    let allowed = null;
    let hasAllowRule = false;
    for (const rule of rules) {
        const action = rule.action;
        if (action === 'allow') hasAllowRule = true;
        let ruleMatched = true;

        if (rule.os) {
            const osName = rule.os.name;
            const isCurrentOS = (process.platform === 'win32' && osName === 'windows') ||
                               (process.platform === 'darwin' && osName === 'osx') ||
                               (process.platform === 'linux' && osName === 'linux');

            let osMatch = isCurrentOS;

            if (rule.os.arch) {
                const isCurrentArch = (rule.os.arch === 'x86' && process.arch === 'ia32') ||
                                     (rule.os.arch === 'x64' && process.arch === 'x64');
                osMatch = osMatch && isCurrentArch;
            }

            if (rule.os.version) {
                const osVersion = require('os').release();
                try {
                    const regex = new RegExp(rule.os.version);
                    const testResult = regex.test(osVersion);
                    osMatch = osMatch && testResult;
                } catch (e) {
                    osMatch = false;
                }
                if (osVersion.length > 256) {
                    osMatch = false;
                }
            }

            ruleMatched = osMatch;
        }

        if (rule.features) {
            if (rule.features.is_demo_user) {
                ruleMatched = ruleMatched && false;
            }
            if (rule.features.has_custom_resolution) {
                ruleMatched = ruleMatched && !!extraVars.hasCustomResolution;
            }
            if (rule.features.has_quick_plays_support) {
                ruleMatched = false;
            }
            if (rule.features.is_quick_play_singleplayer) {
                ruleMatched = false;
            }
            if (rule.features.is_quick_play_multiplayer) {
                ruleMatched = false;
            }
            if (rule.features.is_quick_play_realms) {
                ruleMatched = false;
            }
        }

        if (!rule.os && !rule.features) {
            ruleMatched = true;
        }

        if (ruleMatched) {
            allowed = action === 'allow';
        }
    }
    if (allowed !== null) return allowed;
    return !hasAllowRule;
}

// ============================================================================
// 导出
// ============================================================================

module.exports = {
    watchVersionsDir,
    loadVersions,
    saveVersions,
    findVersionChain,
    cleanupVersionChain,
    cleanupIncompleteVersion,
    isVersionComplete,
    validateInstalledVersions,
    getVersionManifest,
    getVersionDetails,
    fixModpackInheritsFrom,
    correctVersionType,
    getInstalledVersions,
    getVersionLocalDetails,
    resolveVersionIsolation,
    resolveExternalVersionDir,
    getVersionGameDir,
    getVersionModsDir,
    getVersionSubDir,
    loadExternalFolders,
    saveExternalFolders,
    scanExternalFolder,
    loadVersionSettings,
    saveVersionSettings,
    findVersionJson,
    resolveVersionJson,
    loadSettingsCached,
    findExternalRoot,
    findMainJar,
    _invalidateResolvedJsonCache,
    mergeVersionJson,
    deduplicateJvmArgs,
    deduplicateGameArgs,
    evaluateRules,
    saveDiskCache,
};
