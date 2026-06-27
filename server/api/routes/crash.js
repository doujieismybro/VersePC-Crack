/**
 * server/api/routes/crash.js - 崩溃日志路由
 * ============================================================================
 * 从 server.js handleAPI switch 语句抽取的崩溃日志相关端点。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

module.exports = {
    register(registerRoute, deps) {
        const { ctx, sendJSON, sendError, readBody } = deps;

        const DATA_DIR = ctx.dirs.DATA_DIR;
        const VERSIONS_DIR = ctx.dirs.VERSIONS_DIR;
        const MINECRAFT_DIR = ctx.dirs.MINECRAFT_DIR;

        // ====================================================================
        // /api/crash/analyze
        // ====================================================================
        registerRoute('*', '/api/crash/analyze', async (req, res, parsedUrl) => {
            if (req.method === 'POST') {
                const data = await readBody(req);
                const { CrashAnalyzer } = require('../../../crashAnalyzer');

                try {
                    const mcDir = data.minecraftDir || MINECRAFT_DIR;
                    const analyzer = new CrashAnalyzer(null, mcDir);

                    if (data.filePath) {
                        await analyzer.importFile(data.filePath);
                    } else {
                        await analyzer.collect(data.versionPath || '', data.latestLog);
                    }

                    if (analyzer.analyzeRawFiles.length === 0) {
                        sendJSON(res, {
                            success: false,
                            error: '未找到任何日志文件。请确认 Minecraft 目录下存在 crash-reports 或 logs 文件夹，或手动导入日志文件。'
                        });
                        return;
                    }

                    const prepared = analyzer.prepare();
                    if (!prepared) {
                        sendJSON(res, {
                            success: false,
                            error: '未能从日志文件中提取有效信息。请确认日志文件内容完整。'
                        });
                        return;
                    }

                    analyzer.analyze();
                    const result = await analyzer.output(false);

                    sendJSON(res, {
                        success: true,
                        result
                    });
                } catch (e) {
                    console.error('[Crash] 分析崩溃失败:', e);
                    sendJSON(res, {
                        success: false,
                        error: '分析崩溃失败: ' + e.message
                    });
                }
            } else {
                sendError(res, 'Method not allowed', 405);
            }
        });

        // ====================================================================
        // /api/crash/logs
        // ====================================================================
        registerRoute('GET', '/api/crash/logs', async (req, res, parsedUrl) => {
            try {
                const mcDir = parsedUrl.query.minecraftDir || MINECRAFT_DIR;
                const crashLogs = [];

                const crashReportsDir = path.join(mcDir, 'crash-reports');
                if (fs.existsSync(crashReportsDir)) {
                    const files = fs.readdirSync(crashReportsDir)
                        .filter(f => f.startsWith('crash-') && f.endsWith('.txt'))
                        .map(f => ({
                            name: f,
                            path: path.join(crashReportsDir, f),
                            time: fs.statSync(path.join(crashReportsDir, f)).mtime.getTime()
                        }))
                        .sort((a, b) => b.time - a.time);
                    crashLogs.push(...files);
                }

                const logsDir = path.join(mcDir, 'logs');
                if (fs.existsSync(logsDir)) {
                    const logFiles = ['latest.log', 'debug.log'];
                    for (const logFile of logFiles) {
                        const logPath = path.join(logsDir, logFile);
                        if (fs.existsSync(logPath)) {
                            crashLogs.push({
                                name: logFile,
                                path: logPath,
                                time: fs.statSync(logPath).mtime.getTime()
                            });
                        }
                    }
                }

                try {
                    const mcFiles = fs.readdirSync(mcDir);
                    for (const file of mcFiles) {
                        if (file.startsWith('hs_err_pid') && file.endsWith('.log')) {
                            crashLogs.push({
                                name: file,
                                path: path.join(mcDir, file),
                                time: fs.statSync(path.join(mcDir, file)).mtime.getTime()
                            });
                        }
                    }
                } catch (ex) {}

                const versionPath = parsedUrl.query.version;
                if (versionPath) {
                    const versionDir = path.join(mcDir, 'versions', versionPath);
                    if (fs.existsSync(versionDir)) {
                        const versionLogs = fs.readdirSync(versionDir)
                            .filter(f => f.endsWith('.log'))
                            .map(f => ({
                                name: f,
                                path: path.join(versionDir, f),
                                time: fs.statSync(path.join(versionDir, f)).mtime.getTime()
                            }));
                        crashLogs.push(...versionLogs);
                    }
                }

                sendJSON(res, {
                    success: true,
                    logs: crashLogs.sort((a, b) => b.time - a.time)
                });
            } catch (e) {
                console.error('[Crash] 获取崩溃日志列表失败:', e);
                sendJSON(res, {
                    success: false,
                    error: '获取崩溃日志列表失败: ' + e.message,
                    logs: []
                });
            }
        });

        // ====================================================================
        // /api/crash/log-content
        // ====================================================================
        registerRoute('GET', '/api/crash/log-content', async (req, res, parsedUrl) => {
            const logPath = parsedUrl.query.path;
            if (!logPath) {
                sendError(res, 'Missing path parameter', 400);
                return;
            }

            const resolvedLogPath = path.resolve(logPath);
            const allowedLogBases = [DATA_DIR, path.join(os.homedir(), '.minecraft'), ...Object.values(VERSIONS_DIR)].map(d => path.resolve(d));
            const isLogPathAllowed = allowedLogBases.some(base => resolvedLogPath.toLowerCase().startsWith(base.toLowerCase()));
            if (!isLogPathAllowed) {
                sendError(res, 'Forbidden', 403);
                return;
            }

            try {
                if (!fs.existsSync(logPath)) {
                    sendError(res, 'Log file not found', 404);
                    return;
                }

                const content = fs.readFileSync(logPath, 'utf8');
                const stat = fs.statSync(logPath);

                sendJSON(res, {
                    success: true,
                    content,
                    size: stat.size,
                    modified: stat.mtime
                });
            } catch (e) {
                console.error('[Crash] 读取日志文件失败:', e);
                sendError(res, '读取日志文件失败: ' + e.message);
            }
        });

        // ====================================================================
        // /api/crash/export
        // ====================================================================
        registerRoute('*', '/api/crash/export', async (req, res, parsedUrl) => {
            if (req.method === 'POST') {
                const data = await readBody(req);
                const { files, analysis } = data;

                try {
                    const exportDir = path.join(MINECRAFT_DIR, 'crash-exports');
                    if (!fs.existsSync(exportDir)) {
                        fs.mkdirSync(exportDir, { recursive: true });
                    }

                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const exportFile = path.join(exportDir, `crash-report-${timestamp}.txt`);

                    let exportContent = '=== VersePC 崩溃报告 ===\n';
                    exportContent += `导出时间: ${new Date().toLocaleString()}\n\n`;

                    if (analysis) {
                        exportContent += '=== 崩溃分析结果 ===\n';
                        exportContent += analysis + '\n\n';
                    }

                    if (files && files.length > 0) {
                        const allowedExportBases = [DATA_DIR, ...Object.values(VERSIONS_DIR)].map(d => path.resolve(d));
                        exportContent += '=== 相关日志文件 ===\n';
                        for (const file of files) {
                            const resolvedFile = path.resolve(file);
                            if (!allowedExportBases.some(base => resolvedFile.toLowerCase().startsWith(base.toLowerCase()))) continue;
                            if (fs.existsSync(file)) {
                                exportContent += `\n--- ${path.basename(file)} ---\n`;
                                exportContent += fs.readFileSync(file, 'utf8') + '\n';
                            }
                        }
                    }

                    fs.writeFileSync(exportFile, exportContent, 'utf8');

                    sendJSON(res, {
                        success: true,
                        path: exportFile
                    });
                } catch (e) {
                    console.error('[Crash] 导出崩溃报告失败:', e);
                    sendError(res, '导出崩溃报告失败: ' + e.message);
                }
            } else {
                sendError(res, 'Method not allowed', 405);
            }
        });
    }
};
