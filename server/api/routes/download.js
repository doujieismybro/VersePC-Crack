/**
 * server/api/routes/download.js - 自定义下载路由
 * ============================================================================
 * 从 server.js handleAPI switch 语句抽取的自定义文件下载端点。
 */

const fs = require('fs');
const path = require('path');

module.exports = {
    register(registerRoute, deps) {
        const { ctx, sendJSON, sendError, readBody } = deps;
        const { http } = deps;

        const customDownloadSessions = ctx.sessions.customDownloadSessions;

        // ====================================================================
        // /api/download-custom
        // ====================================================================
        registerRoute('POST', '/api/download-custom', async (req, res, parsedUrl) => {
            const dcBody = await readBody(req);
            const dcUrl = dcBody.url || '';
            const dcSavePath = dcBody.savePath || '';
            const dcFileName = dcBody.fileName || '';
            if (!dcUrl) { sendError(res, '请输入下载地址', 400); return; }
            if (!dcSavePath) { sendError(res, '请选择保存位置', 400); return; }

            const dcFinalName = dcFileName || path.basename(new URL(dcUrl).pathname) || 'download';
            const dcDestDir = dcSavePath;
            if (!fs.existsSync(dcDestDir)) fs.mkdirSync(dcDestDir, { recursive: true });
            const dcDestPath = path.join(dcDestDir, dcFinalName);

            const dcSessionId = `custom-${Date.now()}`;
            const dcAbort = new AbortController();
            customDownloadSessions.set(dcSessionId, {
                status: 'downloading', progress: 0, message: '准备下载...',
                fileName: dcFinalName, totalSize: 0, downloaded: 0, abortController: dcAbort
            });

            sendJSON(res, { success: true, sessionId: dcSessionId, destPath: dcDestPath });

            (async () => {
                try {
                    await http.downloadFile(dcUrl, dcDestPath, (p) => {
                        const s = customDownloadSessions.get(dcSessionId);
                        if (s) {
                            s.progress = Math.round(p.progress);
                            s.downloaded = p.bytesDownloaded || 0;
                            s.totalSize = p.totalBytes || 0;
                            s.message = `下载中 ${p.progress.toFixed(0)}%`;
                        }
                    }, 3, dcAbort.signal);

                    const s = customDownloadSessions.get(dcSessionId);
                    if (s) {
                        s.status = 'completed';
                        s.progress = 100;
                        s.message = `${dcFinalName} 下载完成！`;
                    }
                } catch (e) {
                    const s = customDownloadSessions.get(dcSessionId);
                    if (s) {
                        s.status = e.name === 'AbortError' ? 'cancelled' : 'failed';
                        s.message = e.name === 'AbortError' ? '下载已取消' : `下载失败: ${e.message}`;
                    }
                }
            })();
        });

        // ====================================================================
        // /api/download-custom/status
        // ====================================================================
        registerRoute('GET', '/api/download-custom/status', async (req, res, parsedUrl) => {
            const dcsId = parsedUrl.query.sessionId;
            if (!dcsId || !customDownloadSessions.has(dcsId)) { sendJSON(res, { status: 'not_found' }); return; }
            const dcs = customDownloadSessions.get(dcsId);
            sendJSON(res, { status: dcs.status, progress: dcs.progress, message: dcs.message, fileName: dcs.fileName, totalSize: dcs.totalSize, downloaded: dcs.downloaded });
        });

        // ====================================================================
        // /api/download-custom/cancel
        // ====================================================================
        registerRoute('POST', '/api/download-custom/cancel', async (req, res, parsedUrl) => {
            const dccBody = await readBody(req);
            const dccId = dccBody.sessionId;
            if (dccId && customDownloadSessions.has(dccId)) {
                const dcc = customDownloadSessions.get(dccId);
                if (dcc.abortController) dcc.abortController.abort();
                dcc.status = 'cancelled';
                dcc.message = '下载已取消';
                sendJSON(res, { success: true });
            } else {
                sendError(res, 'Invalid session', 404);
            }
        });
    }
};
