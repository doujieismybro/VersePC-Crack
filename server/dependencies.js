/**
 * server/dependencies.js - 依赖检查与下载模块
 * ============================================================================
 * 从 server.js 抽取的依赖检查和缺失文件下载功能。
 * 通过 ctx (./context) 访问共享状态，通过 utils (./utils) 访问工具函数，
 * 通过 http (./http-client) 访问 HTTP 请求功能，通过 versions (./versions) 访问版本管理功能。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ctx = require('./context');
const utils = require('./utils');
const http = require('./http-client');
const versions = require('./versions');
const java = require('./java');

// modloaders.js 已 require 本模块，使用懒加载避免循环依赖
let _modloadersModule = null;
function _modloaders() {
    if (_modloadersModule === null) {
        _modloadersModule = require('./modloaders');
    }
    return _modloadersModule;
}

// ============================================================================
// 依赖检查
// ============================================================================
async function checkDependencies(versionId, settings, externalVersionDir = null) {
    const _cacheKey = versionId + ':' + JSON.stringify(settings || {});
    const _cached = ctx.caches._depCheckCache.get(_cacheKey);
    if (_cached && (Date.now() - _cached.ts) < ctx.caches._DEP_CHECK_CACHE_TTL) {
        console.log(`[DepCheck] 命中缓存，跳过重复扫描: ${versionId}`);
        return _cached.result;
    }
    console.log(`[DepCheck] 开始检查版本 ${versionId} 的依赖`);

    let externalAssetsDir = null;
    if (externalVersionDir) {
        const exRoot = versions.findExternalRoot(externalVersionDir) || path.dirname(path.dirname(externalVersionDir));
        const exAssets = path.join(exRoot, 'assets');
        if (fs.existsSync(exAssets)) {
            externalAssetsDir = exAssets;
            console.log(`[DepCheck] 外部资源目录: ${externalAssetsDir}`);
        }
    }

    const result = {
        java: { ok: false, path: '', version: '', required: 8, maxVersion: 999, rangeSource: 'default', message: '' },
        versionJson: { ok: false, message: '' },
        mainJar: { ok: false, message: '' },
        libraries: { ok: true, missing: [], total: 0, message: '' },
        natives: { ok: true, missing: [], total: 0, message: '' },
        assets: { ok: true, missing: [], total: 0, message: '' },
        parentVersion: { ok: true, message: '' },
        forgeCore: { ok: true, missing: [], message: '' },
        ready: false,
        missingFiles: []
    };

    const versionJson = versions.resolveVersionJson(versionId, externalVersionDir);
    if (!versionJson) {
        result.versionJson.ok = false;
        result.versionJson.message = `版本 ${versionId} 的JSON文件缺失或损坏`;
        return result;
    }
    result.versionJson.ok = true;

    if (versionJson.javaVersion) {
        console.log(`[DepCheck] version.json中的javaVersion字段:`, JSON.stringify(versionJson.javaVersion));
    }

    const range = java.getJavaVersionRange(versionId, versionJson);
    const requiredJavaVer = range.min;
    const maxJavaVer = range.max;
    result.java.required = requiredJavaVer;
    result.java.maxVersion = maxJavaVer;
    result.java.rangeSource = range.source;
    console.log(`[DepCheck] 需要的Java版本: ${requiredJavaVer}${maxJavaVer < 999 ? '~' + maxJavaVer : '+'} (来源: ${range.source})`);

    const javaPath = java.selectJavaForVersion(versionId, settings, versionJson);
    console.log(`[DepCheck] 选择的Java路径: ${javaPath}`);

    if (!javaPath) {
        result.java.ok = false;
        const rangeDesc = maxJavaVer < 999 ? `${requiredJavaVer}~${maxJavaVer}` : `${requiredJavaVer}+`;
        const sysJava = java.detectSystemJava();
        const bunJava = java.detectBundledJava();
        const totalDetected = sysJava.length + bunJava.length;
        if (totalDetected > 0) {
            const detectedList = [...bunJava, ...sysJava].map(j => `Java ${j.majorVersion} (${j.path})`).join(', ');
            result.java.message = `未找到合适版本的Java（需要 ${rangeDesc}，检测到 ${totalDetected} 个但版本不匹配: ${detectedList}），请前往 Java 管理页面安装或配置`;
        } else {
            result.java.message = `未找到Java运行环境（需要 ${rangeDesc}），请前往 Java 管理页面安装或配置`;
        }
        console.log(`[DepCheck] 未找到Java，消息: ${result.java.message}`);
    } else {
        result.java.path = javaPath;
        try {
            const verOutput = execSync(`"${javaPath}" -version 2>&1`, { encoding: 'utf8', timeout: 5000 });
            const verMatch = verOutput.match(/version "([^"]+)"/) || verOutput.match(/version (\S+)/);
            result.java.version = verMatch ? verMatch[1] : 'unknown';
            const majorStr = result.java.version.startsWith('1.')
                ? result.java.version.split('.')[1]
                : result.java.version.split('.')[0];
            const majorVer = parseInt(majorStr, 10);
            console.log(`[DepCheck] 检测到的Java版本: ${result.java.version}, 主版本: ${majorVer}`);

            const maxJavaVer = range.max;
            if (majorVer >= requiredJavaVer && majorVer <= maxJavaVer) {
                result.java.ok = true;
                result.java.message = maxJavaVer < 999
                    ? `Java ${result.java.version} (满足要求 ${requiredJavaVer}~${maxJavaVer})`
                    : `Java ${result.java.version} (满足要求 ${requiredJavaVer}+)`;
                console.log(`[DepCheck] Java满足要求`);
            } else {
                result.java.ok = false;
                const rangeDesc = maxJavaVer < 999 ? `${requiredJavaVer}~${maxJavaVer}` : `${requiredJavaVer}+`;
                result.java.message = `Java ${result.java.version} 不满足要求(需要 ${rangeDesc})，请在版本设置中更换Java或使用文件修复功能自动安装`;
                result.java.warning = true;
                console.log(`[DepCheck] Java不满足要求: ${majorVer} 不在范围 ${requiredJavaVer}~${maxJavaVer} 内`);
            }
        } catch (e) {
            result.java.ok = false;
            result.java.message = '无法检测Java版本';
            console.error(`[DepCheck] 检测Java版本失败:`, e.message);
        }
    }

    if (versionJson.inheritsFrom) {
        const jarName = versionJson.jar || versionJson.inheritsFrom;
        let parentJsonFound = false;
        let parentJsonPath = null;

        const jsonSearchPaths = [];
        if (externalVersionDir) {
            const externalRoot = versions.findExternalRoot(externalVersionDir);
            if (externalRoot) {
                jsonSearchPaths.push(path.join(externalRoot, 'versions', versionJson.inheritsFrom, `${versionJson.inheritsFrom}.json`));
            }
            jsonSearchPaths.push(path.join(path.dirname(externalVersionDir), versionJson.inheritsFrom, `${versionJson.inheritsFrom}.json`));
            const externalFolders = versions.loadExternalFolders();
            for (const folder of externalFolders) {
                if (!fs.existsSync(folder.path)) continue;
                const candidate = path.join(folder.path, 'versions', versionJson.inheritsFrom, `${versionJson.inheritsFrom}.json`);
                if (!jsonSearchPaths.includes(candidate)) jsonSearchPaths.push(candidate);
            }
        }
        jsonSearchPaths.push(path.join(ctx.dirs.VERSIONS_DIR, versionJson.inheritsFrom, `${versionJson.inheritsFrom}.json`));

        for (const candidate of jsonSearchPaths) {
            if (fs.existsSync(candidate)) {
                parentJsonPath = candidate;
                parentJsonFound = true;
                break;
            }
        }

        const mainJarPath = versions.findMainJar(versionJson, versionId, externalVersionDir);
        const mainJarFound = !!mainJarPath && fs.existsSync(mainJarPath);

        if (!parentJsonFound && !mainJarFound) {
            const hasMainClass = !!versionJson.mainClass;
            const hasLibs = Array.isArray(versionJson.libraries) && versionJson.libraries.length > 0;
            const hasForgeLibs = hasLibs && versionJson.libraries.some(l => l.name && (
                l.name.includes('net.minecraftforge') || l.name.includes('fancymodloader') ||
                l.name.includes('net.neoforged') || l.name.includes('fabric-loader')
            ));
            /*
            [CRITICAL] 外部版本 depCheck 豁免
            ====================================
            【问题原理】
              depCheck（启动前依赖检查）会检查版本 JSON 的 inheritsFrom 字段，
              确认前置版本（parent version）存在且有 JAR 文件。这是为了防止用户
              删除了基础版本后启动整合包导致崩溃。

              但外部导入的 Forge/NeoForge 版本（来自 HMCL 等启动器）情况特殊：
              它们的版本 JSON 可能有 inheritsFrom 指向一个在 VersePC 中不存在的版本，
              但实际上这些 JSON 已经包含了完整的 mainClass 和所有库文件（PCL2式合并），
              即使没有前置版本也能正常启动。

              如果此处不豁免，外部版本首次启动后会被误判为"错误版本"——
              版本列表中不会显示该版本，用户无法启动。

            【豁免条件】
              仅当以下条件全部满足时豁免：
              1. externalVersionDir 不为空（说明是外部导入的版本）
              2. 版本 JSON 包含 mainClass 或 Forge/NeoForge/Fabric 库（说明是自包含的）

            【与 _scanVersionDir 的一致性】
              版本列表扫描代码（_scanVersionDir 中的 isVersionAvailable）已经有相同的豁免逻辑：
              如果外部版本 JSON 有 mainClass 或 Forge libs，即使 inheritsFrom 指向不存在的版本，
              也会被标记为可用。此处 depCheck 必须保持一致，否则版本列表显示可用但启动时报错。

            [AI-AUTOGEN-WARNING] 请勿删除此豁免逻辑。删除后外部导入的 Forge/NeoForge 版本
            首次启动后会被标记为"错误版本"，从版本列表中消失。
            */
            const isSelfSufficient = externalVersionDir && (hasMainClass || hasForgeLibs);
            if (!isSelfSufficient) {
                result.parentVersion.ok = false;
                result.parentVersion.message = `缺少基础版本 ${versionJson.inheritsFrom}，请先安装`;
                result.missingFiles.push({
                    type: 'parent_version',
                    id: versionJson.inheritsFrom,
                    message: `缺少基础版本 ${versionJson.inheritsFrom} (JSON: ${parentJsonFound ? '有' : '无'}, JAR: ${mainJarFound ? '有' : '无'})`
                });
            } else {
                console.log(`[DepCheck] 外部版本 ${versionId} 缺少前置 ${versionJson.inheritsFrom}，但自身包含完整配置，跳过前置检查`);
            }
        }
    }

    const mainJarPath = versions.findMainJar(versionJson, versionId, externalVersionDir);
    if (mainJarPath && fs.existsSync(mainJarPath)) {
        const isModdedVersion = !!(versionJson.forge || versionJson.neoforge || versionJson.fabricVersion || versionJson.inheritsFrom);
        if (versionJson.downloads?.client?.sha1 && !isModdedVersion) {
            try {
                const sha1 = await utils.calculateSHA1(mainJarPath);
                if (sha1 === versionJson.downloads.client.sha1) {
                    result.mainJar.ok = true;
                } else {
                    result.mainJar.ok = false;
                    result.mainJar.message = '主JAR文件SHA1校验失败';
                    result.missingFiles.push({
                        type: 'main_jar',
                        url: versionJson.downloads.client.url,
                        path: mainJarPath,
                        sha1: versionJson.downloads.client.sha1,
                        size: versionJson.downloads.client.size,
                        name: `${versionId}.jar`
                    });
                }
            } catch (e) {
                result.mainJar.ok = true;
            }
        } else {
            result.mainJar.ok = true;
        }
    } else if (versionJson.downloads?.client) {
        result.mainJar.ok = false;
        result.mainJar.message = '主JAR文件缺失';
        result.missingFiles.push({
            type: 'main_jar',
            url: versionJson.downloads.client.url,
            path: mainJarPath || path.join(ctx.dirs.VERSIONS_DIR, versionId, `${versionId}.jar`),
            sha1: versionJson.downloads.client.sha1,
            size: versionJson.downloads.client.size,
            name: `${versionId}.jar`
        });
    } else {
        let fallbackUrl = null, fallbackSha1 = null, fallbackSize = null, fallbackJarId = null;
        const _chainVisited = new Set();
        let _cur = versionJson;
        while (_cur && _cur.inheritsFrom && !_chainVisited.has(_cur.inheritsFrom)) {
            _chainVisited.add(_cur.inheritsFrom);
            try {
                const pjPath = path.join(ctx.dirs.VERSIONS_DIR, _cur.inheritsFrom, `${_cur.inheritsFrom}.json`);
                if (fs.existsSync(pjPath)) {
                    const pj = JSON.parse(fs.readFileSync(pjPath, 'utf-8'));
                    if (pj.downloads?.client?.url) {
                        fallbackUrl = pj.downloads.client.url;
                        fallbackSha1 = pj.downloads.client.sha1;
                        fallbackSize = pj.downloads.client.size;
                        fallbackJarId = _cur.inheritsFrom;
                        break;
                    }
                    _cur = pj;
                    continue;
                }
            } catch (_) {}
            break;
        }
        result.mainJar.ok = false;
        result.mainJar.message = '主JAR文件缺失';
        if (fallbackUrl && fallbackJarId) {
            const fallbackPath = path.join(ctx.dirs.VERSIONS_DIR, fallbackJarId, `${fallbackJarId}.jar`);
            result.missingFiles.push({
                type: 'main_jar',
                url: fallbackUrl,
                path: fallbackPath,
                sha1: fallbackSha1,
                size: fallbackSize,
                name: `${fallbackJarId}.jar`
            });
            console.log(`[checkDeps] 主JAR缺失，从继承链版本 ${fallbackJarId} 获取下载URL`);
        }
    }

    const libraries = versionJson.libraries || [];
    const currentPlatform = process.platform === 'win32' ? 'windows' :
                             process.platform === 'darwin' ? 'osx' : 'linux';
    let libTotal = 0;
    for (const lib of libraries) {
        if (lib.rules && !versions.evaluateRules(lib.rules)) continue;

        const hasNatives = lib.natives && lib.natives[process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'];
        const libNameSuffix = lib.name ? lib.name.split(':').pop() : '';
        const isNewFormatNative = !hasNatives && libNameSuffix.startsWith('natives-');

        if (isNewFormatNative) {
            const nameParts = lib.name.split(':');
            const nativeSuffix = nameParts[nameParts.length - 1];
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

            libTotal++;
            let nativePath = null;
            if (lib.downloads?.artifact?.path) {
                nativePath = utils.safeLibPath(lib.downloads.artifact.path);
                if (!nativePath) continue;
                if (!fs.existsSync(nativePath) && externalVersionDir) {
                    const externalRoot = versions.findExternalRoot(externalVersionDir);
                    if (externalRoot) {
                        const extPath = utils.safeLibPath(lib.downloads.artifact.path, path.join(externalRoot, 'libraries'));
                        if (fs.existsSync(extPath)) nativePath = extPath;
                    }
                }
            }
            if (!nativePath || !fs.existsSync(nativePath)) {
                if (nameParts.length >= 4) {
                    const ngroupPath = nameParts[0].replace(/\./g, path.sep);
                    const nname = nameParts[1];
                    const nver = nameParts[2];
                    const nclassifier = nameParts[3];
                    const njarName = `${nname}-${nver}-${nclassifier}.jar`;
                    nativePath = path.join(ctx.dirs.LIBRARIES_DIR, ngroupPath, nname, nver, njarName);
                    if (!fs.existsSync(nativePath) && externalVersionDir) {
                        const externalRoot = versions.findExternalRoot(externalVersionDir);
                        if (externalRoot) {
                            const extPath = path.join(externalRoot, 'libraries', ngroupPath, nname, nver, njarName);
                            if (fs.existsSync(extPath)) nativePath = extPath;
                        }
                    }
                }
            }
            if (!nativePath || !fs.existsSync(nativePath)) {
                const ngroupMaven = nameParts[0].replace(/\./g, '/');
                const nname = nameParts[1];
                const nver = nameParts[2];
                const nclassifier = nameParts[3];
                const njarName = `${nname}-${nver}-${nclassifier}.jar`;
                const baseUrl = lib.url || (lib.downloads?.artifact?.url ? lib.downloads.artifact.url.replace(/\/[^/]+\/[^/]+\/[^/]+\/[^/]+\.jar$/, '/') : 'https://libraries.minecraft.net/');
                const nativeUrl = lib.downloads?.artifact?.url || `${baseUrl}${ngroupMaven}/${nname}/${nver}/${njarName}`;
                result.natives.missing.push({
                    type: 'native',
                    url: nativeUrl,
                    path: nativePath,
                    sha1: lib.downloads?.artifact?.sha1 || '',
                    size: lib.downloads?.artifact?.size || 0,
                    name: lib.name
                });
            } else if (lib.downloads?.artifact?.sha1) {
                try {
                    const sha1 = await utils.calculateSHA1(nativePath);
                    if (sha1 !== lib.downloads.artifact.sha1) {
                        result.natives.missing.push({
                            type: 'native',
                            url: lib.downloads.artifact.url,
                            path: nativePath,
                            sha1: lib.downloads.artifact.sha1,
                            size: lib.downloads.artifact.size,
                            name: lib.name
                        });
                    }
                } catch (e) {}
            }
        } else if (lib.downloads?.artifact) {
            libTotal++;
            let libPath = utils.safeLibPath(lib.downloads.artifact.path);
            if (!libPath) continue;
                        if (!fs.existsSync(libPath) && externalVersionDir) {
                const externalRoot = versions.findExternalRoot(externalVersionDir);
                if (externalRoot) {
                    const extLibPath = utils.safeLibPath(lib.downloads.artifact.path, path.join(externalRoot, 'libraries'));
                    if (fs.existsSync(extLibPath)) libPath = extLibPath;
                }
                if (!fs.existsSync(libPath)) {
                    const extLibPath2 = utils.safeLibPath(lib.downloads.artifact.path, path.join(path.dirname(path.dirname(externalVersionDir)), 'libraries'));
                    if (fs.existsSync(extLibPath2)) libPath = extLibPath2;
                }
            }
            if (!fs.existsSync(libPath)) {
                let fixUrl = lib.downloads.artifact.url;
                if (!fixUrl && lib.name) {
                    const p = lib.name.split(':');
                    if (p.length >= 3) {
                        const gp = p[0].replace(/\./g, '/');
                        const nm = p[1]; const vr = p[2];
                        const cl = p.length >= 4 ? p[3] : '';
                        const jn = cl ? `${nm}-${vr}-${cl}.jar` : `${nm}-${vr}.jar`;
                        const base = lib.url || (p[0].includes('minecraftforge') || p[0].includes('forge') || p[0].includes('minecraft') ? 'https://maven.minecraftforge.net/' : 'https://libraries.minecraft.net/');
                        fixUrl = `${base}${gp}/${nm}/${vr}/${jn}`;
                    }
                }
                result.libraries.missing.push({
                    type: 'library',
                    url: fixUrl || '',
                    path: libPath,
                    sha1: lib.downloads.artifact.sha1,
                    size: lib.downloads.artifact.size,
                    name: lib.name || path.basename(lib.downloads.artifact.path)
                });
            } else if (lib.downloads.artifact.sha1) {
                try {
                    const sha1 = await utils.calculateSHA1(libPath);
                    if (sha1 !== lib.downloads.artifact.sha1) {
                        let fixUrl = lib.downloads.artifact.url;
                        if (!fixUrl && lib.name) {
                            const p = lib.name.split(':');
                            if (p.length >= 3) {
                                const gp = p[0].replace(/\./g, '/');
                                const nm = p[1]; const vr = p[2];
                                const cl = p.length >= 4 ? p[3] : '';
                                const jn = cl ? `${nm}-${vr}-${cl}.jar` : `${nm}-${vr}.jar`;
                                const base = lib.url || (p[0].includes('minecraftforge') || p[0].includes('forge') ? 'https://maven.minecraftforge.net/' : 'https://libraries.minecraft.net/');
                                fixUrl = `${base}${gp}/${nm}/${vr}/${jn}`;
                            }
                        }
                        result.libraries.missing.push({
                            type: 'library',
                            url: fixUrl || '',
                            path: libPath,
                            sha1: lib.downloads.artifact.sha1,
                            size: lib.downloads.artifact.size,
                            name: lib.name || path.basename(lib.downloads.artifact.path)
                        });
                    }
                } catch (e) {}
            }
        } else if (lib.name && !hasNatives) {
            const parts = lib.name.split(':');
            if (parts.length >= 3) {
                libTotal++;
                const groupPath = parts[0].replace(/\./g, '/');
                const name = parts[1];
                const version = parts[2];
                const classifier = parts.length >= 4 ? parts[3] : '';
                const jarName = classifier ? `${name}-${version}-${classifier}.jar` : `${name}-${version}.jar`;
                const localGroupPath = parts[0].replace(/\./g, path.sep);
                let libPath = path.join(ctx.dirs.LIBRARIES_DIR, localGroupPath, name, version, jarName);
                if (!fs.existsSync(libPath) && externalVersionDir) {
                    const externalRoot = versions.findExternalRoot(externalVersionDir);
                    if (externalRoot) {
                        const extLibPath = path.join(externalRoot, 'libraries', localGroupPath, name, version, jarName);
                        if (fs.existsSync(extLibPath)) libPath = extLibPath;
                    }
                    if (!fs.existsSync(libPath)) {
                        const extLibPath2 = path.join(path.dirname(path.dirname(externalVersionDir)), 'libraries', localGroupPath, name, version, jarName);
                        if (fs.existsSync(extLibPath2)) libPath = extLibPath2;
                    }
                }
                if (!fs.existsSync(libPath)) {
                    let baseUrl = lib.url;
                    if (!baseUrl) {
                        if (lib.name.includes('fabric') || lib.name.includes('fabricmc')) {
                            baseUrl = 'https://maven.fabricmc.net/';
                        } else if (lib.name.includes('neoforged')) {
                            baseUrl = 'https://maven.neoforged.net/';
                        } else if (lib.name.includes('forge') || lib.name.includes('minecraftforge') || lib.name.startsWith('net.minecraft')) {
                            baseUrl = 'https://maven.minecraftforge.net/';
                        } else {
                            baseUrl = 'https://libraries.minecraft.net/';
                        }
                    }
                    const downloadUrl = `${baseUrl}${groupPath}/${name}/${version}/${jarName}`;
                    console.log(`[DepCheck] 库缺失，构造URL: ${lib.name} -> ${downloadUrl}`);
                    result.libraries.missing.push({
                        type: 'library',
                        url: downloadUrl,
                        path: libPath,
                        sha1: '',
                        size: 0,
                        name: lib.name
                    });
                }
            }
        }

        if (hasNatives) {
            const nativeKey = lib.natives[process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'];
            const classifier = nativeKey.replace('${arch}', process.arch === 'x64' ? '64' : '32');
            const nativeDownload = lib.downloads?.classifiers?.[classifier];
            if (nativeDownload) {
                libTotal++;
                let nativePath = path.join(ctx.dirs.LIBRARIES_DIR, nativeDownload.path);
            if (!fs.existsSync(nativePath) && externalVersionDir) {
                const externalRoot = versions.findExternalRoot(externalVersionDir);
                if (externalRoot) {
                    const extNativePath = path.join(externalRoot, 'libraries', nativeDownload.path);
                    if (fs.existsSync(extNativePath)) nativePath = extNativePath;
                }
            }
                if (!fs.existsSync(nativePath)) {
                    result.natives.missing.push({
                        type: 'native',
                        url: nativeDownload.url,
                        path: nativePath,
                        sha1: nativeDownload.sha1,
                        size: nativeDownload.size,
                        name: `${lib.name} (${classifier})`
                    });
                } else if (nativeDownload.sha1) {
                    try {
                        const sha1 = await utils.calculateSHA1(nativePath);
                        if (sha1 !== nativeDownload.sha1) {
                            result.natives.missing.push({
                                type: 'native',
                                url: nativeDownload.url,
                                path: nativePath,
                                sha1: nativeDownload.sha1,
                                size: nativeDownload.size,
                                name: `${lib.name} (${classifier})`
                            });
                        }
                    } catch (e) {}
                }
            }
        }
    }
    result.libraries.total = libTotal;
    result.libraries.ok = result.libraries.missing.length === 0;
    if (result.libraries.missing.length > 0) {
        result.libraries.message = `${result.libraries.missing.length} 个库文件缺失或损坏`;
        result.missingFiles.push(...result.libraries.missing);
    }

    result.natives.total = result.natives.missing.length;
    result.natives.ok = result.natives.missing.length === 0;
    if (result.natives.missing.length > 0) {
        result.natives.message = `${result.natives.missing.length} 个原生库缺失或损坏`;
        result.missingFiles.push(...result.natives.missing);
    }

    const scanInheritsForge = (vid, visited) => {
        if (!vid || (visited && visited.has(vid))) return false;
        if (!visited) visited = new Set();
        const vl = vid.toLowerCase();
        if (vl.includes('forge') && !vl.includes('neoforge') && !vl.includes('neoforged')) return true;
        visited.add(vid);
        const vjPath = path.join(ctx.dirs.VERSIONS_DIR, vid, `${vid}.json`);
        if (!fs.existsSync(vjPath)) return false;
        try {
            const vj = JSON.parse(fs.readFileSync(vjPath, 'utf-8'));
            if (vj.inheritsFrom && !visited.has(vj.inheritsFrom)) {
                return scanInheritsForge(vj.inheritsFrom, visited);
            }
        } catch (_) {}
        return false;
    };

    const hasForgeLibs = (libs) => (libs || []).some(l =>
        l.name && (l.name.startsWith('net.minecraftforge:forge:') ||
                    l.name.startsWith('net.minecraftforge:fmlloader:') ||
                    l.name.startsWith('net.neoforged:neoforge:') ||
                    l.name.startsWith('net.neoforged.fancymodloader:') ||
                    (l.name.startsWith('net.minecraft:client:') && (l.name.endsWith(':srg') || l.name.endsWith(':extra')))));

    const _depVLower = versionId.toLowerCase();
    const _depIsNeo = _depVLower.includes('neoforge') || _depVLower.includes('neoforged');
    const _depHasForgeId = _depVLower.includes('forge') && !_depIsNeo;
    const _depHasForgeLibOnly = (versionJson.libraries || []).some(l =>
        l.name && (l.name.startsWith('net.minecraftforge:forge:') || l.name.startsWith('net.minecraftforge:fmlloader:')));
    const isForgeVersion = _depHasForgeId || scanInheritsForge(versionId) || _depHasForgeLibOnly;
    result.forgeCore = { ok: true, missing: [], message: '' };

    if (isForgeVersion) {
        const forgeCoreLibs = [];
        const forgeLibraries = versionJson.libraries || [];

        const isNeoForgeVersion = (versionJson.libraries || []).some(l => l.name && (l.name.startsWith('net.neoforged:neoforge:') || l.name.startsWith('net.neoforged.fancymodloader:')));
        const hasNeoForgeLibs = (versionJson.libraries || []).some(l => l.name && l.name.startsWith('net.neoforged'));

        // [CRITICAL - 2026-06-21] MC 26+ 新版 Forge 格式检测
        // MC 26.2 + Forge 65.0.0 使用全新格式：Forge 核心嵌入在版本 JAR 中（39MB），
        // 不再有独立的 fmlcore、client-srg、client-extra 文件。
        // 特征：mainClass 是 net.minecraft.client.main.Main（不是 BootstrapLauncher），
        //       gameArgs 中没有 --fml.forgeVersion，libraries 中没有 net.minecraftforge 库。
        // 此时应跳过核心文件检查，因为版本 JAR 已包含所有 Forge 核心代码。
        // [AI-AUTOGEN-WARNING] 不要删除 isNewForgeFormat 检测逻辑，否则 MC 26+ Forge 版本
        // 会因 DepCheck 误报核心库缺失而无法启动。
        const gameArgs = versionJson.arguments?.game || [];
        const hasFmlArgs = gameArgs.some(a => typeof a === 'string' && (a === '--fml.forgeVersion' || a === '--fml.mcVersion'));
        const hasBootstrapMain = (versionJson.mainClass || '').includes('bootstraplauncher') || (versionJson.mainClass || '').includes('BootstrapLauncher') || (versionJson.mainClass || '').includes('cpw.mods');
        const hasForgeLibsInJson = forgeLibraries.some(l => l.name && (l.name.startsWith('net.minecraftforge:forge:') || l.name.startsWith('net.minecraftforge:fmlloader:') || l.name.startsWith('net.minecraftforge:fmlcore:')));
        const isNewForgeFormat = !isNeoForgeVersion && !hasFmlArgs && !hasBootstrapMain && !hasForgeLibsInJson;

        if (isNewForgeFormat) {
            console.log(`[DepCheck] 检测到新版Forge格式(MC26+)，核心已嵌入版本JAR，跳过核心库检查`);
            result.forgeCore = { ok: true, missing: [], message: '新版Forge格式，核心已嵌入版本JAR' };
        } else {

        const forgeClientLib = forgeLibraries.find(l =>
            l.name && /^net\.minecraftforge:forge:\d/.test(l.name) && l.name.endsWith(':client')) ||
            forgeLibraries.find(l =>
            l.name && /^net\.minecraftforge:forge:\d/.test(l.name) && l.name.split(':').length === 3);
        const forgeMainLib = forgeLibraries.find(l =>
            l.name && /^net\.minecraftforge:forge:\d/.test(l.name) && l.name.split(':').length === 3);
        const neoForgeLib = forgeLibraries.find(l => l.name && l.name.startsWith('net.neoforged:neoforge:'));
        const neoFmlLib = forgeLibraries.find(l => l.name && l.name.startsWith('net.neoforged.fancymodloader:loader:'));
        const srgLib = forgeLibraries.find(l =>
            l.name && l.name.startsWith('net.minecraft:client:') && l.name.endsWith(':srg'));
        const extraLib = forgeLibraries.find(l =>
            l.name && l.name.startsWith('net.minecraft:client:') && l.name.endsWith(':extra'));

        let externalRootForForge = null;
        if (externalVersionDir) {
            externalRootForForge = versions.findExternalRoot(externalVersionDir);
            if (!externalRootForForge) externalRootForForge = path.dirname(path.dirname(externalVersionDir));
        }

        const forgeCoreDir = (fp) => path.join(ctx.dirs.LIBRARIES_DIR, fp[0].replace(/\./g, path.sep), fp[1], fp[2]);
        const forgeCoreDirExt = (fp) => externalRootForForge ? path.join(externalRootForForge, 'libraries', fp[0].replace(/\./g, path.sep), fp[1], fp[2]) : null;

        const findForgeCoreFile = (fp, jarName) => {
            const localPath = path.join(forgeCoreDir(fp), jarName);
            if (fs.existsSync(localPath)) return localPath;
            const extDir = forgeCoreDirExt(fp);
            if (extDir) {
                const extPath = path.join(extDir, jarName);
                if (fs.existsSync(extPath)) return extPath;
            }
            return localPath;
        };

        if (forgeClientLib) {
            const fp = forgeClientLib.name.split(':');
            const cl = fp.length >= 4 ? `-${fp[3]}` : '';
            forgeCoreLibs.push({
                name: forgeClientLib.name,
                path: findForgeCoreFile(fp, `${fp[1]}-${fp[2]}${cl}.jar`),
                desc: 'Forge客户端核心'
            });
        }
        if (forgeMainLib && forgeMainLib !== forgeClientLib) {
            const fp = forgeMainLib.name.split(':');
            forgeCoreLibs.push({
                name: forgeMainLib.name,
                path: findForgeCoreFile(fp, `${fp[1]}-${fp[2]}.jar`),
                desc: 'Forge主核心'
            });
        }
        if (srgLib) {
            const sp = srgLib.name.split(':');
            forgeCoreLibs.push({
                name: srgLib.name,
                path: findForgeCoreFile(sp, `${sp[1]}-${sp[2]}-srg.jar`),
                desc: 'Minecraft SRG映射客户端'
            });
        }
        if (extraLib) {
            const ep = extraLib.name.split(':');
            forgeCoreLibs.push({
                name: extraLib.name,
                path: findForgeCoreFile(ep, `${ep[1]}-${ep[2]}-extra.jar`),
                desc: 'Minecraft额外客户端'
            });
        }
        if (neoForgeLib) {
            const fp = neoForgeLib.name.split(':');
            const cl = fp.length >= 4 ? `-${fp[3]}` : '';
            forgeCoreLibs.push({
                name: neoForgeLib.name,
                path: findForgeCoreFile(fp, `${fp[1]}-${fp[2]}${cl}.jar`),
                desc: 'NeoForge核心'
            });
        }
        if (neoFmlLib) {
            const fp = neoFmlLib.name.split(':');
            forgeCoreLibs.push({
                name: neoFmlLib.name,
                path: findForgeCoreFile(fp, `${fp[1]}-${fp[2]}.jar`),
                desc: 'NeoForge FML加载器'
            });
        }

        if (forgeCoreLibs.length === 0) {
            let forgeVerMatch = versionId.match(/^(.+)-[Nn]eo[Ff]orge-(.+)$/) || versionId.match(/^(.+)-[Ff]orge-(.+)$/);
            if (!forgeVerMatch && versionJson.inheritsFrom) {
                forgeVerMatch = versionJson.inheritsFrom.match(/^(.+)-[Nn]eo[Ff]orge-(.+)$/) || versionJson.inheritsFrom.match(/^(.+)-[Ff]orge-(.+)$/);
            }
            if (forgeVerMatch) {
                const mcVer = forgeVerMatch[1];
                const fVer = forgeVerMatch[2];
                const forgeSearchBases = [ctx.dirs.LIBRARIES_DIR];
                if (externalRootForForge) forgeSearchBases.unshift(path.join(externalRootForForge, 'libraries'));
                let forgeDirFound = false;
                for (const base of forgeSearchBases) {
                    const forgeDir = path.join(base, 'net', 'minecraftforge', 'forge', `${mcVer}-${fVer}`);
                    if (fs.existsSync(forgeDir)) {
                        try {
                            const files = fs.readdirSync(forgeDir);
                            const clientJar = files.find(f => f.endsWith('-client.jar'));
                            if (clientJar) { forgeCoreLibs.push({ name: `forge-client:${mcVer}-${fVer}`, path: path.join(forgeDir, clientJar), desc: 'Forge客户端核心' }); forgeDirFound = true; }
                        } catch (_) {}
                        break;
                    }
                }
                for (const base of forgeSearchBases) {
                    const neoDir = path.join(base, 'net', 'neoforged', 'neoforge', fVer);
                    if (fs.existsSync(neoDir)) {
                        try {
                            const files = fs.readdirSync(neoDir);
                            const neoJar = files.find(f => f.endsWith('.jar') && !f.endsWith('-sources.jar') && !f.endsWith('-javadoc.jar'));
                            if (neoJar) { forgeCoreLibs.push({ name: `net.neoforged:neoforge:${fVer}`, path: path.join(neoDir, neoJar), desc: 'NeoForge核心' }); forgeDirFound = true; }
                        } catch (_) {}
                        break;
                    }
                }
                for (const base of forgeSearchBases) {
                    const clientDir = path.join(base, 'net', 'minecraft', 'client');
                    if (fs.existsSync(clientDir)) {
                        try {
                            for (const sd of fs.readdirSync(clientDir)) {
                                if (!sd.startsWith(`${mcVer}-`) && sd !== mcVer) continue;
                                const fullDir = path.join(clientDir, sd);
                                try { if (!fs.statSync(fullDir).isDirectory()) continue; } catch (_) { continue; }
                                const files = fs.readdirSync(fullDir);
                                const srgFile = files.find(f => f.endsWith('-srg.jar'));
                                if (srgFile) forgeCoreLibs.push({ name: `client-srg:${sd}`, path: path.join(fullDir, srgFile), desc: 'Minecraft SRG映射客户端' });
                                const extraFile = files.find(f => f.endsWith('-extra.jar'));
                                if (extraFile) forgeCoreLibs.push({ name: `client-extra:${sd}`, path: path.join(fullDir, extraFile), desc: 'Minecraft额外客户端' });
                            }
                        } catch (_) {}
                        break;
                    }
                }
                // 新式Forge (1.13+, bootstraplauncher): 检查模块化核心库
                if ((versionJson.mainClass || '').includes('bootstraplauncher') || (versionJson.mainClass || '').includes('ForgeBootstrap')) {
                    const fmlVersion = `${mcVer}-${fVer}`;
                    const moduleNames = ['fmlcore', 'javafmllanguage', 'mclanguage', 'lowcodelanguage'];
                    for (const modName of moduleNames) {
                        const modPath = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'minecraftforge', modName, fmlVersion, `${modName}-${fmlVersion}.jar`);
                        if (!forgeCoreLibs.some(f => f.path === modPath)) forgeCoreLibs.push({ name: `net.minecraftforge:${modName}:${fmlVersion}`, path: modPath, desc: `Forge模块:${modName}` });
                    }
                }
                if (!_depIsNeo) {
                    // Forge patching JARs (client-srg, client-extra, forge-client) - NeoForge不需要这些
                    forgeCoreLibs.push({ name: `net.minecraftforge:forge:${mcVer}-${fVer}:client`, path: path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'minecraftforge', 'forge', `${mcVer}-${fVer}`, `forge-${mcVer}-${fVer}-client.jar`), desc: 'Forge客户端核心' });
                    const clientBaseDir = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'minecraft', 'client');
                    let mcpDirName = null;
                    try {
                        if (fs.existsSync(clientBaseDir)) {
                            const subdirs = fs.readdirSync(clientBaseDir).filter(d => d.startsWith(`${mcVer}-`) && fs.statSync(path.join(clientBaseDir, d)).isDirectory());
                            if (subdirs.length > 0) mcpDirName = subdirs[0];
                        }
                    } catch (_) {}
                    if (mcpDirName) {
                        forgeCoreLibs.push({ name: `net.minecraft:client:${mcpDirName}:srg`, path: path.join(clientBaseDir, mcpDirName, `client-${mcpDirName}-srg.jar`), desc: 'Minecraft SRG映射客户端' });
                        forgeCoreLibs.push({ name: `net.minecraft:client:${mcpDirName}:extra`, path: path.join(clientBaseDir, mcpDirName, `client-${mcpDirName}-extra.jar`), desc: 'Minecraft额外客户端' });
                    } else if (!((versionJson.mainClass || '').includes('bootstraplauncher') || (versionJson.mainClass || '').includes('ForgeBootstrap'))) {
                        forgeCoreLibs.push({ name: `net.minecraft:client:${mcVer}:srg`, path: path.join(clientBaseDir, `${mcVer}-mcp`, `client-${mcVer}-mcp-srg.jar`), desc: 'Minecraft SRG映射客户端' });
                        forgeCoreLibs.push({ name: `net.minecraft:client:${mcVer}:extra`, path: path.join(clientBaseDir, `${mcVer}-mcp`, `client-${mcVer}-mcp-extra.jar`), desc: 'Minecraft额外客户端' });
                    }
                }
            }
        }

        for (const fcl of forgeCoreLibs) {
            if (!fs.existsSync(fcl.path) || (fcl.path.endsWith('.jar') && !utils.isJarIntact(fcl.path))) {
                result.forgeCore.missing.push(fcl);
                console.warn(`[DepCheck] Forge核心库缺失: ${fcl.name} (${fcl.desc})`);
            }
        }

        if (result.forgeCore.missing.length > 0) {
            result.forgeCore.ok = false;
            const missingNames = result.forgeCore.missing.map(m => m.desc || m.name).join('、');
            result.forgeCore.message = `${result.forgeCore.missing.length} 个Forge核心库文件缺失(${missingNames})，无法启动游戏。\n` +
                `修复建议:\n` +
                `1) 前往"版本设置 → 文件修复"自动修复缺失文件\n` +
                `2) 重新安装该Forge版本(版本设置 → 删除后重新安装)\n` +
                `3) 检查杀毒软件是否将Forge核心库文件误删并加入白名单\n` +
                `4) 如果使用自定义游戏目录,确认libraries文件夹完整`;
            for (const m of result.forgeCore.missing) {
                const existingEntry = result.missingFiles.find(f => f.path === m.path);
                if (!existingEntry) {
                    let forgeUrl = '';
                    if (m.name && m.name.includes(':')) {
                        const parts = m.name.split(':');
                        if (parts.length >= 3) {
                            const groupId = parts[0];
                            const artifactId = parts[1];
                            const version = parts[2];
                            const groupPath = groupId.replace(/\./g, '/');
                            const classifierSuffix = parts[3] ? `-${parts[3]}` : '';
                            const mavenFile = `${artifactId}-${version}${classifierSuffix}.jar`;
                            if (groupId === 'net.minecraft') {
                                forgeUrl = `https://libraries.minecraft.net/${groupPath}/${artifactId}/${version}/${mavenFile}`;
                            } else {
                                forgeUrl = `https://maven.minecraftforge.net/${groupPath}/${artifactId}/${version}/${mavenFile}`;
                            }
                        }
                    }
                    result.missingFiles.push({
                        type: 'forge_core',
                        url: forgeUrl,
                        path: m.path,
                        sha1: '',
                        size: 0,
                        name: m.name,
                        desc: m.desc,
                        message: `Forge核心库缺失: ${m.desc} (${path.basename(m.path)})`
                    });
                }
            }
            console.warn(`[DepCheck] Forge核心检查不通过: ${result.forgeCore.message}`);
        } else {
            console.log(`[DepCheck] Forge核心库(共${forgeCoreLibs.length}个)全部就绪`);
        }

        } // end else !isNewForgeFormat
    }

    if (versionJson.assetIndex) {
        const assetIndexInfo = versionJson.assetIndex;
        let assetIndexPath = path.join(ctx.dirs.ASSETS_DIR, 'indexes', `${assetIndexInfo.id}.json`);
        if (!fs.existsSync(assetIndexPath) && externalAssetsDir) {
            const exIndexPath = path.join(externalAssetsDir, 'indexes', `${assetIndexInfo.id}.json`);
            if (fs.existsSync(exIndexPath)) {
                assetIndexPath = exIndexPath;
                console.log(`[DepCheck] 在外部目录找到资源索引: ${assetIndexPath}`);
            }
        }

        if (!fs.existsSync(assetIndexPath)) {
            result.assets.ok = false;
            result.assets.message = '资源索引文件缺失';
            result.missingFiles.push({
                type: 'asset_index',
                url: assetIndexInfo.url,
                path: assetIndexPath,
                sha1: assetIndexInfo.sha1,
                size: assetIndexInfo.size,
                name: `${assetIndexInfo.id}.json`
            });
        } else {
            try {
                const assetIndexData = JSON.parse(fs.readFileSync(assetIndexPath, 'utf-8'));
                const assetObjects = assetIndexData.objects || {};
                const assetEntries = Object.entries(assetObjects);
                result.assets.total = assetEntries.length;

                let missingCount = 0;
                for (const [name, info] of assetEntries) {
                    const hash = info.hash;
                    const subDir = hash.substring(0, 2);
                    let assetPath = path.join(ctx.dirs.ASSETS_DIR, 'objects', subDir, hash);
                    if (!fs.existsSync(assetPath) && externalAssetsDir) {
                        const exAssetPath = path.join(externalAssetsDir, 'objects', subDir, hash);
                        if (fs.existsSync(exAssetPath)) {
                            assetPath = exAssetPath;
                        }
                    }
                    if (!fs.existsSync(assetPath)) {
                        missingCount++;
                        if (missingCount <= 50) {
                            result.assets.missing.push({
                                type: 'asset',
                                url: `https://resources.download.minecraft.net/${subDir}/${hash}`,
                                path: assetPath,
                                sha1: hash,
                                size: info.size,
                                name: name
                            });
                        }
                    }
                }
                if (missingCount > 50) {
                    result.assets.missing.push({
                        type: 'asset_batch',
                        count: missingCount - 50,
                        message: `还有 ${missingCount - 50} 个资源文件缺失`
                    });
                }
                result.assets.ok = missingCount === 0;
                if (missingCount > 0) {
                    result.assets.message = `${missingCount} 个资源文件缺失`;
                    result.missingFiles.push(...result.assets.missing.filter(f => f.type !== 'asset_batch'));
                }
            } catch (e) {
                result.assets.ok = false;
                result.assets.message = '无法解析资源索引文件';
            }
        }
    }

    result.ready = result.java.ok && result.versionJson.ok && result.mainJar.ok
        && result.libraries.ok && result.natives.ok && result.parentVersion.ok
        && result.assets.ok && result.forgeCore.ok;

    ctx.caches._depCheckCache.set(_cacheKey, { result, ts: Date.now() });
    if (ctx.caches._depCheckCache.size > 50) {
        const oldest = ctx.caches._depCheckCache.keys().next().value;
        ctx.caches._depCheckCache.delete(oldest);
    }

    return result;
}

// ============================================================================
// 下载缺失依赖
// ============================================================================
async function downloadMissingDependencies(missingFiles, onProgress, versionJson, maxThreads = null, externalVersionDir = null) {
    let dlExternalAssetsDir = null;
    if (externalVersionDir) {
        const exRoot = versions.findExternalRoot(externalVersionDir) || path.dirname(path.dirname(externalVersionDir));
        const exAssets = path.join(exRoot, 'assets');
        if (fs.existsSync(exAssets)) dlExternalAssetsDir = exAssets;
    }
    const parentVersions = missingFiles.filter(f => f.type === 'parent_version');
    for (const pv of parentVersions) {
        console.log(`[Download] Installing missing parent version: ${pv.id}`);
        if (onProgress) {
            onProgress({
                stage: 'parent_version',
                message: `正在安装基础版本 ${pv.id}...`,
                progress: 0
            });
        }
        const result = await _modloaders().ensureBaseVersionInstalled(pv.id);
        if (result.error) {
            console.error(`[Download] Failed to install parent version ${pv.id}:`, result.error);
        }
    }

    let allFiles = missingFiles.filter(f => f.type !== 'asset_batch' && f.type !== 'parent_version');
    allFiles = allFiles.filter(f => {
        if (!f.url) {
            console.warn(`[Download] 跳过无URL文件: ${f.name || f.path}`);
            return false;
        }
        return true;
    });

    if (versionJson?.assetIndex) {
        const assetIndexInfo = versionJson.assetIndex;
        let assetIndexPath = path.join(ctx.dirs.ASSETS_DIR, 'indexes', `${assetIndexInfo.id}.json`);
        if (!fs.existsSync(assetIndexPath) && dlExternalAssetsDir) {
            const exIdx = path.join(dlExternalAssetsDir, 'indexes', `${assetIndexInfo.id}.json`);
            if (fs.existsSync(exIdx)) assetIndexPath = exIdx;
        }

        if (!fs.existsSync(assetIndexPath) || (assetIndexInfo.sha1 && !(await utils.verifyFileSha1(assetIndexPath, assetIndexInfo.sha1)))) {
            const targetPath = path.join(ctx.dirs.ASSETS_DIR, 'indexes', `${assetIndexInfo.id}.json`);
            const dir = path.dirname(targetPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            try {
                if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
                await http.downloadFileWithMirror(assetIndexInfo.url, targetPath);
                assetIndexPath = targetPath;
            } catch (e) {
                console.error(`[Download] 资源索引下载失败: ${e.message}`);
            }
        }

        if (fs.existsSync(assetIndexPath)) {
            try {
                const assetIndexData = JSON.parse(fs.readFileSync(assetIndexPath, 'utf-8'));
                const assetObjects = assetIndexData.objects || {};
                const existingAssetUrls = new Set(allFiles.filter(f => f.type === 'asset').map(f => f.url));

                for (const [name, info] of Object.entries(assetObjects)) {
                    const hash = info.hash;
                    const subDir = hash.substring(0, 2);
                    let assetPath = path.join(ctx.dirs.ASSETS_DIR, 'objects', subDir, hash);
                    if (!fs.existsSync(assetPath) && dlExternalAssetsDir) {
                        const exPath = path.join(dlExternalAssetsDir, 'objects', subDir, hash);
                        if (fs.existsSync(exPath)) assetPath = exPath;
                    }
                    const assetUrl = `https://resources.download.minecraft.net/${subDir}/${hash}`;

                    if (!fs.existsSync(assetPath) && !existingAssetUrls.has(assetUrl)) {
                        allFiles.push({
                            type: 'asset',
                            url: assetUrl,
                            path: path.join(ctx.dirs.ASSETS_DIR, 'objects', subDir, hash),
                            sha1: hash,
                            size: info.size,
                            name: name
                        });
                        existingAssetUrls.add(assetUrl);
                    }
                }
            } catch (e) {}
        }
    }

    const settings = versions.loadSettingsCached();
    const CONCURRENT_DOWNLOADS = maxThreads || parseInt(settings.maxThreads, 10) || 64;
    const PRELOAD_QUEUE_SIZE = CONCURRENT_DOWNLOADS * 2;

    ctx.DownloadManager.connectionLimit = Math.min(Math.max(CONCURRENT_DOWNLOADS * 4, 64), 128);
    ctx.DownloadManager.reset();
    ctx.DownloadManager.totalFiles = allFiles.length;

    const speedLimit = parseInt(settings.speedLimit, 10) || 0;
    ctx.DownloadManager.setSpeedLimit(speedLimit);

    const preCheckFiles = [];
    const skipFiles = [];
    for (const file of allFiles) {
        if (fs.existsSync(file.path)) {
            if (file.sha1) {
                try {
                    const actualSha1 = await utils.calculateSHA1(file.path);
                    if (actualSha1 === file.sha1) {
                        skipFiles.push(file);
                        ctx.DownloadManager.skippedFiles++;
                        continue;
                    }
                } catch (e) {}
                try { fs.unlinkSync(file.path); } catch (e) {}
            } else {
                try {
                    const stat = fs.statSync(file.path);
                    if (stat.size > 0) {
                        if (file.path.endsWith('.jar') && !utils.isJarIntact(file.path)) {
                            try { fs.unlinkSync(file.path); } catch (_) {}
                        } else {
                            skipFiles.push(file);
                            ctx.DownloadManager.skippedFiles++;
                            continue;
                        }
                    }
                } catch (e) {}
            }
        }
        preCheckFiles.push(file);
    }

    if (skipFiles.length > 0) {
        console.log(`[下载] 跳过 ${skipFiles.length} 个已存在的文件`);
    }

    allFiles = preCheckFiles;
    const total = allFiles.length + skipFiles.length;
    ctx.DownloadManager.totalFiles = total;

    if (allFiles.length === 0) {
        console.log(`[下载] 所有文件已存在，无需下载`);
        if (onProgress) {
            onProgress({
                status: 'completed',
                current: skipFiles.length,
                total: total,
                progress: 100,
                completedFiles: skipFiles.length,
                totalFiles: total,
                speed: 0
            });
        }
        return { completed: skipFiles.length, failed: 0, total: skipFiles.length, errors: [], failedFiles: [], skipped: skipFiles.length };
    }

    console.log(`[下载] 开始下载 ${allFiles.length} 个文件 (跳过 ${skipFiles.length}), 文件并发: ${CONCURRENT_DOWNLOADS}, 连接池: ${ctx.DownloadManager.connectionLimit}, 限速: ${speedLimit > 0 ? speedLimit + ' MB/s' : '无限制'}`);

    let completed = skipFiles.length;
    let failed = 0;
    const errors = [];
    const failedFiles = [];
    const activeDownloads = new Map();

    let fileIndex = 0;
    let activeCount = 0;
    let resolveAll = null;

    const prepareFile = (file) => {
        const dir = path.dirname(file.path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    };

    const downloadSingleFile = async (file) => {
        const downloadId = `${file.name}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        activeDownloads.set(downloadId, { name: file.name, progress: 0, speed: 0, bytesDownloaded: 0, totalBytes: 0 });

        try {
            await http.downloadFileWithMirror(file.url, file.path, (p) => {
                const active = activeDownloads.get(downloadId);
                if (active) {
                    active.progress = p.progress || 0;
                    active.speed = p.speed || 0;
                    active.bytesDownloaded = p.bytesDownloaded || 0;
                    active.totalBytes = p.totalBytes || 0;
                }
                if (onProgress) {
                    onProgress({
                        current: completed + failed + 1,
                        total,
                        file: file.name,
                        progress: Math.round(((completed + failed + (p.progress || 0) / 100) / total) * 100),
                        bytesDownloaded: p.bytesDownloaded || 0,
                        totalBytes: p.totalBytes || 0,
                        speed: ctx.DownloadManager.getSpeed() || p.speed || 0,
                        activeDownloads: Array.from(activeDownloads.values()),
                        completed,
                        failed,
                        queued: Math.min(PRELOAD_QUEUE_SIZE, allFiles.length - fileIndex - activeCount),
                        concurrentDownloads: CONCURRENT_DOWNLOADS,
                        activeConnections: ctx.DownloadManager.activeConnections,
                        connectionLimit: ctx.DownloadManager.connectionLimit,
                        chunks: p.chunks || 1,
                        activeChunks: p.activeChunks || 1
                    });
                }
            }, 3);

            if (file.sha1) {
                const actualSha1 = await utils.calculateSHA1(file.path);
                if (actualSha1 !== file.sha1) {
                    console.warn(`[下载] SHA1校验失败: ${file.name} (期望: ${file.sha1}, 实际: ${actualSha1})`);
                    try { fs.unlinkSync(file.path); } catch (e) {}

                    const mirrorUrls = http.getMirrorUrls(file.url);
                    let retrySuccess = false;
                    for (let mi = 0; mi < mirrorUrls.length; mi++) {
                        try {
                            console.log(`[下载] SHA1重试镜像 ${mi + 1}/${mirrorUrls.length}: ${mirrorUrls[mi]}`);
                            await http.downloadFile(mirrorUrls[mi], file.path, null, 2);
                            const retrySha1 = await utils.calculateSHA1(file.path);
                            if (retrySha1 === file.sha1) {
                                retrySuccess = true;
                                break;
                            }
                            try { fs.unlinkSync(file.path); } catch (e) {}
                        } catch (e2) {
                            console.warn(`[下载] 镜像重试失败: ${mirrorUrls[mi]} - ${e2.message}`);
                        }
                    }

                    if (retrySuccess) {
                        completed++;
                        ctx.DownloadManager.completedFiles++;
                    } else {
                        const errorMsg = `${file.name}: SHA1校验失败`;
                        errors.push(errorMsg);
                        failedFiles.push({ name: file.name, url: file.url, path: file.path, error: 'SHA1校验失败' });
                        console.error(`[下载] 所有镜像重试后SHA1仍然失败: ${file.name}`);
                        failed++;
                        ctx.DownloadManager.failedFiles++;
                    }
                } else {
                    completed++;
                    ctx.DownloadManager.completedFiles++;
                }
            } else {
                completed++;
                ctx.DownloadManager.completedFiles++;
            }
        } catch (e) {
            const errorMsg = `${file.name}: 下载失败 (${e.message})`;
            errors.push(errorMsg);
            failedFiles.push({ name: file.name, url: file.url, path: file.path, error: e.message });
            console.error(`[下载] 下载失败: ${file.name} - URL: ${file.url} - 错误: ${e.message}`);
            failed++;
            ctx.DownloadManager.failedFiles++;
        } finally {
            activeDownloads.delete(downloadId);
            activeCount--;

            while (activeCount < CONCURRENT_DOWNLOADS && fileIndex < allFiles.length) {
                const nextFile = allFiles[fileIndex++];
                prepareFile(nextFile);
                activeCount++;
                downloadSingleFile(nextFile);
            }

            if (onProgress) {
                onProgress({
                    current: completed + failed,
                    total,
                    file: `已完成 ${completed + failed}/${total} 个文件`,
                    progress: Math.round(((completed + failed) / total) * 100),
                    bytesDownloaded: 0,
                    totalBytes: 0,
                    speed: ctx.DownloadManager.getSpeed(),
                    activeDownloads: Array.from(activeDownloads.values()),
                    completed,
                    failed,
                    skipped: skipFiles.length,
                    queued: Math.max(0, allFiles.length - fileIndex),
                    failedFiles,
                    stats: ctx.DownloadManager.getStats()
                });
            }

            if (activeCount === 0 && fileIndex >= allFiles.length && resolveAll) {
                resolveAll();
            }
        }
    };

    const initialBatch = Math.min(CONCURRENT_DOWNLOADS + PRELOAD_QUEUE_SIZE, allFiles.length);
    for (let i = 0; i < initialBatch; i++) {
        prepareFile(allFiles[i]);
    }

    const startPromise = new Promise((resolve) => {
        resolveAll = resolve;

        for (let i = 0; i < Math.min(CONCURRENT_DOWNLOADS, allFiles.length); i++) {
            fileIndex++;
            activeCount++;
            downloadSingleFile(allFiles[i]);
        }

        if (allFiles.length === 0) {
            resolve();
        }
    });

    await startPromise;

    console.log(`[下载] 下载完成: 成功 ${completed}, 失败 ${failed}, 总计 ${total}`);
    if (failedFiles.length > 0) {
        console.log(`[下载] 失败文件列表:`);
        failedFiles.forEach(f => console.log(`  - ${f.name}: ${f.error}`));
    }

    if (onProgress) {
        onProgress({
            status: failed > 0 ? 'completed_with_errors' : 'completed',
            current: completed + failed,
            total,
            progress: 100,
            completedFiles: completed,
            totalFiles: total,
            speed: 0,
            failed,
            failedFiles
        });
    }

    return { completed, failed, total, errors, failedFiles, skipped: skipFiles.length };
}

module.exports = {
    checkDependencies,
    downloadMissingDependencies,
};
