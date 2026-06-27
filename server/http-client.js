/**
 * server/http-client.js - HTTP/下载功能模块
 * ============================================================================
 * 从 server.js 抽取的 HTTP 请求、文件下载、镜像选择等功能。
 * 通过 ctx (./context) 访问共享状态，通过 utils (./utils) 访问工具函数。
 */

const http = require('http');
const https = require('https');
const http2 = require('http2');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const url = require('url');
const { execSync, exec } = require('child_process');

const ctx = require('./context');
const utils = require('./utils');

// ============================================================================
// 本地 loadSettingsCached - 使用 ctx 缓存，行为与 server.js 中一致
// ============================================================================
function loadSettingsCached() {
    const now = Date.now();
    if (ctx.caches._settingsCache && (now - ctx.caches._settingsCacheTime) < ctx.caches.SETTINGS_CACHE_TTL) {
        return ctx.caches._settingsCache;
    }
    const defaults = {
        javaPath: '',
        maxMemory: 4096,
        minMemory: 1024,
        gameDir: ctx.dirs.DATA_DIR,
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
        maxThreads: 16,
        enableChunkDownload: true,
        maxChunksPerFile: 32,
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
        autoSetChinese: true,
        jvmPreheat: true,
        enableCds: true
    };

    const saved = utils.safeReadJsonFile(ctx.dirs.SETTINGS_FILE, null);
    ctx.caches._settingsCache = saved ? { ...defaults, ...saved } : defaults;
    ctx.caches._settingsCacheTime = now;
    return ctx.caches._settingsCache;
}

// ============================================================================
// 基础 HTTP 请求
// ============================================================================

function fetchWithProtocol(targetUrl, options = {}) {
    const mod = targetUrl.startsWith('https') ? https : http;
    return new Promise((resolve, reject) => {
        const req = mod.get(targetUrl, options, resolve);
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function cachedFetchJSON(urlStr, cacheTTL, retriesOrHeaders, timeoutMs) {
    const cached = ctx.caches._apiCache.get(urlStr);
    if (cached && Date.now() - cached.ts < cacheTTL) return Promise.resolve(cached.data);
    return fetchJSON(urlStr, retriesOrHeaders, timeoutMs).then(data => {
        ctx.caches._apiCache.set(urlStr, { data, ts: Date.now() });
        if (ctx.caches._apiCache.size > 2000) {
            const now = Date.now();
            for (const [k, v] of ctx.caches._apiCache) {
                if (now - v.ts > cacheTTL * 2) ctx.caches._apiCache.delete(k);
            }
        }
        return data;
    });
}


function _fetchOnce(url, headers, timeout, retries = 0) {
    const mod = url.startsWith('https') ? https : http;
    const agent = url.startsWith('https') ? ctx.httpAgents.SHARED_HTTPS_AGENT : ctx.httpAgents.SHARED_HTTP_AGENT;
    const reqHeaders = { ...headers, 'Accept-Encoding': 'gzip, deflate, br' };
    return new Promise((resolve, reject) => {
        const req = mod.get(url, { headers: reqHeaders, agent, timeout }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                req.destroy();
                return _fetchOnce(res.headers.location, headers, timeout, retries).then(resolve).catch(reject);
            }
            if (res.statusCode === 429) {
                res.destroy();
                const retryAfter = parseInt(res.headers['retry-after'] || '0', 10) || 3;
                const waitMs = Math.min(retryAfter * 1000, 15000);
                if (retries < 2) {
                    console.warn(`[fetchOnce] 429 限流，等待 ${waitMs}ms 后重试 (${url.substring(0, 60)}...)`);
                    setTimeout(() => _fetchOnce(url, headers, timeout, retries + 1).then(resolve).catch(reject), waitMs);
                } else {
                    reject(new Error(`HTTP 429 限流，已重试 ${retries} 次`));
                }
                return;
            }
            if (res.statusCode !== 200) { res.destroy(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
            const encoding = (res.headers['content-encoding'] || '').toLowerCase();
            let stream = res;
            if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
            else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
            else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
            let data = '';
            stream.on('data', chunk => { data += chunk; });
            stream.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`JSON解析失败: ${e.message}`)); }
            });
            stream.on('error', reject);
        });
        req.on('timeout', () => { req.destroy(); reject(new Error(`请求超时 (${timeout}ms)`)); });
        req.on('error', reject);
    });
}

function _isMirrorAvailable() {
    if (ctx.caches._mirrorHealth.down && Date.now() < ctx.caches._mirrorHealth.until) return false;
    if (ctx.caches._mirrorHealth.down && Date.now() >= ctx.caches._mirrorHealth.until) {
        ctx.caches._mirrorHealth.down = false;
        ctx.caches._mirrorHealth.fails = 0;
    }
    return true;
}
function _mirrorFailed() {
    ctx.caches._mirrorHealth.fails++;
    if (ctx.caches._mirrorHealth.fails >= 3) {
        ctx.caches._mirrorHealth.down = true;
        ctx.caches._mirrorHealth.until = Date.now() + 60 * 1000;
        console.warn(`[Mirror] 镜像连续失败${ctx.caches._mirrorHealth.fails}次，暂停使用1分钟`);
    }
}
function _mirrorSuccess() {
    ctx.caches._mirrorHealth.fails = 0;
    ctx.caches._mirrorHealth.down = false;
}

async function fetchJSON(urlStr, retriesOrHeaders = 3, timeoutMs) {
    let extraHeaders = {};
    if (typeof retriesOrHeaders === 'object' && retriesOrHeaders !== null) {
        extraHeaders = retriesOrHeaders;
    }
    const reqTimeout = typeof timeoutMs === 'number' ? timeoutMs : 20000;

    let mirrorUrl = null;
    if (urlStr.startsWith(ctx.urls.MODRINTH_API)) {
        mirrorUrl = urlStr.replace(ctx.urls.MODRINTH_API, ctx.urls.MODRINTH_API_MIRROR);
    } else if (urlStr.startsWith(ctx.urls.CURSEFORGE_API)) {
        mirrorUrl = urlStr.replace(ctx.urls.CURSEFORGE_API, ctx.urls.CURSEFORGE_API_MIRROR);
    }

    const headers = { 'User-Agent': 'VersePC/2.0 (PCL2)', 'Connection': 'keep-alive', ...extraHeaders };
    const useMirror = mirrorUrl && _isMirrorAvailable();
    const steps = useMirror
        ? [{ url: mirrorUrl, t: 4000, isMirror: true }, { url: urlStr, t: Math.min(reqTimeout, 10000) }, { url: urlStr, t: reqTimeout }]
        : [{ url: urlStr, t: Math.min(reqTimeout, 10000) }, { url: urlStr, t: reqTimeout }];

    let lastErr = null;
    for (const step of steps) {
        try {
            const result = await _fetchOnce(step.url, headers, step.t);
            if (step.isMirror) _mirrorSuccess();
            return result;
        } catch (e) {
            lastErr = e;
            if (step.isMirror) _mirrorFailed();
            console.warn(`[fetchJSON] ${step.url.substring(0, 80)}... 失败: ${e.message} (超时${step.t}ms)`);
        }
    }
    throw lastErr || new Error('fetchJSON failed: ' + urlStr.substring(0, 80));
}

function fetchText(urlStr) {
    return new Promise((resolve, reject) => {
        const mod = urlStr.startsWith('https') ? https : http;
        const req = mod.get(urlStr, { headers: { 'User-Agent': 'VersePC/1.0' }, timeout: 15000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchText(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
        req.on('error', reject);
    });
}

async function fetchWithRacing(tasks, timeout = 15000) {
    return Promise.any(tasks.map(async ({ fetchFn, label }) => {
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timeout`)), timeout)
        );
        const result = await Promise.race([fetchFn(), timeoutPromise]);
        if (!result || (Array.isArray(result) && result.length === 0)) {
            throw new Error(`${label} returned empty`);
        }
        return result;
    }));
}

// ============================================================================
// HTTP GET (支持 Range / 重定向)
// ============================================================================

function httpGet(urlStr, opts = {}, _redirectCount = 0) {
    if (_redirectCount > 5) return Promise.reject(new Error('Too many redirects'));
    return new Promise((resolve, reject) => {
        const isHttps = urlStr.startsWith('https');
        const mod = isHttps ? https : http;
        const agent = opts.agent || (isHttps ? ctx.httpAgents.SHARED_HTTPS_AGENT : ctx.httpAgents.SHARED_HTTP_AGENT);
        const headers = { 'User-Agent': 'VersePC/2.0 (PCL2)', 'Connection': 'keep-alive', ...opts.headers };
        if (opts.start !== undefined) {
            headers['Range'] = opts.end !== undefined ? `bytes=${opts.start}-${opts.end}` : `bytes=${opts.start}-`;
        }
        const req = mod.get(urlStr, { headers, agent }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.destroy();
                const nu = res.headers.location.startsWith('http')
                    ? res.headers.location
                    : new URL(res.headers.location, urlStr).toString();
                return httpGet(nu, opts, _redirectCount + 1).then(resolve).catch(reject);
            }
            resolve({ stream: res, statusCode: res.statusCode, headers: res.headers,
                contentLength: parseInt(res.headers['content-length'] || '0', 10), request: req });
        });
        req.on('error', reject);
        req.setTimeout(opts.timeout || 30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    });
}

// ============================================================================
// HTTP/2 多线程分块下载
// ============================================================================

async function downloadFileH2(url, destPath, options = {}) {
    const { onProgress = null, timeout = 600000, abortSignal = null } = options;
    // [CRITICAL] H2下载前清理路径中与目录同名的文件。
    // 此函数不调用 ensureDir，需要自行处理 ENOTDIR 问题（同 ensureDir 的原理）。
    // [AI-AUTOGEN-WARNING] 请勿删除此处的文件清理块。
    const dir = path.dirname(destPath);
    try {
        const parts = dir.split(path.sep);
        for (let i = 1; i <= parts.length; i++) {
            const partial = parts.slice(0, i).join(path.sep);
            if (partial) {
                try {
                    const st = await fs.promises.stat(partial);
                    if (!st.isDirectory()) await fs.promises.unlink(partial);
                } catch (_) {}
            }
        }
    } catch (_) {}
    await fs.promises.mkdir(dir, { recursive: true });

    const _pclAgent = new https.Agent({
        keepAlive: true,
        maxSockets: 200,
        maxFreeSockets: 128,
        timeout: timeout || 120000,
        keepAliveMsecs: 300000,
        scheduling: 'fifo'
    });

    try {
        const probeRes = await new Promise((resolve, reject) => {
            const req = https.get(url, {
                method: 'HEAD',
                agent: _pclAgent,
                headers: { 'User-Agent': 'VersePC/2.0 (PCL2)' }
            }, (res) => { resolve({ statusCode: res.statusCode, headers: res.headers }); res.destroy(); });
            req.on('error', reject);
            req.setTimeout(15000, () => { req.destroy(); reject(new Error('probe timeout')); });
        });

        let fileSize = 0, supportsRange = false;
        if (probeRes.statusCode === 206) {
            supportsRange = true;
            const cr = probeRes.headers['content-range'] || '';
            const m = cr.match(/\/(\d+)/);
            fileSize = m ? parseInt(m[1], 10) : parseInt(probeRes.headers['content-length'] || '0', 10);
        } else if (probeRes.statusCode === 200) {
            supportsRange = (probeRes.headers['accept-ranges'] === 'bytes');
            fileSize = parseInt(probeRes.headers['content-length'] || '0', 10);
        }
        if (fileSize <= 0) throw new Error('H2: 无法获取文件大小');

        if (!supportsRange || fileSize <= 1 * 1024 * 1024) {
            await new Promise((resolve, reject) => {
                if (abortSignal && abortSignal.aborted) { reject(new Error('已取消')); return; }
                const req = https.get(url, {
                    agent: _pclAgent,
                    headers: { 'User-Agent': 'VersePC/2.0 (PCL2)' }
                }, (res) => {
                    if (res.statusCode >= 400) { res.destroy(); reject(new Error(`H2 HTTP ${res.statusCode}`)); return; }
                    let dl = 0;
                    const ws = fs.createWriteStream(destPath);
                    res.on('data', (chunk) => {
                        dl += chunk.length;
                        ws.write(chunk);
                        ctx.DownloadManager.recordProgress(chunk.length);
                        if (onProgress && fileSize > 0) onProgress({ progress: Math.round((dl / fileSize) * 100), downloaded: dl, total: fileSize, speed: ctx.DownloadManager.getSpeed() });
                    });
                    res.on('end', () => { ws.end(); ws.on('finish', resolve); });
                    res.on('error', reject);
                });
                req.on('error', reject);
                if (abortSignal) abortSignal.addEventListener('abort', () => { req.destroy(); reject(new Error('已取消')); }, { once: true });
            });
            return;
        }

        const cCount = Math.min(16, Math.ceil(fileSize / (512 * 1024)));
        const cSize = Math.ceil(fileSize / cCount);
        const chunks = [];
        for (let i = 0; i < cCount; i++) {
            chunks.push({ i, s: i * cSize, e: Math.min((i + 1) * cSize - 1, fileSize - 1), tmp: `${destPath}.c${i}` });
        }
        const cProg = new Array(cCount).fill(0);
        let lastProgUpdate = Date.now();

        const dlChunk = (c) => new Promise((resolve, reject) => {
            if (abortSignal && abortSignal.aborted) { reject(new Error('已取消')); return; }
            const req = https.get(url, {
                agent: _pclAgent,
                headers: { 'Range': `bytes=${c.s}-${c.e}`, 'User-Agent': 'VersePC/2.0 (PCL2)' }
            }, (res) => {
                if (res.statusCode !== 206 && res.statusCode !== 200) { res.destroy(); reject(new Error(`H2 chunk ${c.i}: HTTP ${res.statusCode}`)); return; }
                let dl = 0;
                const ws = fs.createWriteStream(c.tmp);
                let stalled = setTimeout(() => { res.destroy(); reject(new Error(`chunk ${c.i} stall`)); }, 60000);
                res.on('data', (chunk) => {
                    clearTimeout(stalled);
                    stalled = setTimeout(() => { res.destroy(); reject(new Error(`chunk ${c.i} stall`)); }, 60000);
                    dl += chunk.length;
                    ws.write(chunk);
                    cProg[c.i] = dl;
                    const now = Date.now();
                    if (now - lastProgUpdate >= 200) {
                        lastProgUpdate = now;
                        const total = cProg.reduce((a, b) => a + b, 0);
                        ctx.DownloadManager.recordProgress(total - (downloadFileH2._lastTotal || 0));
                        downloadFileH2._lastTotal = total;
                        if (onProgress) onProgress({ progress: Math.round((total / fileSize) * 100), downloaded: total, total: fileSize, speed: ctx.DownloadManager.getSpeed() });
                    }
                });
                res.on('end', () => { clearTimeout(stalled); ws.end(); ws.on('finish', resolve); });
                res.on('error', (e) => { clearTimeout(stalled); reject(e); });
            });
            req.on('error', reject);
            if (abortSignal) abortSignal.addEventListener('abort', () => { req.destroy(); reject(new Error('已取消')); }, { once: true });
        });

        downloadFileH2._lastTotal = 0;
        await Promise.all(chunks.map(c => dlChunk(c)));
        const buffers = [];
        for (const c of chunks) {
            buffers.push(await fs.promises.readFile(c.tmp));
            try { fs.unlinkSync(c.tmp); } catch (_) {}
        }
        await fs.promises.writeFile(destPath, Buffer.concat(buffers));
    } finally {
        try { _pclAgent.destroy(); } catch (_) {}
    }
}

// ============================================================================
// 多线程分块下载 (HTTP/1.1 Range)
// ============================================================================

async function downloadFileChunked(url, destPath, options = {}) {
    const { retries = 3, onProgress = null, sha1 = null, timeout = 120000, mirrors = null, abortSignal = null, agent: customAgent = null, maxChunks: optMaxChunks = null } = options;
    const minChunkSize = 512 * 1024;
    const CHUNK_THRESHOLD = 1 * 1024 * 1024;
    // [CRITICAL] 分块下载前清理路径中与目录同名的文件。
    // 此函数不调用 ensureDir，需要自行处理 ENOTDIR 问题（同 ensureDir 的原理）。
    // [AI-AUTOGEN-WARNING] 请勿删除此处的文件清理块。
    {
        const d = path.dirname(destPath);
        try {
            for (const p of d.split(path.sep).map((_, i, a) => a.slice(0, i + 1).join(path.sep))) {
                if (p) { try { const s = await fs.promises.stat(p); if (!s.isDirectory()) await fs.promises.unlink(p); } catch (_) {} }
            }
        } catch (_) {}
        await fs.promises.mkdir(d, { recursive: true });
    }

    // 优先使用传入的 mirrors（已排序），否则内部生成
    const allUrls = (mirrors && mirrors.length > 0) ? mirrors : getMirrorUrls(url);
    const _agent = customAgent || undefined;

    for (let ra = 0; ra <= retries; ra++) {
        if (abortSignal && abortSignal.aborted) throw new Error('下载已取消');
        for (let urlIdx = 0; urlIdx < allUrls.length; urlIdx++) {
            if (abortSignal && abortSignal.aborted) throw new Error('下载已取消');
            const currentUrl = allUrls[urlIdx];
            try {
                let fileSize = 0, supportsRange = false, workingUrl = currentUrl;
                const probeR = await httpGet(currentUrl, { start: 0, end: 0, timeout: 2000, agent: _agent });
                probeR.stream.destroy();
                if (probeR.statusCode === 206) {
                    supportsRange = true;
                    workingUrl = currentUrl;
                    const crMatch = (probeR.headers['content-range'] || '').match(/\/(\d+)/);
                    fileSize = crMatch ? parseInt(crMatch[1], 10) : probeR.contentLength;
                } else if (probeR.statusCode === 200) {
                    supportsRange = (probeR.headers['accept-ranges'] === 'bytes');
                    fileSize = probeR.contentLength;
                    workingUrl = currentUrl;
                }
                if (fileSize <= 0) {
                    for (let probeIdx = urlIdx + 1; probeIdx < allUrls.length; probeIdx++) {
                        try {
                            const r2 = await httpGet(allUrls[probeIdx], { start: 0, end: 0, timeout: 2000, agent: _agent });
                            r2.stream.destroy();
                            if (r2.statusCode === 206) {
                                supportsRange = true;
                                workingUrl = allUrls[probeIdx];
                                const crMatch = (r2.headers['content-range'] || '').match(/\/(\d+)/);
                                fileSize = crMatch ? parseInt(crMatch[1], 10) : r2.contentLength;
                            } else if (r2.statusCode === 200) {
                                supportsRange = (r2.headers['accept-ranges'] === 'bytes');
                                fileSize = r2.contentLength;
                                workingUrl = allUrls[probeIdx];
                            }
                            if (fileSize > 0) break;
                        } catch (e) { continue; }
                    }
                }
                const settings = loadSettingsCached();
                const useChunk = settings.enableChunkDownload && supportsRange && fileSize > CHUNK_THRESHOLD;
                if (!useChunk || fileSize <= 0) {
                    return await _dlSingle(workingUrl, destPath, { onProgress, sha1, timeout, abortSignal, agent: customAgent });
                }
                const maxC = optMaxChunks !== null ? optMaxChunks : Math.min(parseInt(settings.maxChunksPerFile, 10) || 16, 32);
                const cCount = Math.min(maxC, Math.ceil(fileSize / minChunkSize));
                const cSize = Math.ceil(fileSize / cCount);
                const chunks = [];
                for (let i = 0; i < cCount; i++) {
                    chunks.push({ i, s: i * cSize, e: Math.min((i + 1) * cSize - 1, fileSize - 1), tmp: `${destPath}.c${i}` });
                }
                const cProg = new Array(cCount).fill(0);
                // 检测已下载的分块，支持续传
                const _getChunkResumeOffset = (c) => {
                    try {
                        if (!fs.existsSync(c.tmp)) return 0;
                        const stat = fs.statSync(c.tmp);
                        const expected = c.e - c.s + 1;
                        if (stat.size > expected) return 0;   // 文件过大，重新下载
                        if (stat.size === expected) return -1; // 已完成，跳过
                        return stat.size;                      // 返回续传偏移
                    } catch (_) { return 0; }
                };
                // 初始化进度（累加已完成分块的字节）
                for (const c of chunks) {
                    const off = _getChunkResumeOffset(c);
                    if (off === -1) cProg[c.i] = c.e - c.s + 1;
                    else if (off > 0) cProg[c.i] = off;
                }
                let lastProgUpdate = Date.now();
                const dlChunk = async (c) => {
                    if (abortSignal && abortSignal.aborted) throw new Error('下载已中止');
                    // 检测续传偏移
                    const resumeOffset = _getChunkResumeOffset(c);
                    if (resumeOffset === -1) {
                        console.log(`[MultiThread] Chunk ${c.i} 已完成，跳过`);
                        return;
                    }
                    while (!ctx.DownloadManager.acquireConnection()) {
                        if (abortSignal && abortSignal.aborted) throw new Error('下载已中止');
                        await new Promise(r => setTimeout(r, 50));
                    }
                    try {
                        // 续传时调整 Range 起始位置
                        const startByte = c.s + resumeOffset;
                        const cr = await httpGet(workingUrl, { start: startByte, end: c.e, timeout, agent: _agent });
                        if (abortSignal && abortSignal.aborted) {
                            cr.stream.destroy();
                            throw new Error('下载已中止');
                        }
                        if (cr.statusCode !== 200 && cr.statusCode !== 206) throw new Error(`Chunk ${c.i}: HTTP ${cr.statusCode}`);
                        // 续传时追加写入，否则覆盖写
                        const ws = fs.createWriteStream(c.tmp, resumeOffset > 0 ? { flags: 'a' } : {});
                        let dl = resumeOffset;
                        let aborted = false;
                        let stallTimer = null;
                        const resetStall = () => {
                            if (stallTimer) clearTimeout(stallTimer);
                            stallTimer = setTimeout(() => {
                                if (!aborted) {
                                    console.warn(`[MultiThread] Chunk ${c.i} stall timeout (60s), aborting...`);
                                    try { cr.stream.destroy(); } catch (_) {}
                                    try { ws.destroy(); } catch (_) {}
                                    if (_chunkReject) { try { _chunkReject(new Error(`Chunk ${c.i} stall timeout`)); } catch (_) {} _chunkReject = null; }
                                }
                            }, 60000);
                        };
                        resetStall();
                        let _chunkReject = null;
                        const onAbort = () => {
                            aborted = true;
                            if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
                            if (cr.stream) try { cr.stream.destroy(); } catch (_) {}
                            if (ws) try { ws.destroy(); } catch (_) {}
                            if (_chunkReject) { try { _chunkReject(new Error('下载已中止')); } catch (_) {} _chunkReject = null; }
                        };
                        if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });
                        return new Promise((resolve, reject) => {
                            _chunkReject = reject;
                            cr.stream.on('data', (d) => {
                                dl += d.length;
                                ctx.DownloadManager.recordProgress(d.length);
                                cProg[c.i] = dl;
                                resetStall();
                                if (onProgress && Date.now() - lastProgUpdate > 50) {
                                    lastProgUpdate = Date.now();
                                    const t = cProg.reduce((a, b) => a + b, 0);
                                    onProgress({ bytesDownloaded: t, totalBytes: fileSize, speed: ctx.DownloadManager.getSpeed(),
                                        progress: Math.min(99.9, (t / fileSize) * 100), chunks: cCount, activeChunks: ctx.DownloadManager.activeConnections });
                                }
                            });
                            cr.stream.pipe(ws);
                            ws.on('finish', () => {
                                _chunkReject = null;
                                if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
                                ws.close();
                                if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
                                if (aborted) return;
                                resolve();
                            });
                            ws.on('error', (err) => {
                                _chunkReject = null;
                                if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
                                if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
                                reject(err);
                            });
                            cr.stream.on('error', (err) => {
                                _chunkReject = null;
                                if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
                                if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
                                reject(err);
                            });
                        }).then(() => {
                            if (onProgress) {
                                const t = cProg.reduce((a, b) => a + b, 0);
                                onProgress({ bytesDownloaded: t, totalBytes: fileSize, speed: ctx.DownloadManager.getSpeed(),
                                    progress: Math.min(99.9, (t / fileSize) * 100), chunks: cCount, activeChunks: ctx.DownloadManager.activeConnections });
                            }
                        });
                    } finally { ctx.DownloadManager.releaseConnection(); }
                };
                try {
                await Promise.all(chunks.map(c => dlChunk(c)));
                await new Promise((resolve, reject) => {
                    const ws = fs.createWriteStream(destPath);
                    let idx = 0;
                    let mergedBytes = 0;
                    let lastMergeProg = Date.now();
                    const writeNext = () => {
                        if (idx >= chunks.length) { ws.end(); return; }
                        const rs = fs.createReadStream(chunks[idx].tmp);
                        rs.on('data', (d) => {
                            mergedBytes += d.length;
                            if (onProgress && Date.now() - lastMergeProg > 100) {
                                lastMergeProg = Date.now();
                                onProgress({ bytesDownloaded: mergedBytes, totalBytes: fileSize, speed: 0,
                                    progress: Math.min(99.9, (mergedBytes / fileSize) * 100), chunks: cCount, activeChunks: 0, merging: true });
                            }
                        });
                        rs.on('end', () => { idx++; writeNext(); });
                        rs.on('error', reject);
                        rs.pipe(ws, { end: false });
                    };
                    ws.on('finish', () => { ws.close(); resolve(); });
                    ws.on('error', reject);
                    writeNext();
                });
                // 合并成功后清理临时分块
                for (const c of chunks) { try { await fs.promises.unlink(c.tmp); } catch (e) {} }
            } catch (e) {
                // 保留临时分块文件，支持下次重试续传（仅清理可能不完整的目标文件）
                try { await fs.promises.unlink(destPath); } catch (_) {}
                throw e;
            }
                if (sha1) {
                    const actual = await utils.calculateSHA1(destPath);
                    if (actual !== sha1) {
                        console.warn(`[MultiThread] SHA1 mismatch on ${allUrls[urlIdx]}: ${path.basename(destPath)}`);
                        await fs.promises.unlink(destPath).catch(() => {});
                        // SHA1 失败时清理分块，避免损坏数据续传
                        for (const c of chunks) { try { await fs.promises.unlink(c.tmp); } catch (_) {} }
                        if (urlIdx < allUrls.length - 1) {
                            console.log(`[MultiThread] Switching mirror: ${allUrls[urlIdx]} -> ${allUrls[urlIdx + 1]}`);
                            continue;
                        }
                        if (ra < retries) continue;
                        return { size: fileSize, path: destPath, sha1Match: false, chunks: cCount };
                    }
                }
                if (onProgress) onProgress({ bytesDownloaded: fileSize, totalBytes: fileSize, speed: 0, progress: 100, chunks: cCount, activeChunks: 0 });
                console.log(`[MultiThread] Done: ${path.basename(destPath)} (${cCount}x, ${utils.formatSize(fileSize)}) from ${workingUrl}`);
                return { size: fileSize, path: destPath, sha1Match: sha1 ? true : undefined, chunks: cCount };
            } catch (err) {
                console.warn(`[MultiThread] URL ${currentUrl} failed: ${err.message}`);
                if (urlIdx < allUrls.length - 1) {
                    console.log(`[MultiThread] Switching mirror: ${currentUrl} -> ${allUrls[urlIdx + 1]}`);
                    continue;
                }
                if (ra < retries) {
                    console.warn(`[MultiThread] Retry ${ra + 1}/${retries}`);
                    // 保留临时分块文件用于续传，仅清理目标文件
                    try { fs.unlinkSync(destPath); } catch (e) {}
                    await new Promise(r => setTimeout(r, Math.min(1000 * (ra + 1), 5000) + Math.floor(Math.random() * 500)));
                } else {
                    // 所有重试耗尽，清理临时文件
                    for (let i = 0; i < 64; i++) { try { fs.unlinkSync(`${destPath}.c${i}`); } catch (e) {} }
                    try { fs.unlinkSync(destPath); } catch (e) {}
                    throw err;
                }
            }
        }
    }
}

// ============================================================================
// 单流下载 (带重试 / SHA1 / JAR 完整性检查)
// ============================================================================

async function _dlSingle(urlStr, destPath, options = {}) {
    const { onProgress = null, sha1 = null, timeout = 60000, retries = 3, abortSignal = null, stallTimeout = 60000, agent: customAgent = null } = options;
    const isHttps = urlStr.startsWith('https');
    const agent = customAgent || (isHttps ? ctx.httpAgents.SHARED_HTTPS_AGENT : ctx.httpAgents.SHARED_HTTP_AGENT);
    while (!ctx.DownloadManager.acquireConnection()) {
        if (abortSignal && abortSignal.aborted) throw new Error('下载已中止');
        await new Promise(r => setTimeout(r, 50));
    }
    const tmpPath = destPath + '.downloading';
    let settled = false;
    try {
        if (abortSignal && abortSignal.aborted) throw new Error('下载已中止');
        return await new Promise((resolve, reject) => {
            const doReject = (e) => { if (!settled) { settled = true; reject(e); } };
            const doResolve = (v) => { if (!settled) { settled = true; resolve(v); } };
            let currentAbortHandler = null;
            const removeAbortListener = () => {
                if (currentAbortHandler && abortSignal) {
                    try { abortSignal.removeEventListener('abort', currentAbortHandler); } catch (_) {}
                    currentAbortHandler = null;
                }
            };
            const attempt = (rc) => {
                if (settled) return;
                if (abortSignal && abortSignal.aborted) { doReject(new Error('下载已中止')); return; }
                removeAbortListener();
                const mod = urlStr.startsWith('https') ? https : http;
                utils.ensureDir(destPath);
                const reqHeaders = { 'User-Agent': 'VersePC/2.0 (PCL2)', 'Connection': 'keep-alive' };
                // 检测续传偏移
                let resumeOffset = 0;
                try {
                    if (fs.existsSync(tmpPath)) {
                        const stat = fs.statSync(tmpPath);
                        if (stat.size > 0) resumeOffset = stat.size;
                    }
                } catch (_) {}
                if (resumeOffset > 0) {
                    reqHeaders['Range'] = `bytes=${resumeOffset}-`;
                    console.log(`[Download] 续传 ${path.basename(destPath)} 从 ${resumeOffset} 字节开始`);
                }
                let ws = null;
                let cleaned = false;
                let stallTimer = null;
                // keepTmp=true 时保留临时文件供续传，keepTmp=false 时删除
                const clean = (keepTmp = false) => {
                    if (cleaned) return; cleaned = true;
                    try { if (ws) ws.destroy(); } catch (_) {}
                    if (!keepTmp) fs.promises.unlink(tmpPath).catch(() => {});
                    fs.promises.unlink(destPath).catch(() => {});
                    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
                };
                const resetStall = () => {
                    if (stallTimer) clearTimeout(stallTimer);
                    stallTimer = setTimeout(() => {
                        if (!settled && !cleaned) {
                            try { if (onProgress) onProgress({ bytesDownloaded: resumeOffset, totalBytes: 0, speed: 0, progress: 0, chunks: 1, activeChunks: 1, stall: true }); } catch (_) {}
                            try { req.destroy(); } catch (_) {}
                            clean(true);  // 保留临时文件供续传
                            if (rc > 0) {
                                setTimeout(() => attempt(rc - 1), 1000);
                            } else {
                                doReject(new Error(`Stall timeout: ${urlStr}`));
                            }
                        }
                    }, stallTimeout);
                };
                currentAbortHandler = () => {
                    try { req.destroy(); } catch (_) {}
                    clean(false);  // 用户取消，删除临时文件
                    doReject(new Error('下载已中止'));
                };
                if (abortSignal) {
                    if (abortSignal.aborted) { currentAbortHandler(); return; }
                    abortSignal.addEventListener('abort', currentAbortHandler, { once: true });
                }
                resetStall();
                const req = mod.get(urlStr, { headers: reqHeaders, agent }, (res) => {
                    if (settled) { res.destroy(); return; }
                    if (abortSignal && abortSignal.aborted) { res.destroy(); clean(false); doReject(new Error('下载已中止')); return; }
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        clean(false);  // 重定向到新 URL，删除临时文件
                        const nu = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, urlStr).toString();
                        return _dlSingle(nu, destPath, { onProgress, sha1, timeout, retries: rc, abortSignal, stallTimeout }).then(doResolve).catch(doReject);
                    }
                    // 206 = 续传成功，追加写入；200 = 服务器不支持续传，覆盖写入
                    const isResume = (res.statusCode === 206 && resumeOffset > 0);
                    if (res.statusCode !== 200 && res.statusCode !== 206) { clean(false); doReject(new Error(`HTTP ${res.statusCode} for ${urlStr}`)); return; }
                    // 206 响应的 content-length 是剩余字节数，总大小需加上 resumeOffset
                    const contentLen = parseInt(res.headers['content-length'] || '0', 10);
                    const tSz = isResume ? (resumeOffset + contentLen) : contentLen;
                    let dl = resumeOffset;
                    ws = fs.createWriteStream(tmpPath, isResume ? { flags: 'a' } : {});
                    res.on('data', (ch) => {
                        if (settled) { res.destroy(); return; }
                        dl += ch.length; ctx.DownloadManager.recordProgress(ch.length);
                        resetStall();
                        try { if (onProgress) onProgress({ bytesDownloaded: dl, totalBytes: tSz, speed: ctx.DownloadManager.getSpeed(), progress: tSz > 0 ? (dl / tSz * 100) : 0, chunks: 1, activeChunks: 1 }); } catch (_) {}
                    });
                    res.pipe(ws);
                    res.on('error', (e) => {
                        try { ws.destroy(); } catch (_) {}
                        clean(true);  // 保留临时文件供续传
                        if (settled) return;
                        if (rc > 0) { setTimeout(() => attempt(rc - 1), 1000 + Math.random() * 500); }
                        else { doReject(e); }
                    });
                    ws.on('finish', async () => {
                        try {
                            if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
                            ws.close();
                            if (settled) return;
                            if (sha1) { const a = await utils.calculateSHA1(tmpPath); if (a !== sha1) { clean(false); if (rc > 0 && !settled) { setTimeout(() => attempt(rc - 1), 1000); } else { doReject(new Error(`SHA1 mismatch: ${path.basename(destPath)}`)); } return; } }
                            if (tSz > 0 && dl !== tSz) { clean(true); if (rc > 0 && !settled) { setTimeout(() => attempt(rc - 1), 1000); } else { doReject(new Error(`Size mismatch: ${path.basename(destPath)} expected=${tSz} got=${dl}`)); } return; }
                            if (dl === 0) { clean(false); if (rc > 0 && !settled) { setTimeout(() => attempt(rc - 1), 1000); } else { doReject(new Error(`Empty file: ${path.basename(destPath)}`)); } return; }
                            if (destPath.toLowerCase().endsWith('.jar') && !utils.isJarIntact(tmpPath)) {
                                const fileSize = dl || (fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0);
                                if (fileSize > 1000) {
                                    console.warn(`[Download] JAR文件ZIP结构不完整: ${path.basename(destPath)} (${fileSize} bytes)，尝试重新下载`);
                                    clean(false);  // JAR 损坏，删除重下
                                    if (rc > 0 && !settled) { setTimeout(() => attempt(rc - 1), 1000); }
                                    else { doResolve({ size: dl, path: destPath, jarWarning: true }); }
                                    return;
                                }
                            }
                            fs.renameSync(tmpPath, destPath);
                            doResolve({ size: dl, path: destPath });
                        } catch (e) {
                            console.error(`[Download] finish处理异常: ${e.message}`);
                            clean(false);
                            if (!settled) doReject(e);
                        }
                    });
                    ws.on('error', (e) => {
                        clean(true);  // 保留临时文件供续传
                        if (settled) return;
                        if (rc > 0) { setTimeout(() => attempt(rc - 1), 1000 + Math.random() * 500); }
                        else { doReject(e); }
                    });
                });
                req.on('error', (e) => {
                    clean(true);  // 保留临时文件供续传
                    if (settled) return;
                    if (rc > 0) { setTimeout(() => attempt(rc - 1), Math.min(2000 + (retries - rc) * 1000, 8000)); }
                    else { doReject(e); }
                });
                req.setTimeout(timeout, () => {
                    req.destroy(); clean(true);  // 保留临时文件供续传
                    if (settled) return;
                    if (rc > 0) { setTimeout(() => attempt(rc - 1), 2000); }
                    else { doReject(new Error(`Timeout: ${urlStr}`)); }
                });
            };
            attempt(retries);
        });
    } finally { ctx.DownloadManager.releaseConnection(); }
}

// ============================================================================
// 下载入口 (根据 host 选择分块/单流)
// ============================================================================

function downloadFile(urlStr, destPath, onProgress, retries = 3, abortSignal = null) {
    if (ctx.constants.NO_CHUNK_HOSTS.some(d => urlStr.includes(d))) return _dlSingle(urlStr, destPath, { onProgress, retries, abortSignal });
    return downloadFileChunked(urlStr, destPath, { onProgress, retries, abortSignal }).catch(err => {
        if (abortSignal && abortSignal.aborted) throw err;
        console.log(`[MultiThread] Chunked failed, fallback single: ${err.message}`);
        return _dlSingle(urlStr, destPath, { onProgress, retries, abortSignal });
    });
}

// ============================================================================
// 同步下载 (curl / PowerShell 回退)
// ============================================================================

function downloadFileSync(urlStr, destPath) {
    utils.ensureDirForFile(destPath);
    try {
        execSync(`curl --silent --location --output "${destPath}" "${urlStr}"`, { timeout: 30000, windowsHide: true, stdio: 'ignore' });
    } catch (e) {
        if (process.platform === 'win32') {
            execSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
                `try { Invoke-WebRequest -Uri '${urlStr.replace(/'/g, "''")}' -OutFile '${destPath.replace(/'/g, "''")}' -UseBasicParsing } catch { exit 1 }`],
                { timeout: 30000, windowsHide: true, stdio: 'ignore' });
        } else {
            throw new Error('curl failed and no fallback available: ' + e.message);
        }
    }
}

function downloadFileSyncAsync(urlStr, destPath) {
    utils.ensureDirForFile(destPath);
    return new Promise((resolve, reject) => {
        exec(`curl --silent --location --retry 2 --connect-timeout 10 --max-time 120 --output "${destPath}" "${urlStr}"`,
            { timeout: 150000, windowsHide: true },
            (error) => {
                if (!error) return resolve();
                if (process.platform === 'win32') {
                    exec(`powershell -NoProfile -NonInteractive -Command "try { Invoke-WebRequest -Uri '${urlStr.replace(/'/g, "''")}' -OutFile '${destPath.replace(/'/g, "''")}' -UseBasicParsing -TimeoutSec 120 } catch { exit 1 }"`,
                        { timeout: 150000, windowsHide: true },
                        (err2) => err2 ? reject(err2) : resolve());
                } else {
                    reject(error);
                }
            }
        );
    });
}

// ============================================================================
// 下载到 Buffer
// ============================================================================

function downloadFileToBuffer(urlStr, onProgress, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const protocol = urlStr.startsWith('https') ? https : http;
        const req = protocol.get(urlStr, { timeout: timeoutMs }, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                const redirectUrl = response.headers.location;
                const redirectProtocol = redirectUrl.startsWith('https') ? https : http;
                redirectProtocol.get(redirectUrl, { timeout: timeoutMs }, (redirectRes) => {
                    if (redirectRes.statusCode !== 200) {
                        redirectRes.resume();
                        reject(new Error(`HTTP ${redirectRes.statusCode}`));
                        return;
                    }
                    const total = parseInt(redirectRes.headers['content-length']) || 0;
                    const chunks = [];
                    let received = 0;
                    redirectRes.on('data', (chunk) => {
                        chunks.push(chunk);
                        received += chunk.length;
                        if (total > 0 && onProgress) onProgress(received / total);
                    });
                    redirectRes.on('end', () => resolve(Buffer.concat(chunks)));
                    redirectRes.on('error', reject);
                }).on('timeout', function () { this.destroy(); reject(new Error('redirect timeout')); })
                  .on('error', reject);
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }
            const total = parseInt(response.headers['content-length']) || 0;
            const chunks = [];
            let received = 0;
            response.on('data', (chunk) => {
                chunks.push(chunk);
                received += chunk.length;
                if (total > 0 && onProgress) onProgress(received / total);
            });
            response.on('end', () => resolve(Buffer.concat(chunks)));
            response.on('error', reject);
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('download timeout')); });
        req.on('error', reject);
    });
}

// ============================================================================
// 镜像 URL 选择
// ============================================================================

function getMirrorUrls(originalUrl) {
    if (!originalUrl) return [originalUrl];
    const urls = [];
    let hasBmclapi = false;
    for (const [original, mirror] of Object.entries(ctx.mirrors.BMCLAPI_MIRROR)) {
        if (originalUrl.startsWith(original)) {
            const mirrored = originalUrl.replace(original, mirror);
            if (mirrored !== originalUrl) {
                urls.push(mirrored);
                hasBmclapi = true;
            }
            break;
        }
    }
    for (const [original, mirror] of Object.entries(ctx.mirrors.MCIM_MIRROR)) {
        if (originalUrl.startsWith(original)) {
            const mirrored = originalUrl.replace(original, mirror);
            if (mirrored !== originalUrl && !urls.includes(mirrored)) urls.push(mirrored);
            break;
        }
    }
    if (originalUrl.startsWith('https://libraries.minecraft.net/')) {
        const forgeMirror = originalUrl.replace('https://libraries.minecraft.net/', 'https://maven.minecraftforge.net/');
        if (!urls.includes(forgeMirror)) urls.push(forgeMirror);
        const bmclapiMaven = originalUrl.replace('https://libraries.minecraft.net/', 'https://bmclapi2.bangbang93.com/maven/');
        if (!urls.includes(bmclapiMaven)) urls.push(bmclapiMaven);
    }
    urls.push(originalUrl);
    return urls;
}

async function probeMirrorSpeed(urls, probeSize = 65536, timeoutMs = 5000) {
    if (!urls || urls.length <= 1) return urls;
    const probes = urls.map(async (url) => {
        const start = Date.now();
        try {
            const r = await httpGet(url, { start: 0, end: probeSize - 1, timeout: timeoutMs });
            const chunks = [];
            for await (const c of r.stream) chunks.push(c);
            const elapsed = Date.now() - start;
            const bytes = Buffer.concat(chunks).length;
            const speed = elapsed > 0 ? bytes / (elapsed / 1000) : 0;
            return { url, speed, elapsed, ok: true };
        } catch (e) {
            return { url, speed: 0, elapsed: 99999, ok: false };
        }
    });
    const results = await Promise.all(probes);
    results.sort((a, b) => b.speed - a.speed);
    const sorted = results.map(r => r.url);
    console.log(`[Mirror] 测速结果: ${results.map(r => `${r.ok ? (r.speed / 1024).toFixed(0) + 'KB/s' : 'FAIL'} ${r.url.substring(0, 60)}`).join(' | ')}`);
    return sorted;
}

function getMirrorUrl(originalUrl) {
    if (!originalUrl) return originalUrl;
    const urls = getMirrorUrls(originalUrl);
    return urls.length > 1 ? urls[1] : originalUrl;
}

// ============================================================================
// PCL 风格多线程下载
// ============================================================================

async function downloadPCLStyle(urls, destPath, { onProgress = null, maxChunks = 16, abortSignal = null, stallTimeout = 45000 } = {}) {
    // [CRITICAL] 下载前清理路径中与目录同名的文件。
    // 此函数不调用 ensureDir，需要自行处理 ENOTDIR 问题（同 ensureDir 的原理）。
    {
        const d = path.dirname(destPath);
        try {
            for (const p of d.split(path.sep).map((_, i, a) => a.slice(0, i + 1).join(path.sep))) {
                if (p) { try { const s = await fs.promises.stat(p); if (!s.isDirectory()) await fs.promises.unlink(p); } catch (_) {} }
            }
        } catch (_) {}
        await fs.promises.mkdir(d, { recursive: true }).catch(() => {});
    }
    const cleanTemp = async (base) => {
        try { if (fs.existsSync(base)) await fs.promises.unlink(base); } catch (_) {}
        for (let i = 0; i < 100; i++) { try { await fs.promises.unlink(`${base}.c${i}`); } catch (_) {} }
    };
    const httpGetFollow = (u, opts, cb, depth = 0) => {
        if (depth > 10) { cb(null); return; }
        const mod = u.startsWith('https') ? https : http;
        const agent = u.startsWith('https') ? ctx.httpAgents.SHARED_HTTPS_AGENT : ctx.httpAgents.SHARED_HTTP_AGENT;
        const req = mod.get(u, { ...opts, agent }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                const loc = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, u).toString();
                httpGetFollow(loc, opts, cb, depth + 1);
                return;
            }
            cb(res);
        });
        return req;
    };
    let lastErr = null;
    for (const url of urls) {
        if (abortSignal && abortSignal.aborted) throw new Error('下载已取消');
        try {
            await cleanTemp(destPath);
            let totalSize = 0;
            let chunkFailed = false;
            const chunkSize = 512 * 1024;
            const tryChunk0 = await new Promise((resolve, reject) => {
                let settled = false;
                const done = (v) => { if (settled) return; settled = true; resolve(v); };
                const req = httpGetFollow(url, { headers: { 'User-Agent': 'VersePC/2.0', Range: `bytes=0-${chunkSize - 1}` } }, (res) => {
                    if (!res) { done({ ok: false }); return; }
                    if (res.statusCode === 206) {
                        const cm = (res.headers['content-range'] || '').match(/\/(\d+)/);
                        totalSize = cm ? parseInt(cm[1], 10) : 0;
                        const ws = fs.createWriteStream(`${destPath}.c0`);
                        let bytes = 0;
                        res.on('data', (d) => { bytes += d.length; ctx.DownloadManager.recordProgress(d.length); });
                        res.pipe(ws);
                        ws.on('finish', () => { ws.close(); done({ ok: true, bytes }); });
                        ws.on('error', () => { try { ws.destroy(); } catch (_) {} done({ ok: false }); });
                        res.on('error', () => { try { ws.destroy(); } catch (_) {} done({ ok: false }); });
                    } else if (res.statusCode === 200) {
                        res.resume();
                        const cl = parseInt(res.headers['content-length'] || '0', 10);
                        done({ ok: false, single: true, totalSize: cl });
                    } else {
                        res.resume();
                        done({ ok: false });
                    }
                });
                if (req) { req.on('error', () => done({ ok: false })); req.on('timeout', () => { req.destroy(); done({ ok: false }); }); }
                if (abortSignal) abortSignal.addEventListener('abort', () => done({ ok: false }), { once: true });
                setTimeout(() => done({ ok: false }), 8000);
            });
            if (tryChunk0.ok && totalSize > 8 * 1024 * 1024 && maxChunks > 1) {
                const chunkCount = Math.min(maxChunks, Math.ceil(totalSize / chunkSize));
                const chunks = [{ i: 0, s: 0, e: chunkSize - 1, tmp: `${destPath}.c0`, done: true, bytes: tryChunk0.bytes }];
                for (let i = 1; i < chunkCount; i++) {
                    chunks.push({ i, s: i * chunkSize, e: Math.min((i + 1) * chunkSize - 1, totalSize - 1), tmp: `${destPath}.c${i}`, done: false, bytes: 0 });
                }
                const cProg = chunks.map(c => c.bytes);
                let lastProg = Date.now();
                const dlChunk = async (c) => {
                    if (abortSignal && abortSignal.aborted) throw new Error('下载已取消');
                    while (!ctx.DownloadManager.acquireConnection()) {
                        if (abortSignal && abortSignal.aborted) throw new Error('下载已取消');
                        await new Promise(r => setTimeout(r, 50));
                    }
                    try {
                        let chunkBytes = 0;
                        await new Promise((resolve, reject) => {
                            let settled = false;
                            const doneC = (err) => { if (settled) return; settled = true; if (err) reject(err); else resolve(); };
                            const req = httpGetFollow(url, { headers: { 'User-Agent': 'VersePC/2.0', Range: `bytes=${c.s}-${c.e}` } }, (res) => {
                                if (!res) { doneC(new Error('Too many redirects')); return; }
                                if (res.statusCode !== 206 && res.statusCode !== 200) { res.resume(); doneC(new Error(`Chunk ${c.i} HTTP ${res.statusCode}`)); return; }
                                const ws = fs.createWriteStream(c.tmp);
                                let lastTime = Date.now();
                                const t = setInterval(() => {
                                    if (Date.now() - lastTime > stallTimeout) { try { res.destroy(); ws.destroy(); } catch (_) {} clearInterval(t); doneC(new Error(`Chunk ${c.i} stall`)); }
                                }, 10000);
                                res.pipe(ws);
                                res.on('data', (d) => {
                                    chunkBytes += d.length;
                                    cProg[c.i] = chunkBytes;
                                    lastTime = Date.now();
                                    ctx.DownloadManager.recordProgress(d.length);
                                    if (onProgress && Date.now() - lastProg > 50) {
                                        lastProg = Date.now();
                                        const total = cProg.reduce((a, b) => a + b, 0);
                                        try { onProgress({ bytesDownloaded: total, totalBytes: totalSize, speed: ctx.DownloadManager.getSpeed(), progress: Math.min(99.9, total / totalSize * 100) }); } catch (_) {}
                                    }
                                });
                                ws.on('finish', () => { clearInterval(t); ws.close(); doneC(null); });
                                ws.on('error', (e) => { clearInterval(t); doneC(e); });
                                res.on('error', (e) => { clearInterval(t); try { ws.destroy(); } catch (_) {} doneC(e); });
                            });
                            if (req) { req.on('error', (e) => doneC(e)); }
                            if (abortSignal) abortSignal.addEventListener('abort', () => { try { if (req) req.destroy(); } catch (_) {} }, { once: true });
                        });
                    } finally { ctx.DownloadManager.releaseConnection(); }
                };
                try {
                    await Promise.all(chunks.filter(c => !c.done).map(c => dlChunk(c)));
                    await new Promise((resolve, reject) => {
                        const ws = fs.createWriteStream(destPath);
                        let idx = 0;
                        const writeNext = () => {
                            if (idx >= chunks.length) { ws.end(); return; }
                            const rs = fs.createReadStream(chunks[idx].tmp);
                            rs.on('end', () => { idx++; writeNext(); });
                            rs.on('error', reject);
                            rs.pipe(ws, { end: false });
                        };
                        ws.on('finish', () => { ws.close(); resolve(); });
                        ws.on('error', reject);
                        writeNext();
                    });
                } catch (e) {
                    chunkFailed = true;
                    console.warn(`[PCLStyle] 分块下载失败, 回退单流: ${e.message}`);
                } finally {
                    for (const c of chunks) { try { await fs.promises.unlink(c.tmp); } catch (_) {} }
                }
            } else if (tryChunk0.single) {
                totalSize = tryChunk0.totalSize;
            } else {
                chunkFailed = true;
            }
            if (chunkFailed || !fs.existsSync(destPath) || fs.statSync(destPath).size === 0) {
                await cleanTemp(destPath);
                await new Promise((resolve, reject) => {
                    utils.ensureDir(destPath);
                    const ws = fs.createWriteStream(destPath);
                    let bytes = 0, lastTime = Date.now();
                    let settled = false;
                    const timer = setInterval(() => {
                        if (Date.now() - lastTime > stallTimeout && totalSize > 0 && bytes < totalSize) {
                            try { ws.destroy(); } catch (_) {}
                            clearInterval(timer);
                            if (!settled) { settled = true; reject(new Error('Stall')); }
                        }
                    }, 10000);
                    const done = (err) => { if (settled) return; settled = true; clearInterval(timer); if (err) reject(err); else resolve(); };
                    const req = httpGetFollow(url, { headers: { 'User-Agent': 'VersePC/2.0' } }, (res) => {
                        if (!res) { try { ws.destroy(); } catch (_) {} done(new Error('Too many redirects')); return; }
                        if (res.statusCode !== 200) { try { ws.destroy(); } catch (_) {} done(new Error(`HTTP ${res.statusCode}`)); return; }
                        const cl = parseInt(res.headers['content-length'] || '0', 10);
                        if (cl > 0 && totalSize === 0) totalSize = cl;
                        res.pipe(ws);
                        res.on('data', (c) => { bytes += c.length; lastTime = Date.now(); ctx.DownloadManager.recordProgress(c.length); if (onProgress) try { onProgress({ bytesDownloaded: bytes, totalBytes: cl || totalSize, speed: ctx.DownloadManager.getSpeed(), progress: (cl || totalSize) > 0 ? Math.min(99.9, bytes / (cl || totalSize) * 100) : 0 }); } catch (_) {} });
                        res.on('end', () => ws.end(() => done(null)));
                        res.on('error', (e) => { try { ws.destroy(); } catch (_) {} done(e); });
                    });
                    if (req) { req.on('error', (e) => { try { ws.destroy(); } catch (_) {} done(e); }); }
                    if (abortSignal) abortSignal.addEventListener('abort', () => { try { if (req) req.destroy(); ws.destroy(); } catch (_) {} }, { once: true });
                });
            }
            if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
                if (onProgress) try { onProgress({ bytesDownloaded: fs.statSync(destPath).size, totalBytes: totalSize || fs.statSync(destPath).size, speed: 0, progress: 100 }); } catch (_) {}
                return { size: fs.statSync(destPath).size, path: destPath };
            }
            throw new Error('文件为空');
        } catch (e) {
            lastErr = e;
            if (abortSignal && abortSignal.aborted) throw e;
            console.warn(`[PCLStyle] ${url.substring(0, 60)} 失败: ${e.message}`);
            await cleanTemp(destPath);
            continue;
        }
    }
    throw lastErr || new Error('所有下载源均失败');
}

// ============================================================================
// 带镜像回退的下载入口
// ============================================================================

async function downloadFileWithMirror(urlStr, destPath, onProgress, retries = 3, abortSignal = null, customTimeout = null) {
    const allUrls = getMirrorUrls(urlStr);

    try {
        const stat = await fs.promises.stat(destPath);
        if (stat.size > 0) {
            const isJarFile = destPath.endsWith('.jar');
            if (isJarFile && !utils.isJarIntact(destPath)) {
                console.log(`[Mirror] 已存在JAR损坏 (${path.basename(destPath)}), 重新下载`);
                await fs.promises.unlink(destPath).catch(() => {});
            } else {
                return { size: stat.size, path: destPath, skipped: true };
            }
        }
    } catch (e) {}

    const isSmallAsset = (destPath.includes('/assets/') || destPath.includes('\\assets\\')) && !destPath.endsWith('.jar');
    if (isSmallAsset) {
        return _dlSingle(urlStr, destPath, { onProgress, retries, abortSignal, timeout: customTimeout || 30000, stallTimeout: 60000 });
    }

    if (!ctx.constants.NO_CHUNK_HOSTS.some(d => urlStr.includes(d))) {
        try {
            const chunkOpts = { onProgress, retries, mirrors: allUrls, abortSignal };
            if (customTimeout) chunkOpts.timeout = customTimeout;
            const result = await downloadFileChunked(urlStr, destPath, chunkOpts);
            if (destPath.endsWith('.jar') && !utils.isJarIntact(destPath)) {
                console.log(`[Mirror] Chunked下载后JAR损坏 (${path.basename(destPath)}), 回退顺序下载`);
                await fs.promises.unlink(destPath).catch(() => {});
                throw new Error('Chunked download produced invalid JAR');
            }
            return result;
        } catch (e) {
            if (abortSignal && abortSignal.aborted) throw e;
            console.log(`[Mirror] Chunked with mirrors failed, fallback sequential: ${e.message}`);
        }
    }

    let lastError = null;
    for (const tryUrl of allUrls) {
        if (abortSignal && abortSignal.aborted) throw new Error('下载已中止');
        try {
            const result = await downloadFile(tryUrl, destPath, onProgress, retries, abortSignal);
            if (destPath.endsWith('.jar') && !utils.isJarIntact(destPath)) {
                console.log(`[Mirror] 顺序下载后JAR损坏 (${path.basename(destPath)}), 尝试下一镜像`);
                await fs.promises.unlink(destPath).catch(() => {});
                lastError = new Error(`Downloaded JAR is corrupt: ${tryUrl}`);
                continue;
            }
            return result;
        } catch (e) {
            if (abortSignal && abortSignal.aborted) throw e;
            lastError = e;
            if (allUrls.indexOf(tryUrl) < allUrls.length - 1) {
                console.log(`  Mirror fallback: ${tryUrl} failed, trying next...`);
            }
        }
    }
    throw lastError;
}

// ============================================================================
// 带方法的 JSON 请求 (POST/PUT 等)
// ============================================================================

function fetchJSONWithMethod(urlStr, method, body, headers, _redirectCount) {
    if (!_redirectCount) _redirectCount = 0;
    return new Promise((resolve, reject) => {
        if (_redirectCount > 5) { reject(new Error('Too many redirects')); return; }
        const urlObj = new URL(urlStr);
        const isHttps = urlObj.protocol === 'https:';
        const mod = isHttps ? https : http;
        const agent = isHttps ? ctx.httpAgents.SHARED_HTTPS_AGENT : ctx.httpAgents.SHARED_HTTP_AGENT;
        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: method,
            agent: agent,
            headers: {
                'User-Agent': 'VersePC/1.0 (Minecraft Launcher)',
                'Accept': 'application/json',
                ...(headers || {})
            }
        };
        const req = mod.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let redirectUrl = res.headers.location;
                if (redirectUrl.startsWith('/')) redirectUrl = `${urlObj.protocol}//${urlObj.host}${redirectUrl}`;
                res.resume();
                fetchJSONWithMethod(redirectUrl, method, body, headers, _redirectCount + 1).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode === 429) {
                let errData = '';
                res.on('data', chunk => errData += chunk);
                res.on('end', () => {
                    const retryAfter = parseInt(res.headers['retry-after'] || '5', 10);
                    const err = new Error(`HTTP 429: 请求过于频繁，请等待 ${retryAfter} 秒后重试`);
                    err.isRateLimit = true;
                    err.retryAfter = retryAfter;
                    reject(err);
                });
                return;
            }
            if (res.statusCode >= 400) {
                let errData = '';
                res.on('data', chunk => errData += chunk);
                res.on('end', () => {
                    const err = new Error(`HTTP ${res.statusCode}: ${errData.substring(0, 200)}`);
                    err.httpStatus = res.statusCode;
                    reject(err);
                });
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`JSON parse error: ${e.message}, data: ${data.substring(0, 200)}`)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout: ' + urlStr)); });
        if (body) req.write(body);
        req.end();
    });
}

// ============================================================================
// 带 Bearer Token 的 JSON 请求
// ============================================================================

function fetchJSONWithAuth(urlStr, token) {
    return new Promise((resolve, reject) => {
        const req = https.get(urlStr, {
            headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'VersePC/1.0' }
        }, (res) => {
            if (res.statusCode === 429) {
                let errData = '';
                res.on('data', chunk => errData += chunk);
                res.on('end', () => {
                    const retryAfter = parseInt(res.headers['retry-after'] || '5', 10);
                    const err = new Error(`HTTP 429: 请求过于频繁，请等待 ${retryAfter} 秒后重试`);
                    err.isRateLimit = true;
                    err.retryAfter = retryAfter;
                    reject(err);
                });
                return;
            }
            if (res.statusCode >= 400) {
                let errData = '';
                res.on('data', chunk => errData += chunk);
                res.on('end', () => {
                    const err = new Error(`HTTP ${res.statusCode}: ${errData.substring(0, 200)}`);
                    err.httpStatus = res.statusCode;
                    reject(err);
                });
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
    });
}

// ============================================================================
// 导出
// ============================================================================

module.exports = {
    fetchWithProtocol,
    cachedFetchJSON,
    _fetchOnce,
    _isMirrorAvailable,
    _mirrorFailed,
    _mirrorSuccess,
    fetchJSON,
    fetchText,
    fetchWithRacing,
    httpGet,
    downloadFileH2,
    downloadFileChunked,
    _dlSingle,
    downloadFile,
    downloadFileSync,
    downloadFileSyncAsync,
    downloadFileToBuffer,
    getMirrorUrls,
    probeMirrorSpeed,
    getMirrorUrl,
    downloadPCLStyle,
    downloadFileWithMirror,
    fetchJSONWithMethod,
    fetchJSONWithAuth,
};
