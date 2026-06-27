/**
 * server/api/routes/settings.js - 设置路由
 * ============================================================================
 * 从 server.js handleAPI switch 语句抽取的设置相关端点。
 */

const fs = require('fs');
const path = require('path');

module.exports = {
    register(registerRoute, deps) {
        const { ctx, sendJSON, sendError, readBody } = deps;
        const { accounts, versions } = deps;

        const DATA_DIR = ctx.dirs.DATA_DIR;
        const VERSIONS_DIR = ctx.dirs.VERSIONS_DIR;
        const DATA_DIR_CONFIG_FILE = ctx.dirs.DATA_DIR_CONFIG_FILE;

        // ====================================================================
        // /api/settings
        // ====================================================================
        registerRoute('*', '/api/settings', async (req, res, parsedUrl) => {
            if (req.method === 'POST') {
                const data = await readBody(req);
                const current = accounts.loadSettingsCached();
                const updated = { ...current, ...data };
                console.log(`[设置] 保存设置: maxThreads=${updated.maxThreads}`);
                accounts.saveSettings(updated);
                sendJSON(res, { success: true, settings: updated });
            } else {
                sendJSON(res, accounts.loadSettingsCached());
            }
        });

        // ====================================================================
        // /api/settings/set
        // ====================================================================
        registerRoute('*', '/api/settings/set', async (req, res, parsedUrl) => {
            if (req.method === 'POST') {
                const data = await readBody(req);
                const current = accounts.loadSettingsCached();
                current[data.key] = data.value;
                accounts.saveSettings(current);
                sendJSON(res, { success: true });
            } else {
                sendError(res, 'Method not allowed', 405);
            }
        });

        // ====================================================================
        // /api/settings/reset
        // ====================================================================
        registerRoute('*', '/api/settings/reset', async (req, res, parsedUrl) => {
            if (req.method === 'POST') {
                try {
                    const defaults = {
                        javaPath: '',
                        maxMemory: 4096,
                        minMemory: 1024,
                        gameDir: DATA_DIR,
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
                        maxThreads: 64,
                        enableChunkDownload: true,
                        maxChunksPerFile: 64,
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
                        autoSetChinese: true
                    };
                    accounts.saveSettings(defaults);
                    console.log('[设置] 已重置为默认值');
                    sendJSON(res, { success: true, settings: defaults });
                } catch (e) {
                    console.error('[设置] 重置失败:', e);
                    sendJSON(res, { success: false, error: e.message });
                }
            } else {
                sendError(res, 'Method not allowed', 405);
            }
        });

        // ====================================================================
        // /api/settings/data-dir
        // ====================================================================
        registerRoute('*', '/api/settings/data-dir', async (req, res, parsedUrl) => {
            if (req.method === 'POST') {
                try {
                    const { dataDir, reset } = await readBody(req);
                    if (reset) {
                        try { fs.unlinkSync(DATA_DIR_CONFIG_FILE); } catch (e) {}
                        sendJSON(res, { ok: true, message: '已重置为默认目录，重启后生效' });
                        return;
                    }
                    if (!dataDir || typeof dataDir !== 'string') {
                        sendJSON(res, { error: '请提供有效的目录路径' }, 400);
                        return;
                    }
                    const resolvedPath = path.resolve(dataDir);
                    const oldVersionsDir = VERSIONS_DIR;

                    fs.mkdirSync(resolvedPath, { recursive: true });
                    fs.writeFileSync(DATA_DIR_CONFIG_FILE, JSON.stringify({ dataDir: resolvedPath }, null, 2));

                    try {
                        if (fs.existsSync(oldVersionsDir)) {
                            const entries = fs.readdirSync(oldVersionsDir).filter(e => {
                                try { return fs.statSync(path.join(oldVersionsDir, e)).isDirectory(); } catch (_) { return false; }
                            });
                            if (entries.length > 0) {
                                const folders = versions.loadExternalFolders();
                                const alreadyRegistered = folders.some(f => path.resolve(f.path) === path.resolve(path.dirname(oldVersionsDir)));
                                if (!alreadyRegistered) {
                                    folders.push({ name: path.basename(path.dirname(oldVersionsDir)), path: path.dirname(oldVersionsDir) });
                                    versions.saveExternalFolders(folders);
                                }
                            }
                        }
                    } catch (e) {}

                    sendJSON(res, { ok: true, dataDir: resolvedPath, message: '数据目录已修改，重启后生效' });
                } catch (e) {
                    sendJSON(res, { error: '保存失败: ' + e.message }, 500);
                }
            } else {
                sendJSON(res, { dataDir: DATA_DIR, isDefault: !fs.existsSync(DATA_DIR_CONFIG_FILE) });
            }
        });
    }
};
