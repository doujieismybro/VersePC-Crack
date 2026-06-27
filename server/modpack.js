/**
 * server/modpack.js - 整合包导入功能模块
 * ============================================================================
 * 从 server.js 抽取的整合包本地导入相关函数（Modrinth/CurseForge/HMCL/RawZip）。
 * 通过 ctx (./context) 访问共享状态，通过 utils (./utils) 访问工具函数，
 * 通过 http (./http-client) 访问 HTTP 请求功能，通过 versions (./versions) 访问版本管理，
 * 通过 modloaders (./modloaders) 访问模组加载器安装。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const ctx = require('./context');
const utils = require('./utils');
const http = require('./http-client');
const versions = require('./versions');
const modloaders = require('./modloaders');

// ─── 整合包本地导入（拖拽安装入口）───

// 重复版本名自动去重，避免覆盖已有版本
function _dedupeVersionId(baseName) {
    let candidate = baseName;
    let counter = 2;
    while (fs.existsSync(path.join(ctx.dirs.VERSIONS_DIR, candidate))) {
        candidate = `${baseName} (${counter})`;
        counter++;
        if (counter > 999) break;
    }
    return candidate;
}

// 整合包导入后修复损坏的JAR文件
// AdmZip解压大型JAR或特殊压缩格式时可能产生损坏文件
async function _repairCorruptedModJars(versionDir) {
    const modsDir = path.join(versionDir, 'mods');
    if (!fs.existsSync(modsDir)) return { repaired: 0, failed: 0 };

    const corruptedJars = [];
    function scanDir(dir) {
        const items = fs.readdirSync(dir);
        for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) { scanDir(fullPath); continue; }
            if (!item.toLowerCase().endsWith('.jar')) continue;
            if (stat.size < 100) { corruptedJars.push({ path: fullPath, reason: 'too_small' }); continue; }
            if (!utils.isJarIntact(fullPath)) { corruptedJars.push({ path: fullPath, reason: 'corrupted' }); }
        }
    }
    scanDir(modsDir);

    if (corruptedJars.length === 0) return { repaired: 0, failed: 0 };

    console.log(`[Modpack] 发现 ${corruptedJars.length} 个损坏的JAR文件，尝试修复...`);
    let repaired = 0, failed = 0;

    for (const jar of corruptedJars) {
        let fixed = false;
        try {
            const tempDir = jar.path + '_repair_tmp';
            if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
            fs.mkdirSync(tempDir, { recursive: true });

            if (process.platform === 'win32') {
                try {
                    const { execSync } = require('child_process');
                    execSync(`powershell -NoProfile -NonInteractive -Command "Expand-Archive -Path '${jar.path.replace(/'/g, "''")}' -DestinationPath '${tempDir.replace(/'/g, "''")}' -Force"`, { stdio: 'pipe', timeout: 30000, windowsHide: true });
                    const files = [];
                    function collectPowershell(d) { for (const i of fs.readdirSync(d)) { const p = path.join(d, i); if (fs.statSync(p).isDirectory()) collectPowershell(p); else files.push(p); } }
                    collectPowershell(tempDir);
                    if (files.length > 0) {
                        const AdmZip = require('adm-zip');
                        const newZip = new AdmZip();
                        for (const f of files) {
                            const rel = path.relative(tempDir, f).replace(/\\/g, '/');
                            newZip.addLocalFile(f, path.dirname(rel));
                        }
                        newZip.writeZip(jar.path);
                        if (utils.isJarIntact(jar.path)) { fixed = true; console.log(`[Modpack] 已修复: ${path.basename(jar.path)}`); }
                    }
                } catch (e) {
                    console.warn(`[Modpack] PowerShell修复失败 ${path.basename(jar.path)}: ${e.message}`);
                }
            }

            if (!fixed) {
                const { execSync } = require('child_process');
                const tempDir2 = jar.path + '_unzip_tmp';
                if (fs.existsSync(tempDir2)) fs.rmSync(tempDir2, { recursive: true, force: true });
                fs.mkdirSync(tempDir2, { recursive: true });
                try {
                    execSync(`unzip -o "${jar.path}" -d "${tempDir2}"`, { stdio: 'pipe', timeout: 30000 });
                    const AdmZip = require('adm-zip');
                    const newZip = new AdmZip();
                    function addDirToZip(zip, dir, base) { for (const i of fs.readdirSync(dir)) { const p = path.join(dir, i); if (fs.statSync(p).isDirectory()) addDirToZip(zip, p, base); else zip.addLocalFile(p, path.relative(base, path.dirname(p)).replace(/\\/g, '/')); } }
                    addDirToZip(newZip, tempDir2, tempDir2);
                    newZip.writeZip(jar.path);
                    if (utils.isJarIntact(jar.path)) { fixed = true; console.log(`[Modpack] unzip已修复: ${path.basename(jar.path)}`); }
                } catch (e) {}
                if (fs.existsSync(tempDir2)) fs.rmSync(tempDir2, { recursive: true, force: true });
            }

            if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {
            console.warn(`[Modpack] 修复失败 ${path.basename(jar.path)}: ${e.message}`);
        }
        if (fixed) repaired++; else failed++;
    }

    console.log(`[Modpack] JAR修复完成: ${repaired}个修复, ${failed}个失败`);
    return { repaired, failed };
}

const _WIN_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
function isModpackPathSafe(entryPath) {
    if (!entryPath) return false;
    if (entryPath.replace(/\\/g, '/').toLowerCase().startsWith('__macosx/')) return false;
    const segments = entryPath.replace(/\\/g, '/').split('/');
    for (const seg of segments) {
        if (seg && _WIN_RESERVED_NAMES.test(seg)) return false;
    }
    return true;
}

// overrides解压JAR文件后的完整性校验
async function _extractOverridesWithVerification(zip, versionDir, entries) {
    let extracted = 0;
    let corrupted = 0;
    for (const entry of entries) {
        if (entry.isDirectory) continue;
        const entryName = entry.entryName;
        if (!isModpackPathSafe(entryName)) continue;
        let relPath = null;
        if (entryName.startsWith('overrides/')) relPath = entryName.slice('overrides/'.length);
        else if (entryName.startsWith('client-overrides/')) relPath = entryName.slice('client-overrides/'.length);
        if (!relPath) continue;

        const destPath = path.resolve(versionDir, relPath);
        const resolvedBase = path.resolve(versionDir);
        if (!destPath.startsWith(resolvedBase + path.sep) && destPath !== resolvedBase) continue;

        const isModJar = relPath.toLowerCase().startsWith('mods/') && relPath.toLowerCase().endsWith('.jar');
        await utils.asyncEnsureDir(destPath);

        for (let attempt = 1; attempt <= 5; attempt++) {
            try { await fs.promises.writeFile(destPath, entry.getData()); break; } catch (e) {
                if (attempt < 5) await new Promise(r => setTimeout(r, (attempt - 1) * 2000));
            }
        }

        if (isModJar) {
            const jarStat = fs.existsSync(destPath) ? fs.statSync(destPath) : null;
            if (!jarStat || jarStat.size < 100 || !utils.isJarIntact(destPath)) {
                corrupted++;
                console.warn(`[Modpack] 解压后JAR损坏: ${relPath} (${jarStat?.size || 0} bytes)，标记待修复`);
            }
        }

        if (++extracted % 50 === 0) utils.yieldToEventLoop();
    }
    return { extracted, corrupted };
}

/**
 * 从本地文件路径导入整合包（.mrpack / CurseForge .zip）
 * @param {string} filePath  - 本地文件的绝对路径
 * @param {function} onProgress - 进度回调 ({ stage, message, progress: 0-100 })
 * @param {string} targetVersion - 目标版本ID（版本隔离）
 */
async function importModpackFromPath(filePath, onProgress, targetVersion = '', abortSignal = null) {
    const stageHistory = [];
    const progress = (stage, message, pct, files, currentFile) => {
        const existingIdx = stageHistory.findIndex(s => s.stage === stage);
        if (existingIdx >= 0) {
            stageHistory[existingIdx].progress = pct;
            stageHistory[existingIdx].message = message;
        } else {
            stageHistory.push({ stage, message, progress: pct });
        }
        utils._writeImportLog(`[进度] ${stage} ${Math.round(pct)}% - ${message || ''} ${currentFile ? '(' + currentFile + ')' : ''}`);
        const filesSnapshot = files ? files.slice(0, Math.min(files.length, 200)).map(f => ({ n: f.name, s: f.status, p: f.progress || 0, e: f.error || '', sp: f.speed || 0 })) : [];
        const stagesSnapshot = stageHistory.map(s => ({ stage: s.stage, message: s.message, progress: s.progress }));
        if (typeof onProgress === 'function') onProgress({ stage, message, progress: pct, files: filesSnapshot, currentFile: currentFile || '', stageHistory: stagesSnapshot });
    };

    utils._clearImportLog();
    utils._writeImportLog(`========== 开始导入整合包 ==========`);
    utils._writeImportLog(`文件路径: ${filePath}`);
    utils._writeImportLog(`目标版本: ${targetVersion || '(自动)'}`);
    console.log(`[Modpack] ========== 开始导入整合包 ==========`);
    console.log(`[Modpack] 文件路径: ${filePath}`);
    console.log(`[Modpack] 目标版本: ${targetVersion || '(自动)'}`);

    if (!filePath || !fs.existsSync(filePath)) {
        console.error(`[Modpack] 文件不存在: ${filePath}`);
        return { success: false, error: '文件不存在: ' + filePath };
    }
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.mrpack' && ext !== '.zip') {
        console.error(`[Modpack] 不支持的文件格式: ${ext}`);
        return { success: false, error: '不支持的文件格式，请拖入 .mrpack 或 .zip 整合包' };
    }

    progress('read', '正在读取整合包...', 5);

    let AdmZip;
    try { AdmZip = utils.getAdmZip(); } catch (e) {
        console.error(`[Modpack] 加载 AdmZip 失败:`, e.message);
        return { success: false, error: e.message };
    }

    const fileStat = fs.statSync(filePath);
    console.log(`[Modpack] 文件大小: ${(fileStat.size / 1024 / 1024).toFixed(1)} MB`);
    if (fileStat.size < 1024) {
        console.error(`[Modpack] 文件太小: ${fileStat.size} 字节`);
        return { success: false, error: '文件太小（' + fileStat.size + ' 字节），可能下载不完整' };
    }
    const fd = fs.openSync(filePath, 'r');
    const magicBuf = Buffer.alloc(4);
    fs.readSync(fd, magicBuf, 0, 4, 0);
    fs.closeSync(fd);
    if (magicBuf[0] !== 0x50 || magicBuf[1] !== 0x4B || magicBuf[2] !== 0x03 || magicBuf[3] !== 0x04) {
        console.error(`[Modpack] ZIP magic bytes 无效: ${magicBuf.toString('hex')}`);
        return { success: false, error: '文件格式无效（不是有效的 ZIP 文件），可能下载损坏' };
    }

    let zip;
    try { zip = new AdmZip(filePath); } catch (e) {
        console.error(`[Modpack] 无法读取 ZIP:`, e.message);
        if (ext === '.rar') {
            return { success: false, error: '不支持 rar 格式的压缩包，请解压后重新压缩为 zip 格式再试' };
        }
        if (e.message && (e.message.includes('END header') || e.message.includes('Invalid') || e.message.includes('corrupt'))) {
            return { success: false, error: '整合包文件损坏或下载不完整，请删除后重新下载' };
        }
        return { success: false, error: '打开整合包文件失败，文件可能损坏或为不支持的压缩包格式' };
    }

    // 检测加密ZIP
    try {
        const entries = zip.getEntries();
        const encrypted = entries.some(e => e.header && (e.header.flags & 1) === 1);
        if (encrypted) {
            return { success: false, error: '不支持加密的压缩包，请解压后重新压缩为不加密的 zip 格式再试' };
        }
    } catch (e) {
        console.warn(`[Modpack] 检测加密状态失败:`, e.message);
    }

    const modrinthEntry = zip.getEntry('modrinth.index.json');
    const curseEntry    = zip.getEntry('manifest.json');
    const hmclEntry     = zip.getEntry('modpack.json');
    const mmcEntry      = zip.getEntry('mmc-pack.json');
    utils._writeImportLog(`ZIP分析: Modrinth=${!!modrinthEntry}, CurseForge=${!!curseEntry}, HMCL=${!!hmclEntry}, MMC=${!!mmcEntry}`);

    let result;
    const tempFiles = [];
    try {
        if (modrinthEntry) {
            utils._writeImportLog(`检测到 Modrinth 整合包`);
            console.log(`[Modpack] 检测到 Modrinth 整合包 (.mrpack)`);
            result = await _importMrpack(zip, modrinthEntry, filePath, progress, targetVersion, abortSignal);
        } else if (curseEntry) {
            utils._writeImportLog(`检测到 CurseForge 整合包`);
            console.log(`[Modpack] 检测到 CurseForge 整合包`);
            result = await _importCurseForge(zip, curseEntry, filePath, progress, targetVersion, abortSignal);
        } else if (hmclEntry) {
            utils._writeImportLog(`检测到 HMCL 整合包`);
            console.log(`[Modpack] 检测到 HMCL 整合包 (modpack.json)`);
            result = await _importHmcl(zip, hmclEntry, filePath, progress, targetVersion, abortSignal);
        } else {
            utils._writeImportLog(`未检测到已知格式，尝试普通ZIP导入`);
            console.log(`[Modpack] 未检测到已知整合包格式，尝试作为普通 ZIP 导入`);
            result = await _importRawZip(zip, filePath, progress, targetVersion, abortSignal);
        }
    } catch (e) {
        utils._writeImportLog(`[错误] 异常: ${e.stack || e.message}`);
        console.error(`[Modpack] Import exception:`, e.stack || e.message);
        if (result && result.versionId) {
            versions.cleanupVersionChain(result.versionId);
            console.log(`[Modpack] Cleaned up failed version chain: ${result.versionId}`);
        }
        if (result && result.loaderVersionId) {
            try {
                const loaderDir = path.join(ctx.dirs.VERSIONS_DIR, result.loaderVersionId);
                if (fs.existsSync(loaderDir)) {
                    fs.rmSync(loaderDir, { recursive: true, force: true });
                    console.log(`[Modpack] 清理加载器目录: ${result.loaderVersionId}`);
                }
            } catch (ce) {
                console.error(`[Modpack] 清理加载器目录失败: ${ce.message}`);
            }
        }
        for (const tmp of tempFiles) {
            try {
                if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
            } catch (te) {}
        }
        return { success: false, error: '整合包导入失败: ' + e.message, stageHistory };
    }

    if (result && !result.success && result.versionId) {
        console.error(`[Modpack] 导入失败，清理版本链: ${result.versionId}`);
        versions.cleanupVersionChain(result.versionId);
        if (result.loaderVersionId) {
            try {
                const loaderDir = path.join(ctx.dirs.VERSIONS_DIR, result.loaderVersionId);
                if (fs.existsSync(loaderDir)) {
                    fs.rmSync(loaderDir, { recursive: true, force: true });
                    console.log(`[Modpack] 清理加载器目录: ${result.loaderVersionId}`);
                }
            } catch (ce) {
                console.error(`[Modpack] 清理加载器目录失败: ${ce.message}`);
            }
        }
    }

    if (result?.success) {
        ctx.caches._versionsCache = null;
        ctx.caches._versionsCacheTime = 0;
        utils._writeImportLog(`========== 导入成功 ==========`);
        utils._writeImportLog(`版本ID: ${result.versionId}, 整合包名: ${result.name}`);
        console.log(`[Modpack] ========== 导入成功 ==========`);
        console.log(`[Modpack] 版本ID: ${result.versionId}`);
        console.log(`[Modpack] 整合包名: ${result.name}`);
    } else {
        ctx.caches._versionsCache = null;
        ctx.caches._versionsCacheTime = 0;
        utils._writeImportLog(`========== 导入失败 ==========`);
        utils._writeImportLog(`错误: ${result?.error}`);
        console.error(`[Modpack] ========== 导入失败 ==========`);
        console.error(`[Modpack] 错误: ${result?.error}`);
    }

    return result;
}

async function _importMrpack(zip, manifestEntry, filePath, progress, targetVersion = '', abortSignal = null) {
    console.log(`[mrpack] ========== 开始解析 Modrinth 整合包 ==========`);
    const settings = versions.loadSettingsCached();
    let manifest;
    try {
        manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
    } catch (e) {
        console.error(`[mrpack] 解析 modrinth.index.json 失败:`, e.message);
        return { success: false, error: '解析 modrinth.index.json 失败: ' + e.message };
    }

    const packName    = (manifest.name || path.basename(filePath, path.extname(filePath))).replace(/[<>:"/\\|?*]/g, '_');
    let   mcVersion   = (manifest.dependencies && manifest.dependencies.minecraft && manifest.dependencies.minecraft !== 'minecraft' && /^\d/.test(manifest.dependencies.minecraft)) ? manifest.dependencies.minecraft : '';
    if (mcVersion && manifest.versionId && mcVersion === manifest.versionId) { mcVersion = ''; }
    const fabricVer   = manifest.dependencies ? manifest.dependencies['fabric-loader'] : undefined;
    let   forgeVer    = manifest.dependencies ? manifest.dependencies.forge : undefined;
    const neoforgeVer = manifest.dependencies ? manifest.dependencies.neoforge : undefined;

    if (forgeVer && forgeVer.startsWith(mcVersion + '-')) {
        forgeVer = forgeVer.slice(mcVersion.length + 1);
        console.log(`[mrpack] Forge 版本标准化: ${manifest.dependencies.forge} -> ${forgeVer}`);
    }

    console.log(`[mrpack] 整合包: ${packName}`);
    console.log(`[mrpack] MC版本: ${mcVersion || '(未指定)'}`);
    console.log(`[mrpack] Fabric: ${fabricVer || '(无)'}`);
    console.log(`[mrpack] Forge: ${forgeVer || '(无)'}`);
    console.log(`[mrpack] NeoForge: ${neoforgeVer || '(无)'}`);
    console.log(`[mrpack] 文件数量: ${(manifest.files || []).length}`);

    progress('prepare', `整合包: ${packName}  MC: ${mcVersion}`, 8);

    let versionId;
    let versionDir;

    if (targetVersion) {
        const cleanTargetId = targetVersion.replace(/ \[外部\d*\]/, '');
        const existingDir = path.join(ctx.dirs.VERSIONS_DIR, cleanTargetId);
        if (fs.existsSync(existingDir)) {
            versionId = cleanTargetId;
            versionDir = existingDir;
            console.log(`[Modpack] 安装到现有版本: ${versionId}`);
        } else {
            const extFolders = versions.loadExternalFolders();
            for (const folder of extFolders) {
                if (!fs.existsSync(folder.path)) continue;
                const extVers = versions.scanExternalFolder(folder.path);
                const extV = extVers.find(v => v.id === cleanTargetId);
                if (extV) {
                    versionId = cleanTargetId;
                    versionDir = extV.externalVersionDir;
                    console.log(`[Modpack] 安装到外部版本: ${versionId}`);
                    break;
                }
            }
        }
        if (!versionDir) {
            versionId = _dedupeVersionId(packName);
            versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
            console.log(`[Modpack] 目标版本不存在，创建新版本: ${versionId}`);
        }
    } else {
        versionId = _dedupeVersionId(packName);
        versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
        console.log(`[Modpack] 未指定目标版本，创建新版本: ${versionId}`);
    }

    const isNewVersionDir = !fs.existsSync(path.join(versionDir, `${versionId}.json`));

    if (!fs.existsSync(versionDir)) {
        fs.mkdirSync(versionDir, { recursive: true });
    }

    let loaderVersionId = null;
    if (forgeVer) loaderVersionId = `${mcVersion}-forge-${forgeVer}`;
    else if (neoforgeVer) loaderVersionId = `${mcVersion}-neoforge-${neoforgeVer}`;
    else if (fabricVer) loaderVersionId = `fabric-loader-${fabricVer}-${mcVersion}`;

    if (isNewVersionDir) {
        const _baseStartTime = Date.now();
        progress('base', '正在准备基础版本...', 5);
        console.log(`[mrpack] >>> [步骤1/5] 确保基础版本存在: ${mcVersion} (${new Date().toLocaleTimeString()})`);
        utils._writeImportLog(`>>> [步骤1/5] 确保基础版本存在: ${mcVersion}`);
        const baseResult = await modloaders.ensureBaseVersionInstalled(mcVersion, (msg, pct) => {
            const elapsed = Math.round((Date.now() - _baseStartTime) / 1000);
            console.log(`[mrpack] 基础版本进度: ${msg} (${Math.round(pct)}%, ${elapsed}s)`);
            progress('base', msg || '正在准备基础版本...', 5 + Math.min(pct, 100) * 0.15);
        });
        console.log(`[mrpack] <<< [步骤1/5] 基础版本完成: error=${baseResult.error || '无'}, alreadyInstalled=${baseResult.alreadyInstalled || false}, 耗时=${Math.round((Date.now() - _baseStartTime) / 1000)}s`);
        utils._writeImportLog(`<<< [步骤1/5] 基础版本完成: error=${baseResult.error || '无'}, alreadyInstalled=${baseResult.alreadyInstalled || false}, 耗时=${Math.round((Date.now() - _baseStartTime) / 1000)}s`);
        if (baseResult.error) {
            try { if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true }); } catch (e) {}
            return { success: false, versionId, error: baseResult.error };
        }

        if (forgeVer || neoforgeVer || fabricVer) {
            const _loaderStartTime = Date.now();
            progress('loader-install', '正在安装模组加载器...', 20);
            try {
                if (forgeVer) {
                    loaderVersionId = `${mcVersion}-forge-${forgeVer}`;
                    const lvJson = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                    if (!fs.existsSync(lvJson) || !modloaders.verifyLoaderLibs(loaderVersionId)) {
                        if (fs.existsSync(lvJson) && !modloaders.verifyLoaderLibs(loaderVersionId)) {
                            console.log(`[mrpack] Forge ${loaderVersionId} 库文件缺失，重新安装`);
                            try { fs.rmSync(path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId), { recursive: true, force: true }); } catch (e) {}
                        }
                        console.log(`[mrpack] >>> [步骤2/5] 安装Forge: ${forgeVer} (MC ${mcVersion}) (${new Date().toLocaleTimeString()})`);
                        utils._writeImportLog(`>>> [步骤2/5] 安装Forge: ${forgeVer} (MC ${mcVersion})`);
                        const _forgeStartTime = Date.now();
                        const ir = await modloaders.installForge(mcVersion, forgeVer, (p, msg) => {
                            const np = p > 1 ? p / 100 : p;
                            const elapsed = Math.round((Date.now() - _forgeStartTime) / 1000);
                            console.log(`[mrpack] Forge安装进度: ${(np*100).toFixed(1)}% (${elapsed}s) ${msg || ''}`);
                            progress('loader-install', msg || '正在安装Forge...', 20 + np * 15);
                        });
                        console.log(`[mrpack] <<< [步骤2/5] Forge安装完成: success=${ir.success}, 耗时=${Math.round((Date.now() - _forgeStartTime) / 1000)}s, error=${ir.error || '无'}`);
                        utils._writeImportLog(`<<< [步骤2/5] Forge安装完成: success=${ir.success}, 耗时=${Math.round((Date.now() - _forgeStartTime) / 1000)}s, error=${ir.error || '无'}`);
                        if (!ir.success) throw new Error(ir.error);
                    } else {
                        console.log(`[mrpack] Forge ${loaderVersionId} 已安装，跳过`);
                    }
                } else if (neoforgeVer) {
                    loaderVersionId = `${mcVersion}-neoforge-${neoforgeVer}`;
                    const lvJson = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                    if (!fs.existsSync(lvJson) || !modloaders.verifyLoaderLibs(loaderVersionId)) {
                        if (fs.existsSync(lvJson) && !modloaders.verifyLoaderLibs(loaderVersionId)) {
                            console.log(`[mrpack] NeoForge ${loaderVersionId} 库文件缺失，重新安装`);
                            try { fs.rmSync(path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId), { recursive: true, force: true }); } catch (e) {}
                        }
                        console.log(`[mrpack] >>> [步骤2/5] 安装NeoForge: ${neoforgeVer} (MC ${mcVersion}) (${new Date().toLocaleTimeString()})`);
                        utils._writeImportLog(`>>> [步骤2/5] 安装NeoForge: ${neoforgeVer} (MC ${mcVersion})`);
                        const _nfStartTime = Date.now();
                        const ir = await modloaders.installNeoForge(mcVersion, neoforgeVer, (p, msg) => {
                            const np = p > 1 ? p / 100 : p;
                            const elapsed = Math.round((Date.now() - _nfStartTime) / 1000);
                            console.log(`[mrpack] NeoForge安装进度: ${(np*100).toFixed(1)}% (${elapsed}s) ${msg || ''}`);
                            progress('loader-install', msg || '正在安装NeoForge...', 20 + np * 15);
                        });
                        console.log(`[mrpack] <<< [步骤2/5] NeoForge安装完成: success=${ir.success}, 耗时=${Math.round((Date.now() - _nfStartTime) / 1000)}s, error=${ir.error || '无'}`);
                        utils._writeImportLog(`<<< [步骤2/5] NeoForge安装完成: success=${ir.success}, 耗时=${Math.round((Date.now() - _nfStartTime) / 1000)}s, error=${ir.error || '无'}`);
                        if (!ir.success) throw new Error(ir.error);
                    } else {
                        console.log(`[mrpack] NeoForge ${loaderVersionId} 已安装，跳过`);
                    }
                } else if (fabricVer) {
                    loaderVersionId = `fabric-loader-${fabricVer}-${mcVersion}`;
                    const lvJson = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                    let fabricNeedInstall = !fs.existsSync(lvJson);
                    if (!fabricNeedInstall) {
                        if (!modloaders.verifyLoaderLibs(loaderVersionId)) {
                            fabricNeedInstall = true;
                        } else {
                            try {
                                const existingJson = JSON.parse(fs.readFileSync(lvJson, 'utf-8'));
                                const hasFabricLoader = (existingJson.libraries || []).some(l => l.name && l.name.startsWith('net.fabricmc:fabric-loader'));
                                if (!hasFabricLoader) {
                                    console.log(`[mrpack] Fabric ${loaderVersionId} 缺少 fabric-loader 库，重新安装`);
                                    fabricNeedInstall = true;
                                }
                            } catch (_) { fabricNeedInstall = true; }
                        }
                    }
                    if (fabricNeedInstall) {
                        if (fs.existsSync(lvJson)) {
                            console.log(`[mrpack] Fabric ${loaderVersionId} 需要重新安装`);
                            try { fs.rmSync(path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId), { recursive: true, force: true }); } catch (e) {}
                        }
                        console.log(`[mrpack] >>> [步骤2/5] 安装Fabric: ${fabricVer} (MC ${mcVersion}) (${new Date().toLocaleTimeString()})`);
                        utils._writeImportLog(`>>> [步骤2/5] 安装Fabric: ${fabricVer} (MC ${mcVersion})`);
                        const _fabStartTime = Date.now();
                        const ir = await modloaders.installFabric(mcVersion, fabricVer, (p, msg) => {
                            const np = p > 1 ? p / 100 : p;
                            const elapsed = Math.round((Date.now() - _fabStartTime) / 1000);
                            console.log(`[mrpack] Fabric安装进度: ${(np*100).toFixed(1)}% (${elapsed}s) ${msg || ''}`);
                            progress('loader-install', msg || '正在安装Fabric...', 20 + np * 15);
                        });
                        console.log(`[mrpack] <<< [步骤2/5] Fabric安装完成: success=${ir.success}, 耗时=${Math.round((Date.now() - _fabStartTime) / 1000)}s, error=${ir.error || '无'}`);
                        utils._writeImportLog(`<<< [步骤2/5] Fabric安装完成: success=${ir.success}, 耗时=${Math.round((Date.now() - _fabStartTime) / 1000)}s, error=${ir.error || '无'}`);

                        if (!ir.success) throw new Error(ir.error);
                    } else {
                        console.log(`[mrpack] Fabric ${loaderVersionId} 已安装，跳过`);
                    }
                }
            } catch (e) {
                console.error(`[mrpack] 模组加载器安装失败:`, e.stack || e.message);
                try { if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true }); } catch (ce) {}
                return { success: false, versionId, error: e.message };
            }
        }

        const _vcStartTime = Date.now();
        console.log(`[mrpack] >>> [步骤3/5] 创建版本配置 (${new Date().toLocaleTimeString()})`);
        utils._writeImportLog(`>>> [步骤3/5] 创建版本配置`);
        progress('version-config', '正在创建版本配置...', 35);

        function pcl2StyleMerge(baseJson, loaderJson, versionId) {
            const merged = { ...baseJson };
            const vanillaLibs = baseJson.libraries || [];
            const loaderLibs = loaderJson.libraries || [];
            const seenNames = new Set(loaderLibs.map(l => l.name).filter(Boolean));
            const mergedLibs = [...loaderLibs];
            for (const vl of vanillaLibs) {
                if (vl.name && !seenNames.has(vl.name)) {
                    mergedLibs.push(vl);
                    seenNames.add(vl.name);
                }
            }
            merged.libraries = mergedLibs;
            for (const key of Object.keys(loaderJson)) {
                if (key === 'libraries') continue;
                if (key === 'inheritsFrom' || key === 'jar') continue;
                if (key === 'arguments' && loaderJson.arguments && baseJson.arguments) {
                    const mergedGame = [...(baseJson.arguments.game || [])];
                    for (const ge of (loaderJson.arguments.game || [])) {
                        const geStr = typeof ge === 'string' ? ge : JSON.stringify(ge);
                        if (!mergedGame.some(mg => (typeof mg === 'string' ? mg : JSON.stringify(mg)) === geStr)) {
                            mergedGame.push(ge);
                        }
                    }
                    const expandedLoaderJvm = [];
                    const jvmArr = loaderJson.arguments.jvm || [];
                    for (let ji = 0; ji < jvmArr.length; ji++) {
                        const je = jvmArr[ji];
                        if (typeof je === 'string' && (je === '--add-opens' || je === '--add-exports' || je === '--add-reads' || je === '--add-modules')) {
                            const values = [];
                            while (ji + 1 < jvmArr.length && typeof jvmArr[ji + 1] === 'string' && !jvmArr[ji + 1].startsWith('-')) {
                                ji++;
                                values.push(jvmArr[ji]);
                            }
                            if (values.length === 0) {
                                expandedLoaderJvm.push(je);
                            } else {
                                for (const val of values) {
                                    expandedLoaderJvm.push(je, val);
                                }
                            }
                        } else {
                            expandedLoaderJvm.push(je);
                        }
                    }
                    const mergedJvm = [...(baseJson.arguments.jvm || [])];
                    for (const je of expandedLoaderJvm) {
                        const jeStr = typeof je === 'string' ? je : JSON.stringify(je);
                        if (!mergedJvm.some(mj => (typeof mj === 'string' ? mj : JSON.stringify(mj)) === jeStr)) {
                            mergedJvm.push(je);
                        }
                    }
                    merged.arguments = { game: mergedGame, jvm: mergedJvm };
                } else {
                    if (loaderJson[key] && typeof loaderJson[key] === 'object' && !Array.isArray(loaderJson[key]) && Object.keys(loaderJson[key]).length === 0 && baseJson[key] && typeof baseJson[key] === 'object' && Object.keys(baseJson[key]).length > 0) {
                        continue;
                    }
                    merged[key] = loaderJson[key];
                }
            }
            delete merged.inheritsFrom;
            delete merged._comment_;
            delete merged.jar;
            merged.id = versionId;
            merged.time = new Date().toISOString();
            merged.releaseTime = new Date().toISOString();
            return merged;
        }

        if (loaderVersionId) {
            const lvJsonPath = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
            let mergedJson = null;
            try {
                if (fs.existsSync(lvJsonPath) && mcVersion) {
                    const vanillaJsonPath = path.join(ctx.dirs.VERSIONS_DIR, mcVersion, `${mcVersion}.json`);
                    let baseJson = null;
                    if (fs.existsSync(vanillaJsonPath)) {
                        baseJson = JSON.parse(fs.readFileSync(vanillaJsonPath, 'utf-8'));
                    }
                    const lvJson = JSON.parse(fs.readFileSync(lvJsonPath, 'utf-8'));
                    if (baseJson) {
                        mergedJson = pcl2StyleMerge(baseJson, lvJson, versionId);
                    } else {
                        mergedJson = { ...lvJson };
                        delete mergedJson.inheritsFrom;
                        delete mergedJson._comment_;
                        delete mergedJson.jar;
                        mergedJson.id = versionId;
                        mergedJson.time = new Date().toISOString();
                        mergedJson.releaseTime = new Date().toISOString();
                    }
                    if (!mergedJson.clientVersion && mcVersion) {
                        mergedJson.clientVersion = mcVersion;
                    }
                    console.log(`[mrpack] PCL2式合并JSON: ${loaderVersionId} → ${versionId} (libs: ${(mergedJson.libraries || []).length}, mainClass: ${mergedJson.mainClass || '未设置'}, baseJson: ${baseJson ? '原版' : '加载器'})`);
                } else if (fs.existsSync(lvJsonPath)) {
                    mergedJson = JSON.parse(fs.readFileSync(lvJsonPath, 'utf-8'));
                    delete mergedJson.inheritsFrom;
                    delete mergedJson._comment_;
                    delete mergedJson.jar;
                    mergedJson.id = versionId;
                    mergedJson.time = new Date().toISOString();
                    mergedJson.releaseTime = new Date().toISOString();
                }
            } catch (lvErr) {
                console.error(`[mrpack] 读取加载器JSON失败:`, lvErr.message);
            }
            const versionJson = mergedJson || {
                id: versionId,
                type: 'release',
                time: new Date().toISOString(),
                releaseTime: new Date().toISOString()
            };
            if (versionJson.arguments?.jvm) {
                versionJson.arguments.jvm = versions.deduplicateJvmArgs(versionJson.arguments.jvm);
            }
            // [CRITICAL - 2026-06-21] 整合包版本JSON必须直接写入mergedJson，不能从文件重新读取！
            // 之前有段NeoForge的修复代码被错误复制到这里，导致版本JSON被覆盖为空内容。
            // 如果这里读取文件再写入，文件里的JSON可能是之前创建的空版本（没有libraries），导致整合包不出现在版本列表。
            fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(versionJson, null, 2));
            versions._invalidateResolvedJsonCache(versionId);
            console.log(`[mrpack] 创建版本JSON: ${versionId}.json (PCL2式合并, 无inheritsFrom, libs=${(versionJson.libraries||[]).length})`);
            try {
                const vanillaJar = path.join(ctx.dirs.VERSIONS_DIR, mcVersion || '', `${mcVersion}.jar`);
                const targetJar = path.join(versionDir, `${versionId}.jar`);
                if (!fs.existsSync(targetJar) && fs.existsSync(vanillaJar)) {
                    fs.copyFileSync(vanillaJar, targetJar);
                    console.log(`[mrpack] 复制原版jar到整合包: ${targetJar}`);
                }
            } catch (e) {
                console.warn(`[mrpack] 复制版本jar失败: ${e.message}`);
            }
            try {
                const loaderDir = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId);
                if (fs.existsSync(loaderDir) && loaderDir !== versionDir) {
                    fs.rmSync(loaderDir, { recursive: true, force: true });
                    console.log(`[mrpack] 已删除独立加载器文件夹: ${loaderVersionId}`);
                }
            } catch (e) {
                console.warn(`[mrpack] 删除加载器文件夹失败: ${e.message}`);
            }
        } else {
            const versionJson = {
                id: versionId,
                inheritsFrom: mcVersion || undefined,
                type: 'release',
                mainClass: 'net.minecraft.client.main.Main',
                time: new Date().toISOString(),
                releaseTime: new Date().toISOString()
            };
            fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(versionJson, null, 2));
            versions._invalidateResolvedJsonCache(versionId);
            console.log(`[mrpack] 创建版本JSON: ${versionId}.json (无加载器)`);
        }

        console.log(`[mrpack] <<< [步骤3/5] 版本配置完成, 耗时=${Math.round((Date.now() - _vcStartTime) / 1000)}s`);
        utils._writeImportLog(`<<< [步骤3/5] 版本配置完成, 耗时=${Math.round((Date.now() - _vcStartTime) / 1000)}s`);
        progress('loader', '模组加载器就绪', 40);
    }

    // 整合包重装/重导入: 检测现有版本JSON是否已合并加载器内容
    // 如果没有合并（旧版创建的inheritsFrom方式），则重新合并
    {
        const versionJsonPath = path.join(versionDir, `${versionId}.json`);
        let existingJson = null;
        try {
            if (fs.existsSync(versionJsonPath)) {
                existingJson = JSON.parse(fs.readFileSync(versionJsonPath, 'utf-8'));
            }
        } catch (_e) {}

        // If the existing JSON still has inheritsFrom, it's an old-style version that needs merging
        if (existingJson && existingJson.inheritsFrom && loaderVersionId) {
            const _remergeStartTime = Date.now();
            console.log(`[mrpack] >>> [重合并] 检测到旧版版本JSON (inheritsFrom: ${existingJson.inheritsFrom})，重新合并加载器 (${new Date().toLocaleTimeString()})`);
            progress('base-fix', `正在同步加载器到 ${loaderVersionId}...`, 5);

            if (mcVersion) {
                console.log(`[mrpack] [重合并] 确保基础版本: ${mcVersion}`);
                const baseFix = await modloaders.ensureBaseVersionInstalled(mcVersion, (msg, pct) => {
                    console.log(`[mrpack] [重合并] 基础版本进度: ${msg} (${Math.round(pct)}%)`);
                    progress('base-fix', msg || `正在准备 ${mcVersion}...`, 5 + Math.min(pct, 100) * 0.15);
                });
                console.log(`[mrpack] [重合并] 基础版本完成: error=${baseFix.error || '无'}`);
                if (baseFix.error) {
                    console.error(`[mrpack] 基础版本 ${mcVersion} 安装失败: ${baseFix.error}`);
                    try { if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true }); } catch (ce) {}
                    return { success: false, versionId, error: `基础版本 ${mcVersion} 安装失败: ${baseFix.error}` };
                }
            }

            if (loaderVersionId) {
                const lvJsonPath = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                const needInstall = !fs.existsSync(lvJsonPath) || !modloaders.verifyLoaderLibs(loaderVersionId);
                if (needInstall) {
                    if (fs.existsSync(lvJsonPath) && !modloaders.verifyLoaderLibs(loaderVersionId)) {
                        console.log(`[mrpack] ${loaderVersionId} 库文件缺失，重新安装`);
                        try { fs.rmSync(path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId), { recursive: true, force: true }); } catch (e) {}
                    }
                    console.log(`[mrpack] [重合并] 正在安装加载器: ${loaderVersionId} (${new Date().toLocaleTimeString()})`);
                    try {
                        let ir;
                        const _remergeLdrStart = Date.now();
                        if (forgeVer) ir = await modloaders.installForge(mcVersion, forgeVer, (p, msg) => { const np = p > 1 ? p / 100 : p; console.log(`[mrpack] [重合并] Forge进度: ${(np*100).toFixed(1)}% ${msg || ''}`); progress('loader-install', msg || '正在安装Forge...', 20 + np * 15); });
                        else if (neoforgeVer) ir = await modloaders.installNeoForge(mcVersion, neoforgeVer, (p, msg) => { const np = p > 1 ? p / 100 : p; console.log(`[mrpack] [重合并] NeoForge进度: ${(np*100).toFixed(1)}% ${msg || ''}`); progress('loader-install', msg || '正在安装NeoForge...', 20 + np * 15); });
                        else if (fabricVer) ir = await modloaders.installFabric(mcVersion, fabricVer, (p, msg) => { const np = p > 1 ? p / 100 : p; console.log(`[mrpack] [重合并] Fabric进度: ${(np*100).toFixed(1)}% ${msg || ''}`); progress('loader-install', msg || '正在安装Fabric...', 20 + np * 15); });
                        console.log(`[mrpack] [重合并] 加载器安装完成: success=${ir?.success}, 耗时=${Math.round((Date.now() - _remergeLdrStart) / 1000)}s`);
                        if (!ir || !ir.success) throw new Error((ir && ir.error) || `${loaderVersionId} 安装失败`);
                    } catch (e) {
                        console.error(`[mrpack] 加载器 ${loaderVersionId} 安装失败:`, e.stack || e.message);
                        try { if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true }); } catch (ce) {}
                        return { success: false, versionId, error: `整合包要求 ${loaderVersionId} 但安装失败: ${e.message}` };
                    }
                }
            }

            // re-merge: vanilla JSON as base, merge loader on top
            try {
                const lvJsonPath = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                if (fs.existsSync(lvJsonPath)) {
                    let newJson = null;
                    if (mcVersion) {
                        const vanillaJsonPath = path.join(ctx.dirs.VERSIONS_DIR, mcVersion, `${mcVersion}.json`);
                        let baseJson = null;
                        if (fs.existsSync(vanillaJsonPath)) {
                            baseJson = JSON.parse(fs.readFileSync(vanillaJsonPath, 'utf-8'));
                        }
                        const lvJson = JSON.parse(fs.readFileSync(lvJsonPath, 'utf-8'));
                        if (baseJson) {
                            newJson = pcl2StyleMerge(baseJson, lvJson, versionId);
                        } else {
                            newJson = { ...lvJson };
                            delete newJson.inheritsFrom;
                            delete newJson._comment_;
                            delete newJson.jar;
                            newJson.id = versionId;
                            newJson.time = new Date().toISOString();
                            newJson.releaseTime = new Date().toISOString();
                        }
                    } else {
                        newJson = JSON.parse(fs.readFileSync(lvJsonPath, 'utf-8'));
                        delete newJson.inheritsFrom;
                        delete newJson._comment_;
                        delete newJson.jar;
                        newJson.id = versionId;
                        newJson.time = new Date().toISOString();
                        newJson.releaseTime = new Date().toISOString();
                    }
                    if (!newJson.clientVersion && mcVersion) {
                        newJson.clientVersion = mcVersion;
                    }
                    if (newJson.arguments?.jvm) {
                        newJson.arguments.jvm = versions.deduplicateJvmArgs(newJson.arguments.jvm);
                    }
                    fs.writeFileSync(versionJsonPath, JSON.stringify(newJson, null, 2));
                    versions._invalidateResolvedJsonCache(versionId);
                    console.log(`[mrpack] 已PCL2式重新合并 ${versionId} (libs: ${(newJson.libraries || []).length})`);
                }
            } catch (e) {
                console.error(`[mrpack] 重新合并版本JSON失败:`, e.message);
            }
            try {
                const loaderDir = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId);
                if (fs.existsSync(loaderDir) && loaderDir !== versionDir) {
                    fs.rmSync(loaderDir, { recursive: true, force: true });
                    console.log(`[mrpack] 已删除独立加载器文件夹: ${loaderVersionId}`);
                }
            } catch (e) {
                console.warn(`[mrpack] 删除加载器文件夹失败: ${e.message}`);
            }
            console.log(`[mrpack] <<< [重合并] 完成, 耗时=${Math.round((Date.now() - _remergeStartTime) / 1000)}s`);
        } else if (!loaderVersionId) {
            console.log(`[mrpack] 整合包未指定加载器，跳过加载器校验`);
        } else {
            console.log(`[mrpack] 版本 ${versionId} 已合并加载器，无需更新`);
        }
    }

    if (isNewVersionDir && !fs.existsSync(path.join(versionDir, `${versionId}.json`))) {
        console.log(`[mrpack] 重导入场景: 版本JSON缺失，重新创建 ${versionId}.json`);
        let fallbackJson = {
            id: versionId,
            type: 'release',
            mainClass: 'net.minecraft.client.main.Main',
            time: new Date().toISOString(),
            releaseTime: new Date().toISOString()
        };
        try {
            if (loaderVersionId && mcVersion) {
                const lvP = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                const vanillaJsonPath = path.join(ctx.dirs.VERSIONS_DIR, mcVersion, `${mcVersion}.json`);
                if (fs.existsSync(lvP)) {
                    let baseJson = null;
                    if (fs.existsSync(vanillaJsonPath)) {
                        baseJson = JSON.parse(fs.readFileSync(vanillaJsonPath, 'utf-8'));
                    }
                    const lvJ = JSON.parse(fs.readFileSync(lvP, 'utf-8'));
                    if (baseJson) {
                        fallbackJson = pcl2StyleMerge(baseJson, lvJ, versionId);
                    } else {
                        fallbackJson = { ...lvJ };
                        delete fallbackJson.inheritsFrom;
                        delete fallbackJson._comment_;
                        delete fallbackJson.jar;
                        fallbackJson.id = versionId;
                        fallbackJson.time = new Date().toISOString();
                        fallbackJson.releaseTime = new Date().toISOString();
                    }
                    if (!fallbackJson.clientVersion) fallbackJson.clientVersion = mcVersion;
                }
            }
        } catch (_e) {}
        if (fallbackJson.arguments?.jvm) {
            fallbackJson.arguments.jvm = versions.deduplicateJvmArgs(fallbackJson.arguments.jvm);
        }
        fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(fallbackJson, null, 2));
        versions._invalidateResolvedJsonCache(versionId);
    }

    let _backupDir = null;
    if (!isNewVersionDir) {
        try {
            const existingModsDir = path.join(versionDir, 'mods');
            if (fs.existsSync(existingModsDir)) {
                _backupDir = versionDir + '.backup_' + Date.now();
                fs.cpSync(existingModsDir, path.join(_backupDir, 'mods'), { recursive: true });
                console.log(`[mrpack] 已备份 mods 目录到 ${_backupDir}`);
            }
        } catch (bkErr) {
            console.warn(`[mrpack] 备份 mods 目录失败 (非致命): ${bkErr.message}`);
            _backupDir = null;
        }
    }

    try {
    const _extractStartTime = Date.now();
    console.log(`[mrpack] >>> [步骤4/5] 解压覆盖文件 (${new Date().toLocaleTimeString()})`);
    utils._writeImportLog(`>>> [步骤4/5] 解压覆盖文件`);
    progress('extract', '解压覆盖文件...', 40, [], '');
    const entries = zip.getEntries();
    const overrideFiles = [];
    let extractYieldCounter = 0;
    let extractCount = 0;
    for (const entry of entries) {
        if (entry.isDirectory) continue;
        const entryName = entry.entryName;
        if (!isModpackPathSafe(entryName)) continue;
        let relPath = null;
        if (entryName.startsWith('overrides/')) {
            relPath = entryName.slice('overrides/'.length);
        } else if (entryName.startsWith('client-overrides/')) {
            relPath = entryName.slice('client-overrides/'.length);
        }
        if (relPath) {
            const destPath = path.join(versionDir, relPath);
            const resolvedDest = path.resolve(destPath);
            const resolvedBase = path.resolve(versionDir);
            if (!resolvedDest.startsWith(resolvedBase + path.sep) && resolvedDest !== resolvedBase) {
                console.warn(`[Modpack] 路径遍历攻击已拦截: ${relPath}`);
                continue;
            }
            await utils.asyncEnsureDir(destPath);
            let extractOk = false;
            for (let attempt = 1; attempt <= 5; attempt++) {
                try {
                    await fs.promises.writeFile(destPath, entry.getData());
                    extractOk = true;
                    break;
                } catch (e) {
                    console.warn(`[Modpack] 解压 ${relPath} 第 ${attempt} 次失败: ${e.message}`);
                    if (attempt < 5) await new Promise(r => setTimeout(r, (attempt - 1) * 2000));
                }
            }
            if (extractOk) { overrideFiles.push({ name: relPath, status: 'completed', progress: 100 }); extractCount++; }
            if (++extractYieldCounter % 50 === 0) await utils.yieldToEventLoop();
        }
    }
    console.log(`[mrpack] <<< [步骤4/5] 解压完成: ${extractCount} 个文件, 耗时=${Math.round((Date.now() - _extractStartTime) / 1000)}s`);
    utils._writeImportLog(`<<< [步骤4/5] 解压完成: ${extractCount} 个文件, 耗时=${Math.round((Date.now() - _extractStartTime) / 1000)}s`);

    try {
        const vsPath = path.join(versionDir, 'version-settings.json');
        let vs = {};
        if (fs.existsSync(vsPath)) vs = JSON.parse(fs.readFileSync(vsPath, 'utf-8'));
        if (!vs.isolation || vs.isolation === 'global') {
            vs.isolation = 'on';
            fs.writeFileSync(vsPath, JSON.stringify(vs, null, 2));
        }
    } catch (_) {}

    const targetLoaders = new Set();
    if (fabricVer) targetLoaders.add('fabric');
    if (forgeVer) targetLoaders.add('forge');
    if (neoforgeVer) targetLoaders.add('neoforge');
    console.log(`[mrpack] 目标加载器: [${[...targetLoaders].join(', ')}]`);
    let skippedByLoader = 0;
    const filesList = (manifest.files || []).filter(f => {
        if (f.env && f.env.client === 'unsupported') return false;
        if (targetLoaders.size > 0 && Array.isArray(f.loaders) && f.loaders.length > 0) {
            const fileLoaders = f.loaders.map(l => (l || '').toLowerCase());
            const compatible = [...targetLoaders].some(tl => fileLoaders.includes(tl));
            if (!compatible) { skippedByLoader++; return false; }
        }
        return true;
    });
    if (skippedByLoader > 0) console.log(`[mrpack] 已跳过 ${skippedByLoader} 个不兼容的模组`);
    const modsDir = path.join(versionDir, 'mods');
    utils.ensureDir(path.join(modsDir, 'dummy.txt'));

    const modFiles = filesList.map(f => {
        const downloads = f.downloads || [];
        const fileName = path.basename(f.path || (downloads[0] || 'unknown'));
        return { name: fileName, status: 'pending', progress: 0, size: f.fileSize || 0 };
    });

    progress('mods', `下载 Mod 文件 (共 ${filesList.length} 个)...`, 50, [...overrideFiles, ...modFiles], '');

    const _modsStartTime = Date.now();
    const PARALLEL_MODS = Math.min(parseInt(settings.maxThreads, 10) || 64, 64);
    console.log(`[mrpack] >>> [步骤5/5] 模组下载: 共 ${filesList.length} 个, 并发=${PARALLEL_MODS} (${new Date().toLocaleTimeString()})`);
    utils._writeImportLog(`>>> [步骤5/5] 模组下载: 共 ${filesList.length} 个, 并发=${PARALLEL_MODS}`);
    let okCount = 0, failCount = 0;
    let inFlight = 0;
    const _modAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 60000, maxSockets: PARALLEL_MODS * 4 + 16, maxFreeSockets: PARALLEL_MODS * 2 + 8, timeout: 120000 });
    const _prevConnLimit = ctx.DownloadManager.connectionLimit;
    ctx.DownloadManager.connectionLimit = Math.min(Math.max(PARALLEL_MODS * 4, 64), 128);
    let lastProgUpdate = 0;
    let lastReportedPct = 0;
    let smoothPct = 0;

    const _totalModSize = modFiles.reduce((sum, mf) => sum + Math.max(mf.size || 0, 102400), 0);
    const _modWeights = modFiles.map(mf => Math.max(mf.size || 0, 102400) / _totalModSize);

    const getModTimeout = (sizeBytes) => {
        if (sizeBytes > 50 * 1024 * 1024) return 600000;
        if (sizeBytes > 20 * 1024 * 1024) return 300000;
        if (sizeBytes > 5 * 1024 * 1024) return 180000;
        return 120000;
    };

    const updateOverall = () => {
        const now = Date.now();
        let weightedPct = 0;
        for (let i = 0; i < modFiles.length; i++) {
            const mf = modFiles[i];
            const w = _modWeights[i] || (1 / modFiles.length);
            weightedPct += ((mf.status === 'completed' || mf.status === 'failed') ? 100 : (mf.progress || 0)) * w;
        }
        const pct = 50 + Math.round((weightedPct / 100) * 45);
        const clamped = Math.min(pct, 95);
        if (smoothPct <= 0 || clamped <= smoothPct) {
            smoothPct = clamped;
        } else {
            smoothPct = smoothPct * 0.75 + clamped * 0.25;
        }
        const finalPct = Math.max(lastReportedPct, Math.round(smoothPct));
        if (finalPct <= lastReportedPct && now - lastProgUpdate < 200) return;
        lastReportedPct = finalPct;
        lastProgUpdate = now;
        const totalDone = okCount + failCount;
        progress('mods', `下载 Mod (${totalDone}/${filesList.length}, ${inFlight}个进行中)`, lastReportedPct, [...overrideFiles, ...modFiles], '');
    };

    const dlMod = async (fileEntry, index) => {
        inFlight++;
        if (abortSignal && abortSignal.aborted) { inFlight--; updateOverall(); return; }
        const downloads = fileEntry.downloads || [];
        if (!downloads.length) {
            console.warn(`[mrpack] 模组 ${index + 1}/${filesList.length} 无下载链接，跳过`);
            if (modFiles[index]) { modFiles[index].status = 'failed'; modFiles[index].error = '无可用下载链接'; }
            failCount++; inFlight--; updateOverall();
            return;
        }

        const fileName = path.basename(fileEntry.path || (downloads[0] || 'unknown'));
        let destPath = path.join(versionDir, fileEntry.path || path.join('mods', fileName));
        utils.ensureDir(destPath);
        console.log(`[mrpack] 下载 [${index + 1}/${filesList.length}] ${fileName} (${(fileEntry.fileSize / 1024).toFixed(0)}KB) 从 ${downloads[0]}`);

        if (modFiles[index]) { modFiles[index].status = 'downloading'; modFiles[index].progress = 0; }
        updateOverall();

        if (fileEntry.fileSize > 0 && fs.existsSync(destPath)) {
            try {
                const st = fs.statSync(destPath);
                if (st.size === fileEntry.fileSize && utils.isJarIntact(destPath)) {
                    if (modFiles[index]) { modFiles[index].status = 'completed'; modFiles[index].progress = 100; }
                    okCount++; inFlight--; updateOverall();
                    return;
                }
            } catch (_) {}
        }

        if (!utils.isJarIntact(destPath)) {
            const fileSize = fileEntry.fileSize || 0;
            let downloaded = false;
            const allUrls = [];
            for (const dl of downloads) {
                for (const mu of http.getMirrorUrls(dl)) {
                    if (!allUrls.includes(mu)) allUrls.push(mu);
                }
            }

            const _modOnProgress = (p) => {
                if (p && modFiles[index]) {
                    modFiles[index].progress = Math.round(p.progress || 0);
                    modFiles[index].downloaded = p.downloaded || 0;
                    modFiles[index].speed = p.speed || 0;
                }
                updateOverall();
            };
            const _modTimeout = getModTimeout(fileSize);

            for (const tryUrl of allUrls) {
                if (downloaded || (abortSignal && abortSignal.aborted)) break;
                try {
                    if (fileSize > 10 * 1024 * 1024) {
                        await http.downloadFileChunked(tryUrl, destPath, {
                            onProgress: _modOnProgress, retries: 2, timeout: _modTimeout,
                            abortSignal, agent: _modAgent
                        });
                    } else {
                        // [CRITICAL - 2026-06-21] retries必须>=2！之前是0，下载失败一次就放弃导致大量mod丢失。
                        // 多次重试，stallTimeout从60s增加到120s适应慢网络。
                        await http._dlSingle(tryUrl, destPath, {
                            onProgress: _modOnProgress, retries: 3, abortSignal,
                            timeout: _modTimeout, stallTimeout: 120000, agent: _modAgent
                        });
                    }
                    if (utils.isJarIntact(destPath)) {
                        const expectedSha1 = fileEntry.hashes && fileEntry.hashes.sha1;
                        if (expectedSha1) {
                            const actualSha1 = await utils.calculateSHA1(destPath);
                            if (actualSha1 === expectedSha1) { downloaded = true; }
                            else { console.warn(`[mrpack] SHA1校验失败: ${fileName}`); try { fs.unlinkSync(destPath); } catch (_) {} }
                        } else { downloaded = true; }
                    } else { try { fs.unlinkSync(destPath); } catch (_) {} }
                } catch (e) {
                    if (abortSignal && abortSignal.aborted) break;
                    console.warn(`[mrpack] ${fileName} chunked失败 (${tryUrl.split('/').pop()}): ${e.message}`);
                }
            }

            if (!downloaded && !(abortSignal && abortSignal.aborted)) {
                for (const tryUrl of allUrls) {
                    if (downloaded || (abortSignal && abortSignal.aborted)) break;
                    try {
                        await http._dlSingle(tryUrl, destPath, {
                            onProgress: _modOnProgress, retries: 0, abortSignal,
                            timeout: _modTimeout, stallTimeout: 60000, agent: _modAgent
                        });
                        if (utils.isJarIntact(destPath)) {
                            const expectedSha1 = fileEntry.hashes && fileEntry.hashes.sha1;
                            if (expectedSha1) {
                                const actualSha1 = await utils.calculateSHA1(destPath);
                                if (actualSha1 === expectedSha1) { downloaded = true; }
                                else { try { fs.unlinkSync(destPath); } catch (_) {} }
                            } else { downloaded = true; }
                        } else { try { fs.unlinkSync(destPath); } catch (_) {} }
                    } catch (e) {
                        if (abortSignal && abortSignal.aborted) break;
                        console.warn(`[mrpack] ${fileName} single失败: ${e.message}`);
                    }
                }
            }

            if (!downloaded && !(abortSignal && abortSignal.aborted)) {
                // 修复：支持从多种 Modrinth URL 格式中提取 projectID
                // 格式1: cdn.modrinth.com/data/{projectId}/versions/{versionId}/{fileName}
                // 格式2: modrinth.com/mod/{projectId}/version/{versionId}
                // 格式3: api.modrinth.com/v2/project/{projectId}/version/{versionId}
                const dlUrl = fileEntry.downloads?.[0] || '';
                const projectId = dlUrl.match(/cdn\.modrinth\.com\/data\/([^\/]+)/)?.[1]
                    || dlUrl.match(/modrinth\.com\/mod\/([^\/]+)/)?.[1]
                    || dlUrl.match(/api\.modrinth\.com\/v2\/project\/([^\/]+)/)?.[1]
                    || fileEntry.modId || '';
                const versionId = dlUrl.match(/\/versions\/([^\/]+)/)?.[1] || '';
                if (projectId) {
                    console.log(`[mrpack] Mod ${fileName} 常规下载失败，通过Modrinth API重新获取下载链接 (projectId=${projectId})...`);
                    try {
                        const loaderList = [...targetLoaders];
                        let apiRes = [];
                        if (loaderList.length > 0 && mcVersion) {
                            const qParams = `loaders=${JSON.stringify(loaderList)}&game_versions=${JSON.stringify([mcVersion])}`;
                            console.log(`[mrpack] 查询 Modrinth API: projectId=${projectId}, loaders=${loaderList.join(',')}, mc=${mcVersion}`);
                            apiRes = await http.fetchJSON(`${ctx.urls.MODRINTH_API}/project/${projectId}/version?${qParams}`);
                        }
                        if (!apiRes || apiRes.length === 0) {
                            if (mcVersion) {
                                console.log(`[mrpack] 精确匹配无结果，放宽为仅匹配 MC 版本 ${mcVersion}`);
                                apiRes = await http.fetchJSON(`${ctx.urls.MODRINTH_API}/project/${projectId}/version?game_versions=${JSON.stringify([mcVersion])}`);
                            }
                        }
                        if (!apiRes || apiRes.length === 0) {
                            console.log(`[mrpack] 仍无结果，查询所有版本`);
                            apiRes = await http.fetchJSON(`${ctx.urls.MODRINTH_API}/project/${projectId}/version`);
                        }
                        if (apiRes && Array.isArray(apiRes) && apiRes.length > 0) {
                            for (const ver of apiRes) {
                                if (downloaded) break;
                                for (const f of (ver.files || [])) {
                                    if (downloaded) break;
                                    if (f.filename && f.filename === fileName && f.url) {
                                        try {
                                            await http._dlSingle(f.url, destPath, {
                                                onProgress: (p) => {
                                                    if (p && modFiles[index]) {
                                                        modFiles[index].progress = Math.round(p.progress || 0);
                                                    }
                                                    updateOverall();
                                                },
                                                retries: 2,
                                                abortSignal,
                                                timeout: 300000,
                                                agent: _modAgent
                                            });
                                            if (utils.isJarIntact(destPath)) {
                                                downloaded = true;
                                                console.log(`[mrpack] 通过API重试成功: ${fileName}`);
                                            } else {
                                                try { fs.unlinkSync(destPath); } catch (_) {}
                                            }
                                        } catch (_) {
                                            try { fs.unlinkSync(destPath); } catch (_) {}
                                        }
                                    }
                                }
                            }
                        }
                    } catch (apiErr) {
                        console.warn(`[mrpack] Modrinth API查询失败: ${apiErr.message}`);
                    }
                }
            }

            if (!downloaded && !(abortSignal && abortSignal.aborted)) {
                console.log(`[mrpack] Mod ${fileName} 所有方法失败，尝试通过文件名在Modrinth搜索...`);
                const searchName = fileName.replace(/[-_]\d+[\d._-]*\.jar$/, '').replace(/[-_]/g, ' ').trim();
                if (searchName.length > 2) {
                    try {
                        const loaderList = [...targetLoaders];
                        const facets = [['project_type:mod']];
                        if (loaderList.length > 0) facets.push([`categories:${loaderList[0]}`]);
                        const searchRes = await http.fetchJSON(`${ctx.urls.MODRINTH_API}/search?query=${encodeURIComponent(searchName)}&facets=${JSON.stringify(facets)}`);
                        if (searchRes && searchRes.hits && searchRes.hits.length > 0) {
                            console.log(`[mrpack] 搜索到 ${searchRes.hits.length} 个候选项目: ${searchRes.hits.map(h => h.slug).join(', ')}`);
                            for (const hit of searchRes.hits.slice(0, 3)) {
                                if (downloaded) break;
                                try {
                                    const loaderList2 = [...targetLoaders];
                                    let verRes = [];
                                    if (loaderList2.length > 0 && mcVersion) {
                                        verRes = await http.fetchJSON(`${ctx.urls.MODRINTH_API}/project/${hit.project_id}/version?loaders=${JSON.stringify(loaderList2)}&game_versions=${JSON.stringify([mcVersion])}`);
                                    }
                                    if (!verRes || verRes.length === 0) {
                                        verRes = await http.fetchJSON(`${ctx.urls.MODRINTH_API}/project/${hit.project_id}/version?game_versions=${JSON.stringify([mcVersion])}`);
                                    }
                                    if (!verRes || verRes.length === 0) {
                                        verRes = await http.fetchJSON(`${ctx.urls.MODRINTH_API}/project/${hit.project_id}/version`);
                                    }
                                    if (verRes && Array.isArray(verRes) && verRes.length > 0) {
                                        for (const ver of verRes) {
                                            if (downloaded) break;
                                            for (const f of (ver.files || [])) {
                                                if (downloaded) break;
                                                if (f.primary && f.url) {
                                                    try {
                                                        await http._dlSingle(f.url, destPath, {
                                                            onProgress: (p) => {
                                                                if (p && modFiles[index]) modFiles[index].progress = Math.round(p.progress || 0);
                                                                updateOverall();
                                                            },
                                                            retries: 2,
                                                            abortSignal,
                                                            timeout: 300000,
                                                            agent: _modAgent
                                                        });
                                                        if (utils.isJarIntact(destPath)) {
                                                            downloaded = true;
                                                            console.log(`[mrpack] 通过搜索重试成功: ${fileName} -> ${f.filename}`);
                                                        } else {
                                                            try { fs.unlinkSync(destPath); } catch (_) {}
                                                        }
                                                    } catch (dlErr) {
                                                        console.warn(`[mrpack] 搜索回退下载失败: ${f.filename} - ${dlErr.message}`);
                                                        try { fs.unlinkSync(destPath); } catch (_) {}
                                                    }
                                                }
                                            }
                                        }
                                    }
                                } catch (verErr) {
                                    console.warn(`[mrpack] 获取 ${hit.slug} 版本失败: ${verErr.message}`);
                                }
                            }
                        }
                    } catch (searchErr) {
                        console.warn(`[mrpack] 文件名搜索失败: ${searchName} - ${searchErr.message}`);
                    }
                }
            }

            if (downloaded) {
                if (modFiles[index]) { modFiles[index].status = 'completed'; modFiles[index].progress = 100; }
                okCount++;
            } else {
                if (abortSignal && abortSignal.aborted) {
                    if (modFiles[index]) { modFiles[index].status = 'failed'; modFiles[index].error = '已取消'; }
                } else {
                    console.error(`[mrpack] Mod ${fileName} 所有重试均失败，无法下载`);
                    if (modFiles[index]) { modFiles[index].status = 'failed'; modFiles[index].error = '下载失败'; }
                }
                failCount++;
                if (failCount > Math.max(5, filesList.length * 0.1) && failCount > okCount) {
                    console.error(`[mrpack] 失败数(${failCount})超过阈值，取消剩余下载`);
                    if (abortSignal) try { abortSignal.abort(); } catch (_) {}
                }
            }
        } else {
            if (modFiles[index]) { modFiles[index].status = 'completed'; modFiles[index].progress = 100; }
            okCount++;
        }
        inFlight--;
        updateOverall();
    };

    let taskIdx = 0;
    const runNextMod = async () => {
        while (taskIdx < filesList.length) {
            if (abortSignal && abortSignal.aborted) break;
            const idx = taskIdx++;
            await dlMod(filesList[idx], idx);
        }
    };
    const pool = [];
    for (let p = 0; p < Math.min(PARALLEL_MODS, filesList.length); p++) {
        pool.push(runNextMod());
    }
    await Promise.all(pool);
    try { _modAgent.destroy(); } catch (_) {}
    ctx.DownloadManager.connectionLimit = _prevConnLimit;
    if (abortSignal && abortSignal.aborted) throw new Error('下载已取消');
    console.log(`[mrpack] <<< [步骤5/5] 模组下载完成: ${okCount}成功 ${failCount}失败 (共${filesList.length}个, 并行=${Math.min(PARALLEL_MODS, filesList.length)}, 耗时=${Math.round((Date.now() - _modsStartTime) / 1000)}s)`);
    utils._writeImportLog(`<<< [步骤5/5] 模组下载完成: ${okCount}成功 ${failCount}失败, 耗时=${Math.round((Date.now() - _modsStartTime) / 1000)}s`);
    if (failCount > 0) {
        const failedNames = modFiles.filter(m => m.status === 'failed').map(m => m.name).join(', ');
        console.warn(`[mrpack] 失败的模组: ${failedNames}`);
    }

    progress('repair', '正在修复损坏的模组文件...', 88);
    const repairResult = await _repairCorruptedModJars(versionDir);
    if (repairResult.failed > 0) {
        console.warn(`[mrpack] ${repairResult.failed} 个模组文件损坏且无法修复，游戏启动时可能报错`);
    }

    if (loaderVersionId && mcVersion) {
        const lt = fabricVer ? 'fabric' : (forgeVer || neoforgeVer ? 'forge' : null);
        const cv = fabricVer || forgeVer || neoforgeVer;
        if (lt && cv) {
            await modloaders.ensureLoaderCompat(versionId, versionDir, mcVersion, cv, lt, progress, abortSignal);
        }
    }

    progress('verify', '正在验证整合包完整性...', 90, [...overrideFiles, ...modFiles], '');
    const verifyResult = await modloaders.verifyImportLibs(versionId, progress, abortSignal);
    if (!verifyResult.ok) {
        console.error(`[mrpack] 库文件补全失败: ${verifyResult.missing} 个文件缺失`);
        versions.cleanupVersionChain(versionId);
        return { success: false, versionId, error: `整合包库文件补全失败: ${verifyResult.missing} 个文件缺失，请检查网络后重试` };
    }

    const mergedJson = versions.resolveVersionJson(versionId);

    if (mergedJson && mergedJson.assetIndex) {
        progress('assets', '正在下载游戏资源...', 93, [], '');
        try {
            const assetIndexInfo = mergedJson.assetIndex;
            const assetIndexPath = path.join(ctx.dirs.ASSETS_DIR, 'indexes', `${assetIndexInfo.id}.json`);
            if (!fs.existsSync(assetIndexPath) || (assetIndexInfo.sha1 && !(await utils.verifyFileSha1(assetIndexPath, assetIndexInfo.sha1)))) {
                const idxDir = path.dirname(assetIndexPath);
                if (!fs.existsSync(idxDir)) fs.mkdirSync(idxDir, { recursive: true });
                if (fs.existsSync(assetIndexPath)) fs.unlinkSync(assetIndexPath);
                await http.downloadFileWithMirror(assetIndexInfo.url, assetIndexPath);
            }
            if (fs.existsSync(assetIndexPath)) {
                const assetIndexData = JSON.parse(fs.readFileSync(assetIndexPath, 'utf-8'));
                const assetObjects = assetIndexData.objects || {};
                const assetEntries = Object.entries(assetObjects);
                let missingAssets = [];
                for (const [name, info] of assetEntries) {
                    const hash = info.hash;
                    const subDir = hash.substring(0, 2);
                    const assetPath = path.join(ctx.dirs.ASSETS_DIR, 'objects', subDir, hash);
                    if (!fs.existsSync(assetPath)) {
                        missingAssets.push({ name, hash, subDir, size: info.size });
                    }
                }
                if (missingAssets.length > 0) {
                    console.log(`[mrpack] 资源文件缺失 ${missingAssets.length}/${assetEntries.length} 个，开始下载...`);
                    const ASSET_PARALLEL = Math.min(parseInt(settings.maxThreads, 10) || 64, 64);
                    let assetDone = 0;
                    const assetTotal = missingAssets.length;
                    const runAssetBatch = async () => {
                        while (missingAssets.length > 0) {
                            if (abortSignal && abortSignal.aborted) break;
                            const asset = missingAssets.pop();
                            const targetDir = path.join(ctx.dirs.ASSETS_DIR, 'objects', asset.subDir);
                            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
                            const targetPath = path.join(targetDir, asset.hash);
                            try {
                                await http.downloadFileWithMirror(`https://resources.download.minecraft.net/${asset.subDir}/${asset.hash}`, targetPath);
                            } catch (e) {
                                console.warn(`[mrpack] 资源 ${asset.name} 下载失败: ${e.message}`);
                            }
                            assetDone++;
                            if (assetDone % 20 === 0) {
                                const pct = 93 + Math.round((assetDone / assetTotal) * 4);
                                progress('assets', `下载资源 (${assetDone}/${assetTotal})`, Math.min(pct, 97), [], '');
                            }
                        }
                    };
                    const assetPool = [];
                    for (let i = 0; i < Math.min(ASSET_PARALLEL, assetTotal); i++) assetPool.push(runAssetBatch());
                    await Promise.all(assetPool);
                    console.log(`[mrpack] 资源下载完成: ${assetDone}/${assetTotal}`);
                } else {
                    console.log(`[mrpack] 所有 ${assetEntries.length} 个资源文件已就绪`);
                }
            }
        } catch (e) {
            console.warn(`[mrpack] 资源下载异常(非致命): ${e.message}`);
        }
    }

    if (mergedJson && mergedJson.inheritsFrom) {
        const mainJarId = mergedJson.jar || mergedJson.inheritsFrom;
        const mainJarPath = path.join(ctx.dirs.VERSIONS_DIR, mainJarId, `${mainJarId}.jar`);
        if (!fs.existsSync(mainJarPath)) {
            let jarUrl = mergedJson.downloads?.client?.url;
            if (!jarUrl) {
                try {
                    const baseJsonPath = path.join(ctx.dirs.VERSIONS_DIR, mainJarId, `${mainJarId}.json`);
                    if (fs.existsSync(baseJsonPath)) {
                        const baseJson = JSON.parse(fs.readFileSync(baseJsonPath, 'utf8'));
                        jarUrl = baseJson?.downloads?.client?.url;
                    }
                } catch (_) {}
            }
            if (jarUrl) {
                progress('assets', '正在下载客户端JAR...', 97, [], '');
                let jarOk = false;
                for (let jarAttempt = 0; jarAttempt < 3 && !jarOk; jarAttempt++) {
                    try {
                        const jarDir = path.dirname(mainJarPath);
                        if (!fs.existsSync(jarDir)) fs.mkdirSync(jarDir, { recursive: true });
                        await http.downloadFileWithMirror(jarUrl, mainJarPath);
                        jarOk = true;
                    } catch (e) {
                        console.warn(`[mrpack] 客户端JAR下载失败(${jarAttempt + 1}/3): ${e.message}`);
                        try { if (fs.existsSync(mainJarPath)) fs.unlinkSync(mainJarPath); } catch (_) {}
                        if (jarAttempt < 2) await new Promise(r => setTimeout(r, 2000));
                    }
                }
                if (!jarOk) console.warn(`[mrpack] 客户端JAR下载最终失败(非致命)，启动时会自动补全`);
            }
        }
    }
    if (mergedJson && forgeVer) {
        const forgeCoreCheck = [];
        const mergedLibs = mergedJson.libraries || [];
        const forgeClientLib = mergedLibs.find(l =>
            l.name && /^net\.minecraftforge:forge:\d/.test(l.name) &&
            (l.name.endsWith(':client') || l.name.split(':').length === 3));
        const srgLib = mergedLibs.find(l =>
            l.name && l.name.startsWith('net.minecraft:client:') && l.name.endsWith(':srg'));
        const extraLib = mergedLibs.find(l =>
            l.name && l.name.startsWith('net.minecraft:client:') && l.name.endsWith(':extra'));

        const coreDir = (fp) => path.join(ctx.dirs.LIBRARIES_DIR, fp[0].replace(/\./g, path.sep), fp[1], fp[2]);
        if (forgeClientLib) {
            const fp = forgeClientLib.name.split(':');
            const cl = fp.length >= 4 ? `-${fp[3]}` : '';
            const p = path.join(coreDir(fp), `${fp[1]}-${fp[2]}${cl}.jar`);
            if (!fs.existsSync(p) || !utils.isJarIntact(p)) forgeCoreCheck.push({ name: `forge-client.jar`, path: p });
        }
        if (srgLib) {
            const sp = srgLib.name.split(':');
            const p = path.join(coreDir(sp), `${sp[1]}-${sp[2]}-srg.jar`);
            if (!fs.existsSync(p) || !utils.isJarIntact(p)) forgeCoreCheck.push({ name: `client-srg.jar`, path: p });
        }
        if (extraLib) {
            const ep = extraLib.name.split(':');
            const p = path.join(coreDir(ep), `${ep[1]}-${ep[2]}-extra.jar`);
            if (!fs.existsSync(p) || !utils.isJarIntact(p)) forgeCoreCheck.push({ name: `client-extra.jar`, path: p });
        }

        if (forgeCoreCheck.length > 0) {
            const missingNames = forgeCoreCheck.map(f => f.name).join(', ');
            console.error(`[mrpack] Forge核心文件验证失败: 缺失 ${forgeCoreCheck.length} 个文件: ${missingNames}`);
            for (const f of forgeCoreCheck) {
                console.error(`[mrpack]   缺失: ${f.path}`);
            }
            versions.cleanupVersionChain(versionId);
            return {
                success: false, versionId,
                error: `Forge核心文件生成失败: 缺失 ${missingNames}。\n请检查Java环境是否正常，网络是否畅通，然后重试。\n缺失文件路径:\n${forgeCoreCheck.map(f => f.path).join('\n')}`
            };
        }
        console.log(`[mrpack] Forge核心文件验证通过 (${forgeCoreCheck.length > 0 ? '已检查' : '无需检查'})`);
    }

    const packInfo = {
        name: packName, versionId: versionId, mcVersion, packFormat: 'mrpack',
        fabricVersion: fabricVer, forgeVersion: forgeVer, neoforgeVersion: neoforgeVer,
        importedAt: new Date().toISOString(), sourceFile: filePath,
        targetVersion: targetVersion || ''
    };
    fs.writeFileSync(path.join(versionDir, 'pack-info.json'), JSON.stringify(packInfo, null, 2));

    if (_backupDir && fs.existsSync(_backupDir)) {
        try { fs.rmSync(_backupDir, { recursive: true, force: true }); console.log(`[mrpack] 已清理备份目录: ${_backupDir}`); } catch (e) {}
    }

    progress('done', `整合包 "${packName}" 导入完成！`, 100);
    // [CRITICAL - 2026-06-21] mod下载失败时不能返回success:true！
    // 之前mod下载失败后仍然返回成功，导致用户看到"下载成功"但游戏启动就崩溃。
    // 现在根据失败比例决定：超过10%或超过5个mod失败则返回失败，让用户重试。
    const failThreshold = Math.max(5, Math.floor(filesList.length * 0.1));
    if (failCount > 0 && failCount >= failThreshold) {
        const failedModNames = modFiles.filter(m => m.status === 'failed').map(m => m.name).join(', ');
        const errorMsg = `${failCount}/${filesList.length} 个Mod下载失败（阈值${failThreshold}），整合包不完整无法正常运行。失败的Mod: ${failedModNames}。请检查网络后重试。`;
        console.error(`[mrpack] 导入失败: ${errorMsg}`);
        versions.cleanupVersionChain(versionId);
        return { success: false, versionId, error: errorMsg, failedMods: modFiles.filter(m => m.status === 'failed') };
    }
    if (failCount > 0) {
        const failedModNames = modFiles.filter(m => m.status === 'failed').map(m => m.name).join(', ');
        const warningMsg = `${failCount}/${filesList.length} 个Mod下载失败: ${failedModNames}。请在内部浏览器中手动下载缺失的Mod，或检查网络后重试。`;
        return { success: true, name: packName, versionId, mcVersion, targetVersion: targetVersion || '', warning: warningMsg, failedMods: modFiles.filter(m => m.status === 'failed'), loaderVersionId: loaderVersionId || null };
    }
    return { success: true, name: packName, versionId, mcVersion, targetVersion: targetVersion || '', loaderVersionId: loaderVersionId || null };
    } catch (e) {
        console.error('[mrpack] 导入失败:', e);
        if (_backupDir) {
            try {
                const restoredModsDir = path.join(_backupDir, 'mods');
                if (fs.existsSync(restoredModsDir)) {
                    const currentModsDir = path.join(versionDir, 'mods');
                    if (fs.existsSync(currentModsDir)) fs.rmSync(currentModsDir, { recursive: true, force: true });
                    fs.cpSync(restoredModsDir, currentModsDir, { recursive: true });
                    console.log(`[mrpack] 已从备份恢复 mods 目录`);
                }
                fs.rmSync(_backupDir, { recursive: true, force: true });
            } catch (rbErr) {
                console.error(`[mrpack] 回滚失败: ${rbErr.message}`);
            }
        }
        versions.cleanupVersionChain(versionId);
        return { success: false, versionId, error: e.message || '未知错误' };
    }
    if (_backupDir) {
        try { fs.rmSync(_backupDir, { recursive: true, force: true }); } catch (_) {}
    }
}

async function _importCurseForge(zip, manifestEntry, filePath, progress, targetVersion = '', abortSignal = null) {
    console.log(`[CurseForge] ========== 开始解析 CurseForge 整合包 ==========`);
    const settings = versions.loadSettingsCached();
    let manifest;
    try {
        manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
    } catch (e) {
        console.error(`[CurseForge] 解析 manifest.json 失败:`, e.message);
        return { success: false, error: '解析 manifest.json 失败: ' + e.message };
    }

    const packName  = (manifest.name || path.basename(filePath, path.extname(filePath))).replace(/[<>:"/\\|?*]/g, '_');
    const mcVersion = manifest.minecraft && manifest.minecraft.version ? manifest.minecraft.version : '';
    const loaders   = manifest.minecraft && manifest.minecraft.modLoaders ? manifest.minecraft.modLoaders : [];
    const modLoader = loaders.length > 0 ? loaders[0].id : '';

    let forgeVerCF = '', fabricVerCF = '', neoforgeVerCF = '';
    const mlLower = (modLoader || '').toLowerCase();

    if (/^forge[-]?(\d)/.test(mlLower)) {
        const mlParts = (modLoader || '').split('-');
        forgeVerCF = mlParts[0].toLowerCase() === 'forge' ? mlParts.slice(1).join('-') : mlParts.join('-').replace(/^forge/i, '');
    } else if (/^neoforge[-]?(\d)/.test(mlLower)) {
        const mlParts = (modLoader || '').split('-');
        neoforgeVerCF = mlParts[0].toLowerCase() === 'neoforge' ? mlParts.slice(1).join('-') : mlParts.join('-').replace(/^neoforge/i, '');
    } else if (/^fabric[-]?loader[-]?(\d)/.test(mlLower)) {
        const mlParts = (modLoader || '').split('-');
        if (mlParts[0].toLowerCase() === 'fabric' && mlParts[1] && mlParts[1].toLowerCase() === 'loader') {
            fabricVerCF = mlParts.slice(2).join('-');
        } else if (mlParts[0].toLowerCase() === 'fabric') {
            fabricVerCF = mlParts.slice(1).join('-').replace(/^loader[-]?/i, '');
        } else {
            fabricVerCF = mlParts.join('-').replace(/^fabric[-]?loader[-]?/i, '');
        }
    } else if (/^fabric[-]?(\d)/.test(mlLower)) {
        const mlParts = (modLoader || '').split('-');
        fabricVerCF = mlParts[0].toLowerCase() === 'fabric' ? mlParts.slice(1).join('-') : mlParts.join('-').replace(/^fabric/i, '');
    }

    console.log(`[CurseForge] 解析 modLoader: "${modLoader}" -> forge=${forgeVerCF}, fabric=${fabricVerCF}, neoforge=${neoforgeVerCF}`);

    console.log(`[CurseForge] 整合包: ${packName}`);
    console.log(`[CurseForge] MC版本: ${mcVersion || '(未指定)'}`);
    console.log(`[CurseForge] Mod数量: ${(manifest.files || []).length}`);

    progress('prepare', `整合包: ${packName}  MC: ${mcVersion}`, 8);

    let versionId;
    let versionDir;

    if (targetVersion) {
        const cleanTargetId = targetVersion.replace(/ \[外部\d*\]/, '');
        const existingDir = path.join(ctx.dirs.VERSIONS_DIR, cleanTargetId);
        if (fs.existsSync(existingDir)) {
            versionId = cleanTargetId;
            versionDir = existingDir;
            console.log(`[Modpack] 安装到现有版本: ${versionId}`);
        } else {
            const extFolders = versions.loadExternalFolders();
            for (const folder of extFolders) {
                if (!fs.existsSync(folder.path)) continue;
                const extVers = versions.scanExternalFolder(folder.path);
                const extV = extVers.find(v => v.id === cleanTargetId);
                if (extV) {
                    versionId = cleanTargetId;
                    versionDir = extV.externalVersionDir;
                    console.log(`[Modpack] 安装到外部版本: ${versionId}`);
                    break;
                }
            }
        }
        if (!versionDir) {
            versionId = _dedupeVersionId(packName);
            versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
            console.log(`[Modpack] 目标版本不存在，创建新版本: ${versionId}`);
        }
    } else {
        versionId = _dedupeVersionId(packName);
        versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
        console.log(`[Modpack] 未指定目标版本，创建新版本: ${versionId}`);
    }

    const isNewVersionDirCF = !fs.existsSync(path.join(versionDir, `${versionId}.json`));

    if (!fs.existsSync(versionDir)) {
        fs.mkdirSync(versionDir, { recursive: true });
    }

    const cfApiKey = settings.curseforgeApiKey || '$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEJQnPnm';

    let loaderVersionId = null;

    if (isNewVersionDirCF) {
        console.log(`[CurseForge] 确保基础版本存在: ${mcVersion}`);
        progress('base', '正在准备基础版本...', 5);
        const baseResult = await modloaders.ensureBaseVersionInstalled(mcVersion, (msg, pct) => {
            progress('base', msg || '正在准备基础版本...', 5 + Math.min(pct, 100) * 0.15);
        });
        if (baseResult.error) {
            try { if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true }); } catch (e) {}
            return { success: false, versionId, error: baseResult.error };
        }

        if (forgeVerCF || neoforgeVerCF || fabricVerCF) {
            progress('loader-install', '正在安装模组加载器...', 20);
            try {
                if (forgeVerCF) {
                    loaderVersionId = `${mcVersion}-forge-${forgeVerCF}`;
                    const lvJson = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                    if (!fs.existsSync(lvJson) || !modloaders.verifyLoaderLibs(loaderVersionId)) {
                        if (fs.existsSync(lvJson) && !modloaders.verifyLoaderLibs(loaderVersionId)) {
                            console.log(`[CurseForge] Forge ${loaderVersionId} 库文件缺失，重新安装`);
                            try { fs.rmSync(path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId), { recursive: true, force: true }); } catch (e) {}
                        }
                        console.log(`[CurseForge] 安装模组加载器: Forge ${forgeVerCF} (MC ${mcVersion})`);
                        const ir = await modloaders.installForge(mcVersion, forgeVerCF, (p, msg) => {
                            progress('loader-install', msg || '正在安装Forge...', 20 + p * 15);
                        });
                        if (!ir.success) throw new Error(ir.error);
                    } else {
                        console.log(`[CurseForge] Forge ${loaderVersionId} 已安装，跳过`);
                    }
                } else if (neoforgeVerCF) {
                    loaderVersionId = `${mcVersion}-neoforge-${neoforgeVerCF}`;
                    const lvJson = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                    if (!fs.existsSync(lvJson) || !modloaders.verifyLoaderLibs(loaderVersionId)) {
                        if (fs.existsSync(lvJson) && !modloaders.verifyLoaderLibs(loaderVersionId)) {
                            console.log(`[CurseForge] NeoForge ${loaderVersionId} 库文件缺失，重新安装`);
                            try { fs.rmSync(path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId), { recursive: true, force: true }); } catch (e) {}
                        }
                        console.log(`[CurseForge] 安装模组加载器: NeoForge ${neoforgeVerCF} (MC ${mcVersion})`);
                        const ir = await modloaders.installNeoForge(mcVersion, neoforgeVerCF, (p, msg) => {
                            progress('loader-install', msg || '正在安装NeoForge...', 20 + p * 15);
                        });
                        if (!ir.success) throw new Error(ir.error);
                    } else {
                        console.log(`[CurseForge] NeoForge ${loaderVersionId} 已安装，跳过`);
                    }
                } else if (fabricVerCF) {
                    loaderVersionId = `fabric-loader-${fabricVerCF}-${mcVersion}`;
                    const lvJson = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                    let fabricNeedInstall = !fs.existsSync(lvJson);
                    if (!fabricNeedInstall) {
                        if (!modloaders.verifyLoaderLibs(loaderVersionId)) {
                            fabricNeedInstall = true;
                        } else {
                            try {
                                const existingJson = JSON.parse(fs.readFileSync(lvJson, 'utf-8'));
                                const hasFabricLoader = (existingJson.libraries || []).some(l => l.name && l.name.startsWith('net.fabricmc:fabric-loader'));
                                if (!hasFabricLoader) {
                                    console.log(`[CurseForge] Fabric ${loaderVersionId} 缺少 fabric-loader 库，重新安装`);
                                    fabricNeedInstall = true;
                                }
                            } catch (_) { fabricNeedInstall = true; }
                        }
                    }
                    if (fabricNeedInstall) {
                        if (fs.existsSync(lvJson)) {
                            console.log(`[CurseForge] Fabric ${loaderVersionId} 需要重新安装`);
                            try { fs.rmSync(path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId), { recursive: true, force: true }); } catch (e) {}
                        }
                        console.log(`[CurseForge] 安装模组加载器: Fabric ${fabricVerCF} (MC ${mcVersion})`);
                        const ir = await modloaders.installFabric(mcVersion, fabricVerCF, (p, msg) => {
                            progress('loader-install', msg || '正在安装Fabric...', 20 + p * 15);
                        });
                        if (!ir.success) throw new Error(ir.error);
                    } else {
                        console.log(`[CurseForge] Fabric ${loaderVersionId} 已安装，跳过`);
                    }
                }
            } catch (e) {
                console.error(`[CurseForge] 模组加载器安装失败:`, e.message);
                try { if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true }); } catch (ce) {}
                return { success: false, versionId, error: e.message };
            }
        }

        progress('version-config', '正在创建版本配置...', 35);

        if (loaderVersionId) {
            let cfLoaderMainClass = '';
            try {
                const cfLvJsonPath = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                if (fs.existsSync(cfLvJsonPath)) {
                    const cfLvJson = JSON.parse(fs.readFileSync(cfLvJsonPath, 'utf-8'));
                    cfLoaderMainClass = cfLvJson.mainClass || '';
                }
            } catch (_cfLvErr) {}
            const versionJson = {
                id: versionId,
                inheritsFrom: loaderVersionId,
                type: 'release',
                time: new Date().toISOString(),
                releaseTime: new Date().toISOString()
            };
            if (cfLoaderMainClass) versionJson.mainClass = cfLoaderMainClass;
            fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(versionJson, null, 2));
            versions._invalidateResolvedJsonCache(versionId);
            console.log(`[CurseForge] 创建版本JSON: ${versionId}.json (继承 ${loaderVersionId}, mainClass: ${cfLoaderMainClass || '未设置'})`);
        } else {
            const versionJson = {
                id: versionId,
                inheritsFrom: mcVersion || undefined,
                type: 'release',
                mainClass: 'net.minecraft.client.main.Main',
                time: new Date().toISOString(),
                releaseTime: new Date().toISOString()
            };
            fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(versionJson, null, 2));
            versions._invalidateResolvedJsonCache(versionId);
            console.log(`[CurseForge] 创建版本JSON: ${versionId}.json (无加载器)`);
        }

        progress('loader', '模组加载器就绪', 40);
    }

    let _cfBackupDir = null;
    if (!isNewVersionDirCF) {
        try {
            const existingModsDir = path.join(versionDir, 'mods');
            if (fs.existsSync(existingModsDir)) {
                _cfBackupDir = versionDir + '.backup_' + Date.now();
                fs.cpSync(existingModsDir, path.join(_cfBackupDir, 'mods'), { recursive: true });
                console.log(`[CurseForge] 已备份 mods 目录到 ${_cfBackupDir}`);
            }
        } catch (bkErr) {
            console.warn(`[CurseForge] 备份 mods 目录失败 (非致命): ${bkErr.message}`);
            _cfBackupDir = null;
        }
    }

    try {
    progress('extract', '解压覆盖文件...', 40, [], '');
    const entries = zip.getEntries();
    const overrideFiles = [];
    let cfExtractYieldCounter = 0;
    for (const entry of entries) {
        if (entry.isDirectory) continue;
        if (!isModpackPathSafe(entry.entryName)) continue;
        if (entry.entryName.startsWith('overrides/')) {
            const relPath = entry.entryName.slice('overrides/'.length);
            const destPath = path.join(versionDir, relPath);
            const resolvedDest = path.resolve(destPath);
            const resolvedBase = path.resolve(versionDir);
            if (!resolvedDest.startsWith(resolvedBase + path.sep) && resolvedDest !== resolvedBase) {
                console.warn(`[Modpack] CurseForge路径遍历已拦截: ${relPath}`);
                continue;
            }
            await utils.asyncEnsureDir(destPath);
            let cfExtractOk = false;
            for (let attempt = 1; attempt <= 5; attempt++) {
                try {
                    await fs.promises.writeFile(destPath, entry.getData());
                    cfExtractOk = true;
                    break;
                } catch (e) {
                    console.warn(`[Modpack] CF解压 ${relPath} 第 ${attempt} 次失败: ${e.message}`);
                    if (attempt < 5) await new Promise(r => setTimeout(r, (attempt - 1) * 2000));
                }
            }
            if (cfExtractOk) overrideFiles.push({ name: relPath, status: 'completed', progress: 100 });
            if (++cfExtractYieldCounter % 50 === 0) await utils.yieldToEventLoop();
        }
    }

    try {
        const vsPath = path.join(versionDir, 'version-settings.json');
        let vs = {};
        if (fs.existsSync(vsPath)) vs = JSON.parse(fs.readFileSync(vsPath, 'utf-8'));
        if (!vs.isolation || vs.isolation === 'global') {
            vs.isolation = 'on';
            fs.writeFileSync(vsPath, JSON.stringify(vs, null, 2));
        }
    } catch (_) {}

    const cfFiles = manifest.files || [];
    const modsDir = path.join(versionDir, 'mods');
    utils.ensureDir(path.join(modsDir, 'dummy.txt'));

    const cfModFiles = cfFiles.map(f => ({ name: `Mod #${f.projectID}`, status: 'pending', progress: 0 }));
    progress('mods', `下载 Mod 文件 (共 ${cfFiles.length} 个)...`, 50, [...overrideFiles, ...cfModFiles], '');

    let cfDownloadedCount = 0;
    let cfFailedCount = 0;
    let cfInFlight = 0;
    const CF_PARALLEL = Math.min(parseInt(settings.maxThreads, 10) || 32, 64);
    const _cfAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: CF_PARALLEL + 8, maxFreeSockets: 16, timeout: 120000 });
    let cfLastProgUpdate = 0;
    let cfLastReportedPct = 0;
    let cfSmoothPct = 0;

    const _cfTotalModSize = cfModFiles.reduce((sum, mf) => sum + Math.max(mf.size || 0, 102400), 0);
    const _cfModWeights = cfModFiles.map(mf => Math.max(mf.size || 0, 102400) / _cfTotalModSize);

    const getCfModTimeout = (sizeBytes) => {
        if (sizeBytes > 50 * 1024 * 1024) return 600000;
        if (sizeBytes > 20 * 1024 * 1024) return 300000;
        if (sizeBytes > 5 * 1024 * 1024) return 180000;
        return 120000;
    };

    const cfUpdateOverall = () => {
        const now = Date.now();
        let weightedPct = 0;
        for (let i = 0; i < cfModFiles.length; i++) {
            const mf = cfModFiles[i];
            const w = _cfModWeights[i] || (1 / cfModFiles.length);
            weightedPct += ((mf.status === 'completed' || mf.status === 'failed') ? 100 : (mf.progress || 0)) * w;
        }
        const pct = 50 + Math.round((weightedPct / 100) * 45);
        const clamped = Math.min(pct, 95);
        if (cfSmoothPct <= 0 || clamped <= cfSmoothPct) {
            cfSmoothPct = clamped;
        } else {
            cfSmoothPct = cfSmoothPct * 0.75 + clamped * 0.25;
        }
        const finalPct = Math.max(cfLastReportedPct, Math.round(cfSmoothPct));
        if (finalPct <= cfLastReportedPct && now - cfLastProgUpdate < 200) return;
        cfLastReportedPct = finalPct;
        cfLastProgUpdate = now;
        progress('mods', `下载 Mod (${cfDownloadedCount}/${cfFiles.length}, ${cfInFlight}个进行中)`, cfLastReportedPct, [...overrideFiles, ...cfModFiles], '');
    };

    const dlCFMod = async (file, index) => {
        cfInFlight++;
        if (abortSignal && abortSignal.aborted) { cfInFlight--; cfUpdateOverall(); return; }
        const projectID = file.projectID;
        const fileID    = file.fileID;
        console.log(`[CurseForge] 下载 [${index + 1}/${cfFiles.length}] project=${projectID} file=${fileID}`);
        const fileSize  = file.fileLength || 0;
        if (cfModFiles[index]) { cfModFiles[index].status = 'downloading'; cfModFiles[index].progress = 0; }
        cfUpdateOverall();

        let cfDownloaded = false;
        const MAX_CF_ROUNDS = 3;

        for (let round = 0; round < MAX_CF_ROUNDS && !cfDownloaded; round++) {
            if (abortSignal && abortSignal.aborted) break;
            if (round > 0) {
                console.log(`[CurseForge] Mod ${projectID}:${fileID} 第${round + 1}轮重试...`);
                if (cfModFiles[index]) { cfModFiles[index].status = 'downloading'; cfModFiles[index].progress = 0; }
                await new Promise(r => setTimeout(r, 3000 + round * 2000 + Math.random() * 2000));
            }

            if (!cfApiKey) {
                if (cfModFiles[index]) { cfModFiles[index].status = 'failed'; cfModFiles[index].error = 'API Key 未设置'; }
                break;
            }

            try {
                if (abortSignal && abortSignal.aborted) throw new Error('下载已取消');
                let fileInfo = _cfFileInfoMap[fileID] ? { data: _cfFileInfoMap[fileID] } : null;
                if (!fileInfo && round === 0) {
                    fileInfo = await http.fetchJSON(`${ctx.urls.CURSEFORGE_API}/mods/${projectID}/files/${fileID}`, { 'x-api-key': cfApiKey });
                }
                const downloadUrl = fileInfo && fileInfo.data ? fileInfo.data.downloadUrl : null;
                if (downloadUrl) {
                    const fileName = path.basename(downloadUrl);
                    const destPath = path.join(modsDir, fileName);
                    if (cfModFiles[index]) { cfModFiles[index].name = fileName; cfModFiles[index]._destPath = destPath; }

                    if (utils.isJarIntact(destPath)) {
                        cfDownloaded = true;
                    } else {
                        const perTryAbort = new AbortController();
                        const cfTimeout = getCfModTimeout(fileInfo?.data?.fileLength || fileSize || 0);
                        const perTryTimeout = setTimeout(() => { try { perTryAbort.abort(); } catch (_) {} },
                            Math.max(120000, cfTimeout + 30000));
                        if (abortSignal) {
                            abortSignal.addEventListener('abort', () => { try { perTryAbort.abort(); } catch (_) {} }, { once: true });
                        }
                        try {
                            const allUrls = http.getMirrorUrls(downloadUrl);
                            for (const mirrorUrl of allUrls) {
                                if (cfDownloaded || perTryAbort.signal.aborted) break;
                                try {
                                    await http._dlSingle(mirrorUrl, destPath, {
                                        onProgress: (p) => {
                                            if (p && cfModFiles[index]) {
                                                cfModFiles[index].progress = Math.round(p.progress || 0);
                                                cfModFiles[index].downloaded = p.downloaded || 0;
                                                cfModFiles[index].speed = p.speed || '';
                                            }
                                            cfUpdateOverall();
                                        },
                                        retries: 3,
                                        stallTimeout: 45000,
                                        abortSignal: perTryAbort.signal,
                                        timeout: getCfModTimeout(fileInfo?.data?.fileLength || 0),
                                        agent: _cfAgent
                                    });
                                    if (utils.isJarIntact(destPath)) {
                                        cfDownloaded = true;
                                        break;
                                    } else {
                                        try { fs.unlinkSync(destPath); } catch (_) {}
                                    }
                                } catch (e) {
                                    if (abortSignal && abortSignal.aborted) break;
                                    try { fs.unlinkSync(destPath); } catch (_) {}
                                }
                            }
                        } finally {
                            clearTimeout(perTryTimeout);
                        }
                    }
                } else {
                    console.warn(`[CurseForge] 无法获取下载URL: ${projectID}:${fileID}`);
                    if (cfModFiles[index]) { cfModFiles[index].status = 'failed'; cfModFiles[index].error = 'CurseForge 未提供下载链接'; }
                    break;
                }
            } catch (e) {
                if (abortSignal && abortSignal.aborted) break;
                console.warn(`[CurseForge] 下载失败(round ${round + 1}):`, projectID, fileID, e.message);
            }
        }

        if (!cfDownloaded && !(abortSignal && abortSignal.aborted) && cfApiKey) {
            console.log(`[CurseForge] Mod ${projectID}:${fileID} 常规下载失败，尝试通过API获取其他版本...`);
            try {
                let cfLoaderTypeFilter = '';
                if (forgeVerCF) cfLoaderTypeFilter = '&modLoaderType=1';
                else if (fabricVerCF) cfLoaderTypeFilter = '&modLoaderType=4';
                else if (neoforgeVerCF) cfLoaderTypeFilter = '&modLoaderType=5';
                const allFilesRes = await http.fetchJSON(`${ctx.urls.CURSEFORGE_API}/mods/${projectID}/files?gameVersion=${mcVersion}${cfLoaderTypeFilter}`, { 'x-api-key': cfApiKey });
                if (allFilesRes && allFilesRes.data && Array.isArray(allFilesRes.data)) {
                    console.log(`[CurseForge] 查询到 ${allFilesRes.data.length} 个备用版本 (mc=${mcVersion}, loader=${cfLoaderTypeFilter || 'any'})`);
                    const mcVer = mcVersion;
                    const matchingFiles = allFilesRes.data.filter(f =>
                        f.gameVersions && f.gameVersions.includes(mcVer) &&
                        f.downloadUrl && f.fileName && f.fileName.endsWith('.jar')
                    );
                    for (const altFile of matchingFiles.slice(0, 3)) {
                        if (cfDownloaded) break;
                        const destPath = path.join(modsDir, altFile.fileName);
                        if (cfModFiles[index]) { cfModFiles[index].name = altFile.fileName; cfModFiles[index]._destPath = destPath; }
                        if (utils.isJarIntact(destPath)) { cfDownloaded = true; break; }
                        try {
                            await http._dlSingle(altFile.downloadUrl, destPath, {
                                onProgress: (p) => {
                                    if (p && cfModFiles[index]) cfModFiles[index].progress = Math.round(p.progress || 0);
                                    cfUpdateOverall();
                                },
                                retries: 2,
                                abortSignal,
                                timeout: 300000,
                                agent: _cfAgent
                            });
                            if (utils.isJarIntact(destPath)) {
                                cfDownloaded = true;
                                console.log(`[CurseForge] 通过备用版本下载成功: ${altFile.fileName}`);
                            } else {
                                try { fs.unlinkSync(destPath); } catch (_) {}
                            }
                        } catch (_) {
                            try { fs.unlinkSync(destPath); } catch (_) {}
                        }
                    }
                }
            } catch (_) {}
        }

        if (cfDownloaded) {
            if (cfModFiles[index]) { cfModFiles[index].status = 'completed'; cfModFiles[index].progress = 100; }
        } else if (cfModFiles[index]) {
            if (abortSignal && abortSignal.aborted) {
                cfModFiles[index].status = 'failed'; cfModFiles[index].error = '已取消';
            } else {
                cfModFiles[index].status = 'failed'; cfModFiles[index].error = '下载失败';
                cfFailedCount++;
                console.error(`[CurseForge] Mod ${projectID}:${fileID} 最终下载失败`);
                if (cfFailedCount > Math.max(5, cfFiles.length * 0.1) && cfFailedCount > cfDownloadedCount) {
                    console.error(`[CurseForge] 失败数(${cfFailedCount})超过阈值，取消剩余下载`);
                    if (abortSignal) try { abortSignal.abort(); } catch (_) {}
                }
            }
        }
        cfDownloadedCount++;
        cfInFlight--;
        cfUpdateOverall();
    };

    const _cfFileInfoMap = {};
    if (cfApiKey && cfFiles.length > 0) {
        progress('mods', `正在获取 ${cfFiles.length} 个 Mod 的下载信息...`, 50, [...overrideFiles, ...cfModFiles], '');
        const _cfBatchSize = 50;
        for (let bi = 0; bi < cfFiles.length; bi += _cfBatchSize) {
            if (abortSignal && abortSignal.aborted) break;
            const batch = cfFiles.slice(bi, bi + _cfBatchSize);
            try {
                const batchRes = await http.fetchJSONWithMethod(`${ctx.urls.CURSEFORGE_API}/mods/files`, 'POST',
                    JSON.stringify({ fileIds: batch.map(f => f.fileID) }),
                    { 'x-api-key': cfApiKey, 'Content-Type': 'application/json' });
                if (batchRes && batchRes.data) {
                    for (const fi of batchRes.data) _cfFileInfoMap[fi.id] = fi;
                }
            } catch (e) {
                console.warn(`[CurseForge] 批量获取文件信息失败: ${e.message}，将逐个获取`);
            }
        }
        console.log(`[CurseForge] 预获取文件信息: ${Object.keys(_cfFileInfoMap).length}/${cfFiles.length}`);
    }

    let cfTaskIdx = 0;
    const runNextCfMod = async () => {
        while (cfTaskIdx < cfFiles.length) {
            if (abortSignal && abortSignal.aborted) break;
            const idx = cfTaskIdx++;
            await dlCFMod(cfFiles[idx], idx);
        }
    };
    const cfPool = [];
    for (let p = 0; p < Math.min(CF_PARALLEL, cfFiles.length); p++) {
        cfPool.push(runNextCfMod());
    }
    await Promise.all(cfPool);
    try { _cfAgent.destroy(); } catch (_) {}
    if (abortSignal && abortSignal.aborted) throw new Error('下载已取消');

    progress('repair', '正在修复损坏的模组文件...', 88);
    const cfRepairResult = await _repairCorruptedModJars(versionDir);
    if (cfRepairResult.failed > 0) {
        console.warn(`[CurseForge] ${cfRepairResult.failed} 个模组文件损坏且无法修复，游戏启动时可能报错`);
    }

    if (loaderVersionId && mcVersion) {
        const lt = fabricVerCF ? 'fabric' : (forgeVerCF || neoforgeVerCF ? 'forge' : null);
        const cv = fabricVerCF || forgeVerCF || neoforgeVerCF;
        if (lt && cv) {
            await modloaders.ensureLoaderCompat(versionId, versionDir, mcVersion, cv, lt, progress, abortSignal);
        }
    }

    progress('verify', '正在验证整合包完整性...', 90, [...overrideFiles, ...cfModFiles], '');
    const cfVerifyResult = await modloaders.verifyImportLibs(versionId, progress, abortSignal);
    if (!cfVerifyResult.ok) {
        console.error(`[CurseForge] 库文件补全失败: ${cfVerifyResult.missing} 个文件缺失`);
        versions.cleanupVersionChain(versionId);
        return { success: false, versionId, error: `整合包库文件补全失败: ${cfVerifyResult.missing} 个文件缺失，请检查网络后重试` };
    }

    const cfMergedJson = versions.resolveVersionJson(versionId);

    if (cfMergedJson && cfMergedJson.assetIndex) {
        progress('assets', '正在下载游戏资源...', 93, [], '');
        try {
            const cfAssetIndexInfo = cfMergedJson.assetIndex;
            const cfAssetIndexPath = path.join(ctx.dirs.ASSETS_DIR, 'indexes', `${cfAssetIndexInfo.id}.json`);
            if (!fs.existsSync(cfAssetIndexPath) || (cfAssetIndexInfo.sha1 && !(await utils.verifyFileSha1(cfAssetIndexPath, cfAssetIndexInfo.sha1)))) {
                const cfIdxDir = path.dirname(cfAssetIndexPath);
                if (!fs.existsSync(cfIdxDir)) fs.mkdirSync(cfIdxDir, { recursive: true });
                if (fs.existsSync(cfAssetIndexPath)) fs.unlinkSync(cfAssetIndexPath);
                await http.downloadFileWithMirror(cfAssetIndexInfo.url, cfAssetIndexPath);
            }
            if (fs.existsSync(cfAssetIndexPath)) {
                const cfAssetIndexData = JSON.parse(fs.readFileSync(cfAssetIndexPath, 'utf-8'));
                const cfAssetObjects = cfAssetIndexData.objects || {};
                const cfAssetEntries = Object.entries(cfAssetObjects);
                let cfMissingAssets = [];
                for (const [name, info] of cfAssetEntries) {
                    const hash = info.hash;
                    const subDir = hash.substring(0, 2);
                    const aPath = path.join(ctx.dirs.ASSETS_DIR, 'objects', subDir, hash);
                    if (!fs.existsSync(aPath)) {
                        cfMissingAssets.push({ name, hash, subDir, size: info.size });
                    }
                }
                if (cfMissingAssets.length > 0) {
                    console.log(`[CurseForge] 资源文件缺失 ${cfMissingAssets.length}/${cfAssetEntries.length} 个，开始下载...`);
                    const CF_ASSET_PARALLEL = Math.min(parseInt(settings.maxThreads, 10) || 64, 64);
                    let cfAssetDone = 0;
                    const cfAssetTotal = cfMissingAssets.length;
                    const runCfAssetBatch = async () => {
                        while (cfMissingAssets.length > 0) {
                            if (abortSignal && abortSignal.aborted) break;
                            const asset = cfMissingAssets.pop();
                            const targetDir = path.join(ctx.dirs.ASSETS_DIR, 'objects', asset.subDir);
                            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
                            const targetPath = path.join(targetDir, asset.hash);
                            try {
                                await http.downloadFileWithMirror(`https://resources.download.minecraft.net/${asset.subDir}/${asset.hash}`, targetPath);
                            } catch (e) {
                                console.warn(`[CurseForge] 资源 ${asset.name} 下载失败: ${e.message}`);
                            }
                            cfAssetDone++;
                            if (cfAssetDone % 20 === 0) {
                                const pct = 93 + Math.round((cfAssetDone / cfAssetTotal) * 4);
                                progress('assets', `下载资源 (${cfAssetDone}/${cfAssetTotal})`, Math.min(pct, 97), [], '');
                            }
                        }
                    };
                    const cfAssetPool = [];
                    for (let i = 0; i < Math.min(CF_ASSET_PARALLEL, cfAssetTotal); i++) cfAssetPool.push(runCfAssetBatch());
                    await Promise.all(cfAssetPool);
                    console.log(`[CurseForge] 资源下载完成: ${cfAssetDone}/${cfAssetTotal}`);
                } else {
                    console.log(`[CurseForge] 所有 ${cfAssetEntries.length} 个资源文件已就绪`);
                }
            }
        } catch (e) {
            console.warn(`[CurseForge] 资源下载异常(非致命): ${e.message}`);
        }
    }

    if (cfMergedJson && cfMergedJson.inheritsFrom) {
        const cfMainJarId = cfMergedJson.jar || cfMergedJson.inheritsFrom;
        const cfMainJarPath = path.join(ctx.dirs.VERSIONS_DIR, cfMainJarId, `${cfMainJarId}.jar`);
        if (!fs.existsSync(cfMainJarPath)) {
            let cfJarUrl = cfMergedJson.downloads?.client?.url;
            if (!cfJarUrl) {
                try {
                    const cfBaseJsonPath = path.join(ctx.dirs.VERSIONS_DIR, cfMainJarId, `${cfMainJarId}.json`);
                    if (fs.existsSync(cfBaseJsonPath)) {
                        const cfBaseJson = JSON.parse(fs.readFileSync(cfBaseJsonPath, 'utf8'));
                        cfJarUrl = cfBaseJson?.downloads?.client?.url;
                    }
                } catch (_) {}
            }
            if (cfJarUrl) {
                progress('assets', '正在下载客户端JAR...', 97, [], '');
                let cfJarOk = false;
                for (let jarAttempt = 0; jarAttempt < 3 && !cfJarOk; jarAttempt++) {
                    try {
                        const cfJarDir = path.dirname(cfMainJarPath);
                        if (!fs.existsSync(cfJarDir)) fs.mkdirSync(cfJarDir, { recursive: true });
                        await http.downloadFileWithMirror(cfJarUrl, cfMainJarPath);
                        cfJarOk = true;
                    } catch (e) {
                        console.warn(`[CurseForge] 客户端JAR下载失败(${jarAttempt + 1}/3): ${e.message}`);
                        try { if (fs.existsSync(cfMainJarPath)) fs.unlinkSync(cfMainJarPath); } catch (_) {}
                        if (jarAttempt < 2) await new Promise(r => setTimeout(r, 2000));
                    }
                }
                if (!cfJarOk) console.warn(`[CurseForge] 客户端JAR下载最终失败(非致命)，启动时会自动补全`);
            }
        }
    }
    if (cfMergedJson && (forgeVerCF || neoforgeVerCF)) {
        const cfForgeCoreCheck = [];
        const cfMergedLibs = cfMergedJson.libraries || [];
        const forgeClientLib = cfMergedLibs.find(l =>
            l.name && /^net\.minecraftforge:forge:\d/.test(l.name) &&
            (l.name.endsWith(':client') || l.name.split(':').length === 3));
        const srgLib = cfMergedLibs.find(l =>
            l.name && l.name.startsWith('net.minecraft:client:') && l.name.endsWith(':srg'));
        const extraLib = cfMergedLibs.find(l =>
            l.name && l.name.startsWith('net.minecraft:client:') && l.name.endsWith(':extra'));
        const coreDir = (fp) => path.join(ctx.dirs.LIBRARIES_DIR, fp[0].replace(/\./g, path.sep), fp[1], fp[2]);
        if (forgeClientLib) {
            const fp = forgeClientLib.name.split(':');
            const cl = fp.length >= 4 ? `-${fp[3]}` : '';
            const p = path.join(coreDir(fp), `${fp[1]}-${fp[2]}${cl}.jar`);
            if (!fs.existsSync(p) || !utils.isJarIntact(p)) cfForgeCoreCheck.push({ name: 'forge-client.jar', path: p });
        }
        if (srgLib) {
            const sp = srgLib.name.split(':');
            const p = path.join(coreDir(sp), `${sp[1]}-${sp[2]}-srg.jar`);
            if (!fs.existsSync(p) || !utils.isJarIntact(p)) cfForgeCoreCheck.push({ name: 'client-srg.jar', path: p });
        }
        if (extraLib) {
            const ep = extraLib.name.split(':');
            const p = path.join(coreDir(ep), `${ep[1]}-${ep[2]}-extra.jar`);
            if (!fs.existsSync(p) || !utils.isJarIntact(p)) cfForgeCoreCheck.push({ name: 'client-extra.jar', path: p });
        }
        if (cfForgeCoreCheck.length > 0) {
            const missingNames = cfForgeCoreCheck.map(f => f.name).join(', ');
            console.error(`[CurseForge] Forge核心文件验证失败: ${cfForgeCoreCheck.length}个缺失: ${missingNames}`);
            versions.cleanupVersionChain(versionId);
            return { success: false, versionId, error: `Forge核心文件生成失败: 缺失 ${missingNames}。请检查Java环境和网络后重试。` };
        }
    }

    const cfFailedMods = cfModFiles.filter(m => m.status === 'failed');
    cfFailedCount = cfFailedMods.length;

    const packInfo = {
        name: packName, versionId: versionId, mcVersion, packFormat: 'curseforge',
        modLoader, forgeVersion: forgeVerCF || '', fabricVersion: fabricVerCF || '', neoforgeVersion: neoforgeVerCF || '',
        importedAt: new Date().toISOString(), sourceFile: filePath,
        targetVersion: targetVersion || '',
        pendingMods: cfApiKey ? [] : cfFiles.map(function(f) { return { projectID: f.projectID, fileID: f.fileID }; })
    };
    fs.writeFileSync(path.join(versionDir, 'pack-info.json'), JSON.stringify(packInfo, null, 2));

    progress('done', `整合包 "${packName}" 导入完成！`, 100);
    const cfWarning = cfApiKey ? undefined : 'CurseForge Mod 文件需要 API Key，overrides 已解压。请在设置中配置 CurseForge API Key 后重新导入。';
    let failWarning = undefined;
    if (cfFailedCount > 0) {
        const failedModNames = cfFailedMods.map(m => m.name || m.projectID).join(', ');
        failWarning = `${cfFailedCount}/${cfFiles.length} 个Mod下载失败: ${failedModNames}。请检查网络后重试。`;
        console.warn(`[CurseForge] Mod下载汇总: ${cfFiles.length - cfFailedCount}成功 ${cfFailedCount}失败`);
        console.warn(`[CurseForge] 失败的模组: ${failedModNames}`);
    } else {
        console.log(`[CurseForge] Mod下载完成: 全部${cfFiles.length}个成功`);
    }
    return {
        success: true, name: packName, versionId, mcVersion, targetVersion: targetVersion || '',
        warning: cfWarning || failWarning || undefined,
        failedMods: cfFailedCount > 0 ? cfFailedMods : undefined,
        loaderVersionId: loaderVersionId || null
    };
    } catch (e) {
        console.error('[CurseForge] 导入失败:', e);
        if (_cfBackupDir) {
            try {
                const restoredModsDir = path.join(_cfBackupDir, 'mods');
                if (fs.existsSync(restoredModsDir)) {
                    const currentModsDir = path.join(versionDir, 'mods');
                    if (fs.existsSync(currentModsDir)) fs.rmSync(currentModsDir, { recursive: true, force: true });
                    fs.cpSync(restoredModsDir, currentModsDir, { recursive: true });
                    console.log(`[CurseForge] 已从备份恢复 mods 目录`);
                }
                fs.rmSync(_cfBackupDir, { recursive: true, force: true });
            } catch (rbErr) {
                console.error(`[CurseForge] 回滚失败: ${rbErr.message}`);
            }
        }
        versions.cleanupVersionChain(versionId);
        return { success: false, versionId, error: e.message || '未知错误' };
    }
    if (_cfBackupDir) {
        try { fs.rmSync(_cfBackupDir, { recursive: true, force: true }); } catch (_) {}
    }
}

// HMCL整合包格式 (modpack.json)
async function _importHmcl(zip, hmclEntry, filePath, progress, targetVersion = '', abortSignal = null) {
    console.log(`[HMCL] ========== 开始解析 HMCL 整合包 ==========`);
    let hmclMeta;
    try {
        hmclMeta = JSON.parse(hmclEntry.getData().toString('utf8'));
    } catch (e) {
        return { success: false, error: '解析 modpack.json 失败: ' + e.message };
    }

    const packName  = (hmclMeta.name || path.basename(filePath, path.extname(filePath))).replace(/[<>:"/\\|?*]/g, '_');
    const mcVersion = hmclMeta.gameVersion || '';
    const author    = hmclMeta.author || '';

    console.log(`[HMCL] 整合包: ${packName}, MC: ${mcVersion}, 作者: ${author}`);
    progress('prepare', `整合包: ${packName}  MC: ${mcVersion}`, 8);

    let versionId = targetVersion ? targetVersion.replace(/ \[外部\d*\]/, '') : _dedupeVersionId(packName);
    let versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);

    if (targetVersion) {
        const existingDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
        if (fs.existsSync(existingDir)) {
            // 使用已有版本
        } else {
            const extFolders = versions.loadExternalFolders();
            for (const folder of extFolders) {
                if (!fs.existsSync(folder.path)) continue;
                const extVers = versions.scanExternalFolder(folder.path);
                const extV = extVers.find(v => v.id === versionId);
                if (extV) { versionDir = extV.externalVersionDir; break; }
            }
        }
        if (!fs.existsSync(versionDir)) {
            versionId = _dedupeVersionId(packName);
            versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
        }
    }

    const isNewVersion = !fs.existsSync(path.join(versionDir, `${versionId}.json`));
    if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });

    let loaderVersionId = null;

    if (isNewVersion && mcVersion) {
        progress('base', '正在准备基础版本...', 5);
        const baseResult = await modloaders.ensureBaseVersionInstalled(mcVersion);
        if (baseResult.error) {
            try { if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true }); } catch (e) {}
            return { success: false, versionId, error: baseResult.error };
        }

        const addons = hmclMeta.addons || [];
        for (const addon of addons) {
            const uid = (addon.uid || '').toLowerCase();
            const ver = addon.version || '';
            if (uid === 'net.minecraftforge' && ver) {
                progress('loader-install', '正在安装Forge...', 20);
                loaderVersionId = `${mcVersion}-forge-${ver}`;
                const lvJson = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                if (!fs.existsSync(lvJson)) {
                    const ir = await modloaders.installForge(mcVersion, ver, (p, msg) => progress('loader-install', msg || '正在安装Forge...', 20 + p * 15));
                    if (!ir.success) { versions.cleanupVersionChain(versionId); return { success: false, versionId, error: ir.error }; }
                }
                break;
            } else if (uid === 'net.neoforged' && ver) {
                progress('loader-install', '正在安装NeoForge...', 20);
                loaderVersionId = `${mcVersion}-neoforge-${ver}`;
                const lvJson = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                if (!fs.existsSync(lvJson)) {
                    const ir = await modloaders.installNeoForge(mcVersion, ver, (p, msg) => progress('loader-install', msg || '正在安装NeoForge...', 20 + p * 15));
                    if (!ir.success) { versions.cleanupVersionChain(versionId); return { success: false, versionId, error: ir.error }; }
                }
                break;
            } else if (uid === 'net.fabricmc.fabric-loader' && ver) {
                progress('loader-install', '正在安装Fabric...', 20);
                loaderVersionId = `fabric-loader-${ver}-${mcVersion}`;
                const lvJson = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                let hmclFabricNeedInstall = !fs.existsSync(lvJson);
                if (!hmclFabricNeedInstall) {
                    try {
                        const existingJson = JSON.parse(fs.readFileSync(lvJson, 'utf-8'));
                        if (!(existingJson.libraries || []).some(l => l.name && l.name.startsWith('net.fabricmc:fabric-loader'))) {
                            hmclFabricNeedInstall = true;
                        }
                    } catch (_) { hmclFabricNeedInstall = true; }
                }
                if (hmclFabricNeedInstall) {
                    if (fs.existsSync(lvJson)) {
                        try { fs.rmSync(path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId), { recursive: true, force: true }); } catch (e) {}
                    }
                    const ir = await modloaders.installFabric(mcVersion, ver, (p, msg) => progress('loader-install', msg || '正在安装Fabric...', 20 + p * 15));
                    if (!ir.success) { versions.cleanupVersionChain(versionId); return { success: false, versionId, error: ir.error }; }
                }
                break;
            }
        }

        const versionJson = { id: versionId, inheritsFrom: loaderVersionId || mcVersion, type: 'release', time: new Date().toISOString(), releaseTime: new Date().toISOString() };
        if (loaderVersionId) {
            try {
                const lvJsonPath = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                if (fs.existsSync(lvJsonPath)) { const lvJson = JSON.parse(fs.readFileSync(lvJsonPath, 'utf-8')); if (lvJson.mainClass) versionJson.mainClass = lvJson.mainClass; }
            } catch (e) {}
        }
        fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(versionJson, null, 2));
        versions._invalidateResolvedJsonCache(versionId);
    }

    progress('extract', '解压覆盖文件...', 20);
    const entries = zip.getEntries();
    let extractCounter = 0;
    for (const entry of entries) {
        if (entry.isDirectory) continue;
        const entryName = entry.entryName;
        if (entryName === 'modpack.json') continue;
        const destPath = path.resolve(versionDir, entryName);
        if (!destPath.startsWith(path.resolve(versionDir) + path.sep)) continue;
        await utils.asyncEnsureDir(destPath);
        for (let attempt = 1; attempt <= 5; attempt++) {
            try { await fs.promises.writeFile(destPath, entry.getData()); break; } catch (e) {
                if (attempt < 5) await new Promise(r => setTimeout(r, (attempt - 1) * 2000));
            }
        }
        if (++extractCounter % 50 === 0) await utils.yieldToEventLoop();
    }

    const packInfo = { name: packName, versionId, packFormat: 'hmcl', importedAt: new Date().toISOString(), sourceFile: filePath, author };
    fs.writeFileSync(path.join(versionDir, 'pack-info.json'), JSON.stringify(packInfo, null, 2));

    if (loaderVersionId) {
        progress('verify', '正在验证依赖完整性...', 90);
        await modloaders.verifyImportLibs(versionId, progress, abortSignal);
    }

    progress('done', `"${packName}" 导入完成！`, 100);
    return { success: true, name: packName, versionId, targetVersion: targetVersion || '', loaderVersionId };
}

async function _importRawZip(zip, filePath, progress, targetVersion = '', abortSignal = null) {
    const settings = versions.loadSettingsCached();
    const packName   = path.basename(filePath, path.extname(filePath)).replace(/[<>:"/\\|?*]/g, '_');
    let versionId;
    let versionDir;

    if (targetVersion) {
        const cleanTargetId = targetVersion.replace(/ \[外部\d*\]/, '');
        const existingDir = path.join(ctx.dirs.VERSIONS_DIR, cleanTargetId);
        if (fs.existsSync(existingDir)) {
            versionId = cleanTargetId;
            versionDir = existingDir;
            console.log(`[RawZip] 安装到现有版本: ${versionId}`);
        } else {
            const extFolders = versions.loadExternalFolders();
            for (const folder of extFolders) {
                if (!fs.existsSync(folder.path)) continue;
                const extVers = versions.scanExternalFolder(folder.path);
                const extV = extVers.find(v => v.id === cleanTargetId);
                if (extV) {
                    versionId = cleanTargetId;
                    versionDir = extV.externalVersionDir;
                    console.log(`[RawZip] 安装到外部版本: ${versionId}`);
                    break;
                }
            }
        }
        if (!versionDir) {
            versionId = _dedupeVersionId(packName);
            versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
            console.log(`[RawZip] 目标版本不存在，创建新版本: ${versionId}`);
        }
    } else {
        versionId = _dedupeVersionId(packName);
        versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
        console.log(`[RawZip] 未指定目标版本，创建新版本: ${versionId}`);
    }

    const isNewVersionDirRZ = !fs.existsSync(path.join(versionDir, `${versionId}.json`));
    let baseMcVersion = '';
    try {
        utils.ensureDir(path.join(versionDir, 'dummy.txt'));

    progress('extract', `解压 ${packName}...`, 10);
    try {
        const entries = zip.getEntries();
        let rzExtractYieldCounter = 0;
        for (const entry of entries) {
            const entryName = entry.entryName;
            const destPath = path.resolve(versionDir, entryName);
            if (!destPath.startsWith(path.resolve(versionDir) + path.sep) && destPath !== path.resolve(versionDir)) {
                console.warn(`[Security] Blocked Zip Slip entry: ${entryName}`);
                continue;
            }
            if (entry.isDirectory) {
                await utils.asyncEnsureDir(path.join(versionDir, entryName, 'dummy.txt'));
            } else {
                await utils.asyncEnsureDir(path.join(versionDir, entryName));
                for (let attempt = 1; attempt <= 5; attempt++) {
                    try {
                        await fs.promises.writeFile(destPath, entry.getData());
                        break;
                    } catch (e) {
                        console.warn(`[Modpack] RawZip解压 ${entryName} 第 ${attempt} 次失败: ${e.message}`);
                        if (attempt < 5) await new Promise(r => setTimeout(r, (attempt - 1) * 2000));
                    }
                }
                if (++rzExtractYieldCounter % 50 === 0) await utils.yieldToEventLoop();
            }
        }
    } catch (e) {
        return { success: false, versionId, error: '解压失败: ' + e.message };
    }

    const packInfo = {
        name: packName, versionId: versionId, packFormat: 'raw',
        importedAt: new Date().toISOString(), sourceFile: filePath,
        targetVersion: targetVersion || ''
    };
    fs.writeFileSync(path.join(versionDir, 'pack-info.json'), JSON.stringify(packInfo, null, 2));

    if (isNewVersionDirRZ) {
        try {
            const allInstalled = versions.getInstalledVersions();
            const mcDirs = fs.readdirSync(ctx.dirs.VERSIONS_DIR).filter(d => {
                const dd = path.join(ctx.dirs.VERSIONS_DIR, d);
                if (!fs.statSync(dd).isDirectory()) return false;
                return /^\d+\.\d+(\.\d+)?$/.test(d);
            });
            if (mcDirs.length > 0) {
                baseMcVersion = mcDirs.sort((a, b) => {
                    const pa = a.split('.').map(Number);
                    const pb = b.split('.').map(Number);
                    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
                    return 0;
                })[0];
            }
        } catch (e) {}

        const versionJson = {
            id: versionId,
            inheritsFrom: baseMcVersion || undefined,
            type: 'release',
            time: new Date().toISOString(),
            releaseTime: new Date().toISOString()
        };
        if (baseMcVersion) {
            try {
                const baseResult = await modloaders.ensureBaseVersionInstalled(baseMcVersion);
                if (baseResult.error) console.log(`[RawZip] 基础版本安装失败: ${baseResult.error}`);
            } catch (e) {
                console.log(`[RawZip] 基础版本安装异常: ${e.message}`);
            }
        }
        fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(versionJson, null, 2));
        versions._invalidateResolvedJsonCache(versionId);
        console.log(`[RawZip] 创建版本JSON: ${versionId}.json (inheritsFrom: ${baseMcVersion || '无'})`);
    }

    if (baseMcVersion) {
        progress('verify', '正在验证依赖完整性...', 90, [], '');
        await modloaders.verifyImportLibs(versionId, progress, abortSignal);
    }

    progress('done', `"${packName}" 解压完成！`, 100);
    return { success: true, name: packName, versionId, targetVersion: targetVersion || '' };
    } catch (e) {
        console.error('[RawZip] 导入失败:', e);
        try { if (fs.existsSync(versionDir)) { fs.rmSync(versionDir, { recursive: true, force: true }); console.log(`[RawZip] 清理失败目录: ${versionDir}`); } } catch (ce) {}
        return { success: false, versionId, error: e.message || '导入失败' };
    }
}

module.exports = {
    _dedupeVersionId,
    _repairCorruptedModJars,
    isModpackPathSafe,
    _extractOverridesWithVerification,
    importModpackFromPath,
    _importMrpack,
    _importCurseForge,
    _importHmcl,
    _importRawZip,
};
