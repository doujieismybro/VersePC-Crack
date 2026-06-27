/**
 * server/skins.js - 皮肤/头像功能模块
 * ============================================================================
 * 从 server.js 抽取的皮肤与头像相关函数。
 * 通过 ctx (./context) 访问共享状态，通过 utils (./utils) 访问工具函数，
 * 通过 http (./http-client) 访问 HTTP 请求功能。
 */

const fs = require('fs');
const path = require('path');

const ctx = require('./context');
const utils = require('./utils');
const http = require('./http-client');

// ============================================================================
// 服务器 URL 清理
// ============================================================================

function cleanServerUrl(url) {
    if (!url) return '';
    return url.replace(/@@@.*$/, '').replace(/@@.*$/, '').replace(/\/$/, '');
}

// ============================================================================
// 从 Session Server 获取皮肤 URL / 模型
// ============================================================================

async function fetchSkinFromSessionServer(uuid, serverUrl) {
    try {
        const cleanUuid = uuid.replace(/-/g, '');
        const dashedUuid = uuid.length === 32
            ? `${uuid.slice(0,8)}-${uuid.slice(8,12)}-${uuid.slice(12,16)}-${uuid.slice(16,20)}-${uuid.slice(20)}`
            : uuid;

        if (serverUrl) {
            let apiUrl = cleanServerUrl(serverUrl);
            const profileUrl = `${apiUrl}/sessionserver/session/minecraft/profile/${dashedUuid}`;
            const profileData = await http.fetchJSON(profileUrl);
            if (profileData && profileData.properties) {
                const texturesProp = profileData.properties.find(p => p.name === 'textures');
                if (texturesProp) {
                    const decoded = JSON.parse(Buffer.from(texturesProp.value, 'base64').toString('utf8'));
                    if (decoded.textures && decoded.textures.SKIN && decoded.textures.SKIN.url) {
                        return decoded.textures.SKIN.url;
                    }
                }
            }
        }

        const mojangUrl = `https://sessionserver.mojang.com/session/minecraft/profile/${dashedUuid}`;
        const mojangData = await http.fetchJSON(mojangUrl);
        if (mojangData && mojangData.properties) {
            const texturesProp = mojangData.properties.find(p => p.name === 'textures');
            if (texturesProp) {
                const decoded = JSON.parse(Buffer.from(texturesProp.value, 'base64').toString('utf8'));
                if (decoded.textures && decoded.textures.SKIN && decoded.textures.SKIN.url) {
                    return decoded.textures.SKIN.url;
                }
            }
        }
    } catch (e) {
        console.log('[Avatar] session server获取皮肤失败:', e.message);
    }
    return null;
}

async function fetchSkinModelFromSessionServer(uuid, serverUrl) {
    try {
        const cleanUuid = uuid.replace(/-/g, '');
        const dashedUuid = uuid.length === 32
            ? `${uuid.slice(0,8)}-${uuid.slice(8,12)}-${uuid.slice(12,16)}-${uuid.slice(16,20)}-${uuid.slice(20)}`
            : uuid;

        let profileData = null;
        if (serverUrl) {
            try {
                let apiUrl = cleanServerUrl(serverUrl);
                const profileUrl = `${apiUrl}/sessionserver/session/minecraft/profile/${dashedUuid}`;
                profileData = await http.fetchJSON(profileUrl);
            } catch (e) {}
        }
        if (!profileData) {
            try {
                const mojangUrl = `https://sessionserver.mojang.com/session/minecraft/profile/${dashedUuid}`;
                profileData = await http.fetchJSON(mojangUrl);
            } catch (e) {}
        }
        if (profileData && profileData.properties) {
            const texturesProp = profileData.properties.find(p => p.name === 'textures');
            if (texturesProp) {
                const decoded = JSON.parse(Buffer.from(texturesProp.value, 'base64').toString('utf8'));
                if (decoded.textures && decoded.textures.SKIN) {
                    const meta = decoded.textures.SKIN.metadata;
                    if (meta && meta.model === 'slim') return 'slim';
                    return 'default';
                }
            }
        }
    } catch (e) {}
    return null;
}

// ============================================================================
// 皮肤路径解析
// ============================================================================

function resolveSkinPath(skinFile) {
    if (!skinFile) return null;
    const userDataPath = path.join(ctx.dirs.DATA_DIR, 'img', skinFile);
    if (fs.existsSync(userDataPath)) return userDataPath;
    const appPath = path.join(ctx.dirs.APP_IMG_DIR, skinFile);
    if (fs.existsSync(appPath)) return appPath;
    return null;
}

// ============================================================================
// 本地 Steve 头像加载
// ============================================================================

async function getSteveHeadLocal() {
    if (ctx.caches.cachedSteveHead) return ctx.caches.cachedSteveHead;
    if (ctx.caches.steveHeadPromise) {
        try { return await ctx.caches.steveHeadPromise; } catch (e) {}
    }
    ctx.caches.steveHeadPromise = (async () => {
        try {
            if (!fs.existsSync(ctx.dirs.STEVE_SKIN_LOCAL_PATH)) return null;
            const skinBuffer = fs.readFileSync(ctx.dirs.STEVE_SKIN_LOCAL_PATH);
            const sharpLib = require('sharp');
            const metadata = await sharpLib(skinBuffer).metadata();
            const w = metadata.width || 0;
            const h = metadata.height || 0;
            if (w < 64 || h < 32) return null;
            const scale = w / 64;
            const headLeft = Math.round(8 * scale);
            const headTop = Math.round(8 * scale);
            const headDim = Math.round(8 * scale);
            const hatLeft = Math.round(40 * scale);
            const hatTop = Math.round(8 * scale);

            const facePng = await sharpLib(skinBuffer)
                .extract({ left: headLeft, top: headTop, width: headDim, height: headDim })
                .ensureAlpha()
                .resize(64, 64, { kernel: 'nearest' })
                .png()
                .toBuffer();

            if (h < 64 && metadata.channels !== 4) {
                ctx.caches.cachedSteveHead = facePng;
                console.log('[Avatar] Steve head loaded (no hat layer)');
                return ctx.caches.cachedSteveHead;
            }

            const hatPng = await sharpLib(skinBuffer)
                .extract({ left: hatLeft, top: hatTop, width: headDim, height: headDim })
                .ensureAlpha()
                .resize(64, 64, { kernel: 'nearest' })
                .png()
                .toBuffer();

            ctx.caches.cachedSteveHead = await sharpLib(facePng)
                .composite([{ input: hatPng, blend: 'over' }])
                .png()
                .toBuffer();

            console.log('[Avatar] Steve head loaded with hat overlay');
            return ctx.caches.cachedSteveHead;
        } catch (e) {
            console.error('[Avatar] getSteveHeadLocal error:', e.message);
            return null;
        }
    })();
    try {
        return await ctx.caches.steveHeadPromise;
    } catch (e) {
        console.error('[Avatar] getSteveHeadLocal await error:', e.message);
        return null;
    }
}

// ============================================================================
// 使用 sharp 裁剪皮肤为头像
// ============================================================================

async function cropSkinToHeadWithSharp(skinBuffer) {
    try {
        const sharpLib = require('sharp');
        const metadata = await sharpLib(skinBuffer).metadata();
        const w = metadata.width || 0;
        const h = metadata.height || 0;
        if (!w || !h) return null;
        const isValidSkin = (w === 64 && h === 32) || (w === 64 && h === 64) || w === 128 || w === 256 || w === 512;
        if (!isValidSkin) return null;
        const scale = w / 64;
        const headLeft = Math.round(8 * scale);
        const headTop = Math.round(8 * scale);
        const headDim = Math.round(8 * scale);
        const hatLeft = Math.round(40 * scale);
        const hatTop = Math.round(8 * scale);
        if (headLeft + headDim > w || headTop + headDim > h) return null;
        if (hatLeft + headDim > w || hatTop + headDim > h) return null;

        const isRGBA = metadata.channels === 4;

        const faceRaw = await sharpLib(skinBuffer)
            .extract({ left: headLeft, top: headTop, width: headDim, height: headDim })
            .ensureAlpha()
            .raw()
            .toBuffer();

        if (!isRGBA) {
            return await sharpLib(faceRaw, { raw: { width: headDim, height: headDim, channels: 4 } })
                .resize(64, 64, { kernel: 'nearest' })
                .png()
                .toBuffer();
        }

        const hatRaw = await sharpLib(skinBuffer)
            .extract({ left: hatLeft, top: hatTop, width: headDim, height: headDim })
            .ensureAlpha()
            .raw()
            .toBuffer();

        const pixelCount = headDim * headDim;
        const blended = Buffer.alloc(pixelCount * 4);
        for (let i = 0; i < pixelCount; i++) {
            const off = i * 4;
            const fr = faceRaw[off], fg = faceRaw[off + 1], fb = faceRaw[off + 2], fa = faceRaw[off + 3];
            const hr = hatRaw[off], hg = hatRaw[off + 1], hb = hatRaw[off + 2], ha = hatRaw[off + 3];
            if (ha === 0) {
                blended[off] = fr; blended[off + 1] = fg; blended[off + 2] = fb; blended[off + 3] = fa;
                continue;
            }
            if (ha === 255) {
                blended[off] = hr; blended[off + 1] = hg; blended[off + 2] = hb; blended[off + 3] = 255;
                continue;
            }
            if (fa === 0) {
                blended[off] = hr; blended[off + 1] = hg; blended[off + 2] = hb; blended[off + 3] = ha;
                continue;
            }
            const hA = ha / 255;
            const fA = fa / 255;
            const outA = hA + fA * (1 - hA);
            const invOutA = 1 / outA;
            blended[off] = Math.round((hr * hA + fr * fA * (1 - hA)) * invOutA);
            blended[off + 1] = Math.round((hg * hA + fg * fA * (1 - hA)) * invOutA);
            blended[off + 2] = Math.round((hb * hA + fb * fA * (1 - hA)) * invOutA);
            blended[off + 3] = Math.round(outA * 255);
        }

        return await sharpLib(blended, { raw: { width: headDim, height: headDim, channels: 4 } })
            .resize(64, 64, { kernel: 'nearest' })
            .png()
            .toBuffer();
    } catch (e) {
        console.error('[Avatar] cropSkinToHeadWithSharp error:', e.message);
        return null;
    }
}

// ============================================================================
// 获取头像数据 (裁剪为头部)
// ============================================================================

async function fetchAvatarData(cleanUuid, avatarServerUrl, avatarUsername, storedSkinUrl) {
    let avatarData = null;
    let avatarContentType = 'image/png';
    let isFullSkin = false;

    if (storedSkinUrl) {
        try {
            const skinRes = await http.fetchWithProtocol(storedSkinUrl, { timeout: 8000 });
            if (skinRes.statusCode === 200) {
                const chunks = [];
                for await (const chunk of skinRes) chunks.push(chunk);
                avatarData = Buffer.concat(chunks);
                avatarContentType = skinRes.headers['content-type'] || 'image/png';
                isFullSkin = true;
            } else { skinRes.resume(); }
        } catch (e) { console.log('[Avatar] storedSkinUrl失败: ' + e.message); }
    }

    if (!avatarData && !avatarServerUrl) {
        const serviceResults = await Promise.allSettled(
            ctx.constants.AVATAR_SERVICES.map(async (serviceFn) => {
                const tryUrl = serviceFn(cleanUuid);
                const checkRes = await http.fetchWithProtocol(tryUrl, { timeout: 4000 });
                if (checkRes.statusCode === 200) {
                    const chunks = [];
                    for await (const chunk of checkRes) chunks.push(chunk);
                    return { data: Buffer.concat(chunks), contentType: checkRes.headers['content-type'] || 'image/png' };
                }
                checkRes.resume();
                throw new Error('non-200');
            })
        );
        for (const r of serviceResults) {
            if (r.status === 'fulfilled' && r.value) {
                avatarData = r.value.data;
                avatarContentType = r.value.contentType;
                break;
            }
        }
    } else if (avatarServerUrl) {
        console.log('[Avatar] 外置认证，跳过公共Avatar服务，直连 ' + avatarServerUrl);
    }

    if (!avatarData && avatarServerUrl && avatarUsername) {
        try {
            let skinRoot = cleanServerUrl(avatarServerUrl);
            if (skinRoot.endsWith('/api/yggdrasil')) skinRoot = skinRoot.replace('/api/yggdrasil', '');
            const skinUrl = skinRoot + '/skin/' + encodeURIComponent(avatarUsername) + '.png';
            console.log('[Avatar] 传统API: ' + skinUrl);
            const skinRes = await http.fetchWithProtocol(skinUrl, { timeout: 10000 });
            if (skinRes.statusCode === 200) {
                const chunks = [];
                for await (const chunk of skinRes) chunks.push(chunk);
                avatarData = Buffer.concat(chunks);
                isFullSkin = true;
            } else { skinRes.resume(); }
        } catch (e) { console.log('[Avatar] 传统API失败: ' + e.message); }
    }

    if (!avatarData && avatarServerUrl) {
        try {
            let cslRoot = cleanServerUrl(avatarServerUrl);
            if (cslRoot.endsWith('/api/yggdrasil')) cslRoot = cslRoot.replace('/api/yggdrasil', '');
            const cslUsername = avatarUsername || '';
            if (cslUsername) {
                const cslUrl = cslRoot + '/csl/' + encodeURIComponent(cslUsername) + '.json';
                const cslData = await http.fetchJSON(cslUrl);
                if (cslData && cslData.skins) {
                    const skinHash = cslData.skins.slim || cslData.skins.default || cslData.skins.steve;
                    if (skinHash) {
                        const textureUrl = cslRoot + '/textures/' + skinHash;
                        const textureRes = await http.fetchWithProtocol(textureUrl, { timeout: 10000 });
                        if (textureRes.statusCode === 200) {
                            const chunks = [];
                            for await (const chunk of textureRes) chunks.push(chunk);
                            avatarData = Buffer.concat(chunks);
                            isFullSkin = true;
                        } else { textureRes.resume(); }
                    }
                }
            }
        } catch (e) { console.log('[Avatar] CSL失败: ' + e.message); }
    }

    if (!avatarData) {
        const skinTextureUrl = await fetchSkinFromSessionServer(cleanUuid, avatarServerUrl);
        if (skinTextureUrl) {
            try {
                const texRes = await http.fetchWithProtocol(skinTextureUrl, { timeout: 10000 });
                if (texRes.statusCode === 200) {
                    const chunks = [];
                    for await (const chunk of texRes) chunks.push(chunk);
                    avatarData = Buffer.concat(chunks);
                    isFullSkin = true;
                } else { texRes.resume(); }
            } catch (e) { console.log('[Avatar] SessionServer失败: ' + e.message); }
        }
    }

    if (avatarData && isFullSkin) {
        const cropped = await cropSkinToHeadWithSharp(avatarData);
        if (cropped) {
            avatarData = cropped;
            avatarContentType = 'image/png';
            isFullSkin = false;
            console.log('[Avatar] sharp裁剪全皮肤为头像成功');
        } else {
            console.warn('[Avatar] sharp裁剪失败，保留完整皮肤供前端裁剪');
            isFullSkin = true;
        }
    }

    if (!avatarData) return null;
    return { data: avatarData, contentType: avatarContentType, isFullSkin };
}

// ============================================================================
// 后台刷新头像缓存
// ============================================================================

function refreshAvatarCache(cacheKey, cleanUuid, avatarServerUrl, avatarUsername) {
    let storedSkinUrl = '';
    try {
        const accounts = utils.safeReadJsonFile(ctx.dirs.ACCOUNTS_FILE, []);
        if (Array.isArray(accounts)) {
            const acc = accounts.find(a => (a.uuid || '').replace(/-/g, '') === cleanUuid);
            if (acc && acc.skinUrl) storedSkinUrl = acc.skinUrl;
        }
    } catch (e) {}
    fetchAvatarData(cleanUuid, avatarServerUrl, avatarUsername, storedSkinUrl).then(result => {
        if (result) {
            ctx.caches.AVATAR_CACHE.set(cacheKey, { data: result.data, contentType: result.contentType, time: Date.now(), isFullSkin: result.isFullSkin });
            console.log('[Avatar] 后台刷新成功: ' + cacheKey);
        }
    }).catch(e => {
        console.error('[Avatar] 后台刷新失败: ' + e.message);
    });
}

// ============================================================================
// 获取完整皮肤数据 (不裁剪)
// ============================================================================

async function fetchAvatarDataFull(cleanUuid, avatarServerUrl, avatarUsername, storedSkinUrl) {
    let avatarData = null;
    let avatarContentType = 'image/png';

    if (storedSkinUrl) {
        try {
            const skinRes = await http.fetchWithProtocol(storedSkinUrl, { timeout: 8000 });
            if (skinRes.statusCode === 200) {
                const chunks = [];
                for await (const chunk of skinRes) chunks.push(chunk);
                avatarData = Buffer.concat(chunks);
                avatarContentType = skinRes.headers['content-type'] || 'image/png';
            } else { skinRes.resume(); }
        } catch (e) { console.log('[AvatarFull] storedSkinUrl失败: ' + e.message); }
    }

    if (!avatarData && !avatarServerUrl) {
        const skinTextureUrl = await fetchSkinFromSessionServer(cleanUuid, null);
        if (skinTextureUrl) {
            try {
                const texRes = await http.fetchWithProtocol(skinTextureUrl, { timeout: 10000 });
                if (texRes.statusCode === 200) {
                    const texChunks = [];
                    for await (const chunk of texRes) texChunks.push(chunk);
                    avatarData = Buffer.concat(texChunks);
                    avatarContentType = texRes.headers['content-type'] || 'image/png';
                } else { texRes.resume(); }
            } catch (e) { console.log('[AvatarFull] SessionServer失败: ' + e.message); }
        }
    }
    if (!avatarData && !avatarServerUrl) {
        const serviceResults = await Promise.allSettled(
            ctx.constants.AVATAR_SERVICES.map(async (serviceFn) => {
                const tryUrl = serviceFn(cleanUuid);
                const checkRes = await http.fetchWithProtocol(tryUrl, { timeout: 4000 });
                if (checkRes.statusCode === 200) {
                    const chunks = [];
                    for await (const chunk of checkRes) chunks.push(chunk);
                    return { data: Buffer.concat(chunks), contentType: checkRes.headers['content-type'] || 'image/png' };
                }
                checkRes.resume();
                throw new Error('non-200');
            })
        );
        for (const r of serviceResults) {
            if (r.status === 'fulfilled' && r.value) {
                avatarData = r.value.data;
                avatarContentType = r.value.contentType;
                break;
            }
        }
    }
    if (!avatarData && avatarServerUrl && avatarUsername) {
        try {
            let skinRoot = cleanServerUrl(avatarServerUrl);
            if (skinRoot.endsWith('/api/yggdrasil')) skinRoot = skinRoot.replace('/api/yggdrasil', '');
            const skinUrl = skinRoot + '/skin/' + encodeURIComponent(avatarUsername) + '.png';
            const skinRes = await http.fetchWithProtocol(skinUrl, { timeout: 10000 });
            if (skinRes.statusCode === 200) {
                const chunks = [];
                for await (const chunk of skinRes) chunks.push(chunk);
                avatarData = Buffer.concat(chunks);
                avatarContentType = skinRes.headers['content-type'] || 'image/png';
            } else { skinRes.resume(); }
        } catch (e) {}
    }
    if (!avatarData && avatarServerUrl && avatarUsername) {
        try {
            let cslRoot = cleanServerUrl(avatarServerUrl);
            if (cslRoot.endsWith('/api/yggdrasil')) cslRoot = cslRoot.replace('/api/yggdrasil', '');
            const cslUrl = cslRoot + '/csl/' + encodeURIComponent(avatarUsername) + '.json';
            const cslRes = await http.fetchWithProtocol(cslUrl, { timeout: 4000 });
            if (cslRes.statusCode === 200) {
                const cslChunks = [];
                for await (const chunk of cslRes) cslChunks.push(chunk);
                const cslData = JSON.parse(Buffer.concat(cslChunks).toString('utf8'));
                const skinEntry = cslData.skins && cslData.skins.find(s => s.type === 'skin' || s.type === 'default');
                if (skinEntry && skinEntry.url) {
                    const texRes = await http.fetchWithProtocol(skinEntry.url, { timeout: 5000 });
                    if (texRes.statusCode === 200) {
                        const texChunks = [];
                        for await (const chunk of texRes) texChunks.push(chunk);
                        avatarData = Buffer.concat(texChunks);
                        avatarContentType = texRes.headers['content-type'] || 'image/png';
                    } else { texRes.resume(); }
                }
            } else { cslRes.resume(); }
        } catch (e) {}
    }
    if (!avatarData && avatarServerUrl) {
        const skinTextureUrl = await fetchSkinFromSessionServer(cleanUuid, avatarServerUrl);
        if (skinTextureUrl) {
            try {
                const texRes = await http.fetchWithProtocol(skinTextureUrl, { timeout: 5000 });
                if (texRes.statusCode === 200) {
                    const texChunks = [];
                    for await (const chunk of texRes) texChunks.push(chunk);
                    avatarData = Buffer.concat(texChunks);
                    avatarContentType = texRes.headers['content-type'] || 'image/png';
                } else { texRes.resume(); }
            } catch (e) {}
        }
    }
    if (!avatarData) return null;
    return { data: avatarData, contentType: avatarContentType };
}

// ============================================================================
// 本地完整 Steve 皮肤加载
// ============================================================================

async function getSteveSkinFull() {
    if (ctx.caches._steveSkinFull) return ctx.caches._steveSkinFull;
    if (ctx.caches._steveSkinFullPromise) { try { return await ctx.caches._steveSkinFullPromise; } catch (e) {} }
    ctx.caches._steveSkinFullPromise = (async () => {
        try {
            const skinPath = path.join(ctx.dirs.APP_IMG_DIR, 'steve_skin.png');
            if (fs.existsSync(skinPath)) {
                ctx.caches._steveSkinFull = fs.readFileSync(skinPath);
                return ctx.caches._steveSkinFull;
            }
            const headPath = ctx.dirs.STEVE_SKIN_LOCAL_PATH;
            if (fs.existsSync(headPath)) {
                ctx.caches._steveSkinFull = fs.readFileSync(headPath);
                return ctx.caches._steveSkinFull;
            }
        } catch (e) {}
        return null;
    })();
    return await ctx.caches._steveSkinFullPromise;
}

// ============================================================================
// 定期清理过期的头像缓存
// ============================================================================

function cleanAvatarCache() {
    const now = Date.now();
    const MAX_AVATAR_CACHE = 500;
    const MAX_ICON_CACHE = 500;
    for (const [key, value] of ctx.caches.AVATAR_CACHE.entries()) {
        if (now - value.time > ctx.caches.AVATAR_CACHE_DURATION) {
            ctx.caches.AVATAR_CACHE.delete(key);
        }
    }
    if (ctx.caches.AVATAR_CACHE.size > MAX_AVATAR_CACHE) {
        const oldestKey = ctx.caches.AVATAR_CACHE.keys().next().value;
        ctx.caches.AVATAR_CACHE.delete(oldestKey);
    }
    for (const [key, value] of ctx.caches.VERSION_ICON_CACHE.entries()) {
        if (now - value.time > ctx.caches.VERSION_ICON_CACHE_DURATION) {
            ctx.caches.VERSION_ICON_CACHE.delete(key);
        }
    }
    if (ctx.caches.VERSION_ICON_CACHE.size > MAX_ICON_CACHE) {
        const oldestKey = ctx.caches.VERSION_ICON_CACHE.keys().next().value;
        ctx.caches.VERSION_ICON_CACHE.delete(oldestKey);
    }
}

// ============================================================================
// 纯 JS 裁剪皮肤头部 (无 sharp 依赖)
// ============================================================================

function cropSkinHead(skinPngBuffer) {
    try {
        const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
        if (skinPngBuffer.length < 24 || !skinPngBuffer.slice(0, 8).equals(PNG_SIGNATURE)) {
            return null;
        }

        let offset = 8;
        let width = 0, height = 0;
        let ihdrFound = false;

        while (offset < skinPngBuffer.length) {
            const chunkLen = skinPngBuffer.readUInt32BE(offset);
            const chunkType = skinPngBuffer.slice(offset + 4, offset + 8).toString('ascii');
            if (chunkType === 'IHDR') {
                width = skinPngBuffer.readUInt32BE(offset + 8);
                height = skinPngBuffer.readUInt32BE(offset + 12);
                ihdrFound = true;
                break;
            }
            offset += 12 + chunkLen;
        }

        if (!ihdrFound || width < 64 || height < 32) return null;

        const headX = 8, headY = 8;
        const headW = 8, headH = 8;
        const hatX = 40, hatY = 8;

        const pixelData = utils.decodePngPixels(skinPngBuffer);
        if (!pixelData) return null;

        const outputSize = 64;
        const outPixels = Buffer.alloc(outputSize * outputSize * 4, 0);

        for (let dy = 0; dy < headH; dy++) {
            for (let dx = 0; dx < headW; dx++) {
                const sx = headX + dx;
                const sy = headY + dy;
                const srcIdx = (sy * width + sx) * 4;
                const r = pixelData[srcIdx] || 0;
                const g = pixelData[srcIdx + 1] || 0;
                const b = pixelData[srcIdx + 2] || 0;
                const a = pixelData[srcIdx + 3] || 0;

                const hx = hatX + dx;
                const hy = hatY + dy;
                const hatIdx = (hy * width + hx) * 4;
                const hr = pixelData[hatIdx] || 0;
                const hg = pixelData[hatIdx + 1] || 0;
                const hb = pixelData[hatIdx + 2] || 0;
                const ha = pixelData[hatIdx + 3] || 0;

                const fa = ha / 255;
                const ba = a / 255;
                const outA = ha + ba * (1 - fa);
                const outR = outA > 0 ? (hr * fa + r * ba * (1 - fa)) / outA : 0;
                const outG = outA > 0 ? (hg * fa + g * ba * (1 - fa)) / outA : 0;
                const outB = outA > 0 ? (hb * fa + b * ba * (1 - fa)) / outA : 0;

                const scale = outputSize / headW;
                for (let sy2 = 0; sy2 < scale; sy2++) {
                    for (let sx2 = 0; sx2 < scale; sx2++) {
                        const outX = dx * scale + sx2;
                        const outY = dy * scale + sy2;
                        const outIdx = (outY * outputSize + outX) * 4;
                        outPixels[outIdx] = Math.round(outR);
                        outPixels[outIdx + 1] = Math.round(outG);
                        outPixels[outIdx + 2] = Math.round(outB);
                        outPixels[outIdx + 3] = Math.round(outA * 255);
                    }
                }
            }
        }

        return utils.encodePng(outPixels, outputSize, outputSize);
    } catch (e) {
        console.log('[Avatar] cropSkinHead失败:', e.message);
        return null;
    }
}

// ============================================================================
// 从认证结果中提取皮肤 URL / 模型
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

// ============================================================================
// 版本清单磁盘缓存持久化
// ============================================================================

function saveDiskCache() {
    try {
        const dir = path.dirname(ctx.dirs.DISK_CACHE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(ctx.dirs.DISK_CACHE_PATH, JSON.stringify({ data: ctx.caches.versionCache, timestamp: ctx.caches.versionCacheTime }));
    } catch (e) {}
}

// ============================================================================
// 导出
// ============================================================================

module.exports = {
    cleanServerUrl,
    fetchSkinFromSessionServer,
    fetchSkinModelFromSessionServer,
    resolveSkinPath,
    getSteveHeadLocal,
    cropSkinToHeadWithSharp,
    fetchAvatarData,
    refreshAvatarCache,
    fetchAvatarDataFull,
    getSteveSkinFull,
    cleanAvatarCache,
    cropSkinHead,
    extractSkinUrlFromAuthResult,
    extractSkinModelFromAuthResult,
    saveDiskCache,
};
