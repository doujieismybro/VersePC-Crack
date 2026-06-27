/**
 * server/api/routes/launch.js - 启动相关路由
 * ============================================================================
 * 从 server.js handleAPI switch 语句抽取的启动相关端点。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

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
        // /api/launch
        // ====================================================================
        registerRoute('POST', '/api/launch', async (req, res, parsedUrl) => {
            if (global._versepc_launching) {
                sendJSON(res, { success: false, error: '正在启动中，请稍候' });
                return;
            }
            global._versepc_launching = true;
            setTimeout(() => { global._versepc_launching = false; }, 30000);

            const data = await readBody(req);
            const versionId = data.versionId;
            if (!versionId) { sendError(res, 'Missing versionId', 400); global._versepc_launching = false; return; }
            const settings = versions.loadSettingsCached();

            try {
                const storePath = path.join(ctx.dirs.DATA_DIR, 'app-store.json');
                if (fs.existsSync(storePath)) {
                    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
                    const launchStr = store['versepc_launch_settings'];
                    if (launchStr) {
                        const lsData = JSON.parse(launchStr);
                        if (lsData.windowSize) {
                            if (lsData.windowSize === 'default') {
                                settings.resolution = '854x480';
                            } else {
                                settings.resolution = lsData.windowSize;
                            }
                            console.log(`[Launch] 使用启动设置窗口大小: ${settings.resolution}`);
                        }
                        if (typeof lsData.fullscreen === 'boolean') {
                            settings.fullscreen = lsData.fullscreen;
                            console.log(`[Launch] 使用启动设置全屏模式: ${settings.fullscreen}`);
                        }
                        if (lsData.customInfo) {
                            settings.customInfo = lsData.customInfo;
                            console.log(`[Launch] 使用启动设置自定义信息: ${settings.customInfo}`);
                        }
                        if (lsData.windowTitle) {
                            settings.windowTitle = lsData.windowTitle;
                            console.log(`[Launch] 使用启动设置窗口标题: ${settings.windowTitle}`);
                        }
                    }
                }
            } catch (e) {
                console.log(`[Launch] 读取启动设置失败，使用全局设置: ${e.message}`);
            }

            try {
                const verSettings = versions.loadVersionSettings(versionId);
                if (verSettings.customInfo) {
                    settings.customInfo = verSettings.customInfo;
                    console.log(`[Launch] 使用版本设置自定义信息: ${settings.customInfo}`);
                }
                if (verSettings.windowTitle) {
                    settings.windowTitle = verSettings.windowTitle;
                    console.log(`[Launch] 使用版本设置窗口标题: ${settings.windowTitle}`);
                }
                if (verSettings.fullscreen && verSettings.fullscreen !== 'global') {
                    settings.fullscreen = verSettings.fullscreen === true || verSettings.fullscreen === 'true';
                    console.log(`[Launch] 使用版本设置全屏模式: ${settings.fullscreen}`);
                }
                if (verSettings.resolution && verSettings.resolution !== '') {
                    settings.resolution = verSettings.resolution;
                    console.log(`[Launch] 使用版本设置分辨率: ${settings.resolution}`);
                }
            } catch (e) {
                console.log(`[Launch] 读取版本设置失败: ${e.message}`);
            }

            const acctsList = accounts.loadAccounts();
            if (acctsList.length === 0) {
                sendJSON(res, { success: false, error: '未登录，请先添加账户后再启动游戏。' });
                global._versepc_launching = false;
                return;
            }
            let account = acctsList.find(a => a.id === settings.selectedAccount) || acctsList[0];

            if (account.type === 'microsoft' && account.refreshToken) {
                const tokenExpiresAt = account.tokenExpiresAt || 0;
                const now = Date.now();
                const shouldRefresh = !tokenExpiresAt || now > tokenExpiresAt - 5 * 60 * 1000;
                if (shouldRefresh) {
                    console.log(`[Launch] 微软账号Token即将过期或已过期，尝试刷新...`);
                    try {
                        const tokenUrl = `https://login.microsoftonline.com/consumers/oauth2/v2.0/token`;
                        const postData = `grant_type=refresh_token&client_id=${ctx.urls.MS_CLIENT_ID}&refresh_token=${encodeURIComponent(account.refreshToken)}&scope=XboxLive.signin+offline_access`;
                        const msTokenResult = await new Promise((resolve, reject) => {
                            const req = https.request(tokenUrl, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) },
                                timeout: 15000
                            }, (res) => {
                                let data = '';
                                res.on('data', chunk => data += chunk);
                                res.on('end', () => {
                                    if (res.statusCode >= 400) {
                                        try { const errBody = JSON.parse(data); resolve(errBody); } catch (e) { resolve({ error: `HTTP ${res.statusCode}` }); }
                                        return;
                                    }
                                    try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('微软服务返回了无效的数据')); }
                                });
                            });
                            req.on('error', (e) => reject(new Error('网络连接失败: ' + e.message)));
                            req.on('timeout', () => { req.destroy(); reject(new Error('连接微软服务超时')); });
                            req.write(postData);
                            req.end();
                        });
                        if (!msTokenResult.error && msTokenResult.access_token) {
                            const msAccessToken = msTokenResult.access_token;
                            const msRefreshTokenNew = msTokenResult.refresh_token || account.refreshToken;
                            const xblResult = await http.fetchJSONWithMethod('https://user.auth.xboxlive.com/user/authenticate', 'POST', JSON.stringify({
                                Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
                                RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT'
                            }), { 'Content-Type': 'application/json' });
                            const xblToken = xblResult.Token;
                            const xblUhs = xblResult.DisplayClaims?.xui?.[0]?.uhs || '';
                            const xstsResult = await http.fetchJSONWithMethod('https://xsts.auth.xboxlive.com/xsts/authorize', 'POST', JSON.stringify({
                                Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
                                RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT'
                            }), { 'Content-Type': 'application/json' });
                            if (!xstsResult.XErr) {
                                const xstsToken = xstsResult.Token;
                                const xstsUhs = xstsResult.DisplayClaims?.xui?.[0]?.uhs || xblUhs;
                                const mcResult = await http.fetchJSONWithMethod('https://api.minecraftservices.com/authentication/login_with_xbox', 'POST', JSON.stringify({
                                    identityToken: `XBL3.0 x=${xstsUhs};${xstsToken}`
                                }), { 'Content-Type': 'application/json' });
                                if (mcResult.access_token) {
                                    const refreshNow = new Date();
                                    account.accessToken = mcResult.access_token;
                                    account.refreshToken = msRefreshTokenNew;
                                    account.tokenExpiresAt = refreshNow.getTime() + (msTokenResult.expires_in || 3600) * 1000;
                                    account.lastRefreshed = refreshNow.toISOString();
                                    try {
                                        const refreshProfile = await http.fetchJSONWithAuth('https://api.minecraftservices.com/minecraft/profile', mcResult.access_token);
                                        if (refreshProfile && refreshProfile.skins && Array.isArray(refreshProfile.skins)) {
                                            const activeSkin = refreshProfile.skins.find(s => s.state === 'ACTIVE');
                                            if (activeSkin) {
                                                account.skinUrl = activeSkin.url;
                                                account.skinModel = activeSkin.variant === 'SLIM' ? 'slim' : 'default';
                                            }
                                        }
                                        if (refreshProfile && refreshProfile.name) account.username = refreshProfile.name;
                                    } catch (pfErr) { console.warn(`[Launch] 刷新皮肤信息失败: ${pfErr.message}`); }
                                    const accts = accounts.loadAccounts();
                                    const idx = accts.findIndex(a => a.id === account.id);
                                    if (idx >= 0) { accts[idx] = { ...accts[idx], ...account }; accounts.saveAccounts(accts); }
                                    console.log(`[Launch] 微软账号Token刷新成功`);
                                }
                            }
                        } else {
                            console.warn(`[Launch] 微软Token刷新失败: ${msTokenResult.error}, 使用旧Token尝试启动`);
                        }
                    } catch (refreshErr) {
                        console.warn(`[Launch] 微软Token刷新异常: ${refreshErr.message}, 使用旧Token尝试启动`);
                    }
                }
            }

            const result = await launch.launchGame(versionId, settings, account, data.checkOnly === true);
            if (!result.success) {
                try {
                    if (!fs.existsSync(ctx.dirs.LOGS_DIR)) fs.mkdirSync(ctx.dirs.LOGS_DIR, { recursive: true });
                    fs.writeFileSync(path.join(ctx.dirs.LOGS_DIR, `launch-fail-${Date.now()}.json`), JSON.stringify({ versionId, result, timestamp: new Date().toISOString() }, null, 2), 'utf-8');
                } catch (_) {}
            }
            if (result.success) {
                try {
                    const playTimePath = path.join(ctx.dirs.DATA_DIR, 'play-time.json');
                    let ptData = {};
                    if (fs.existsSync(playTimePath)) {
                        try { ptData = JSON.parse(fs.readFileSync(playTimePath, 'utf8')); } catch (e) {}
                    }
                    if (!ptData[versionId]) ptData[versionId] = { totalSeconds: 0, playCount: 0, lastPlayed: null };
                    ptData[versionId].lastPlayed = new Date().toISOString();
                    ptData[versionId].playCount = (ptData[versionId].playCount || 0) + 1;
                    ptData[versionId]._launchTime = Date.now();
                    utils.ensureDir(playTimePath);
                    fs.writeFileSync(playTimePath, JSON.stringify(ptData, null, 2), 'utf8');
                } catch (e) {
                    console.error('[PlayTime] 记录启动时间失败:', e.message);
                }
            }
            global._versepc_launching = false;
            sendJSON(res, result);
        });

        // ====================================================================
        // /api/launch/cancel
        // ====================================================================
        registerRoute('POST', '/api/launch/cancel', async (req, res, parsedUrl) => {
            global._versepc_launching = false;
            for (const [sid, inst] of ctx.sessions.gameInstances) {
                try { inst.process.kill(); } catch (e) {}
            }
            ctx.sessions.gameInstances.clear();
            for (const [sid, sess] of ctx.sessions.launchSessions) {
                sess.status = 'cancelled';
                sess.message = '启动已取消';
            }
            ctx.sessions.launchSessions.clear();
            sendJSON(res, { success: true, message: '启动已取消' });
        });

        // ====================================================================
        // /api/launch/check
        // ====================================================================
        registerRoute('POST', '/api/launch/check', async (req, res, parsedUrl) => {
            const lcData = await readBody(req);
            const lcVersionId = lcData.versionId;
            if (!lcVersionId) { sendError(res, 'Missing versionId', 400); return; }
            const lcSettings = versions.loadSettingsCached();
            const lcCleanId = lcVersionId.replace(/ \[外部\d*\]/, '');
            let lcExternalDir = null;
            const lcExtFolders = versions.loadExternalFolders();
            for (const folder of lcExtFolders) {
                if (!fs.existsSync(folder.path)) continue;
                const extVers = versions.scanExternalFolder(folder.path);
                const extV = extVers.find(v => v.id === lcCleanId);
                if (extV) { lcExternalDir = extV.externalVersionDir; break; }
            }
            const depResult = await dependencies.checkDependencies(lcCleanId, lcSettings, lcExternalDir);
            const _javaDiag = { settingsJavaPath: lcSettings.javaPath || '', settingsJavaExists: !!(lcSettings.javaPath && fs.existsSync(lcSettings.javaPath)) };
            if (lcSettings.javaPath && fs.existsSync(lcSettings.javaPath)) {
                const _info = java.getJavaVersionInfo(lcSettings.javaPath);
                _javaDiag.settingsJavaMajor = _info.major;
            }
            const _sysJava = java.detectSystemJava();
            const _bunJava = java.detectBundledJava();
            _javaDiag.systemJavaCount = _sysJava.length;
            _javaDiag.bundledJavaCount = _bunJava.length;
            _javaDiag.allJava = [..._bunJava, ..._sysJava].map(j => ({ path: j.path, major: j.majorVersion, source: j.source }));
            depResult.javaDiagnostics = _javaDiag;
            if (!depResult.parentVersion.ok || !depResult.forgeCore.ok) {
                try {
                    if (!fs.existsSync(ctx.dirs.LOGS_DIR)) fs.mkdirSync(ctx.dirs.LOGS_DIR, { recursive: true });
                    fs.writeFileSync(path.join(ctx.dirs.LOGS_DIR, `dep-check-${Date.now()}.json`), JSON.stringify({ versionId: lcCleanId, externalDir: lcExternalDir, parentVersion: depResult.parentVersion, forgeCore: { ok: depResult.forgeCore.ok, missingCount: depResult.forgeCore.missing?.length } }, null, 2), 'utf-8');
                } catch (_) {}
            }
            sendJSON(res, { success: true, ...depResult });
        });

        // ====================================================================
        // /api/launch/download-deps
        // ====================================================================
        registerRoute('POST', '/api/launch/download-deps', async (req, res, parsedUrl) => {
            const ldData = await readBody(req);
            const ldVersionId = ldData.versionId;
            const ldSessionId = ldData.sessionId;
            if (!ldVersionId) { sendError(res, 'Missing versionId', 400); return; }

            const ldSettings = versions.loadSettingsCached();
            const ldCleanId = ldVersionId.replace(/ \[外部\d*\]/, '');
            let ldExternalDir = null;
            const ldExtFolders = versions.loadExternalFolders();
            for (const folder of ldExtFolders) {
                if (!fs.existsSync(folder.path)) continue;
                const extVers = versions.scanExternalFolder(folder.path);
                const extV = extVers.find(v => v.id === ldCleanId);
                if (extV) { ldExternalDir = extV.externalVersionDir; break; }
            }
            const ldDepCheck = await dependencies.checkDependencies(ldCleanId, ldSettings, ldExternalDir);
            const ldVersionJson = versions.resolveVersionJson(ldCleanId, ldExternalDir);

            if (ldDepCheck.missingFiles.length === 0) {
                sendJSON(res, { success: true, message: '无需下载', completed: 0, failed: 0 });
                return;
            }

            const dlSessionId = ldSessionId || `launch-${Date.now()}`;
            if (!ctx.sessions.launchSessions.has(dlSessionId)) {
                ctx.sessions.launchSessions.set(dlSessionId, {
                    status: 'downloading',
                    progress: 0,
                    message: `正在下载 ${ldDepCheck.missingFiles.length} 个缺失文件..`,
                    totalFiles: ldDepCheck.missingFiles.length,
                    completedFiles: 0,
                    currentFile: '',
                    errors: [],
                    versionId: ldVersionId
                });
            }

            sendJSON(res, { success: true, sessionId: dlSessionId, missingCount: ldDepCheck.missingFiles.length });

            dependencies.downloadMissingDependencies(ldDepCheck.missingFiles, (progress) => {
                const session = ctx.sessions.launchSessions.get(dlSessionId);
                if (session) {
                    session.progress = progress.progress;
                    session.currentFile = progress.file;
                    session.completedFiles = progress.current;
                    session.message = `下载文件 (${progress.current}/${progress.total}): ${progress.file}`;
                    session.speed = progress.speed;
                    session.activeDownloads = progress.activeDownloads || [];
                    session.completed = progress.completed || 0;
                    session.failed = progress.failed || 0;
                    session.queued = progress.queued || 0;
                    session.concurrentDownloads = progress.concurrentDownloads || 10;
                    session.failedFiles = progress.failedFiles || [];
                }
            }, ldVersionJson).then(async (result) => {
                const session = ctx.sessions.launchSessions.get(dlSessionId);
                if (session) {
                    session.errors = result.errors;
                    session.failedFiles = result.failedFiles || [];
                    if (result.failed > 0 && result.completed === 0) {
                        session.status = 'failed';
                        session.message = `下载失败: ${result.failed} 个文件下载失败`;
                    } else {
                        session.status = 'completed';
                        session.message = `下载完成: ${result.completed} 个成功, ${result.failed} 个失败`;
                        java.invalidateDepCheckCache(ldCleanId);
                    }
                }
            }).catch((e) => {
                const session = ctx.sessions.launchSessions.get(dlSessionId);
                if (session) {
                    session.status = 'failed';
                    session.message = `下载失败: ${e.message}`;
                }
            });
        });

        // ====================================================================
        // /api/launch/session-status
        // ====================================================================
        registerRoute('GET', '/api/launch/session-status', async (req, res, parsedUrl) => {
            const lsSessionId = parsedUrl.query.sessionId;
            if (!lsSessionId || !ctx.sessions.launchSessions.has(lsSessionId)) {
                sendJSON(res, { status: 'unknown', progress: 0, message: '' });
                return;
            }
            const lsSession = ctx.sessions.launchSessions.get(lsSessionId);
            const response = {
                status: lsSession.status,
                progress: lsSession.progress,
                message: lsSession.message,
                currentFile: lsSession.currentFile || '',
                totalFiles: lsSession.totalFiles || 0,
                completedFiles: lsSession.completedFiles || 0,
                errors: lsSession.errors || [],
                launchResult: lsSession.launchResult || null,
                activeDownloads: lsSession.activeDownloads || [],
                completed: lsSession.completed || 0,
                failed: lsSession.failed || 0,
                speed: ctx.DownloadManager.getSpeed() || lsSession.speed || 0,
                queued: lsSession.queued || 0,
                concurrentDownloads: lsSession.concurrentDownloads || 16,
                activeConnections: ctx.DownloadManager.activeConnections,
                connectionLimit: ctx.DownloadManager.connectionLimit,
                failedFiles: lsSession.failedFiles || []
            };
            sendJSON(res, response);
            if (['launched', 'launch_failed', 'failed'].includes(lsSession.status)) {
                setTimeout(() => ctx.sessions.launchSessions.delete(lsSessionId), 60000);
            }
        });

        // ====================================================================
        // /api/launch/diagnose
        // ====================================================================
        registerRoute('GET', '/api/launch/diagnose', async (req, res, parsedUrl) => {
            const diagVersionId = parsedUrl.query.versionId;
            const diagExternal = parsedUrl.query.externalDir || '';
            if (!diagVersionId) { sendError(res, 'Missing versionId', 400); return; }

            try {
                const extDir = diagExternal || null;
                const versionJson = versions.resolveVersionJson(diagVersionId, extDir);
                if (!versionJson) { sendError(res, '版本JSON缺失', 400); return; }

                const settings = versions.loadSettingsCached();
                const acctsList = accounts.loadAccounts();
                const account = acctsList.find(a => a.id === settings.selectedAccount) || acctsList[0] || { username: 'Player', type: 'offline' };

                const diagResult = {
                    versionId: diagVersionId,
                    externalDir: extDir,
                    mainClass: versionJson.mainClass || 'N/A',
                    inheritsFrom: versionJson.inheritsFrom || null,
                    librariesCount: (versionJson.libraries || []).length,
                    javaPath: 'auto-detect',
                    classpathEntries: [],
                    missingLibraries: [],
                    criticalMissing: [],
                    mainJarFound: false,
                    mainJarPath: null,
                    argsPreview: null
                };

                const javaPath = _server().findJavaPath(versionJson, settings);
                diagResult.javaPath = javaPath;
                diagResult.javaMajorVersion = java.getJavaMajorVersion(javaPath);

                const classpathStr = _server().buildClasspath(versionJson, diagVersionId, extDir);
                const cpEntries = classpathStr.split(';');
                diagResult.classpathEntries = cpEntries;

                for (const entry of cpEntries) {
                    if (!fs.existsSync(entry)) {
                        diagResult.missingLibraries.push(entry);
                        const bn = path.basename(entry).toLowerCase();
                        if (bn.includes('securejarhandler') || bn.includes('forge') || bn.includes('neoforge') ||
                            bn.includes('fmlloader') || bn.includes('modlauncher') || bn.includes('fabric-loader') ||
                            bn.includes('launchwrapper') || bn.includes('log4j') || bn.includes('lwjgl')) {
                            diagResult.criticalMissing.push(entry);
                        }
                    }
                }

                const actualVersionId = diagVersionId || versionJson.id || '';
                const jarSearchPaths = [];
                if (extDir) {
                    const er = versions.findExternalRoot(extDir);
                    if (er) jarSearchPaths.push(path.join(er, 'versions', actualVersionId, `${actualVersionId}.jar`));
                    jarSearchPaths.push(path.join(extDir, `${actualVersionId}.jar`));
                    jarSearchPaths.push(path.join(extDir, `${path.basename(extDir)}.jar`));
                }
                jarSearchPaths.push(path.join(ctx.dirs.VERSIONS_DIR, actualVersionId, `${actualVersionId}.jar`));
                for (const p of jarSearchPaths) {
                    if (fs.existsSync(p)) {
                        diagResult.mainJarFound = true;
                        diagResult.mainJarPath = p;
                        break;
                    }
                }

                try {
                    const { args } = launch.buildLaunchArguments(versionJson, settings, account, diagVersionId,
                        extDir ? path.dirname(extDir) : path.join(ctx.dirs.DATA_DIR, 'minecraft'),
                        extDir);
                    diagResult.argsPreview = args;
                    diagResult.argsCount = args.length;
                    diagResult.estimatedCmdLength = javaPath.length + args.reduce((sum, a) => sum + a.length + 3, 0);
                } catch (e) {
                    diagResult.argsPreviewError = e.message;
                }

                sendJSON(res, diagResult);
            } catch (e) {
                sendError(res, '诊断失败: ' + e.message);
            }
        });

        // ====================================================================
        // /api/launch/args-preview
        // ====================================================================
        registerRoute('POST', '/api/launch/args-preview', async (req, res, parsedUrl) => {
            const laData = await readBody(req);
            const laVersionId = laData.versionId;
            if (!laVersionId) { sendError(res, 'Missing versionId', 400); return; }

            try {
                const versionJson = versions.resolveVersionJson(laVersionId);
                if (!versionJson) { sendError(res, '版本JSON缺失', 400); return; }
                const settings = versions.loadSettingsCached();
                const acctsList = accounts.loadAccounts();
                const account = acctsList.find(a => a.id === settings.selectedAccount) || acctsList[0] || { username: 'Player', type: 'offline' };
                const { args } = launch.buildLaunchArguments(versionJson, settings, account);
                sendJSON(res, { args, javaPath: settings.javaPath || 'auto-detect' });
            } catch (e) {
                sendError(res, '预览失败: ' + e.message);
            }
        });
    }
};
