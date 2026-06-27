/**
 * server/diagnose.js - 版本诊断与修复模块
 * ============================================================================
 * 从 server.js 抽取的版本诊断、修复功能。
 * 通过 ctx (./context) 访问共享状态，通过 utils (./utils) 访问工具函数，
 * 通过 http (./http-client) 访问 HTTP 请求功能，通过 versions (./versions) 访问版本管理功能。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ctx = require('./context');
const utils = require('./utils');
const http = require('./http-client');
const versions = require('./versions');

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

function evaluateRules(rules, extraVars = {}) {
    return _server().evaluateRules(rules, extraVars);
}

function detectBundledJava() {
    return _server().detectBundledJava();
}

function detectSystemJava() {
    return _server().detectSystemJava();
}

async function ensureBaseVersionInstalled(gameVersion, onProgress) {
    return _server().ensureBaseVersionInstalled(gameVersion, onProgress);
}

async function runForgeInstallerJar(installerJarPath, mcDir, onProgress, useNative) {
    return _server().runForgeInstallerJar(installerJarPath, mcDir, onProgress, useNative);
}

// ============================================================================
// 解析库文件路径
// ============================================================================
function resolveLibraryPath(libName) {
    const parts = libName.split(':');
    if (parts.length < 3) return null;
    const groupPath = parts[0].replace(/\./g, '/');
    const name = parts[1];
    const version = parts[2];
    const fileName = `${name}-${version}.jar`;
    return path.join(ctx.dirs.LIBRARIES_DIR, groupPath, name, version, fileName);
}

// ============================================================================
// 版本诊断
// ============================================================================
function diagnoseVersion(versionId) {
    const issues = [];
    const cleanId = versionId.replace(/ \[外部\d*\]/, '');
    let versionDir = null;
    const extFolders = versions.loadExternalFolders();
    for (const folder of extFolders) {
        if (!fs.existsSync(folder.path)) continue;
        const extVers = versions.scanExternalFolder(folder.path);
        if (extVers.some(v => v.id === cleanId)) {
            versionDir = path.join(folder.path, cleanId);
            break;
        }
    }
    if (!versionDir) {
        versionDir = path.join(ctx.dirs.VERSIONS_DIR, cleanId);
    }

    if (!fs.existsSync(versionDir)) {
        return { issues: [{ type: 'critical', message: '版本目录不存在', solution: '请重新安装此版本' }] };
    }

    const versionJsonPath = versions.findVersionJson(versionDir);
    if (!versionJsonPath) {
        issues.push({ type: 'critical', message: '版本 JSON 文件缺失', solution: '请重新安装此版本或修复版本文件' });
    } else {
        try {
            const vj = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));

            if (!vj.mainClass) {
                issues.push({ type: 'critical', message: '主类缺失', solution: '版本 JSON 损坏，请重新安装' });
            }

            if (vj.libraries && Array.isArray(vj.libraries)) {
                let missingLibs = 0;
                for (const lib of vj.libraries) {
                    if (!lib.name) continue;
                    const libNameSuffix = lib.name.split(':').pop();
                    if (libNameSuffix.startsWith('natives-')) continue;
                    if (lib.rules && !evaluateRules(lib.rules)) continue;
                    if (lib.downloads && lib.downloads.artifact) {
                        const libPath = path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path);
                        if (!fs.existsSync(libPath)) {
                            missingLibs++;
                        }
                    } else {
                        const libPath = resolveLibraryPath(lib.name);
                        if (libPath && !fs.existsSync(libPath)) {
                            missingLibs++;
                        }
                    }
                }
                if (missingLibs > 0) {
                    issues.push({ type: 'warning', message: `${missingLibs} 个依赖库文件缺失`, solution: '点击修复以下载缺失的库文件' });
                }
            }

            if (vj.inheritsFrom) {
                const parentJsonPath = path.join(ctx.dirs.VERSIONS_DIR, vj.inheritsFrom, `${vj.inheritsFrom}.json`);
                if (!fs.existsSync(parentJsonPath)) {
                    issues.push({ type: 'critical', message: `缺少基础版本 ${vj.inheritsFrom}`, solution: `请先安装原版 ${vj.inheritsFrom}` });
                }
                const parentJarPath = path.join(ctx.dirs.VERSIONS_DIR, vj.inheritsFrom, `${vj.inheritsFrom}.jar`);
                if (!fs.existsSync(parentJarPath)) {
                    issues.push({ type: 'critical', message: '缺少基础版本 JAR 文件', solution: `重新安装原版 ${vj.inheritsFrom}` });
                }
            } else {
                const jarName = vj.jar || cleanId;
                const jarPath = path.join(versionDir, `${jarName}.jar`);
                if (!fs.existsSync(jarPath)) {
                    issues.push({ type: 'critical', message: '游戏主 JAR 文件缺失', solution: '请重新安装此版本' });
                }
            }

            if (vj.javaVersion) {
                const requiredVer = vj.javaVersion.majorVersion;
                const settings = versions.loadSettingsCached();
                let javaPath = settings.javaPath;
                if (!javaPath) {
                    const allJava = [...detectBundledJava(), ...detectSystemJava()];
                    if (allJava.length > 0) javaPath = (allJava.find(j => j.majorVersion >= 17) || allJava[0]).path;
                }
                if (javaPath && fs.existsSync(javaPath)) {
                    try {
                        const verOutput = execSync(`"${javaPath}" -version 2>&1`, { encoding: 'utf8', timeout: 5000 });
                        const verMatch = verOutput.match(/version "([^"]+)"/);
                        if (verMatch) {
                            const ver = verMatch[1];
                            const major = parseInt(ver.startsWith('1.') ? ver.split('.')[1] : ver.split('.')[0], 10);
                            if (major < requiredVer) {
                                issues.push({ type: 'warning', message: `此版本需要 Java ${requiredVer}+，当前 Java 版本: ${ver}`, solution: `请安装 Java ${requiredVer} 或更高版本` });
                            }
                        }
                    } catch (e) {}
                } else {
                    issues.push({ type: 'warning', message: `此版本需要 Java ${requiredVer}+，但未检测到 Java`, solution: '请在设置中配置 Java 路径或安装 Java' });
                }
            }
        } catch (e) {
            issues.push({ type: 'critical', message: '版本 JSON 格式错误', solution: '请重新安装此版本' });
        }
    }

    if (!fs.existsSync(ctx.dirs.ASSETS_DIR)) {
        issues.push({ type: 'warning', message: '资源文件目录不存在', solution: '启动游戏时会自动下载资源文件' });
    }

    const modsDir = path.join(versionDir, 'mods');
    if (fs.existsSync(modsDir)) {
        const disabledMods = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar.disabled') || f.endsWith('.jar.disabled_backup'));
        if (disabledMods.length > 0) {
            issues.push({ type: 'info', message: `${disabledMods.length} 个模组已被禁用`, solution: '如需启用，请在模组管理中操作' });
        }
    }

    const crashDir = path.join(versionDir, 'crash-reports');
    if (fs.existsSync(crashDir)) {
        const recentCrashes = fs.readdirSync(crashDir).filter(f => {
            try {
                const stat = fs.statSync(path.join(crashDir, f));
                return Date.now() - stat.mtimeMs < 86400000;
            } catch (e) { return false; }
        });
        if (recentCrashes.length > 0) {
            issues.push({ type: 'warning', message: `最近24小时有 ${recentCrashes.length} 次崩溃记录`, solution: '建议查看崩溃日志分析原因' });
        }
    }

    if (issues.length === 0) {
        issues.push({ type: 'info', message: '未发现问题', solution: '版本状态正常' });
    }

    return { issues };
}

// ============================================================================
// 版本修复
// ============================================================================
async function performRepair(sessionId, versionId) {
    const session = ctx.sessions.repairSessions.get(sessionId);
    if (!session) return;

    const repairLogPath = path.join(ctx.dirs.DATA_DIR, 'logs', `repair-${Date.now()}.log`);
    try { fs.mkdirSync(path.dirname(repairLogPath), { recursive: true }); } catch (_) {}
    function rlog(msg) {
        const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
        console.log(`[Repair] ${msg}`);
        try { fs.appendFileSync(repairLogPath, line + '\n'); } catch (_) {}
    }
    session._logFile = repairLogPath;
    rlog(`========== 开始修复 ${versionId} ==========`);
    rlog(`版本文件夹: ${path.join(ctx.dirs.VERSIONS_DIR, versionId)}`);
    rlog(`版本JSON存在: ${fs.existsSync(path.join(ctx.dirs.VERSIONS_DIR, versionId, `${versionId}.json`))}`);
    const isAborted = () => session.status === 'cancelled' || (session._abortController && session._abortController.signal.aborted);

    try {
        if (isAborted()) return;

        // Phase 1: Create missing directories (0-3%)
        session.status = 'running';
        session.stage = 'directories';
        session.message = '正在检查目录结构...';
        session.progress = 1;
        const verDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
        const dirsToCheck = ['mods', 'config', 'resourcepacks', 'shaderpacks', 'saves', 'screenshots', 'logs', 'crash-reports', 'natives'];
        for (const d of dirsToCheck) {
            const dp = path.join(verDir, d);
            if (!fs.existsSync(dp)) {
                fs.mkdirSync(dp, { recursive: true });
            }
        }
        session.progress = 3;

        if (isAborted()) return;

        // Phase 2: Resolve version JSON and collect all libraries (3-10%)
        session.stage = 'resolve';
        session.message = '正在解析版本JSON...';
        const versionJson = versions.resolveVersionJson(versionId);
        rlog(`Phase2 版本JSON解析: ${versionJson ? '成功' : '失败'}, inheritsFrom: ${versionJson?.inheritsFrom || '无'}`);
        if (!versionJson) {
            session.status = 'failed';
            session.stage = 'failed';
            session.message = '版本JSON文件缺失，无法修复';
            return;
        }
        session.progress = 8;

        if (isAborted()) return;

        // Phase 3: Scan all libraries for missing/corrupted files (10-25%)
        session.stage = 'scanning';
        session.message = '正在扫描库文件...';

        function collectAllLibraries(verId, visited = new Set()) {
            if (visited.has(verId)) return [];
            visited.add(verId);
            const jsonPath = path.join(ctx.dirs.VERSIONS_DIR, verId, `${verId}.json`);
            if (!fs.existsSync(jsonPath)) return [];
            let result = [];
            try {
                const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
                const libs = (data.libraries || []).filter(lib => {
                    if (lib.rules && !evaluateRules(lib.rules)) return false;
                    return true;
                });
                result = libs;
                if (data.inheritsFrom) {
                    result = [...collectAllLibraries(data.inheritsFrom, visited), ...result];
                }
            } catch (e) {}
            return result;
        }

        const allLibs = collectAllLibraries(versionId);
        rlog(`Phase3 扫描到 ${allLibs.length} 个库文件`);
        session.totalFiles = allLibs.length;
        session.message = `正在扫描 ${allLibs.length} 个库文件...`;

        const missingLibs = [];
        const corruptLibs = [];
        for (let i = 0; i < allLibs.length; i++) {
            if (isAborted()) return;
            const lib = allLibs[i];
            session.checkedFiles = i + 1;
            session.progress = 10 + (i / allLibs.length) * 15;
            if (i % 50 === 0) {
                session.message = `正在扫描库文件 (${i+1}/${allLibs.length})...`;
            }

            if (!lib.name) continue;
            const libPath = resolveLibraryPath(lib.name);
            if (!libPath) continue;

            if (!fs.existsSync(libPath)) {
                missingLibs.push({ lib, path: libPath });
            } else if (libPath.endsWith('.jar') && !utils.isJarIntact(libPath)) {
                corruptLibs.push({ lib, path: libPath });
            }
        }
        session.missingFiles = missingLibs.length + corruptLibs.length;
        session.checkedFiles = allLibs.length;
        rlog(`Phase3 扫描完成: 缺失=${missingLibs.length}, 损坏=${corruptLibs.length}`);
        missingLibs.forEach(m => rlog(`  缺失: ${path.basename(m.path)}`));
        corruptLibs.forEach(m => rlog(`  损坏: ${path.basename(m.path)}`));
        session.progress = 25;

        if (isAborted()) return;

        // Phase 4: Check client JAR (25-30%)
        session.stage = 'client_jar';
        session.message = '正在检查客户端JAR...';
        const actualVerId = versionJson.inheritsFrom || versionId;
        const jarPath = path.join(ctx.dirs.VERSIONS_DIR, actualVerId, `${actualVerId}.jar`);
        const jarMissing = !fs.existsSync(jarPath);
        if (jarMissing) {
            missingLibs.push({ lib: { name: `${actualVerId}.jar`, downloads: { artifact: versionJson.downloads?.client } }, path: jarPath });
            session.missingFiles++;
        }
        session.progress = 30;

        if (isAborted()) return;

        // Phase 4.5: Check Forge core files (patching JARs, FML modules)
        const _pfLower = (versionId + ' ' + (versionJson.inheritsFrom || '')).toLowerCase();
        const _pfIsNeo = _pfLower.includes('neoforge') || _pfLower.includes('neoforged');
        const isForgeRepair = (_pfLower.includes('forge') && !_pfIsNeo);
        rlog(`Phase4.5 检测到Forge: ${isForgeRepair}, NeoForge: ${_pfIsNeo}`);
        if (isForgeRepair) {
            session.message = '正在检查Forge核心文件...';
            const forgeMatch = (versionJson.inheritsFrom || versionId).match(/^(.+)-[Ff]orge-(.+)$/);
            if (forgeMatch) {
                const mcVer = forgeMatch[1];
                const fVer = forgeMatch[2];
                rlog(`Phase4.5 Forge匹配: MC=${mcVer}, Forge=${fVer}`);
                const forgeVerStr = `${mcVer}-${fVer}`;
                const prefix = 'net/minecraftforge';
                const coreArtifacts = [
                    { dir: `${prefix}/fmlcore/${forgeVerStr}`, file: `fmlcore-${forgeVerStr}.jar` },
                    { dir: `${prefix}/javafmllanguage/${forgeVerStr}`, file: `javafmllanguage-${forgeVerStr}.jar` },
                    { dir: `${prefix}/mclanguage/${forgeVerStr}`, file: `mclanguage-${forgeVerStr}.jar` },
                    { dir: `${prefix}/lowcodelanguage/${forgeVerStr}`, file: `lowcodelanguage-${forgeVerStr}.jar` },
                ];
                for (const art of coreArtifacts) {
                    const p = path.join(ctx.dirs.LIBRARIES_DIR, art.dir, art.file);
                    if (!fs.existsSync(p) || !utils.isJarIntact(p)) {
                        const mvnBase = p.includes('minecraft') ? 'https://libraries.minecraft.net/' : 'https://maven.minecraftforge.net/';
                        missingLibs.push({ lib: { name: art.file.replace('.jar', '').replace(/-/g, ':'), downloads: { artifact: { url: `${mvnBase}${art.dir}/${art.file}` } } }, path: p });
                        session.missingFiles++;
                    }
                }
                const forgeDir = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'minecraftforge', 'forge', forgeVerStr);
                const forgeClientJar = path.join(forgeDir, `forge-${forgeVerStr}-client.jar`);
                const forgeUniversalJar = path.join(forgeDir, `forge-${forgeVerStr}-universal.jar`);
                const hasForgeJar = (fs.existsSync(forgeClientJar) && utils.isJarIntact(forgeClientJar)) ||
                    (fs.existsSync(forgeUniversalJar) && utils.isJarIntact(forgeUniversalJar));
                if (!hasForgeJar) {
                    missingLibs.push({ lib: { name: `net.minecraftforge:forge:${forgeVerStr}:universal`, downloads: { artifact: { url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${forgeVerStr}/forge-${forgeVerStr}-universal.jar` } } }, path: forgeUniversalJar });
                    session.missingFiles++;
                }
                let mcpVer = '';
                try {
                    const ga = versionJson.arguments?.game || [];
                    const mi = ga.findIndex(a => a === '--fml.mcpVersion');
                    if (mi >= 0 && mi + 1 < ga.length) mcpVer = ga[mi + 1];
                } catch (_) {}
                if (!mcpVer) {
                    try {
                        const cbd = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'minecraft', 'client');
                        if (fs.existsSync(cbd)) {
                            const sd = fs.readdirSync(cbd).filter(d => d.startsWith(`${mcVer}-`) && fs.statSync(path.join(cbd, d)).isDirectory());
                            if (sd.length > 0) mcpVer = sd[0].slice(mcVer.length + 1);
                        }
                    } catch (_) {}
                }
                rlog(`Phase4.5 MCP版本: ${mcpVer || '未找到'}`);
                if (mcpVer) {
                    const clientVerStr = `${mcVer}-${mcpVer}`;
                    const clientDir = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'minecraft', 'client', clientVerStr);
                    for (const suffix of ['srg', 'extra']) {
                        const jarPath = path.join(clientDir, `client-${clientVerStr}-${suffix}.jar`);
                        if (!fs.existsSync(jarPath) || !utils.isJarIntact(jarPath)) {
                            missingLibs.push({ lib: { name: `net.minecraft:client:${clientVerStr}:${suffix}`, _patchingJar: true }, path: jarPath });
                            session.missingFiles++;
                        }
                    }
                }
            }
        }

        // Phase 5: Download missing/corrupted files (30-95%)
        session.stage = 'downloading';
        const allMissing = [...corruptLibs, ...missingLibs];
        rlog(`Phase5 准备下载: 总计=${allMissing.length}个缺失/损坏文件`);
        const uniqueMissing = [];
        const seen = new Set();
        for (const item of allMissing) {
            if (!seen.has(item.path)) { seen.add(item.path); uniqueMissing.push(item); }
        }

        session.missingFiles = uniqueMissing.length;
        session.totalFiles = uniqueMissing.length > 0 ? uniqueMissing.length : allLibs.length;

        let repaired = 0;
        let failed = 0;
        const failedList = [];

        for (let i = 0; i < uniqueMissing.length; i++) {
            if (isAborted()) { session.message = '修复已取消'; return; }

            const item = uniqueMissing[i];
            const lib = item.lib;
            const libPath = item.path;

            session.currentFile = path.basename(libPath);
            session.message = `正在修复 (${i+1}/${uniqueMissing.length}): ${session.currentFile}`;
            session.progress = 30 + (i / Math.max(uniqueMissing.length, 1)) * 65;
            session.repairedFiles = repaired;
            session.lastActivity = Date.now();

            if (utils.isJarIntact(libPath)) { repaired++; continue; }

            if (lib._patchingJar) { rlog(`  跳过补丁JAR (Phase5.5处理): ${path.basename(libPath)}`); failed++; failedList.push(path.basename(libPath)); continue; }

            let url = null;
            if (lib.downloads?.artifact?.url) {
                url = lib.downloads.artifact.url;
            } else if (lib.name) {
                const p = lib.name.split(':');
                if (p.length >= 3) {
                    const mg = p[0].replace(/\./g, '/');
                    const cl = p.length >= 4 ? `-${p[3]}` : '';
                    const jn = `${p[1]}-${p[2]}${cl}.jar`;
                    const base = lib.url || (p[0].includes('neoforged') ? 'https://maven.neoforged.net/'
                        : (p[0].includes('forge') || p[0].includes('minecraftforge') || p[0].includes('minecraft')
                        ? 'https://maven.minecraftforge.net/' : 'https://libraries.minecraft.net/'));
                    url = `${base}${mg}/${p[1]}/${p[2]}/${jn}`;
                }
            }
            if (!url && lib.downloads?.client?.url) {
                url = lib.downloads.client.url;
            }

            if (!url) {
                failed++;
                failedList.push(path.basename(libPath));
                continue;
            }

            try {
                if (fs.existsSync(libPath)) {
                    try { fs.unlinkSync(libPath); } catch (e) {}
                }
                if (!fs.existsSync(path.dirname(libPath))) {
                    // [CRITICAL] depCheck 自动下载库文件前清理路径中的文件冲突（同 ensureDir 的 ENOTDIR 修复）。
                    // [AI-AUTOGEN-WARNING] 请勿删除此处的文件清理逻辑。
                    {
                        const _d = path.dirname(libPath);
                        const _parts = _d.split(path.sep);
                        for (let _i = 1; _i <= _parts.length; _i++) {
                            const _partial = _parts.slice(0, _i).join(path.sep);
                            if (_partial && fs.existsSync(_partial)) {
                                try { const _st = fs.statSync(_partial); if (!_st.isDirectory()) fs.unlinkSync(_partial); } catch (_) {}
                            }
                        }
                    }
                    fs.mkdirSync(path.dirname(libPath), { recursive: true });
                }

                await http.downloadFileWithMirror(url, libPath, null, 2, session._abortController ? session._abortController.signal : null);

                if (libPath.endsWith('.jar') && !utils.isJarIntact(libPath)) {
                    failed++;
                    failedList.push(path.basename(libPath));
                    try { fs.unlinkSync(libPath); } catch (e) {}
                } else {
                    repaired++;
                }
            } catch (e) {
                failed++;
                failedList.push(path.basename(libPath));
                if (fs.existsSync(libPath) && !utils.isJarIntact(libPath)) {
                    try { fs.unlinkSync(libPath); } catch (e2) {}
                }
            }
        }

        if (isAborted()) return;

        // Phase 5.5: Forge patching JARs can only be generated by the Forge installer
        if (isForgeRepair) {
            const forgeMatchP = (versionJson.inheritsFrom || versionId).match(/^(\d+\.\d+(?:\.\d+)?)-forge-(.+)$/);
            if (forgeMatchP) {
                const pmcVer = forgeMatchP[1];
                const pfVer = forgeMatchP[2];
                const patchingStillMissing = uniqueMissing.filter(item =>
                    item.lib?._patchingJar && (!fs.existsSync(item.path) || !utils.isJarIntact(item.path))
                );
                rlog(`Phase5.5 补丁JAR仍缺失: ${patchingStillMissing.length}个`);
                patchingStillMissing.forEach(p => rlog(`  ${path.basename(p.path)}`));
                if (patchingStillMissing.length > 0) {
                    session.stage = 'forge_reinstall';
                    session.message = '正在重装Forge以生成补丁JAR...';
                    session.progress = Math.max(session.progress, 90);
                    try {
                        const baseJar = path.join(ctx.dirs.VERSIONS_DIR, pmcVer, `${pmcVer}.jar`);
                        rlog(`Phase5.5 原版JAR: ${baseJar} (存在: ${fs.existsSync(baseJar)})`);
                        if (!fs.existsSync(baseJar)) {
                            session.message = '正在下载原版JAR...';
                            rlog(`Phase5.5 下载原版JAR ${pmcVer}...`);
                            await ensureBaseVersionInstalled(pmcVer);
                            rlog(`Phase5.5 原版JAR下载后: ${fs.existsSync(baseJar)}`);
                        }
                        const settings = versions.loadSettingsCached();
                        const gameDir = settings.gameDir || ctx.dirs.DATA_DIR;
                        const forgeVerStr = `${pmcVer}-${pfVer}`;
                        const installerPath = path.join(ctx.dirs.DATA_DIR, 'temp', `forge-repair-${forgeVerStr}.jar`);
                        if (!fs.existsSync(path.dirname(installerPath))) fs.mkdirSync(path.dirname(installerPath), { recursive: true });
                        const installerUrls = [
                            `https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/${forgeVerStr}/forge-${forgeVerStr}-installer.jar`,
                            `https://maven.minecraftforge.net/net/minecraftforge/forge/${forgeVerStr}/forge-${forgeVerStr}-installer.jar`
                        ];
                        let installerOk = false;
                        for (const dlUrl of installerUrls) {
                            rlog(`Phase5.5 下载Forge安装器: ${dlUrl}`);
                            try {
                                await http.downloadFileWithMirror(dlUrl, installerPath);
                                if (fs.existsSync(installerPath) && fs.statSync(installerPath).size > 64 * 1024) {
                                    const fd = fs.openSync(installerPath, 'r');
                                    const buf = Buffer.alloc(2);
                                    fs.readSync(fd, buf, 0, 2, 0);
                                    fs.closeSync(fd);
                                    if (buf[0] === 0x50 && buf[1] === 0x4B) { installerOk = true; rlog(`Phase5.5 安装器下载成功 (${fs.statSync(installerPath).size} bytes)`); break; }
                                    else rlog(`Phase5.5 安装器magic不匹配`);
                                } else {
                                    rlog(`Phase5.5 安装器文件过小或不存在`);
                                }
                            } catch (e) { rlog(`Phase5.5 安装器下载异常: ${e.message}`); }
                        }
                        if (installerOk) {
                            session.message = '正在运行Forge安装器...';
                            let tempGameDir = null;
                            let installerGameDir = gameDir;
                            rlog(`Phase5.5 运行Forge安装器: installerGameDir=${installerGameDir}`);
                            try {
                                const fsLibDir = path.join(gameDir, 'libraries');
                                if (!fs.existsSync(gameDir)) fs.mkdirSync(gameDir, { recursive: true });
                                if (!fs.existsSync(fsLibDir) || path.resolve(fsLibDir) !== path.resolve(ctx.dirs.LIBRARIES_DIR)) {
                                    tempGameDir = path.join(os.tmpdir(), `versepc-repair-forge-${Date.now()}`);
                                    fs.mkdirSync(tempGameDir, { recursive: true });
                                    const tempLibDir = path.join(tempGameDir, 'libraries');
                                    try { fs.symlinkSync(ctx.dirs.LIBRARIES_DIR, tempLibDir, 'junction'); } catch (e) {
                                        try { fs.rmSync(tempGameDir, { recursive: true, force: true }); } catch (_) {}
                                        tempGameDir = null;
                                    }
                                    if (tempGameDir) {
                                        installerGameDir = tempGameDir;
                                        try { fs.mkdirSync(path.join(tempGameDir, 'versions'), { recursive: true }); } catch (_) {}
                                    }
                                }
                            } catch (_) {}
                            const instResult = await runForgeInstallerJar(installerPath, installerGameDir, (msg, pct) => {
                                session.progress = 90 + pct * 8;
                            }, true);
                            rlog(`Phase5.5 安装器结果: success=${instResult.success}, error=${instResult.error || '无'}`);
                            if (instResult.success) {
                                const installerJsonPath = path.join(installerGameDir, 'versions', versionId, `${versionId}.json`);
                                const targetJsonPath = path.join(ctx.dirs.VERSIONS_DIR, versionId, `${versionId}.json`);
                                if (fs.existsSync(installerJsonPath) && !fs.existsSync(targetJsonPath)) {
                                    try { fs.copyFileSync(installerJsonPath, targetJsonPath); } catch (_) {}
                                }
                            }
                            try { if (tempGameDir) fs.rmSync(tempGameDir, { recursive: true, force: true }); } catch (_) {}
                        }
                        try { if (fs.existsSync(installerPath)) fs.unlinkSync(installerPath); } catch (_) {}
                    } catch (e) {
                        console.warn(`[Repair] Forge重装失败: ${e.message}`);
                    }
                    let extraRepaired = 0;
                    for (const item of patchingStillMissing) {
                        const exists = fs.existsSync(item.path);
                        const intact = exists && utils.isJarIntact(item.path);
                        rlog(`Phase5.5 验证: ${path.basename(item.path)} exists=${exists} intact=${intact}`);
                        if (exists && intact) {
                            extraRepaired++;
                            failed = Math.max(0, failed - 1);
                            const idx = failedList.indexOf(path.basename(item.path));
                            if (idx >= 0) failedList.splice(idx, 1);
                        }
                    }
                    if (extraRepaired > 0) repaired += extraRepaired;
                }
            }
        }

        // Phase 6: Complete (95-100%)
        session.stage = 'complete';
        session.repairedFiles = repaired;
        session.progress = 100;
        rlog(`========== 修复完成: 成功=${repaired}, 失败=${failed} ==========`);
        if (failedList.length > 0) rlog(`失败文件: ${failedList.join(', ')}`);

        if (failed > 0) {
            session.status = 'completed';
            session.message = `修复完成，成功 ${repaired} 个，失败 ${failed} 个`;
            session._failedList = failedList;
        } else {
            session.status = 'completed';
            session.message = `修复完成！共修复/验证 ${repaired} 个文件`;
        }
    } catch (e) {
        rlog(`========== 修复异常 ==========`);
        rlog(`错误: ${e.stack || e.message || e}`);
        session.status = 'failed';
        session.stage = 'failed';
        session.message = '修复失败: ' + (e.message || '未知错误');
    }
}

module.exports = { resolveLibraryPath, diagnoseVersion, performRepair };
