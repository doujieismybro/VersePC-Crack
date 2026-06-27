/**
 * server/api/routes/accounts.js - 账号路由
 * ============================================================================
 * 从 server.js handleAPI switch 语句抽取的账号相关端点。
 * 包含离线账号、微软账号(msauth)、第三方账号(Yggdrasil)认证。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const ctx = require('../../context');

const SHARED_HTTPS_AGENT = ctx.httpAgents && ctx.httpAgents.SHARED_HTTPS_AGENT;

// ============================================================================
// 从 server.js 复制的辅助函数 (未从 deps 模块导出)
// ============================================================================

function extractSkinUrlFromAuthResult(authResult) {
    try {
        const sources = [
            authResult?.selectedProfile?.properties,
            authResult?.user?.properties
        ];
        for (const properties of sources) {
            if (!properties) continue;
            const texturesProp = properties.find(p => p.name === 'textures');
            if (texturesProp && texturesProp.value) {
                try {
                    const decoded = JSON.parse(Buffer.from(texturesProp.value, 'base64').toString('utf8'));
                    if (decoded.textures && decoded.textures.SKIN && decoded.textures.SKIN.url) {
                        return decoded.textures.SKIN.url;
                    }
                } catch (e) {}
            }
        }
    } catch (e) {}
    return null;
}

function extractSkinModelFromAuthResult(authResult) {
    try {
        const sources = [
            authResult?.selectedProfile?.properties,
            authResult?.user?.properties
        ];
        for (const properties of sources) {
            if (!properties) continue;
            const texturesProp = properties.find(p => p.name === 'textures');
            if (texturesProp && texturesProp.value) {
                try {
                    const decoded = JSON.parse(Buffer.from(texturesProp.value, 'base64').toString('utf8'));
                    if (decoded.textures && decoded.textures.SKIN && decoded.textures.SKIN.metadata) {
                        return decoded.textures.SKIN.metadata.model === 'slim' ? 'slim' : 'default';
                    }
                } catch (e) {}
            }
        }
    } catch (e) {}
    return null;
}

function yggdrasilRequest(url, body, timeoutMs = 30000, maxRedirects = 3) {
    return new Promise((resolve, reject) => {
        let currentUrl = url;
        let redirectCount = 0;
        const attempt = (targetUrl) => {
            const parsed = new URL(targetUrl);
            const mod = parsed.protocol === 'https:' ? https : http;
            const reqBody = typeof body === 'string' ? body : JSON.stringify(body);
            const req = mod.request({
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(reqBody)
                },
                timeout: timeoutMs,
                agent: parsed.protocol === 'https:' ? SHARED_HTTPS_AGENT : undefined
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectCount < maxRedirects) {
                    res.resume();
                    redirectCount++;
                    const next = res.headers.location.startsWith('http') ? res.headers.location : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
                    return attempt(next);
                }
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        let errMsg = `认证服务器返回 HTTP ${res.statusCode}`;
                        try { const errBody = JSON.parse(data); errMsg = errBody.errorMessage || errBody.error || errMsg; } catch (_) {}
                        return reject(new Error(errMsg));
                    }
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(new Error('认证服务器返回了无效的响应')); }
                });
            });
            req.on('timeout', () => { req.destroy(); reject(new Error('连接认证服务器超时，请检查网络连接')); });
            req.on('error', (e) => {
                if (e.code === 'ECONNREFUSED') reject(new Error('无法连接到认证服务器，请检查服务器地址是否正确'));
                else if (e.code === 'ENOTFOUND') reject(new Error('无法解析认证服务器域名，请检查服务器地址'));
                else if (e.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || e.code === 'CERT_HAS_EXPIRED' || e.code.includes('CERT')) reject(new Error('认证服务器证书错误: ' + e.message));
                else if (e.code === 'ECONNRESET') reject(new Error('与认证服务器的连接被重置'));
                else reject(new Error('连接认证服务器失败: ' + e.message));
            });
            req.write(reqBody);
            req.end();
        };
        attempt(currentUrl);
    });
}

module.exports = {
    register(registerRoute, deps) {
        const { ctx, sendJSON, sendError, readBody } = deps;
        const { accounts, http } = deps;

        const MS_CLIENT_ID = ctx.urls.MS_CLIENT_ID;
        const DATA_DIR = ctx.dirs.DATA_DIR;

        // ====================================================================
        // ensureAuthlibInjector (从 server.js 复制)
        // ====================================================================
        async function ensureAuthlibInjector() {
            const aiDir = path.join(DATA_DIR, 'authlib-injector');
            const aiFiles = fs.existsSync(aiDir) ? fs.readdirSync(aiDir).filter(f => f.endsWith('.jar')) : [];
            if (aiFiles.length === 0) {
                try {
                    const aiData = await http.fetchJSON('https://authlib-injector.yushi.moe/artifact/latest.json');
                    if (!fs.existsSync(aiDir)) fs.mkdirSync(aiDir, { recursive: true });
                    const aiPath = path.join(aiDir, `authlib-injector-${aiData.version}.jar`);
                    await http.downloadFile(aiData.download_url, aiPath);
                    const fileBuffer = fs.readFileSync(aiPath);
                    const actualHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
                    // TODO: 替换为 authlib-injector 已知版本的 SHA256 哈希值
                    const KNOWN_HASHES = {
                    };
                    const expectedHash = KNOWN_HASHES[aiData.version];
                    if (expectedHash && actualHash !== expectedHash) {
                        fs.unlinkSync(aiPath);
                        console.error('[Authlib] SHA256 校验失败，文件可能被篡改');
                        return;
                    }
                    if (aiData.checksums && aiData.checksums.sha256) {
                        if (actualHash !== aiData.checksums.sha256) {
                            fs.unlinkSync(aiPath);
                            console.error('[Authlib] 文件校验失败');
                            return;
                        }
                    }
                } catch (e) {
                    console.log('[Authlib] 下载失败:', e.message);
                }
            }
        }

        // ====================================================================
        // /api/accounts
        // ====================================================================
        registerRoute('GET', '/api/accounts', async (req, res, parsedUrl) => {
            sendJSON(res, accounts.loadAccounts());
        });

        // ====================================================================
        // /api/accounts/add-offline
        // ====================================================================
        registerRoute('POST', '/api/accounts/add-offline', async (req, res, parsedUrl) => {
            const data = await readBody(req);
            const username = (data.username || '').trim();
            if (!username) { sendError(res, '请输入用户名', 400); return; }
            if (username.length < 3 || username.length > 16) { sendError(res, '用户名长度需为 3 - 16 位', 400); return; }
            if (!/^[A-Za-z0-9_]+$/.test(username)) { sendError(res, '用户名只能包含英文字母、数字与下划线', 400); return; }
            const md5 = crypto.createHash('md5').update('OfflinePlayer:' + username).digest();
            md5[6] = (md5[6] & 0x0f) | 0x30;
            md5[8] = (md5[8] & 0x3f) | 0x80;
            const uuid = md5.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
            const accountsList = accounts.loadAccounts();
            const newAccount = {
                id: crypto.randomUUID(),
                username: username,
                uuid: uuid,
                type: 'offline',
                accessToken: '0',
                createdAt: new Date().toISOString()
            };
            accountsList.push(newAccount);
            accounts.saveAccounts(accountsList);
            sendJSON(res, { success: true, account: newAccount });
        });

        // ====================================================================
        // /api/accounts/delete
        // ====================================================================
        registerRoute('POST', '/api/accounts/delete', async (req, res, parsedUrl) => {
            const data = await readBody(req);
            const accountId = data.accountId;
            if (!accountId) { sendError(res, 'Missing accountId', 400); return; }
            let accountsList = accounts.loadAccounts();
            accountsList = accountsList.filter(a => a.id !== accountId);
            accounts.saveAccounts(accountsList);
            sendJSON(res, { success: true });
        });

        // ====================================================================
        // /api/accounts/select
        // ====================================================================
        registerRoute('POST', '/api/accounts/select', async (req, res, parsedUrl) => {
            const data = await readBody(req);
            const accountId = data.accountId;
            const settings = accounts.loadSettingsCached();
            settings.selectedAccount = accountId;
            accounts.saveSettings(settings);
            sendJSON(res, { success: true });
        });

        // ====================================================================
        // /api/msauth/device-code
        // ====================================================================
        registerRoute('POST', '/api/msauth/device-code', async (req, res, parsedUrl) => {
            try {
                const deviceCodeUrl = `https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode`;
                const postData = `client_id=${MS_CLIENT_ID}&scope=XboxLive.signin+offline_access`;

                async function requestDeviceCode(retryCount = 0) {
                    return new Promise((resolve, reject) => {
                        const msreq = https.request(deviceCodeUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded',
                                'Content-Length': Buffer.byteLength(postData)
                            },
                            timeout: 15000
                        }, (msres) => {
                            let data = '';
                            msres.on('data', chunk => data += chunk);
                            msres.on('end', () => {
                                if (msres.statusCode === 429) {
                                    const retryAfter = parseInt(msres.headers['retry-after'] || '5', 10);
                                    const err = new Error(`请求过于频繁，请等待 ${retryAfter} 秒后重试`);
                                    err.isRateLimit = true;
                                    err.retryAfter = retryAfter;
                                    reject(err);
                                    return;
                                }
                                if (msres.statusCode >= 400) {
                                    let errDetail = '';
                                    try {
                                        const errBody = JSON.parse(data);
                                        errDetail = errBody.error_description || errBody.error || data.substring(0, 200);
                                    } catch (e) { errDetail = data.substring(0, 200); }
                                    const err = new Error(`微软服务返回错误 (HTTP ${msres.statusCode}): ${errDetail}`);
                                    err.httpStatus = msres.statusCode;
                                    reject(err);
                                    return;
                                }
                                try { resolve(JSON.parse(data)); }
                                catch (e) { reject(new Error('微软服务返回了无效的数据')); }
                            });
                        });
                        msreq.on('error', (e) => {
                            if (retryCount < 2 && (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED')) {
                                setTimeout(() => {
                                    requestDeviceCode(retryCount + 1).then(resolve).catch(reject);
                                }, 1000 * (retryCount + 1));
                            } else {
                                reject(new Error('网络连接失败: ' + e.message));
                            }
                        });
                        msreq.on('timeout', () => {
                            msreq.destroy();
                            if (retryCount < 2) {
                                setTimeout(() => {
                                    requestDeviceCode(retryCount + 1).then(resolve).catch(reject);
                                }, 1000 * (retryCount + 1));
                            } else {
                                reject(new Error('连接微软服务超时，请检查网络'));
                            }
                        });
                        msreq.write(postData);
                        msreq.end();
                    });
                }

                const result = await requestDeviceCode();
                if (!result.device_code) {
                    throw new Error('微软服务未返回设备码');
                }
                sendJSON(res, {
                    success: true,
                    deviceCode: result.device_code,
                    userCode: result.user_code,
                    verificationUri: result.verification_uri || 'https://www.microsoft.com/link',
                    verificationUriComplete: result.verification_uri_complete || null,
                    expiresIn: result.expires_in,
                    interval: result.interval || 5,
                    message: result.message
                });
            } catch (e) {
                console.error('[MSAuth] 获取设备码失败:', e.message);
                sendError(res, '获取设备码失败: ' + e.message);
            }
        });

        // ====================================================================
        // /api/msauth/poll
        // ====================================================================
        registerRoute('POST', '/api/msauth/poll', async (req, res, parsedUrl) => {
            const data = await readBody(req);
            const deviceCode = data.deviceCode;
            if (!deviceCode) { sendError(res, 'Missing deviceCode', 400); return; }

            try {
                const tokenUrl = `https://login.microsoftonline.com/consumers/oauth2/v2.0/token`;
                const postData = `grant_type=urn:ietf:params:oauth:grant-type:device_code&client_id=${MS_CLIENT_ID}&device_code=${deviceCode}`;

                const msTokenResult = await new Promise((resolve, reject) => {
                    const msreq = https.request(tokenUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Content-Length': Buffer.byteLength(postData)
                        },
                        timeout: 15000
                    }, (msres) => {
                        let data = '';
                        msres.on('data', chunk => data += chunk);
                        msres.on('end', () => {
                            if (msres.statusCode === 429) {
                                const retryAfter = parseInt(msres.headers['retry-after'] || '5', 10);
                                const err = new Error(`请求过于频繁，请等待 ${retryAfter} 秒后重试`);
                                err.isRateLimit = true;
                                err.retryAfter = retryAfter;
                                reject(err);
                                return;
                            }
                            if (msres.statusCode >= 400 && msres.statusCode !== 400) {
                                let errDetail = '';
                                try {
                                    const errBody = JSON.parse(data);
                                    errDetail = errBody.error_description || errBody.error || data.substring(0, 200);
                                } catch (e) { errDetail = data.substring(0, 200); }
                                const err = new Error(`微软服务返回错误 (HTTP ${msres.statusCode}): ${errDetail}`);
                                err.httpStatus = msres.statusCode;
                                reject(err);
                                return;
                            }
                            try { resolve(JSON.parse(data)); }
                            catch (e) { reject(new Error('微软服务返回了无效的数据')); }
                        });
                    });
                    msreq.on('error', (e) => {
                        reject(new Error('网络连接失败: ' + e.message));
                    });
                    msreq.on('timeout', () => {
                        msreq.destroy();
                        reject(new Error('连接微软服务超时，请检查网络'));
                    });
                    msreq.write(postData);
                    msreq.end();
                });

                if (msTokenResult.error) {
                    sendJSON(res, { success: false, pending: msTokenResult.error === 'authorization_pending', error: msTokenResult.error_description || msTokenResult.error, errorCode: msTokenResult.error });
                    return;
                }

                const msAccessToken = msTokenResult.access_token;
                const msRefreshToken = msTokenResult.refresh_token;

                const xblResult = await http.fetchJSONWithMethod('https://user.auth.xboxlive.com/user/authenticate', 'POST', JSON.stringify({
                    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
                    RelyingParty: 'http://auth.xboxlive.com',
                    TokenType: 'JWT'
                }), { 'Content-Type': 'application/json' });

                const xblToken = xblResult.Token;
                const xblUhs = xblResult.DisplayClaims?.xui?.[0]?.uhs || '';

                const xstsResult = await http.fetchJSONWithMethod('https://xsts.auth.xboxlive.com/xsts/authorize', 'POST', JSON.stringify({
                    Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
                    RelyingParty: 'rp://api.minecraftservices.com/',
                    TokenType: 'JWT'
                }), { 'Content-Type': 'application/json' });

                if (xstsResult.XErr) {
                    const xerr = xstsResult.XErr;
                    const xerrMessages = {
                        2148916233: '该微软账号没有关联Xbox账号，请先在 xbox.com 创建',
                        2148916234: '该Xbox账号所在地区不可用',
                        2148916235: 'Xbox Live服务暂时不可用，请稍后重试',
                        2148916236: '该Xbox账号需要成人验证',
                        2148916237: '该Xbox账号是被封禁的',
                        2148916238: '该微软账号是儿童账号，需要成人账号关联'
                    };
                    const xerrMsg = xerrMessages[xerr] || `Xbox认证失败 (错误码: ${xerr})`;
                    sendJSON(res, { success: false, error: xerrMsg, xerr });
                    return;
                }

                const xstsToken = xstsResult.Token;
                const xstsUhs = xstsResult.DisplayClaims?.xui?.[0]?.uhs || xblUhs;

                const mcResult = await http.fetchJSONWithMethod('https://api.minecraftservices.com/authentication/login_with_xbox', 'POST', JSON.stringify({
                    identityToken: `XBL3.0 x=${xstsUhs};${xstsToken}`
                }), { 'Content-Type': 'application/json' });

                const mcAccessToken = mcResult.access_token;
                if (!mcAccessToken) {
                    sendJSON(res, { success: false, error: 'Minecraft服务认证失败，未获取到访问令牌' });
                    return;
                }

                try {
                    const entitlements = await http.fetchJSONWithAuth('https://api.minecraftservices.com/entitlements/mcstore', mcAccessToken);
                    if (entitlements && Array.isArray(entitlements.items)) {
                        const hasGame = entitlements.items.some(item =>
                            item.name === 'product_minecraft' || item.name === 'game_minecraft'
                        );
                        if (!hasGame) {
                            sendJSON(res, { success: false, error: '该账号未购买Minecraft，请先购买游戏', needPurchase: true });
                            return;
                        }
                    }
                } catch (entErr) {
                    console.warn('[MSAuth] 游戏所有权验证跳过:', entErr.message);
                }

                let profileResult;
                try {
                    profileResult = await http.fetchJSONWithAuth('https://api.minecraftservices.com/minecraft/profile', mcAccessToken);
                } catch (profileErr) {
                    if (profileErr.message && profileErr.message.includes('404')) {
                        sendJSON(res, { success: false, error: '未找到Minecraft档案，请先在 Minecraft.net 创建角色名', needCreateProfile: true });
                        return;
                    }
                    throw profileErr;
                }
                if (!profileResult || !profileResult.id) {
                    sendJSON(res, { success: false, error: '未找到Minecraft档案，请先在 Minecraft.net 创建角色名', needCreateProfile: true });
                    return;
                }

                const accountsList = accounts.loadAccounts();
                const now = new Date();
                let activeSkinUrl = null;
                let activeSkinModel = 'default';
                if (profileResult.skins && Array.isArray(profileResult.skins)) {
                    const activeSkin = profileResult.skins.find(s => s.state === 'ACTIVE');
                    if (activeSkin) {
                        activeSkinUrl = activeSkin.url;
                        activeSkinModel = activeSkin.variant === 'SLIM' ? 'slim' : 'default';
                    }
                }
                const newAccount = {
                    id: crypto.randomUUID(),
                    username: profileResult.name,
                    uuid: profileResult.id,
                    type: 'microsoft',
                    accessToken: mcAccessToken,
                    refreshToken: msRefreshToken,
                    tokenExpiresAt: now.getTime() + (msTokenResult.expires_in || 3600) * 1000,
                    lastRefreshed: now.toISOString(),
                    createdAt: new Date().toISOString(),
                    skinUrl: activeSkinUrl,
                    skinModel: activeSkinModel
                };

                const existingIdx = accountsList.findIndex(a => a.uuid === newAccount.uuid);
                if (existingIdx >= 0) {
                    newAccount.createdAt = accountsList[existingIdx].createdAt || newAccount.createdAt;
                    accountsList[existingIdx] = { ...accountsList[existingIdx], ...newAccount };
                } else {
                    accountsList.push(newAccount);
                }
                accounts.saveAccounts(accountsList);

                const settings = accounts.loadSettingsCached();
                settings.selectedAccount = newAccount.id;
                accounts.saveSettings(settings);

                sendJSON(res, { success: true, account: newAccount });
            } catch (e) {
                if (e.isRateLimit) {
                    sendJSON(res, { success: false, error: e.message, isRateLimit: true, retryAfter: e.retryAfter });
                } else {
                    sendError(res, '微软登录失败: ' + e.message);
                }
            }
        });

        // ====================================================================
        // /api/msauth/refresh
        // ====================================================================
        registerRoute('POST', '/api/msauth/refresh', async (req, res, parsedUrl) => {
            const data = await readBody(req);
            const accountId = data.accountId;
            if (!accountId) { sendError(res, 'Missing accountId', 400); return; }

            const accountsList = accounts.loadAccounts();
            const account = accountsList.find(a => a.id === accountId);
            if (!account) { sendError(res, '账号不存在', 404); return; }
            if (account.type !== 'microsoft') { sendError(res, '仅支持刷新微软账号', 400); return; }
            if (!account.refreshToken) { sendJSON(res, { success: false, error: '无刷新令牌，请重新登录' }); return; }

            try {
                const tokenUrl = `https://login.microsoftonline.com/consumers/oauth2/v2.0/token`;
                const postData = `grant_type=refresh_token&client_id=${MS_CLIENT_ID}&refresh_token=${encodeURIComponent(account.refreshToken)}&scope=XboxLive.signin+offline_access`;

                const msTokenResult = await new Promise((resolve, reject) => {
                    const msreq = https.request(tokenUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Content-Length': Buffer.byteLength(postData)
                        },
                        timeout: 15000
                    }, (msres) => {
                        let data = '';
                        msres.on('data', chunk => data += chunk);
                        msres.on('end', () => {
                            if (msres.statusCode === 429) {
                                const retryAfter = parseInt(msres.headers['retry-after'] || '5', 10);
                                const err = new Error(`请求过于频繁，请等待 ${retryAfter} 秒后重试`);
                                err.isRateLimit = true;
                                err.retryAfter = retryAfter;
                                reject(err);
                                return;
                            }
                            if (msres.statusCode >= 400) {
                                let errDetail = '';
                                try {
                                    const errBody = JSON.parse(data);
                                    errDetail = errBody.error_description || errBody.error || data.substring(0, 200);
                                } catch (e) { errDetail = data.substring(0, 200); }
                                const err = new Error(`微软服务返回错误 (HTTP ${msres.statusCode}): ${errDetail}`);
                                err.httpStatus = msres.statusCode;
                                reject(err);
                                return;
                            }
                            try { resolve(JSON.parse(data)); }
                            catch (e) { reject(new Error('微软服务返回了无效的数据')); }
                        });
                    });
                    msreq.on('error', (e) => {
                        reject(new Error('网络连接失败: ' + e.message));
                    });
                    msreq.on('timeout', () => {
                        msreq.destroy();
                        reject(new Error('连接微软服务超时，请检查网络'));
                    });
                    msreq.write(postData);
                    msreq.end();
                });

                if (msTokenResult.error) {
                    const isExpired = msTokenResult.error === 'invalid_grant' || msTokenResult.error === 'expired_token';
                    sendJSON(res, {
                        success: false,
                        error: isExpired ? '登录已过期，请重新登录' : `令牌刷新失败: ${msTokenResult.error_description || msTokenResult.error}`,
                        needRelogin: isExpired
                    });
                    return;
                }

                const msAccessToken = msTokenResult.access_token;
                const msRefreshTokenNew = msTokenResult.refresh_token || account.refreshToken;

                const xblResult = await http.fetchJSONWithMethod('https://user.auth.xboxlive.com/user/authenticate', 'POST', JSON.stringify({
                    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
                    RelyingParty: 'http://auth.xboxlive.com',
                    TokenType: 'JWT'
                }), { 'Content-Type': 'application/json' });

                const xblToken = xblResult.Token;
                const xblUhs = xblResult.DisplayClaims?.xui?.[0]?.uhs || '';

                const xstsResult = await http.fetchJSONWithMethod('https://xsts.auth.xboxlive.com/xsts/authorize', 'POST', JSON.stringify({
                    Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
                    RelyingParty: 'rp://api.minecraftservices.com/',
                    TokenType: 'JWT'
                }), { 'Content-Type': 'application/json' });

                if (xstsResult.XErr) {
                    sendJSON(res, { success: false, error: `Xbox认证失败 (错误码: ${xstsResult.XErr})` });
                    return;
                }

                const xstsToken = xstsResult.Token;
                const xstsUhs = xstsResult.DisplayClaims?.xui?.[0]?.uhs || xblUhs;

                const mcResult = await http.fetchJSONWithMethod('https://api.minecraftservices.com/authentication/login_with_xbox', 'POST', JSON.stringify({
                    identityToken: `XBL3.0 x=${xstsUhs};${xstsToken}`
                }), { 'Content-Type': 'application/json' });

                const mcAccessToken = mcResult.access_token;
                if (!mcAccessToken) {
                    sendJSON(res, { success: false, error: 'Minecraft服务认证失败' });
                    return;
                }

                let profileResult;
                try {
                    profileResult = await http.fetchJSONWithAuth('https://api.minecraftservices.com/minecraft/profile', mcAccessToken);
                } catch (profileErr) {
                    if (profileErr.message && profileErr.message.includes('404')) {
                        sendJSON(res, { success: false, error: '未找到Minecraft档案，请先在 Minecraft.net 创建角色名', needCreateProfile: true });
                        return;
                    }
                    throw profileErr;
                }
                if (!profileResult || !profileResult.id) {
                    sendJSON(res, { success: false, error: '未找到Minecraft档案，请先在 Minecraft.net 创建角色名', needCreateProfile: true });
                    return;
                }

                const now = new Date();
                account.accessToken = mcAccessToken;
                account.refreshToken = msRefreshTokenNew;
                account.tokenExpiresAt = now.getTime() + (msTokenResult.expires_in || 3600) * 1000;
                account.lastRefreshed = now.toISOString();
                account.username = profileResult.name || account.username;
                if (profileResult.skins && Array.isArray(profileResult.skins)) {
                    const activeSkin = profileResult.skins.find(s => s.state === 'ACTIVE');
                    if (activeSkin) {
                        account.skinUrl = activeSkin.url;
                        account.skinModel = activeSkin.variant === 'SLIM' ? 'slim' : 'default';
                    }
                }
                accounts.saveAccounts(accountsList);

                sendJSON(res, { success: true, account });
            } catch (e) {
                if (e.isRateLimit) {
                    sendJSON(res, { success: false, error: e.message, isRateLimit: true, retryAfter: e.retryAfter });
                } else {
                    sendError(res, '令牌刷新失败: ' + e.message);
                }
            }
        });

        // ====================================================================
        // /api/accounts/thirdparty-verify
        // ====================================================================
        registerRoute('GET', '/api/accounts/thirdparty-verify', async (req, res, parsedUrl) => {
            const verifyUrl = parsedUrl.query.serverUrl;
            if (!verifyUrl) { sendError(res, 'Missing serverUrl', 400); return; }
            if (verifyUrl && !verifyUrl.startsWith('https://')) {
                sendJSON(res, { error: '出于安全考虑，仅支持 HTTPS 协议的认证服务器' });
                return;
            }
            try {
                let apiUrl = verifyUrl.replace(/\/$/, '');
                const info = await http.fetchJSON(apiUrl, 2, 10000);
                const meta = {
                    serverName: info.meta?.serverName || info.serverName || '未知',
                    implementationName: info.meta?.implementationName || info.implementationName || '',
                    implementationVersion: info.meta?.implementationVersion || '',
                    serverIcon: info.meta?.serverIcon || info.icon || ''
                };
                sendJSON(res, { success: true, meta });
            } catch (e) {
                sendJSON(res, { success: false, error: '无法连接到认证服务器: ' + (e.message || '') });
            }
        });

        // ====================================================================
        // /api/accounts/thirdparty-login
        // ====================================================================
        registerRoute('POST', '/api/accounts/thirdparty-login', async (req, res, parsedUrl) => {
            const tlData = await readBody(req);
            const tlServerUrl = tlData.serverUrl;
            const tlUsername = tlData.username;
            const tlPassword = tlData.password;
            if (!tlServerUrl || !tlUsername || !tlPassword) {
                sendError(res, 'Missing required fields', 400); return;
            }
            if (tlServerUrl && !tlServerUrl.startsWith('https://')) {
                sendJSON(res, { error: '出于安全考虑，仅支持 HTTPS 协议的认证服务器' });
                return;
            }

            try {
                let apiUrl = tlServerUrl.replace(/\/$/, '');
                const authUrl = `${apiUrl}/authserver/authenticate`;

                const authResult = await yggdrasilRequest(authUrl, {
                    username: tlUsername,
                    password: tlPassword,
                    requestUser: true,
                    agent: { name: 'Minecraft', version: 1 }
                });

                if (authResult.error) {
                    sendJSON(res, { success: false, error: authResult.errorMessage || authResult.error || '认证失败' });
                    return;
                }

                if (!authResult.accessToken) {
                    sendJSON(res, { success: false, error: '认证服务器未返回访问令牌' });
                    return;
                }

                let profile = authResult.selectedProfile;
                const availableProfiles = authResult.availableProfiles || [];

                if (!profile && availableProfiles.length === 0) {
                    sendJSON(res, { success: false, error: '未找到游戏角色，请先在皮肤站创建角色' });
                    return;
                }

                if (!profile && availableProfiles.length > 1) {
                    sendJSON(res, {
                        success: false,
                        needSelectProfile: true,
                        accessToken: authResult.accessToken,
                        clientToken: authResult.clientToken,
                        serverUrl: tlServerUrl,
                        availableProfiles: availableProfiles.map(p => ({
                            id: p.id,
                            name: p.name,
                            skinUrl: `https://mc-heads.net/avatar/${p.id.replace(/-/g, '')}/64`
                        }))
                    });
                    return;
                }

                if (!profile && availableProfiles.length === 1) {
                    profile = availableProfiles[0];
                }
                let refreshResult = null;
                try {
                    refreshResult = await yggdrasilRequest(`${apiUrl}/authserver/refresh`, {
                        accessToken: authResult.accessToken,
                        clientToken: authResult.clientToken,
                        selectedProfile: profile,
                        requestUser: true
                    }, 300000);
                    if (refreshResult.accessToken) {
                        authResult.accessToken = refreshResult.accessToken;
                        if (refreshResult.selectedProfile) {
                            profile = refreshResult.selectedProfile;
                        }
                    }
                } catch (e) {
                    console.log('[ThirdParty] refresh失败，使用原始token:', e.message);
                }

                if (!profile) {
                    sendJSON(res, { success: false, error: '未找到游戏角色，请先在皮肤站创建角色' });
                    return;
                }

                console.log(`[ThirdParty] 登录成功: ${profile.name} (${profile.id})`);
                const extractedSkinUrl = extractSkinUrlFromAuthResult(refreshResult || authResult) || extractSkinUrlFromAuthResult(authResult);
                const extractedSkinModel = extractSkinModelFromAuthResult(refreshResult || authResult) || extractSkinModelFromAuthResult(authResult);
                if (extractedSkinUrl) {
                    console.log(`[ThirdParty] 从登录响应提取到皮肤URL: ${extractedSkinUrl.substring(0, 60)}...`);
                }
                if (extractedSkinModel) {
                    console.log(`[ThirdParty] 从登录响应提取到皮肤模型: ${extractedSkinModel}`);
                }
                await ensureAuthlibInjector();

                const accountsList = accounts.loadAccounts();
                const newAccount = {
                    id: crypto.randomUUID(),
                    username: profile.name,
                    uuid: profile.id,
                    type: 'thirdparty',
                    accessToken: authResult.accessToken,
                    clientToken: authResult.clientToken,
                    serverUrl: tlServerUrl,
                    skinUrl: extractedSkinUrl || null,
                    skinModel: extractedSkinModel || 'default',
                    createdAt: new Date().toISOString()
                };

                const existingIdx = accountsList.findIndex(a => a.uuid === newAccount.uuid && a.type === 'thirdparty');
                if (existingIdx >= 0) {
                    accountsList[existingIdx] = { ...accountsList[existingIdx], ...newAccount };
                } else {
                    accountsList.push(newAccount);
                }
                accounts.saveAccounts(accountsList);

                const settings = accounts.loadSettingsCached();
                settings.selectedAccount = newAccount.id;
                accounts.saveSettings(settings);

                sendJSON(res, { success: true, account: newAccount });
            } catch (e) {
                sendJSON(res, { success: false, error: '登录失败: ' + e.message });
            }
        });

        // ====================================================================
        // /api/accounts/thirdparty-select-profile
        // ====================================================================
        registerRoute('POST', '/api/accounts/thirdparty-select-profile', async (req, res, parsedUrl) => {
            const spData = await readBody(req);
            const spAccessToken = spData.accessToken;
            const spClientToken = spData.clientToken;
            const spServerUrl = spData.serverUrl;
            const spProfileId = spData.profileId;
            const spProfileName = spData.profileName;
            if (!spAccessToken || !spProfileId || !spServerUrl) {
                sendError(res, 'Missing required fields', 400); return;
            }
            if (spServerUrl && !spServerUrl.startsWith('https://')) {
                sendJSON(res, { error: '出于安全考虑，仅支持 HTTPS 协议的认证服务器' });
                return;
            }

            try {
                let spApiUrl = spServerUrl.replace(/\/$/, '');
                const refreshResult = await yggdrasilRequest(`${spApiUrl}/authserver/refresh`, {
                    accessToken: spAccessToken,
                    clientToken: spClientToken,
                    selectedProfile: { id: spProfileId, name: spProfileName || '' },
                    requestUser: true
                });

                if (refreshResult.error) {
                    sendJSON(res, { success: false, error: refreshResult.errorMessage || '角色选择失败' });
                    return;
                }

                const spProfile = refreshResult.selectedProfile || { id: spProfileId, name: spProfileName || 'Player' };
                const spNewAccessToken = refreshResult.accessToken || spAccessToken;
                const spExtractedSkinUrl = extractSkinUrlFromAuthResult(refreshResult);
                const spExtractedSkinModel = extractSkinModelFromAuthResult(refreshResult);
                if (spExtractedSkinUrl) {
                    console.log(`[ThirdParty] 从角色选择响应提取到皮肤URL: ${spExtractedSkinUrl.substring(0, 60)}...`);
                }

                await ensureAuthlibInjector();

                const accountsList = accounts.loadAccounts();
                const newAccount = {
                    id: crypto.randomUUID(),
                    username: spProfile.name,
                    uuid: spProfile.id,
                    type: 'thirdparty',
                    accessToken: spNewAccessToken,
                    clientToken: spClientToken,
                    serverUrl: spServerUrl,
                    skinUrl: spExtractedSkinUrl || null,
                    skinModel: spExtractedSkinModel || 'default',
                    createdAt: new Date().toISOString()
                };

                const existingIdx = accountsList.findIndex(a => a.uuid === newAccount.uuid && a.type === 'thirdparty');
                if (existingIdx >= 0) {
                    accountsList[existingIdx] = { ...accountsList[existingIdx], ...newAccount };
                } else {
                    accountsList.push(newAccount);
                }
                accounts.saveAccounts(accountsList);

                const settings = accounts.loadSettingsCached();
                settings.selectedAccount = newAccount.id;
                accounts.saveSettings(settings);

                sendJSON(res, { success: true, account: newAccount });
            } catch (e) {
                sendJSON(res, { success: false, error: '角色选择失败: ' + e.message });
            }
        });
    }
};
