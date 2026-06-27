/**
 * VersePC - Minecraft Launcher
 * Copyright (c) 2026 豆杰. All Rights Reserved.
 *
 * AI TRAINING PROHIBITED: This code is protected by copyright law.
 * Unauthorized use for AI model training, machine learning datasets,
 * or any form of artificial intelligence training is strictly prohibited.
 *
 * This software is proprietary and confidential.
 * Any unauthorized reproduction or distribution is prohibited.
 */

/**
 * server.js - VersePC 服务端入口模块
 * ============================================================================
 * 重构后的入口文件，仅保留：
 * 1. ENOTDIR 全局 monkey-patch (必须在所有 fs.mkdir 调用前执行)
 * 2. 子模块加载与路由依赖注入
 * 3. handleNativeAPI / handleNativeSSE (与 main.js 的通信层)
 * 4. logStartupInfo (启动信息与 Microsoft token 自动刷新)
 * 5. cleanupOnShutdown (关闭时中断下载任务)
 * 6. module.exports (保持 7 个函数签名不变)
 *
 * 所有业务逻辑已拆分至 server/ 目录下的子模块：
 * - context.js     共享上下文 (路径/缓存/会话/网络状态)
 * - utils.js       工具函数 (fs 辅助/格式化/PNG/SHA1)
 * - http-client.js HTTP/下载引擎
 * - skins.js       皮肤/头像
 * - terracotta.js  Terracotta LAN 联机
 * - network.js     UPnP/WS relay/mcPing
 * - versions.js    版本管理
 * - diagnose.js    版本诊断/修复
 * - java.js        Java 检测/下载
 * - dependencies.js 依赖检查
 * - modloaders.js  模组加载器 (Fabric/Forge/NeoForge/Quilt)
 * - mods.js        模组管理
 * - modpack.js     整合包导入
 * - natives.js     Natives 提取
 * - launch.js      游戏启动
 * - accounts.js    账户/认证
 *
 * API 路由分发由 server/api/router.js 处理，各路由模块位于 server/api/routes/。
 */

// ============================================================================
// 核心模块导入 - 必须在 ENOTDIR monkey-patch 之前
// ============================================================================
const fs = require('fs');
const path = require('path');
const url = require('url');
const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');

/*
[CRITICAL] 全局 ENOTDIR 修复 — Monkey-patch fs.mkdirSync 和 fs.promises.mkdir
===============================================================================
【问题原理】
  Node.js 的 fs.mkdirSync(path, {recursive: true}) 会逐级检查路径中每个组件是否为目录。
  如果路径中某个组件已经是文件（如 libraries/net 是文件），就会抛出:
    ENOTDIR: not a directory, mkdir 'C:\Users\xxx\.versepc\libraries\net'

  在我们的场景中，下载库文件如果中途失败，可能在 libraries/ 下创建 0 字节的文件
  而不是目录。后续所有需要在该路径下创建子目录的操作都会失败。

【为什么需要全局拦截】
  server.js 中有 80+ 个 mkdirSync/mkdir 调用，不可能逐个添加清理逻辑。
  而且用户可能通过整合包导入、模组安装、库文件下载等多种途径触发此问题。
  通过 monkey-patch fs 的 mkdir 方法，任何代码路径（包括第三方依赖）都能
  自动处理 ENOTDIR 情况。

【修复原理】
  拦截 fs.mkdirSync 和 fs.promises.mkdir，当捕获到 ENOTDIR 错误时，
  自动清理路径中冲突的文件，然后重试创建目录。这个过程对调用方完全透明。

[AI-AUTOGEN-WARNING] 请勿删除或修改此 monkey-patch 逻辑。
*/
const _origMkdirSync = fs.mkdirSync;
fs.mkdirSync = function patchedMkdirSync(dir, options) {
    try {
        return _origMkdirSync.call(this, dir, options);
    } catch (e) {
        if (e && e.code === 'ENOTDIR' && typeof dir === 'string') {
            const parts = dir.split(path.sep);
            for (let i = 1; i <= parts.length; i++) {
                const partial = parts.slice(0, i).join(path.sep);
                if (partial) {
                    try {
                        const st = fs.statSync(partial);
                        if (!st.isDirectory()) {
                            fs.unlinkSync(partial);
                            console.log(`[ENOTDIR-Fix] 清理异常文件: ${partial}`);
                        }
                    } catch (_) {}
                }
            }
            return _origMkdirSync.call(this, dir, options);
        }
        throw e;
    }
};

const _origPromisesMkdir = fs.promises.mkdir;
fs.promises.mkdir = async function patchedPromisesMkdir(dir, options) {
    try {
        return await _origPromisesMkdir.call(this, dir, options);
    } catch (e) {
        if (e && e.code === 'ENOTDIR' && typeof dir === 'string') {
            const parts = dir.split(path.sep);
            for (let i = 1; i <= parts.length; i++) {
                const partial = parts.slice(0, i).join(path.sep);
                if (partial) {
                    try {
                        const st = await fs.promises.stat(partial);
                        if (!st.isDirectory()) {
                            await fs.promises.unlink(partial);
                            console.log(`[ENOTDIR-Fix] 清理异常文件: ${partial}`);
                        }
                    } catch (_) {}
                }
            }
            return await _origPromisesMkdir.call(this, dir, options);
        }
        throw e;
    }
};

// ============================================================================
// 子模块加载
// ============================================================================
const ctx = require('./server/context');
const utils = require('./server/utils');
const httpClient = require('./server/http-client');
const skins = require('./server/skins');
const terracotta = require('./server/terracotta');
const network = require('./server/network');
const versions = require('./server/versions');
const diagnose = require('./server/diagnose');
const java = require('./server/java');
const dependencies = require('./server/dependencies');
const modloaders = require('./server/modloaders');
const mods = require('./server/mods');
const modpack = require('./server/modpack');
const natives = require('./server/natives');
const launch = require('./server/launch');
const accounts = require('./server/accounts');
const router = require('./server/api/router');
const { checkTampering: _chkTam } = require('./activation-verify');

// ============================================================================
// 路由依赖注入 - 向各 route 模块传递业务函数
// ============================================================================
router.deps.utils = utils;
router.deps.http = httpClient;
router.deps.skins = skins;
router.deps.terracotta = terracotta;
router.deps.network = network;
router.deps.versions = versions;
router.deps.diagnose = diagnose;
router.deps.java = java;
router.deps.dependencies = dependencies;
router.deps.modloaders = modloaders;
router.deps.mods = mods;
router.deps.modpack = modpack;
router.deps.natives = natives;
router.deps.launch = launch;
router.deps.accounts = accounts;

// ============================================================================
// handleNativeAPI - 原生 Electron API 处理器 (不经过 HTTP 模拟层)
// ============================================================================
/**
 * @param {string} pathname - API 路径 (如 '/api/versions')
 * @param {string} method - HTTP 方法 (GET/POST/DELETE)
 * @param {string|null} body - POST/PUT 请求体
 * @param {Object} query - URL 查询参数
 * @param {string} [incomingContentType] - 请求 Content-Type
 * @returns {Promise<{status: number, headers: Object, body: Buffer}>}
 */
async function handleNativeAPI(pathname, method, body, query, incomingContentType) {
    const req = new EventEmitter();
    req.method = method;
    req.url = pathname + (query && Object.keys(query).length > 0 ? '?' + new URLSearchParams(query).toString() : '');
    req.headers = { 'content-type': incomingContentType || 'application/json' };

    const res = new EventEmitter();
    let statusCode = 200;
    let headers = {};
    let chunks = [];
    let finished = false;
    let finishResolve = null;
    const finishPromise = new Promise((resolve) => { finishResolve = resolve; });

    res.statusCode = 200;
    res.headersSent = false;
    res.finished = false;
    res.setHeader = (name, value) => { headers[name.toLowerCase()] = value; };
    res.getHeader = (name) => headers[name.toLowerCase()];
    res.removeHeader = (name) => { delete headers[name.toLowerCase()]; };
    res.writeHead = (code, hdrs) => {
        statusCode = code;
        res.statusCode = code;
        res.headersSent = true;
        if (hdrs) Object.entries(hdrs).forEach(([k, v]) => { headers[k.toLowerCase()] = v; });
    };
    res.write = (data) => {
        chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    };
    res.end = (data) => {
        if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        finished = true;
        res.finished = true;
        res.emit('finish');
        if (finishResolve) { finishResolve(); finishResolve = null; }
    };
    res.flushHeaders = () => {};

    try {
        const parsedUrl = url.parse(req.url, true);

        if (_chkTam() !== 'ok') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized' }));
            await finishPromise;
            return { status: 403, headers, body: Buffer.concat(chunks) };
        }

        const apiResult = router.handleAPI(pathname, req, res, parsedUrl);

        await new Promise(r => setImmediate(() => {
            if (body !== null && body !== undefined) {
                const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
                req.emit('data', buf);
            }
            req.emit('end');
            setImmediate(r);
        }));

        await apiResult;

        if (!finished) {
            await finishPromise;
        }
    } catch (e) {
        console.error(`[Server] handleNativeAPI error for ${pathname}:`, e.message || e);
        if (!finished) {
            statusCode = 500;
            chunks = [Buffer.from(JSON.stringify({ error: '服务器内部错误', detail: e.message }))];
            finished = true;
            if (finishResolve) { finishResolve(); finishResolve = null; }
        }
    }

    return {
        status: statusCode,
        headers,
        body: Buffer.concat(chunks)
    };
}

// ============================================================================
// handleNativeSSE - 原生 Electron SSE 处理器 (流式响应)
// ============================================================================
/**
 * @param {string} pathname
 * @param {string} method
 * @param {string|null} body
 * @param {Object} query
 * @param {Function} onData - 收到数据块时回调 (chunk: Buffer) => void
 * @returns {{status: number, headers: Object, finishPromise: Promise}}
 */
function handleNativeSSE(pathname, method, body, query, onData) {
    const req = new EventEmitter();
    req.method = method;
    req.url = pathname + (query && Object.keys(query).length > 0 ? '?' + new URLSearchParams(query).toString() : '');
    req.headers = { 'content-type': 'application/json' };

    const res = new EventEmitter();
    let statusCode = 200;
    let headers = {};
    let finishResolve = null;
    const finishPromise = new Promise((resolve) => { finishResolve = resolve; });

    res.statusCode = 200;
    res.headersSent = false;
    res.finished = false;
    res.setHeader = (name, value) => { headers[name.toLowerCase()] = value; };
    res.getHeader = (name) => headers[name.toLowerCase()];
    res.writeHead = (code, hdrs) => {
        statusCode = code;
        if (hdrs) Object.entries(hdrs).forEach(([k, v]) => { headers[k.toLowerCase()] = v; });
    };
    res.write = (data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (onData) onData(buf);
    };
    res.end = (data) => {
        if (data) {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            if (onData) onData(buf);
        }
        res.finished = true;
        res.emit('finish');
        if (finishResolve) { finishResolve(); finishResolve = null; }
    };
    res.flushHeaders = () => {};

    const parsedUrl = url.parse(req.url, true);

    setImmediate(() => {
        if (body !== null && body !== undefined) {
            req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
        }
        req.emit('end');
    });

    router.handleAPI(pathname, req, res, parsedUrl).then(() => {
        if (!res.finished) {
            finishPromise.then(() => {
                if (onData) onData(null); // signal EOF
            });
        } else {
            if (onData) onData(null); // signal EOF
        }
    }).catch((e) => {
        console.error('SSE handler error:', e);
        if (onData) onData(null);
    });

    return { status: statusCode, headers, finishPromise };
}

// ============================================================================
// cleanupOnShutdown - 关闭时中断所有下载任务
// ============================================================================
function cleanupOnShutdown() {
    console.log('[Shutdown] 开始中断所有下载任务...');

    for (const [sessionId, session] of ctx.sessions.installSessions) {
        if (session.status === 'downloading' || session.status === 'preparing') {
            session.status = 'cancelled';
            session.stage = 'cancelled';
            session.message = '应用已关闭';

            if (session._abortController) {
                try { session._abortController.abort(); } catch (e) {}
            }

            if (session.versionId) {
                const versionDir = path.join(ctx.dirs.VERSIONS_DIR, session.versionId);
                versions.cleanupIncompleteVersion(versionDir);
            }
        }
    }

    for (const [sessionId, session] of ctx.sessions.modDownloadSessions) {
        if (session.status === 'downloading' || session.status === 'install') {
            session.status = 'cancelled';
            session.message = '应用已关闭';

            if (session._abortController) {
                try { session._abortController.abort(); } catch (e) {}
            }
        }
    }

    console.log('[Shutdown] 下载任务清理完成');
}

// ============================================================================
// logStartupInfo - 启动信息打印 + Microsoft token 自动刷新
// ============================================================================
function logStartupInfo() {
    utils.rotateLogs();
    versions.validateInstalledVersions();
    console.log(`\n  VersePC - Minecraft Launcher`);
    console.log(`  ────────────────────────────────────────`);
    console.log(`  Data:    ${ctx.dirs.DATA_DIR}`);
    console.log(`  Platform: ${utils.getPlatformKey()}`);
    console.log(`  ────────────────────────────────────────`);

    const installed = versions.getInstalledVersions();
    if (installed.length > 0) {
        console.log(`  Installed:       ${installed.map(v => v.id).join(', ')}`);
    }
    console.log('');

    setTimeout(() => {
        const javaList = [...java.detectBundledJava(), ...java.detectSystemJava()];
        if (javaList.length > 0) {
            console.log(`  Java:            ${javaList[0].version} (${javaList[0].path})`);
        } else {
            console.log('  Java:            未检测到');
        }

        versions.getVersionManifest().then(manifest => {
            console.log(`  Latest Release:  ${manifest.latest.release}`);
            console.log(`  Latest Snapshot: ${manifest.latest.snapshot}`);
            console.log(`  Total Versions:  ${manifest.versions.length}`);
        }).catch(() => {
            console.log('  Warning: Could not fetch version manifest (will retry)');
        });
    }, 100);

    setTimeout(async () => {
        try {
            const accts = accounts.loadAccounts();
            const msAccounts = accts.filter(a => a.type === 'microsoft' && a.refreshToken);
            if (msAccounts.length === 0) return;
            const now = Date.now();
            for (const account of msAccounts) {
                const tokenExpiresAt = account.tokenExpiresAt || 0;
                if (tokenExpiresAt && now < tokenExpiresAt - 3600000) continue;
                try {
                    console.log(`[Auth] Auto-refreshing token for: ${account.username || account.id}`);
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
                                try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid response')); }
                            });
                        });
                        req.on('error', (e) => reject(e));
                        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                        req.write(postData);
                        req.end();
                    });
                    if (!msTokenResult.error && msTokenResult.access_token) {
                        const msAccessToken = msTokenResult.access_token;
                        const msRefreshTokenNew = msTokenResult.refresh_token || account.refreshToken;
                        const xblResult = await httpClient.fetchJSONWithMethod('https://user.auth.xboxlive.com/user/authenticate', 'POST', JSON.stringify({
                            Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
                            RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT'
                        }), { 'Content-Type': 'application/json' });
                        const xblToken = xblResult.Token;
                        const xblUhs = xblResult.DisplayClaims?.xui?.[0]?.uhs || '';
                        const xstsResult = await httpClient.fetchJSONWithMethod('https://xsts.auth.xboxlive.com/xsts/authorize', 'POST', JSON.stringify({
                            Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
                            RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT'
                        }), { 'Content-Type': 'application/json' });
                        if (!xstsResult.XErr) {
                            const xstsToken = xstsResult.Token;
                            const xstsUhs = xstsResult.DisplayClaims?.xui?.[0]?.uhs || xblUhs;
                            const mcResult = await httpClient.fetchJSONWithMethod('https://api.minecraftservices.com/authentication/login_with_xbox', 'POST', JSON.stringify({
                                identityToken: `XBL3.0 x=${xstsUhs};${xstsToken}`
                            }), { 'Content-Type': 'application/json' });
                            if (mcResult.access_token) {
                                const refreshNow = new Date();
                                account.accessToken = mcResult.access_token;
                                account.refreshToken = msRefreshTokenNew;
                                account.tokenExpiresAt = refreshNow.getTime() + (msTokenResult.expires_in || 3600) * 1000;
                                account.lastRefreshed = refreshNow.toISOString();
                                try {
                                    const refreshProfile = await httpClient.fetchJSONWithAuth('https://api.minecraftservices.com/minecraft/profile', mcResult.access_token);
                                    if (refreshProfile && refreshProfile.skins && Array.isArray(refreshProfile.skins)) {
                                        const activeSkin = refreshProfile.skins.find(s => s.state === 'ACTIVE');
                                        if (activeSkin) {
                                            account.skinUrl = activeSkin.url;
                                            account.skinModel = activeSkin.variant === 'SLIM' ? 'slim' : 'default';
                                        }
                                    }
                                    if (refreshProfile && refreshProfile.name) account.username = refreshProfile.name;
                                } catch (pfErr) { console.warn(`[Auth] Refresh skin failed: ${pfErr.message}`); }
                                const accts2 = accounts.loadAccounts();
                                const idx = accts2.findIndex(a => a.id === account.id);
                                if (idx >= 0) { accts2[idx] = { ...accts2[idx], ...account }; accounts.saveAccounts(accts2); }
                                console.log(`[Auth] Token refreshed successfully for: ${account.username}`);
                            }
                        }
                    } else {
                        console.warn(`[Auth] Token refresh failed for ${account.username}: ${msTokenResult.error}`);
                    }
                } catch (e) {
                    console.warn(`[Auth] Token refresh error for ${account.username}: ${e.message}`);
                }
            }
        } catch (e) {
            console.warn(`[Auth] Auto-refresh startup error: ${e.message}`);
        }
    }, 2000);
}

// ============================================================================
// 模块导出 - 保持与原 server.js 相同的 7 个函数签名
// ============================================================================
module.exports = {
    handleNativeAPI,
    handleNativeSSE,
    logStartupInfo,
    importModpackFromPath: modpack.importModpackFromPath,
    cleanupOnShutdown,
    validateInstalledVersions: versions.validateInstalledVersions,
    setMainWindow: ctx.setMainWindow
};

// ============================================================================
// 进程事件监听 - 退出时保存磁盘缓存
// ============================================================================
process.on('exit', () => versions.saveDiskCache());
process.on('SIGINT', () => { versions.saveDiskCache(); process.exit(); });
process.on('SIGTERM', () => { versions.saveDiskCache(); process.exit(); });

/* @versepc-protected: anti-ai-plagiarism-v1.0 */
