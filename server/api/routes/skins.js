/**
 * server/api/routes/skins.js - 皮肤路由
 * ============================================================================
 * 从 server.js handleAPI switch 语句抽取的皮肤相关端点。
 * 包含头像获取、默认皮肤、皮肤上传、皮肤纹理等功能。
 */

const fs = require('fs');
const path = require('path');

module.exports = {
    register(registerRoute, deps) {
        const { ctx, sendJSON, sendError, readBody } = deps;
        const { skins, accounts, utils } = deps;

        const DATA_DIR = ctx.dirs.DATA_DIR;
        const AVATAR_CACHE = ctx.caches.AVATAR_CACHE;
        const AVATAR_CACHE_DURATION = ctx.caches.AVATAR_CACHE_DURATION;

        // ====================================================================
        // /api/avatar
        // ====================================================================
        registerRoute('GET', '/api/avatar', async (req, res, parsedUrl) => {
            const avatarUuid = parsedUrl.query.uuid || '';
            const avatarServerUrl = parsedUrl.query.serverUrl || '';
            const avatarUsername = parsedUrl.query.username || '';
            const isOfflineAccount = parsedUrl.query.offline === '1';
            if (!avatarUuid) { sendError(res, 'Missing uuid', 400); return; }

            const cleanUuid = avatarUuid.replace(/-/g, '');
            const cacheKey = `${cleanUuid}:${avatarServerUrl}:${avatarUsername}`;
            const cached = AVATAR_CACHE.get(cacheKey);

            const serveImage = (data, contentType, fullSkin) => {
                res.writeHead(200, {
                    'Content-Type': contentType || 'image/png',
                    'Cache-Control': 'public, max-age=86400',
                    'X-Avatar-Cache': cached ? 'hit' : 'miss',
                    ...(fullSkin ? { 'X-Is-Full-Skin': 'true' } : {})
                });
                res.end(data);
            };
            const serveImageNoCache = (data, contentType) => {
                res.writeHead(200, {
                    'Content-Type': contentType || 'image/png',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0',
                    'X-Avatar-Fallback': 'true'
                });
                res.end(data);
            };

            if (cached) {
                serveImage(cached.data, cached.contentType, cached.isFullSkin);
                if (Date.now() - cached.time > AVATAR_CACHE_DURATION) {
                    skins.refreshAvatarCache(cacheKey, cleanUuid, avatarServerUrl, avatarUsername);
                }
                return;
            }

            if (isOfflineAccount) {
                let offlineData = null;
                let isFullSkin = false;
                try {
                    const accList = accounts.loadAccounts();
                    const acc = accList.find(a => (a.uuid || '').replace(/-/g, '') === cleanUuid);
                    if (acc && acc.skinFile) {
                        const skinPath = skins.resolveSkinPath(acc.skinFile);
                        if (skinPath) {
                            offlineData = fs.readFileSync(skinPath);
                            isFullSkin = true;
                        }
                    }
                } catch (e) {}
                if (!offlineData) {
                    offlineData = await skins.getSteveHeadLocal();
                    isFullSkin = false;
                }
                if (offlineData) {
                    AVATAR_CACHE.set(cacheKey, { data: offlineData, contentType: 'image/png', time: Date.now(), isFullSkin });
                    serveImage(offlineData, 'image/png', isFullSkin);
                } else {
                    res.writeHead(302, { Location: '/img/steve_head.png' });
                    res.end();
                }
                return;
            }

            try {
                let storedSkinUrl = '';
                try {
                    const accList = accounts.loadAccounts();
                    const acc = accList.find(a => (a.uuid || '').replace(/-/g, '') === cleanUuid);
                    if (acc && acc.skinUrl) storedSkinUrl = acc.skinUrl;
                } catch (e) {}
                const result = await skins.fetchAvatarData(cleanUuid, avatarServerUrl, avatarUsername, storedSkinUrl);
                if (result) {
                    AVATAR_CACHE.set(cacheKey, { data: result.data, contentType: result.contentType, time: Date.now(), isFullSkin: result.isFullSkin });
                    serveImage(result.data, result.contentType, result.isFullSkin);
                } else {
                    const defaultHead = await skins.getSteveHeadLocal();
                    if (defaultHead) {
                        serveImageNoCache(defaultHead, 'image/png');
                    } else {
                        res.writeHead(302, { Location: '/img/steve_head.png' });
                        res.end();
                    }
                }
            } catch (e) {
                console.error('[Avatar] fetch error:', e);
                const defaultHead = await skins.getSteveHeadLocal();
                if (defaultHead) {
                    serveImageNoCache(defaultHead, 'image/png');
                } else {
                    res.writeHead(302, { Location: '/img/steve_head.png' });
                    res.end();
                }
            }
        });

        // ====================================================================
        // /api/default-skins
        // ====================================================================
        registerRoute('GET', '/api/default-skins', async (req, res, parsedUrl) => {
            const skinDir = ctx.dirs.APP_IMG_DIR;
            const skinFiles = [
                { id: 'steve', name: 'Steve', file: 'steve_skin.png', model: 'default' },
                { id: 'alex', name: 'Alex', file: 'skin_alex.png', model: 'slim' },
                { id: 'zombie', name: 'Zombie', file: 'skin_zombie.png', model: 'default' },
                { id: 'enderman', name: 'Enderman', file: 'skin_enderman.png', model: 'default' },
                { id: 'creeper', name: 'Creeper', file: 'skin_creeper.png', model: 'default' }
            ];
            const available = skinFiles.filter(s => fs.existsSync(path.join(skinDir, s.file)));
            sendJSON(res, { success: true, skins: available });
        });

        // ====================================================================
        // /api/skin-head
        // ====================================================================
        registerRoute('GET', '/api/skin-head', async (req, res, parsedUrl) => {
            const headId = parsedUrl.query.id || '';
            const customFile = parsedUrl.query.file || '';
            if (!headId && !customFile) { sendError(res, 'Missing id', 400); return; }
            let headFile = '';
            if (customFile) {
                headFile = customFile;
            } else {
                const headSkinMap = {
                    steve: 'steve_skin.png',
                    alex: 'skin_alex.png',
                    zombie: 'skin_zombie.png',
                    enderman: 'skin_enderman.png',
                    creeper: 'skin_creeper.png'
                };
                headFile = headSkinMap[headId];
            }
            if (!headFile) { sendError(res, 'Invalid skin id', 400); return; }
            const headPath = skins.resolveSkinPath(headFile);
            if (!headPath) { sendError(res, 'Skin not found', 404); return; }
            const headBuf = fs.readFileSync(headPath);
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
            res.end(headBuf);
        });

        // ====================================================================
        // /api/set-account-skin
        // ====================================================================
        registerRoute('POST', '/api/set-account-skin', async (req, res, parsedUrl) => {
            if (req.method !== 'POST') { sendError(res, 'Method not allowed', 405); return; }
            let skBody = '';
            req.on('data', c => skBody += c);
            req.on('end', async () => {
                try {
                    const skData = JSON.parse(skBody);
                    const { accountId, skinId } = skData;
                    if (!accountId || !skinId) { sendError(res, 'Missing params', 400); return; }
                    const accList = accounts.loadAccounts();
                    const acc = accList.find(a => a.id === accountId);
                    if (!acc) { sendError(res, 'Account not found', 404); return; }
                    const skinMap = {
                        steve: { file: 'steve_skin.png', model: 'default' },
                        alex: { file: 'skin_alex.png', model: 'slim' },
                        zombie: { file: 'skin_zombie.png', model: 'default' },
                        enderman: { file: 'skin_enderman.png', model: 'default' },
                        creeper: { file: 'skin_creeper.png', model: 'default' }
                    };
                    const skinInfo = skinMap[skinId];
                    if (!skinInfo) { sendError(res, 'Invalid skin', 400); return; }
                    acc.skinFile = skinInfo.file;
                    acc.skinModel = skinInfo.model;
                    accounts.saveAccounts(accList);
                    const cleanUuid = (acc.uuid || '').replace(/-/g, '');
                    for (const key of AVATAR_CACHE.keys()) {
                        if (key.includes(cleanUuid)) AVATAR_CACHE.delete(key);
                    }
                    sendJSON(res, { success: true });
                } catch (e) {
                    sendError(res, 'Invalid JSON', 400);
                }
            });
        });

        // ====================================================================
        // /api/upload-skin
        // ====================================================================
        registerRoute('POST', '/api/upload-skin', async (req, res, parsedUrl) => {
            if (req.method !== 'POST') { sendError(res, 'Method not allowed', 405); return; }
            const contentType = req.headers['content-type'] || '';
            let uploadBody = Buffer.alloc(0);
            req.on('data', chunk => { uploadBody = Buffer.concat([uploadBody, chunk]); });
            req.on('end', async () => {
                try {
                    let skinBuf, accountId, model = 'default';
                    if (contentType.includes('multipart/form-data')) {
                        const boundary = contentType.split('boundary=')[1];
                        if (!boundary) { sendError(res, 'Invalid multipart', 400); return; }
                        const boundaryBuf = Buffer.from('--' + boundary);
                        const headerSep = Buffer.from('\r\n\r\n');
                        let pos = 0;
                        while (pos < uploadBody.length) {
                            const start = uploadBody.indexOf(boundaryBuf, pos);
                            if (start === -1) break;
                            const afterBoundary = start + boundaryBuf.length;
                            if (uploadBody[afterBoundary] === 0x2D && uploadBody[afterBoundary + 1] === 0x2D) break;
                            const headerStart = afterBoundary + 2;
                            const headerEnd = uploadBody.indexOf(headerSep, headerStart);
                            if (headerEnd === -1) break;
                            const headers = uploadBody.slice(headerStart, headerEnd).toString('utf8');
                            const bodyStart = headerEnd + 4;
                            const nextBoundary = uploadBody.indexOf(boundaryBuf, bodyStart);
                            const bodyEnd = nextBoundary !== -1 ? nextBoundary - 2 : uploadBody.length;
                            const partBody = uploadBody.slice(bodyStart, bodyEnd);
                            if (headers.includes('name="file"')) {
                                skinBuf = partBody;
                            } else if (headers.includes('name="accountId"')) {
                                accountId = partBody.toString('utf8').trim();
                            } else if (headers.includes('name="model"')) {
                                model = partBody.toString('utf8').trim();
                            }
                            pos = nextBoundary !== -1 ? nextBoundary : uploadBody.length;
                        }
                    } else {
                        const jsonData = JSON.parse(uploadBody.toString());
                        accountId = jsonData.accountId;
                        model = jsonData.model || 'default';
                        if (jsonData.fileBase64) {
                            skinBuf = Buffer.from(jsonData.fileBase64, 'base64');
                        }
                    }
                    if (!skinBuf || !accountId) { sendError(res, 'Missing file or accountId', 400); return; }
                    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
                    if (!skinBuf.slice(0, 4).equals(PNG_MAGIC)) { sendError(res, 'File must be PNG', 400); return; }
                    const accList = accounts.loadAccounts();
                    const acc = accList.find(a => a.id === accountId);
                    if (!acc) { sendError(res, 'Account not found', 404); return; }
                    let metadata;
                    try {
                        const sharpLib = require('sharp');
                        metadata = await sharpLib(skinBuf).metadata();
                    } catch (e) { sendError(res, 'Invalid PNG', 400); return; }
                    const isStandardSize = (metadata.width === 64 && (metadata.height === 64 || metadata.height === 32));
                    if (!isStandardSize) {
                        try {
                            const sharpLib2 = require('sharp');
                            skinBuf = await sharpLib2(skinBuf).resize(64, 64, { kernel: 'nearest' }).png().toBuffer();
                            console.log(`[Upload] Resized skin from ${metadata.width}x${metadata.height} to 64x64`);
                        } catch (resizeErr) {
                            console.warn('[Upload] Sharp resize failed, saving original size:', resizeErr.message);
                        }
                    }
                    const fileName = `custom_${accountId}_${Date.now()}.png`;
                    const filePath = path.join(DATA_DIR, 'img', fileName);
                    utils.ensureDir(filePath);
                    fs.writeFileSync(filePath, skinBuf);
                    acc.skinFile = fileName;
                    acc.skinModel = model === 'slim' ? 'slim' : 'default';
                    accounts.saveAccounts(accList);
                    const cleanUuid = (acc.uuid || '').replace(/-/g, '');
                    for (const key of AVATAR_CACHE.keys()) {
                        if (key.includes(cleanUuid)) AVATAR_CACHE.delete(key);
                    }
                    sendJSON(res, { success: true, fileName });
                } catch (e) {
                    sendError(res, 'Upload failed: ' + e.message, 500);
                }
            });
        });

        // ====================================================================
        // /api/skin-texture
        // ====================================================================
        registerRoute('GET', '/api/skin-texture', async (req, res, parsedUrl) => {
            const stUuid = parsedUrl.query.uuid || '';
            const stServerUrl = parsedUrl.query.serverUrl || '';
            const stUsername = parsedUrl.query.username || '';
            if (!stUuid) { sendError(res, 'Missing uuid', 400); return; }
            const stClean = stUuid.replace(/-/g, '');
            const stCacheKey = `skin:${stClean}:${stServerUrl}:${stUsername}`;
            const stCached = AVATAR_CACHE.get(stCacheKey);
            let stSkinModel = 'default';
            let stHasStoredModel = false;
            try {
                const stAccounts = accounts.loadAccounts();
                const stAcc = stAccounts.find(a => (a.uuid || '').replace(/-/g, '') === stClean);
                if (stAcc && stAcc.skinModel) { stSkinModel = stAcc.skinModel; stHasStoredModel = true; }
            } catch (e) {}
            if (!stHasStoredModel) {
                try {
                    const detected = await skins.fetchSkinModelFromSessionServer(stClean, stServerUrl || null);
                    if (detected) stSkinModel = detected;
                } catch (e) {}
            }
            const serveStImage = (data, ct) => {
                res.writeHead(200, { 'Content-Type': ct || 'image/png', 'Cache-Control': 'public, max-age=86400', 'X-Skin-Model': stSkinModel });
                res.end(data);
            };
            if (stCached) { serveStImage(stCached.data, stCached.contentType); return; }
            try {
                let stStoredSkinUrl = '';
                let stSkinFile = '';
                try {
                    const accList = accounts.loadAccounts();
                    const acc = accList.find(a => (a.uuid || '').replace(/-/g, '') === stClean);
                    if (acc && acc.skinUrl) stStoredSkinUrl = acc.skinUrl;
                    if (acc && acc.skinFile) stSkinFile = acc.skinFile;
                } catch (e) {}
                if (stSkinFile) {
                    const skinPath = skins.resolveSkinPath(stSkinFile);
                    if (skinPath) {
                        const data = fs.readFileSync(skinPath);
                        AVATAR_CACHE.set(stCacheKey, { data, contentType: 'image/png', time: Date.now() });
                        serveStImage(data, 'image/png');
                        return;
                    }
                }
                const stResult = await skins.fetchAvatarDataFull(stClean, stServerUrl, stUsername, stStoredSkinUrl);
                if (stResult) {
                    AVATAR_CACHE.set(stCacheKey, { data: stResult.data, contentType: stResult.contentType, time: Date.now() });
                    serveStImage(stResult.data, stResult.contentType);
                } else {
                    const dh = await skins.getSteveSkinFull();
                    if (dh) serveStImage(dh, 'image/png');
                    else { res.writeHead(302, { Location: '/img/steve_head.png' }); res.end(); }
                }
            } catch (e) {
                const dh = await skins.getSteveSkinFull();
                if (dh) serveStImage(dh, 'image/png');
                else { res.writeHead(302, { Location: '/img/steve_head.png' }); res.end(); }
            }
        });

        // ====================================================================
        // /api/save-avatar
        // ====================================================================
        registerRoute('POST', '/api/save-avatar', async (req, res, parsedUrl) => {
            const avBody = await readBody(req);
            const avData = avBody.dataUrl;
            if (!avData) { sendJSON(res, { error: 'dataUrl required' }, 400); return; }
            const avMatch = avData.match(/^data:image\/(\w+);base64,(.+)$/);
            if (!avMatch) { sendJSON(res, { error: 'invalid dataUrl' }, 400); return; }
            const avFile = path.join(DATA_DIR, `avatar.${avMatch[1] === 'jpeg' ? 'jpg' : avMatch[1]}`);
            fs.writeFileSync(avFile, Buffer.from(avMatch[2], 'base64'));
            sendJSON(res, { success: true, path: avFile });
        });

        // ====================================================================
        // /api/clear-avatar
        // ====================================================================
        registerRoute('GET', '/api/clear-avatar', async (req, res, parsedUrl) => {
            const avFiles = ['avatar.png', 'avatar.jpg', 'avatar.jpeg'].map(f => path.join(DATA_DIR, f));
            for (const f of avFiles) { if (fs.existsSync(f)) fs.unlinkSync(f); }
            sendJSON(res, { success: true });
        });
    }
};
