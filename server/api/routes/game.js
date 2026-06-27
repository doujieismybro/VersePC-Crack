/**
 * server/api/routes/game.js - 游戏运行相关路由
 * ============================================================================
 * 从 server.js handleAPI switch 语句抽取的游戏运行相关端点。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execSync } = require('child_process');

let _serverModule = null;
function _server() {
    if (_serverModule === null) {
        try { _serverModule = require('../../../server'); } catch (_) { _serverModule = {}; }
    }
    return _serverModule;
}

module.exports = {
    register(registerRoute, deps) {
        const { ctx, sendJSON, sendError, readBody } = deps;
        const { versions, launch, diagnose, modloaders, accounts, utils, http, java, dependencies } = deps;

        // ====================================================================
        // /api/game/status
        // ====================================================================
        registerRoute('GET', '/api/game/status', async (req, res, parsedUrl) => {
            const instances = [...ctx.sessions.gameInstances.values()].map(inst => ({
                sessionId: inst.sessionId,
                versionId: inst.versionId,
                pid: inst.pid,
                lanPort: inst.lanPort,
                startTime: inst.startTime,
                gameReady: inst.gameReady || false,
                readyTime: inst.readyTime || null,
                loadStage: inst.loadStage || 0,
                launchDuration: inst.readyTime ? (inst.readyTime - inst.startTime) : null,
                running: true,
            }));
            sendJSON(res, {
                running: ctx.sessions.gameInstances.size > 0,
                instances,
                lanPort: ctx.sessions.detectedLanPort
            });
        });

        // ====================================================================
        // /api/game/stop (GET 和 POST 共用同一 handler)
        // ====================================================================
        const stopHandler = async (req, res, parsedUrl) => {
            const stopData = parsedUrl.query.sessionId ? { sessionId: parsedUrl.query.sessionId } : (req.method === 'POST' ? await readBody(req).catch(() => ({})) : {});
            if (stopData.sessionId) {
                const inst = ctx.sessions.gameInstances.get(stopData.sessionId);
                if (inst) {
                    try { inst.process.kill(); } catch (e) {}
                    ctx.sessions.gameInstances.delete(stopData.sessionId);
                    sendJSON(res, { success: true, message: '游戏实例已停止', sessionId: stopData.sessionId });
                } else {
                    sendJSON(res, { success: false, error: '找不到该游戏实例' });
                }
            } else if (ctx.sessions.gameInstances.size > 0) {
                for (const [sid, inst] of ctx.sessions.gameInstances) {
                    try { inst.process.kill(); } catch (e) {}
                }
                ctx.sessions.gameInstances.clear();
                sendJSON(res, { success: true, message: '所有游戏实例已停止' });
            } else {
                sendJSON(res, { success: false, error: '游戏未在运行' });
            }
        };
        registerRoute('GET', '/api/game/stop', stopHandler);
        registerRoute('POST', '/api/game/stop', stopHandler);

        // ====================================================================
        // /api/game/log
        // 注: server.js 中存在两处 case '/api/game/log' (行22368 与 行27265)。
        // 由于 switch 语句中先匹配的 case 会 break，实际生效的是第一处(更完整)。
        // 此处采用第一处的逻辑，它兼容无 sessionId 的场景。
        // ====================================================================
        registerRoute('GET', '/api/game/log', async (req, res, parsedUrl) => {
            const logSessionId = parsedUrl.query.sessionId;
            const count = parseInt(parsedUrl.query.count || '100', 10);
            const offset = parseInt(parsedUrl.query.offset || '0', 10);
            if (logSessionId) {
                const inst = ctx.sessions.gameInstances.get(logSessionId);
                if (inst) {
                    sendJSON(res, {
                        lines: inst.logBuffer.slice(-(count + offset)).slice(0, count),
                        total: inst.logBuffer.length,
                        sessionId: logSessionId
                    });
                } else {
                    sendJSON(res, {
                        lines: ctx.sessions.gameLogBuffer.filter(l => l.includes(logSessionId)).slice(-(count + offset)).slice(0, count),
                        total: ctx.sessions.gameLogBuffer.length,
                        sessionId: logSessionId
                    });
                }
            } else {
                sendJSON(res, {
                    lines: ctx.sessions.gameLogBuffer.slice(-(count + offset)).slice(0, count),
                    total: ctx.sessions.gameLogBuffer.length
                });
            }
        });

        // ====================================================================
        // /api/game/log/stream (SSE)
        // ====================================================================
        registerRoute('GET', '/api/game/log/stream', async (req, res, parsedUrl) => {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });
            let lastLen = 0;
            let lastInstanceLen = 0;
            const SSE_BATCH_LIMIT = 200;
            const interval = setInterval(() => {
                let activeInst = null;
                for (const [sid, inst] of ctx.sessions.gameInstances) {
                    activeInst = inst;
                    break;
                }
                if (activeInst && activeInst.logBuffer.length > lastInstanceLen) {
                    const newLines = activeInst.logBuffer.slice(lastInstanceLen);
                    for (let i = 0; i < newLines.length; i++) {
                        res.write(`data: ${JSON.stringify({ line: newLines[i] })}\n\n`);
                    }
                    lastInstanceLen = activeInst.logBuffer.length;
                }
                if (ctx.sessions.gameLogBuffer.length > lastLen) {
                    const raw = ctx.sessions.gameLogBuffer.length - lastLen;
                    const take = Math.min(raw, SSE_BATCH_LIMIT);
                    const newLines = ctx.sessions.gameLogBuffer.slice(lastLen, lastLen + take);
                    if (newLines.length <= 50) {
                        for (let i = 0; i < newLines.length; i++) {
                            res.write(`data: ${JSON.stringify({ line: newLines[i] })}\n\n`);
                        }
                    } else {
                        res.write(`data: ${JSON.stringify({ batch: newLines })}\n\n`);
                    }
                    lastLen += take;
                    if (raw > SSE_BATCH_LIMIT) {
                        console.warn(`[LogStream] 日志积压 ${raw} 行, 仅推送 ${take} 行`);
                    }
                }
                if (ctx.sessions.gameInstances.size === 0 && lastLen > 0) {
                    res.write(`data: ${JSON.stringify({ event: 'exited' })}\n\n`);
                    clearInterval(interval);
                }
            }, 800);
            req.on('close', () => clearInterval(interval));
        });

        // ====================================================================
        // /api/game/diagnose
        // ====================================================================
        registerRoute('GET', '/api/game/diagnose', async (req, res, parsedUrl) => {
            const dgVersionId = parsedUrl.query.versionId;
            const issues = [];

            try {
                const settings = versions.loadSettingsCached();
                let javaPath = settings.javaPath;
                if (!javaPath) {
                    const allJava = [...java.detectBundledJava(), ...java.detectSystemJava()];
                    if (allJava.length > 0) javaPath = (allJava.find(j => j.majorVersion >= 17) || allJava[0]).path;
                }

                if (!javaPath || !fs.existsSync(javaPath)) {
                    issues.push({ level: 'error', message: '未找到Java运行环境', fix: '请在设置中配置Java路径或安装Java' });
                } else {
                    try {
                        const verOutput = execSync(`"${javaPath}" -version 2>&1`, { encoding: 'utf8', timeout: 5000 });
                        const verMatch = verOutput.match(/version "([^"]+)"/);
                        if (verMatch) {
                            const ver = verMatch[1];
                            const major = parseInt(ver.startsWith('1.') ? ver.split('.')[1] : ver.split('.')[0], 10);
                            if (dgVersionId && !dgVersionId.includes('forge') && !dgVersionId.includes('fabric')) {
                                const dgBaseVer = dgVersionId.split('-')[0];
                                const dgVerParts = dgBaseVer.split('.').map(Number);
                                const isAtLeast1205 = (dgVerParts[0] || 0) > 1 || ((dgVerParts[0] || 0) === 1 && (dgVerParts[1] || 0) > 20) || ((dgVerParts[0] || 0) === 1 && (dgVerParts[1] || 0) === 20 && (dgVerParts[2] || 0) >= 5);
                                const isAtLeast117 = (dgVerParts[0] || 0) > 1 || ((dgVerParts[0] || 0) === 1 && (dgVerParts[1] || 0) >= 17);
                                if (isAtLeast1205 && major < 21) {
                                    issues.push({ level: 'error', message: `Minecraft 1.20.5+ 需要Java 21，当前Java版本: ${ver}`, fix: '请安装Java 21或更高版本' });
                                } else if (isAtLeast117 && major < 16) {
                                    issues.push({ level: 'error', message: `Minecraft 1.17+ 需要Java 16，当前Java版本: ${ver}`, fix: '请安装Java 16或更高版本' });
                                }
                            }
                            try {
                                const archOutput = execSync(`"${javaPath}" -XshowSettings:properties -version 2>&1`, { encoding: 'utf8', timeout: 5000 });
                                if (!archOutput.includes('64') && settings.maxMemory > 1500) {
                                    issues.push({ level: 'warn', message: '32位Java最大只能分配约1.5GB内存', fix: '请安装64位Java或降低内存分配' });
                                }
                            } catch (archErr) {
                                issues.push({ level: 'info', message: '无法检测Java架构(32/64位)' });
                            }
                        }
                    } catch (e) {
                        issues.push({ level: 'warn', message: '无法检测Java版本', fix: '请确认Java安装正确' });
                    }
                }

                if (dgVersionId) {
                    const versionJson = versions.resolveVersionJson(dgVersionId);
                    if (!versionJson) {
                        issues.push({ level: 'error', message: `版本 ${dgVersionId} 的JSON文件缺失或损坏`, fix: '请重新安装此版本' });
                    } else {
                        if (versionJson.inheritsFrom) {
                            const parentJsonPath = path.join(ctx.dirs.VERSIONS_DIR, versionJson.inheritsFrom, `${versionJson.inheritsFrom}.json`);
                            if (!fs.existsSync(parentJsonPath)) {
                                issues.push({ level: 'error', message: `缺少基础版本 ${versionJson.inheritsFrom}，请先安装`, fix: `安装原版 ${versionJson.inheritsFrom}` });
                            }
                            const parentJarPath = path.join(ctx.dirs.VERSIONS_DIR, versionJson.inheritsFrom, `${versionJson.inheritsFrom}.jar`);
                            if (!fs.existsSync(parentJarPath)) {
                                issues.push({ level: 'error', message: `缺少基础版本JAR文件`, fix: `重新安装原版 ${versionJson.inheritsFrom}` });
                            }
                        }

                        const mainJar = path.join(ctx.dirs.VERSIONS_DIR, dgVersionId, `${dgVersionId}.jar`);
                        if (!fs.existsSync(mainJar) && !versionJson.inheritsFrom) {
                            issues.push({ level: 'error', message: '游戏主JAR文件缺失', fix: '请重新安装此版本' });
                        }

                        const missingLibs = [];
                        for (const lib of (versionJson.libraries || [])) {
                            const libNameSuffix = lib.name ? lib.name.split(':').pop() : '';
                            if (libNameSuffix.startsWith('natives-')) continue;
                            if (lib.rules && !versions.evaluateRules(lib.rules)) continue;
                            if (lib.downloads?.artifact) {
                                const libPath = path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path);
                                if (!fs.existsSync(libPath)) {
                                    missingLibs.push(lib.name || lib.downloads.artifact.path);
                                }
                            }
                        }
                        if (missingLibs.length > 0) {
                            issues.push({ level: 'warn', message: `${missingLibs.length} 个库文件缺失`, fix: '点击修复以重新下载缺失的库文件' });
                        }
                    }
                }

                if (settings.maxMemory < 1024) {
                    issues.push({ level: 'warn', message: '分配内存过小（低于1GB），可能导致游戏卡顿', fix: '建议将最大内存设置为2GB以上' });
                }

                const totalMem = os.totalmem();
                if (settings.maxMemory > totalMem / (1024 * 1024) * 0.8) {
                    issues.push({ level: 'warn', message: `分配内存接近系统总内存(${(totalMem / (1024*1024*1024)).toFixed(1)}GB)`, fix: '建议降低内存分配' });
                }

                if (issues.length === 0) {
                    issues.push({ level: 'info', message: '未发现明显问题，可以尝试启动游戏', fix: '' });
                }

                sendJSON(res, { issues });
            } catch (e) {
                sendError(res, '诊断失败: ' + e.message);
            }
        });

        // ====================================================================
        // /api/game/crash-log
        // ====================================================================
        registerRoute('GET', '/api/game/crash-log', async (req, res, parsedUrl) => {
            const crVersionId = parsedUrl.query.versionId;
            let crashLog = null;
            const searchDirs = [];

            if (crVersionId && versions.resolveVersionIsolation(crVersionId)) {
                searchDirs.push(path.join(ctx.dirs.VERSIONS_DIR, crVersionId, 'crash-reports'));
            }
            const settings = versions.loadSettingsCached();
            searchDirs.push(path.join(settings.gameDir || ctx.dirs.DATA_DIR, 'crash-reports'));

            for (const dir of searchDirs) {
                if (!fs.existsSync(dir)) continue;
                const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt')).sort().reverse();
                if (files.length > 0) {
                    try {
                        const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');
                        crashLog = { file: files[0], content: content.substring(0, 10000), path: path.join(dir, files[0]) };
                        break;
                    } catch (e) {}
                }
            }

            sendJSON(res, { crashLog });
        });

        // ====================================================================
        // /api/game/exit-analysis
        // ====================================================================
        registerRoute('GET', '/api/game/exit-analysis', async (req, res, parsedUrl) => {
            sendJSON(res, { analysis: ctx.sessions.lastGameExitAnalysis });
        });

        // ====================================================================
        // /api/game/crash-analyze
        // ====================================================================
        registerRoute('GET', '/api/game/crash-analyze', async (req, res, parsedUrl) => {
            const caVersionId = parsedUrl.query.versionId;
            if (!caVersionId) { sendError(res, 'Missing versionId', 400); return; }

            try {
                const caSettings = versions.loadSettingsCached();
                let caVersionDir = null;
                const caCleanId = caVersionId.replace(/ \[外部\d*\]/, '');
                const caExtFolders = versions.loadExternalFolders();
                for (const folder of caExtFolders) {
                    if (!fs.existsSync(folder.path)) continue;
                    const extVers = versions.scanExternalFolder(folder.path);
                    if (extVers.some(v => v.id === caCleanId)) {
                        caVersionDir = path.join(folder.path, caCleanId);
                        break;
                    }
                }
                if (!caVersionDir) {
                    caVersionDir = path.join(ctx.dirs.VERSIONS_DIR, caCleanId);
                }

                let crashContent = '';
                let latestLogContent = '';
                let hsErrContent = '';
                let logFile = null;

                const crashReportsDir = path.join(caVersionDir, 'crash-reports');
                if (fs.existsSync(crashReportsDir)) {
                    const crashFiles = fs.readdirSync(crashReportsDir)
                        .filter(f => f.startsWith('crash-') && f.endsWith('.txt'))
                        .map(f => ({ name: f, mtime: fs.statSync(path.join(crashReportsDir, f)).mtime }))
                        .sort((a, b) => b.mtime - a.mtime);
                    for (const cf of crashFiles) {
                        const mtime = cf.mtime;
                        if (Math.abs((mtime - new Date()) / 60000) < 3) {
                            try {
                                crashContent = fs.readFileSync(path.join(crashReportsDir, cf.name), 'utf8');
                                logFile = 'crash-reports/' + cf.name;
                                break;
                            } catch (e) {}
                        }
                    }
                }

                const latestLogPath = path.join(caVersionDir, 'logs', 'latest.log');
                if (fs.existsSync(latestLogPath)) {
                    try {
                        const lines = fs.readFileSync(latestLogPath, 'utf8').split('\n');
                        latestLogContent = lines.slice(-500).join('\n');
                        if (!logFile) logFile = 'logs/latest.log';
                    } catch (e) {}
                }

                try {
                    const versionFiles = fs.readdirSync(caVersionDir);
                    for (const vf of versionFiles) {
                        if (vf.startsWith('hs_err_pid') && vf.endsWith('.log')) {
                            const hsPath = path.join(caVersionDir, vf);
                            const stat = fs.statSync(hsPath);
                            if (Math.abs((stat.mtime - new Date()) / 60000) < 10) {
                                try {
                                    const hsLines = fs.readFileSync(hsPath, 'utf8').split('\n');
                                    hsErrContent = hsLines.slice(0, 200).join('\n');
                                    if (!logFile) logFile = vf;
                                    break;
                                } catch (e) {}
                            }
                        }
                    }
                } catch (e) {}

                const allLog = crashContent + '\n' + latestLogContent + '\n' + hsErrContent;

                if (!allLog.trim()) {
                    sendJSON(res, { found: false });
                    return;
                }

                const crashRules = [
                    { pattern: 'java.lang.OutOfMemoryError', reason: '内存不足', solution: '建议增加分配内存或减少模组数量。当前分配的内存可能不足以支撑游戏运行。', severity: 'high' },
                    { pattern: 'The driver does not appear to support OpenGL', reason: '显卡不支持OpenGL', solution: '请更新显卡驱动，或确认您的显卡支持OpenGL。老旧显卡可能无法运行Minecraft。', severity: 'high' },
                    { pattern: 'Pixel format not accelerated', reason: '显卡驱动不支持', solution: '显卡驱动不支持所需的像素格式。请更新显卡驱动至最新版本。', severity: 'high' },
                    { pattern: "Couldn't set pixel format", reason: '显卡驱动不支持', solution: '显卡驱动不支持所需的像素格式。请更新显卡驱动至最新版本。', severity: 'high' },
                    { pattern: 'Unsupported class file major version', reason: 'Java版本不兼容', solution: '当前Java版本过低，无法运行该版本的游戏或Mod。请安装更高版本的Java。', severity: 'high' },
                    { pattern: 'Unsupported major.minor version', reason: 'Java版本不兼容', solution: '当前Java版本过低，无法运行该版本的游戏或Mod。请安装更高版本的Java。', severity: 'high' },
                    { pattern: 'because module java.base does not export', reason: 'Java版本过高', solution: '当前Java版本过高，导致与游戏不兼容。请降低Java版本（推荐Java 8或11）。', severity: 'high' },
                    { pattern: 'NoSuchFieldException: ucp', reason: 'Java版本过高', solution: '当前Java版本过高，导致与游戏不兼容。请降低Java版本（推荐Java 8或11）。', severity: 'high' },
                    { pattern: 'Open J9 is not supported', reason: '使用OpenJ9', solution: 'Minecraft不支持OpenJ9虚拟机。请更换为HotSpot JVM（如Oracle JDK或OpenJDK HotSpot）。', severity: 'high' },
                    { pattern: 'The directories below appear to be extracted jar files', reason: 'Mod文件被解压', solution: '检测到Mod文件被解压到mods文件夹中。请删除解压后的文件夹，直接放入.jar文件。', severity: 'medium' },
                    { pattern: 'LoaderExceptionModCrash', reason: 'Mod导致崩溃', solution: '某个Mod导致了游戏崩溃。请查看详细信息中的Mod名称，尝试删除或更新该Mod。', severity: 'medium', modExtract: /Caught exception from (\S+)/ },
                    { pattern: 'Caught exception from ', reason: 'Mod导致崩溃', solution: '某个Mod导致了游戏崩溃。请查看详细信息中的Mod名称，尝试删除或更新该Mod。', severity: 'medium', modExtract: /Caught exception from (\S+)/ },
                    { pattern: 'Found duplicate mods', reason: 'Mod重复安装', solution: '检测到重复安装的Mod。请检查mods文件夹，删除重复的Mod文件。', severity: 'medium' },
                    { pattern: 'DuplicateModsFoundException', reason: 'Mod重复安装', solution: '检测到重复安装的Mod。请检查mods文件夹，删除重复的Mod文件。', severity: 'medium' },
                    { pattern: 'Incompatible mods found', reason: 'Mod互不兼容', solution: '检测到互不兼容的Mod。请查看详细信息，删除冲突的Mod之一。', severity: 'medium' },
                    { pattern: 'Shaders Mod detected. Please remove it', reason: 'ShadersMod与OptiFine冲突', solution: 'ShadersMod与OptiFine冲突。OptiFine已内置光影支持，请删除ShadersMod。', severity: 'medium' },
                    { pattern: '1282: Invalid operation', reason: '光影或资源包导致OpenGL错误', solution: '光影或资源包导致了OpenGL错误。请尝试移除当前光影或更换低分辨率资源包。', severity: 'medium' },
                    { pattern: 'Maybe try a lower resolution resourcepack', reason: '材质过大', solution: '当前使用的资源包分辨率过高，导致内存不足。请尝试使用更低分辨率的资源包。', severity: 'medium' },
                    { pattern: 'Out of Memory Error', reason: '内存不足', solution: 'JVM层面内存不足。建议增加分配内存或减少模组数量。', severity: 'high' },
                    { pattern: 'The system is out of physical RAM', reason: '内存不足', solution: '系统物理内存不足。建议关闭其他程序释放内存，或增加分配的内存。', severity: 'high' },
                    { pattern: 'Cannot find launch target fmlclient', reason: 'Forge安装不完整', solution: 'Forge安装不完整，缺少必要的启动文件。请重新安装Forge。', severity: 'high' },
                    { pattern: 'Missing or unsupported mandatory dependencies', reason: 'Mod缺少前置', solution: '某些Mod缺少必要的前置Mod。请查看详细信息，安装缺少的前置Mod。', severity: 'medium' },
                ];

                let result = { found: false };
                for (const rule of crashRules) {
                    if (allLog.includes(rule.pattern)) {
                        let modName = null;
                        if (rule.modExtract) {
                            const match = allLog.match(rule.modExtract);
                            if (match) modName = match[1];
                        }
                        result = {
                            found: true,
                            reason: rule.reason,
                            solution: rule.solution,
                            modName: modName,
                            logFile: logFile,
                            severity: rule.severity
                        };
                        break;
                    }
                }

                if (!result.found) {
                    const { CrashAnalyzer } = require('../../../crashAnalyzer');
                    try {
                        const analyzer = new CrashAnalyzer(null, caVersionDir);
                        await analyzer.collect(caCleanId, []);
                        if (analyzer.analyzeRawFiles.length > 0) {
                            analyzer.prepare();
                            analyzer.analyze();
                            if (analyzer.crashReasons.size > 0) {
                                const [reason, additional] = analyzer.crashReasons.entries().next().value;
                                const detail = analyzer.getAnalyzeResult(false);
                                result = {
                                    found: true,
                                    reason: reason,
                                    solution: detail || '',
                                    modName: additional && additional.length > 0 ? additional.join(', ') : null,
                                    logFile: logFile,
                                    severity: 'medium'
                                };
                            }
                        }
                    } catch (e) {
                        console.error('[CrashAnalyze] CrashAnalyzer fallback failed:', e.message);
                    }
                }

                sendJSON(res, result);
            } catch (e) {
                sendError(res, '崩溃分析失败: ' + e.message);
            }
        });

        // ====================================================================
        // /api/game/play-time
        // ====================================================================
        registerRoute('GET', '/api/game/play-time', async (req, res, parsedUrl) => {
            const ptVersionId = parsedUrl.query.versionId;
            if (!ptVersionId) { sendError(res, 'Missing versionId', 400); return; }

            try {
                const ptSettings = versions.loadSettingsCached();
                let ptVersionDir = null;
                const ptCleanId = ptVersionId.replace(/ \[外部\d*\]/, '');
                const ptExtFolders = versions.loadExternalFolders();
                for (const folder of ptExtFolders) {
                    if (!fs.existsSync(folder.path)) continue;
                    const extVers = versions.scanExternalFolder(folder.path);
                    if (extVers.some(v => v.id === ptCleanId)) {
                        ptVersionDir = path.join(folder.path, ptCleanId);
                        break;
                    }
                }
                if (!ptVersionDir) {
                    ptVersionDir = path.join(ctx.dirs.VERSIONS_DIR, ptCleanId);
                }

                const worlds = [];
                const savesDir = path.join(ptVersionDir, 'saves');
                if (fs.existsSync(savesDir)) {
                    const saves = fs.readdirSync(savesDir).filter(d => {
                        return fs.existsSync(path.join(savesDir, d, 'level.dat'));
                    });
                    for (const save of saves) {
                        try {
                            const levelDat = fs.readFileSync(path.join(savesDir, save, 'level.dat'));
                            const decompressed = zlib.gunzipSync(levelDat);
                            const timeStr = 'Time';
                            for (let i = 0; i < decompressed.length - 20; i++) {
                                if (decompressed[i] === 4 &&
                                    decompressed[i + 1] === 0 && decompressed[i + 2] === 4) {
                                    const name = decompressed.slice(i + 3, i + 7).toString('ascii');
                                    if (name === timeStr) {
                                        const value = decompressed.readBigInt64BE(i + 7);
                                        const totalSeconds = Number(value) / 20;
                                        worlds.push({
                                            worldName: save,
                                            ticks: Number(value),
                                            seconds: totalSeconds,
                                            formatted: utils.formatPlayTime(totalSeconds)
                                        });
                                        break;
                                    }
                                }
                            }
                        } catch (e) {}
                    }
                }

                const playTimePath = path.join(ctx.dirs.DATA_DIR, 'play-time.json');
                let sessionData = {};
                try {
                    if (fs.existsSync(playTimePath)) {
                        sessionData = JSON.parse(fs.readFileSync(playTimePath, 'utf8'));
                    }
                } catch (e) {}

                const versionSession = sessionData[ptVersionId] || {};
                const totalSessionSeconds = versionSession.totalSeconds || 0;
                const lastPlayed = versionSession.lastPlayed || null;
                const playCount = versionSession.playCount || 0;

                sendJSON(res, {
                    worlds,
                    session: {
                        totalSeconds: totalSessionSeconds,
                        formatted: utils.formatPlayTime(totalSessionSeconds),
                        lastPlayed: lastPlayed,
                        playCount: playCount
                    }
                });
            } catch (e) {
                sendError(res, '获取游戏时间失败: ' + e.message);
            }
        });

        // ====================================================================
        // /api/game/log/export
        // ====================================================================
        registerRoute('GET', '/api/game/log/export', async (req, res, parsedUrl) => {
            try {
                const exportVersionId = parsedUrl.query.versionId || '';
                const exportParts = [];
                exportParts.push('='.repeat(60));
                exportParts.push('VersePC 游戏日志导出');
                exportParts.push(`导出时间: ${new Date().toLocaleString()}`);
                exportParts.push(`版本: ${exportVersionId || '未知'}`);
                exportParts.push('='.repeat(60));
                exportParts.push('');

                const settings = versions.loadSettingsCached();
                exportParts.push(`[环境信息]`);
                exportParts.push(`数据目录: ${ctx.dirs.DATA_DIR}`);
                exportParts.push(`JAVA_DIR: ${ctx.dirs.JAVA_DIR}`);
                exportParts.push(`Java路径: ${settings.javaPath || '自动检测'}`);
                if (settings.javaPath && fs.existsSync(settings.javaPath)) {
                    const _pInfo = java.getJavaVersionInfo(settings.javaPath);
                    exportParts.push(`Java路径版本: ${_pInfo.version} (major=${_pInfo.major})`);
                }
                exportParts.push(`JAVA_HOME: ${process.env.JAVA_HOME || '未设置'}`);
                exportParts.push(`最大内存: ${settings.maxMemory || 2048}MB`);
                exportParts.push(`版本隔离: ${settings.versionIsolation ? '是' : '否'}`);
                exportParts.push('');

                exportParts.push(`[Java检测]`);
                try {
                    const _sysJava = java.detectSystemJava();
                    const _bunJava = java.detectBundledJava();
                    exportParts.push(`系统Java: ${_sysJava.length}个`);
                    _sysJava.forEach(j => exportParts.push(`  - ${j.path} (版本=${j.version}, major=${j.majorVersion}, 来源=${j.source})`));
                    exportParts.push(`内置Java: ${_bunJava.length}个`);
                    _bunJava.forEach(j => exportParts.push(`  - ${j.path} (版本=${j.version}, major=${j.majorVersion}, 来源=${j.source})`));
                    if (fs.existsSync(ctx.dirs.JAVA_DIR)) {
                        const _javaDirs = fs.readdirSync(ctx.dirs.JAVA_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
                        exportParts.push(`JAVA_DIR内容: ${_javaDirs.map(d => d.name).join(', ')}`);
                    }
                    const _mcRuntime = path.join(ctx.dirs.MINECRAFT_DIR, 'runtime');
                    if (fs.existsSync(_mcRuntime)) {
                        const _rtDirs = fs.readdirSync(_mcRuntime, { withFileTypes: true }).filter(d => d.isDirectory());
                        exportParts.push(`.minecraft/runtime内容: ${_rtDirs.map(d => d.name).join(', ')}`);
                    }
                } catch (e) {
                    exportParts.push(`Java检测异常: ${e.message}`);
                }
                exportParts.push('');

                if (ctx.sessions.lastGameExitAnalysis) {
                    exportParts.push(`[上次退出分析]`);
                    exportParts.push(`退出码: ${ctx.sessions.lastGameExitAnalysis.code}`);
                    exportParts.push(`原因: ${ctx.sessions.lastGameExitAnalysis.reason}`);
                    exportParts.push(`建议: ${ctx.sessions.lastGameExitAnalysis.suggestion}`);
                    exportParts.push(`是否崩溃: ${ctx.sessions.lastGameExitAnalysis.isCrash ? '是' : '否'}`);
                    if (ctx.sessions.lastGameExitAnalysis.versionId) exportParts.push(`版本ID: ${ctx.sessions.lastGameExitAnalysis.versionId}`);
                    exportParts.push('');
                }

                if (ctx.sessions.gameLogBuffer.length > 0) {
                    exportParts.push(`[游戏日志] (最近 ${Math.min(ctx.sessions.gameLogBuffer.length, 2000)} 行)`);
                    exportParts.push('-'.repeat(40));
                    const exportLogs = ctx.sessions.gameLogBuffer.slice(-2000);
                    exportParts.push(...exportLogs);
                    exportParts.push('');
                }

                if (exportVersionId) {
                    const crashReportsDir = versions.getVersionSubDir(exportVersionId, 'crash-reports');
                    if (crashReportsDir && fs.existsSync(crashReportsDir)) {
                        const crashFiles = fs.readdirSync(crashReportsDir)
                            .filter(f => f.startsWith('crash-') && f.endsWith('.txt'))
                            .sort().reverse();
                        if (crashFiles.length > 0) {
                            try {
                                const crashContent = fs.readFileSync(path.join(crashReportsDir, crashFiles[0]), 'utf8');
                                exportParts.push(`[最新崩溃报告] ${crashFiles[0]}`);
                                exportParts.push('-'.repeat(40));
                                exportParts.push(crashContent.substring(0, 5000));
                                if (crashContent.length > 5000) exportParts.push(`... (已截断，共${crashContent.length}字符)`);
                                exportParts.push('');
                            } catch (_) {}
                        }
                    }

                    const logsDir = versions.getVersionSubDir(exportVersionId, 'logs');
                    const latestLogPath = path.join(logsDir, 'latest.log');
                    if (fs.existsSync(latestLogPath)) {
                        try {
                            const logContent = fs.readFileSync(latestLogPath, 'utf8');
                            exportParts.push(`[latest.log] (最后 2000 行)`);
                            exportParts.push('-'.repeat(40));
                            const logLines = logContent.split('\n');
                            exportParts.push(...logLines.slice(-2000));
                            exportParts.push('');
                        } catch (_) {}
                    }
                }

                const exportContent = exportParts.join('\n');
                const exportFileName = `VersePC_Log_${new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)}.txt`;
                const exportPath = path.join(ctx.dirs.DATA_DIR, 'temp', exportFileName);
                if (!fs.existsSync(path.dirname(exportPath))) fs.mkdirSync(path.dirname(exportPath), { recursive: true });
                fs.writeFileSync(exportPath, exportContent, 'utf8');

                res.writeHead(200, {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Content-Disposition': `attachment; filename="${encodeURIComponent(exportFileName)}"`,
                    'Content-Length': Buffer.byteLength(exportContent, 'utf8')
                });
                res.end(exportContent);
                try { fs.unlinkSync(exportPath); } catch (_) {}
            } catch (exportErr) {
                sendError(res, '导出日志失败: ' + exportErr.message, 500);
            }
        });

        // ====================================================================
        // /api/game/log/save-export
        // ====================================================================
        registerRoute('GET', '/api/game/log/save-export', async (req, res, parsedUrl) => {
            try {
                const seVersionId = parsedUrl.query.versionId || '';
                const seParts = [];
                seParts.push('='.repeat(60));
                seParts.push('VersePC 游戏日志导出');
                seParts.push(`导出时间: ${new Date().toLocaleString()}`);
                seParts.push(`版本: ${seVersionId || '未知'}`);
                seParts.push('='.repeat(60));
                seParts.push('');

                const seSettings = versions.loadSettingsCached();
                seParts.push(`[环境信息]`);
                seParts.push(`数据目录: ${ctx.dirs.DATA_DIR}`);
                seParts.push(`Java路径: ${seSettings.javaPath || '自动检测'}`);
                seParts.push(`最大内存: ${seSettings.maxMemory || 2048}MB`);
                seParts.push(`版本隔离: ${seSettings.versionIsolation ? '是' : '否'}`);
                seParts.push('');

                if (ctx.sessions.lastGameExitAnalysis) {
                    seParts.push(`[上次退出分析]`);
                    seParts.push(`退出码: ${ctx.sessions.lastGameExitAnalysis.code}`);
                    seParts.push(`原因: ${ctx.sessions.lastGameExitAnalysis.reason}`);
                    seParts.push(`建议: ${ctx.sessions.lastGameExitAnalysis.suggestion}`);
                    seParts.push(`是否崩溃: ${ctx.sessions.lastGameExitAnalysis.isCrash ? '是' : '否'}`);
                    if (ctx.sessions.lastGameExitAnalysis.versionId) seParts.push(`版本ID: ${ctx.sessions.lastGameExitAnalysis.versionId}`);
                    seParts.push('');
                }

                if (ctx.sessions.gameLogBuffer.length > 0) {
                    seParts.push(`[游戏日志] (最近 ${Math.min(ctx.sessions.gameLogBuffer.length, 2000)} 行)`);
                    seParts.push('-'.repeat(40));
                    seParts.push(...ctx.sessions.gameLogBuffer.slice(-2000));
                    seParts.push('');
                }

                if (seVersionId) {
                    const seCrashDir = versions.getVersionSubDir(seVersionId, 'crash-reports');
                    if (seCrashDir && fs.existsSync(seCrashDir)) {
                        const seCrashFiles = fs.readdirSync(seCrashDir)
                            .filter(f => f.startsWith('crash-') && f.endsWith('.txt'))
                            .sort().reverse();
                        if (seCrashFiles.length > 0) {
                            try {
                                const seCrashContent = fs.readFileSync(path.join(seCrashDir, seCrashFiles[0]), 'utf8');
                                seParts.push(`[最新崩溃报告] ${seCrashFiles[0]}`);
                                seParts.push('-'.repeat(40));
                                seParts.push(seCrashContent.substring(0, 5000));
                                if (seCrashContent.length > 5000) seParts.push(`... (已截断，共${seCrashContent.length}字符)`);
                                seParts.push('');
                            } catch (_) {}
                        }
                    }

                    const seLogsDir = versions.getVersionSubDir(seVersionId, 'logs');
                    const seLatestLog = path.join(seLogsDir, 'latest.log');
                    if (fs.existsSync(seLatestLog)) {
                        try {
                            const seLogContent = fs.readFileSync(seLatestLog, 'utf8');
                            seParts.push(`[latest.log] (最后 2000 行)`);
                            seParts.push('-'.repeat(40));
                            seParts.push(...seLogContent.split('\n').slice(-2000));
                            seParts.push('');
                        } catch (_) {}
                    }
                }

                const seContent = seParts.join('\n');
                const seFileName = `VersePC_Log_${new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)}.txt`;
                const seTempDir = path.join(ctx.dirs.DATA_DIR, 'temp');
                if (!fs.existsSync(seTempDir)) fs.mkdirSync(seTempDir, { recursive: true });
                const seFilePath = path.join(seTempDir, seFileName);
                fs.writeFileSync(seFilePath, seContent, 'utf8');

                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: true, filePath: seFilePath, fileName: seFileName }));
            } catch (seErr) {
                sendError(res, '保存日志失败: ' + seErr.message, 500);
            }
        });
    }
};
