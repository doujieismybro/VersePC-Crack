/**
 * server/api/routes/authlib.js - authlib-injector 路由
 * ============================================================================
 * 从 server.js handleAPI switch 语句抽取的 authlib-injector 信息查询与下载端点。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = {
    register(registerRoute, deps) {
        const { ctx, sendJSON, sendError } = deps;
        const { http } = deps;

        const DATA_DIR = ctx.dirs.DATA_DIR;

        // ====================================================================
        // /api/authlib-injector/info
        // ====================================================================
        registerRoute('GET', '/api/authlib-injector/info', async (req, res, parsedUrl) => {
            const aiInfoServerUrl = parsedUrl.query.serverUrl || '';
            if (aiInfoServerUrl && !aiInfoServerUrl.startsWith('https://')) {
                sendJSON(res, { success: false, error: '第三方登录服务器必须使用 HTTPS 协议' }, 400);
                return;
            }
            try {
                const aiData = await http.fetchJSON('https://authlib-injector.yushi.moe/artifact/latest.json');
                sendJSON(res, {
                    version: aiData.version || 'unknown',
                    downloadUrl: aiData.download_url || '',
                    size: aiData.size || 0
                });
            } catch (e) {
                sendError(res, '获取authlib-injector信息失败');
            }
        });

        // ====================================================================
        // /api/authlib-injector/download
        // ====================================================================
        registerRoute('GET', '/api/authlib-injector/download', async (req, res, parsedUrl) => {
            const aiInfoServerUrl2 = parsedUrl.query.serverUrl || '';
            if (aiInfoServerUrl2 && !aiInfoServerUrl2.startsWith('https://')) {
                sendJSON(res, { success: false, error: '第三方登录服务器必须使用 HTTPS 协议' }, 400);
                return;
            }
            const aiDir = path.join(DATA_DIR, 'authlib-injector');
            if (!fs.existsSync(aiDir)) fs.mkdirSync(aiDir, { recursive: true });
            try {
                const aiData2 = await http.fetchJSON('https://authlib-injector.yushi.moe/artifact/latest.json');
                const aiUrl = aiData2.download_url;
                const aiPath = path.join(aiDir, `authlib-injector-${aiData2.version}.jar`);
                if (!fs.existsSync(aiPath)) {
                    await http.downloadFile(aiUrl, aiPath);
                    const fileBuffer = fs.readFileSync(aiPath);
                    const actualHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
                    // TODO: 替换为 authlib-injector 已知版本的 SHA256 哈希值
                    const KNOWN_HASHES = {
                    };
                    const expectedHash = KNOWN_HASHES[aiData2.version];
                    if (expectedHash && actualHash !== expectedHash) {
                        fs.unlinkSync(aiPath);
                        sendError(res, 'authlib-injector SHA256 校验失败，文件可能被篡改');
                        return;
                    }
                    if (aiData2.checksums && aiData2.checksums.sha256) {
                        if (actualHash !== aiData2.checksums.sha256) {
                            fs.unlinkSync(aiPath);
                            sendError(res, 'authlib-injector 文件校验失败，请重试');
                            return;
                        }
                    }
                }
                sendJSON(res, { success: true, path: aiPath, version: aiData2.version });
            } catch (e) {
                sendError(res, '下载authlib-injector失败: ' + e.message);
            }
        });
    }
};
