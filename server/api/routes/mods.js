/**
 * server/api/routes/mods.js - 模组管理路由
 * ============================================================================
 * 从 server.js handleAPI switch 语句抽取的模组相关端点。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

module.exports = {
    register(registerRoute, deps) {
        const { ctx, sendJSON, sendError, readBody } = deps;
        const { mods, modpack, accounts, utils, http, versions } = deps;

        const MODRINTH_API = ctx.urls.MODRINTH_API;
        const CURSEFORGE_API = ctx.urls.CURSEFORGE_API;
        const ICON_CACHE_DIR = ctx.dirs.ICON_CACHE_DIR;
        const DATA_DIR = ctx.dirs.DATA_DIR;
        const modDownloadSessions = ctx.sessions.modDownloadSessions;

        // ====================================================================
        // /api/mods
        // ====================================================================
        registerRoute('GET', '/api/mods', async (req, res, parsedUrl) => {
            const modResult = mods.getInstalledMods();
            sendJSON(res, modResult);
        });

        // ====================================================================
        // /api/mod-icon
        // ====================================================================
        registerRoute('GET', '/api/mod-icon', async (req, res, parsedUrl) => {
            const hash = (parsedUrl.query.hash || '').replace(/[^a-f0-9]/gi, '');
            const iconPath = hash ? path.join(ICON_CACHE_DIR, hash + '.png') : '';
            try {
                if (iconPath && fs.existsSync(iconPath)) {
                    const data = fs.readFileSync(iconPath);
                    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' });
                    res.end(data);
                } else {
                    res.writeHead(404);
                    res.end('');
                }
            } catch (e) {
                res.writeHead(404);
                res.end('');
            }
        });

        // ====================================================================
        // /api/mods/search
        // ====================================================================
        registerRoute('GET', '/api/mods/search', async (req, res, parsedUrl) => {
            await new Promise(r => setImmediate(r));
            let rawQuery = parsedUrl.query.query || '';
            const source = parsedUrl.query.source || 'any';
            const loader = parsedUrl.query.loader || '';
            const mcVersion = parsedUrl.query.version || '';
            const category = parsedUrl.query.category || '';
            const sort = parsedUrl.query.sort || 'relevance';
            const limit = parseInt(parsedUrl.query.limit || '15', 10);
            const offset = parseInt(parsedUrl.query.offset || '0', 10);

            if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(rawQuery)) {
                try {
                    const cnMod = require('../../../js/mod-chinese-names.js');
                    const translated = cnMod.translateChineseSearch(rawQuery, 'mod');
                    if (translated) rawQuery = translated;
                } catch (e) {
                    try {
                        const cnKeys = Object.entries(require('../../../js/mod-chinese-names.js').CHINESE_SEARCH_KEYWORDS || {});
                        for (const [cn, enList] of cnKeys) {
                            if (rawQuery.includes(cn) || cn.includes(rawQuery)) { rawQuery = enList.join(' '); break; }
                        }
                    } catch (_) {}
                }
            }

            const SEARCH_STOP_WORDS = new Set(['forge', 'fabric', 'for', 'mod', 'quilt', 'neoforge', 'the', 'and', 'of']);
            function processSearchKeywords(text) {
                if (!text) return '';
                const lower = text.toLowerCase().trim();
                const words = lower.split(/\s+/).map(w => w.replace(/[\[\]]/g, '')).filter(w => {
                    if (!w) return false;
                    if (w.length <= 1) return false;
                    if (SEARCH_STOP_WORDS.has(w)) return false;
                    return true;
                });
                const distinct = [...new Set(words)];
                if (distinct.length === 0 && text.trim().length > 0) return text.trim().toLowerCase();
                const result = distinct.join(' ');
                if (lower.includes('optiforge') && !result.includes('optiforge')) return 'optiforge';
                if (lower.includes('optifabric') && !result.includes('optifabric')) return 'optifabric';
                return result;
            }

            const processedQuery = processSearchKeywords(rawQuery);

            async function searchModrinth(q, off, lim) {
                const facets = [['project_type:mod']];
                if (loader) facets.push([`categories:${loader}`]);
                if (mcVersion) facets.push([`versions:${mcVersion}`]);
                if (category) facets.push([`categories:${category}`]);
                const sortMap = { relevance: 'relevance', downloads: 'downloads', newest: 'newest', updated: 'updated', follows: 'follows' };
                const sortField = sortMap[sort] || (q ? 'relevance' : 'downloads');
                let searchUrl = `${MODRINTH_API}/search?query=${encodeURIComponent(q)}&index=${sortField}&limit=${lim}&offset=${off}`;
                searchUrl += `&facets=${encodeURIComponent(JSON.stringify(facets))}`;
                const result = await http.cachedFetchJSON(searchUrl, 60000);
                return {
                    hits: (result.hits || []).map(hit => ({
                        id: hit.project_id, slug: hit.slug, title: hit.title,
                        description: hit.description || '', author: (hit.author || '').replace(/_/g, ''),
                        icon: hit.icon_url || '', downloads: hit.downloads || 0, followers: hit.followers || 0,
                        categories: hit.categories || [], versions: hit.versions || [],
                        dateCreated: hit.date_created || '', dateModified: hit.date_modified || '',
                        source: 'modrinth', installed: false
                    })),
                    total: result.total_hits || 0
                };
            }

            async function searchCurseForge(q, off, lim) {
                const settings = versions.loadSettingsCached();
                const cfApiKey = settings.curseforgeApiKey || '$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEJQnPnm';
                const cfHeaders = { 'x-api-key': cfApiKey };
                let searchUrl = `${CURSEFORGE_API}/mods/search?gameId=432&searchFilter=${encodeURIComponent(q)}&sortOrder=Desc&classId=6&pageSize=${lim}&index=${off}`;
                if (sort === 'downloads') searchUrl += '&sortField=6';
                else if (sort === 'newest') searchUrl += '&sortField=11';
                else if (sort === 'updated') searchUrl += '&sortField=3';
                else searchUrl += '&sortField=2';
                if (loader) {
                    const loaderMap = { forge: 1, fabric: 4, quilt: 5, neoforge: 5 };
                    const loaderId = loaderMap[loader.toLowerCase()];
                    if (loaderId) searchUrl += `&modLoaderType=${loaderId}`;
                }
                if (mcVersion) searchUrl += `&gameVersion=${encodeURIComponent(mcVersion)}`;
                const result = await http.fetchJSON(searchUrl, cfHeaders);
                return {
                    hits: (result.data || []).map(mod => ({
                        id: String(mod.id), slug: mod.slug || '', title: mod.name || 'Unknown',
                        description: mod.summary || '', author: (mod.authors || [])[0] || 'Unknown',
                        icon: mod.logo?.url || '', downloads: mod.downloadCount || 0, followers: mod.followers || 0,
                        categories: (mod.categories || []).map(c => c.name || c.id || ''),
                        versions: [], dateCreated: mod.dateCreated || '', dateModified: mod.dateModified || '',
                        source: 'curseforge', installed: false, _cfDateReleased: mod.dateReleased || ''
                    })),
                    total: result.pagination?.totalCount || 0
                };
            }

            function isSameProject(a, b) {
                if (a.source === b.source) return false;
                const slugA = (a.slug || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                const slugB = (b.slug || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                if (slugA && slugB && slugA === slugB) return true;
                const titleA = (a.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                const titleB = (b.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                if (titleA && titleB && titleA === titleB) return true;
                const descA = (a.description || '').substring(0, 100).toLowerCase();
                const descB = (b.description || '').substring(0, 100).toLowerCase();
                if (descA.length > 20 && descB.length > 20 && descA === descB) return true;
                return false;
            }

            function computeScore(item, q) {
                let score = 0;
                const dl = item.downloads || 0;
                if (dl > 0) score += Math.log10(dl + 1) / 9;
                if (item.followers > 0) score += Math.log10(item.followers + 1) / 12;
                if (q && item.title) {
                    const t = item.title.toLowerCase();
                    const ql = q.toLowerCase();
                    if (t === ql) score += 10;
                    else if (t.startsWith(ql)) score += 8;
                    else if (t.includes(ql)) score += 5;
                    else {
                        const qWords = ql.split(/\s+/);
                        let matchCount = 0;
                        for (const w of qWords) {
                            if (w && t.includes(w)) matchCount++;
                        }
                        if (qWords.length > 0) score += (matchCount / qWords.length) * 4;
                    }
                }
                if (item.source === 'modrinth') score += 0.1;
                return score;
            }

            try {
                let hits = [];
                let totalHits = 0;

                if (source === 'modrinth') {
                    const r = await searchModrinth(processedQuery, offset, limit);
                    hits = r.hits;
                    totalHits = r.total;
                } else if (source === 'curseforge') {
                    const r = await searchCurseForge(processedQuery || rawQuery, offset, limit);
                    hits = r.hits;
                    totalHits = r.total;
                } else {
                    const cfLimit = Math.min(limit + 10, 40);
                    const mrLimit = Math.min(limit + 10, 40);
                    const fetchSize = Math.max(limit * 2, 40);
                    const [mrResult, cfResult] = await Promise.all([
                        searchModrinth(processedQuery, offset, fetchSize).catch(() => ({ hits: [], total: 0 })),
                        searchCurseForge(processedQuery || rawQuery, offset, fetchSize).catch(() => ({ hits: [], total: 0 }))
                    ]);
                    const allRaw = [...mrResult.hits, ...cfResult.hits];
                    const deduped = [];
                    for (const item of allRaw) {
                        if (!deduped.some(d => isSameProject(d, item))) {
                            deduped.push(item);
                        }
                    }
                    if (sort === 'downloads' || sort === 'newest' || sort === 'updated') {
                        const sortMap2 = {
                            downloads: (a, b) => (b.downloads || 0) - (a.downloads || 0),
                            newest: (a, b) => new Date(b.dateCreated || b._cfDateReleased || 0) - new Date(a.dateCreated || a._cfDateReleased || 0),
                            updated: (a, b) => new Date(b.dateModified || 0) - new Date(a.dateModified || 0)
                        };
                        deduped.sort(sortMap2[sort] || sortMap2.downloads);
                    } else {
                        deduped.sort((a, b) => computeScore(b, processedQuery || rawQuery) - computeScore(a, processedQuery || rawQuery));
                    }
                    totalHits = Math.max(mrResult.total, cfResult.total);
                    hits = deduped.slice(offset, offset + limit);
                }

                sendJSON(res, { hits, total: totalHits, offset, processedQuery: processedQuery !== rawQuery ? processedQuery : undefined });
            } catch (e) {
                sendError(res, '搜索失败: ' + e.message);
            }
        });

        // ====================================================================
        // /api/mods/download
        // ====================================================================
        registerRoute('POST', '/api/mods/download', async (req, res, parsedUrl) => {
            const data = await readBody(req);
            const projectId = data.projectId;
            const source = data.source || 'modrinth';
            const loader = data.loader || '';
            const mcVersion = data.mcVersion || '';
            const versionId = data.versionId || '';
            if (!projectId) { sendError(res, 'Missing projectId', 400); return; }

            let modsDestDir = null;
            if (versionId) {
                modsDestDir = versions.getVersionModsDir(versionId);
            }
            if (!modsDestDir && mcVersion) {
                const installedVersions = versions.getInstalledVersions();
                const matched = installedVersions.find(v =>
                    v.id === mcVersion || v.baseVersion === mcVersion ||
                    v.inheritsFrom === mcVersion || v.id.startsWith(mcVersion)
                );
                if (matched) {
                    modsDestDir = versions.getVersionModsDir(matched.id);
                }
            }
            if (!modsDestDir) {
                const settings = versions.loadSettingsCached();
                modsDestDir = versions.getVersionModsDir(settings.selectedVersion);
            }
            if (!modsDestDir) {
                const installedVersions = versions.getInstalledVersions();
                if (installedVersions.length > 0) {
                    modsDestDir = versions.getVersionModsDir(installedVersions[0].id);
                }
                if (!modsDestDir) {
                    sendError(res, '请先安装一个游戏版本');
                    return;
                }
            }
            if (!fs.existsSync(modsDestDir)) fs.mkdirSync(modsDestDir, { recursive: true });

            let downloadUrl = null;
            let fileName = null;

            try {
                if (source === 'modrinth') {
                    const versionUrl = `${MODRINTH_API}/project/${projectId}/version`;
                    let versions = null;

                    if (loader && mcVersion) {
                        try {
                            versions = await http.fetchJSON(versionUrl + '?' + `loaders=["${loader}"]&game_versions=["${mcVersion}"]`);
                        } catch (e) {
                            console.warn(`[mods/download] Modrinth 精确查询失败: ${projectId} - ${e.message}`);
                        }
                    }
                    if (!versions || !versions.length) {
                        if (mcVersion) {
                            try {
                                versions = await http.fetchJSON(versionUrl + '?' + `game_versions=["${mcVersion}"]`);
                            } catch (e) {
                                console.warn(`[mods/download] Modrinth MC版本查询失败: ${projectId} - ${e.message}`);
                            }
                        }
                    }
                    if (!versions || !versions.length) {
                        try {
                            versions = await http.fetchJSON(versionUrl + '?limit=10');
                        } catch (e) {
                            console.warn(`[mods/download] Modrinth 全量查询失败: ${projectId} - ${e.message}`);
                        }
                    }

                    if (versions && versions.length) {
                        const primaryFile = versions[0].files?.find(f => f.primary === true);
                        const file = primaryFile || versions[0].files?.[0];
                        if (file) {
                            downloadUrl = file.url;
                            fileName = file.filename;
                        }
                    }
                } else if (source === 'curseforge') {
                    const settings = versions.loadSettingsCached();
                    const cfApiKey = settings.curseforgeApiKey || '$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEJQnPnm';
                    let loaderType = 4;
                    if (loader === 'forge') loaderType = 1;
                    else if (loader === 'neoforge') loaderType = 5;
                    else if (loader === 'fabric') loaderType = 4;
                    else if (loader === 'quilt') loaderType = 5;

                    const cfVersionUrl = `${CURSEFORGE_API}/mods/${projectId}/files?gameVersion=${mcVersion}${loader ? '&modLoaderType=' + loaderType : ''}`;
                    const cfHeaders = cfApiKey ? { 'x-api-key': cfApiKey } : {};
                    const cfResult = await http.fetchJSON(cfVersionUrl, cfHeaders);
                    if (cfResult.data && cfResult.data.length > 0) {
                        const file = cfResult.data[0];
                        downloadUrl = file.downloadUrl;
                        fileName = file.fileName;
                    } else if (mcVersion) {
                        const cfFallbackUrl = `${CURSEFORGE_API}/mods/${projectId}/files`;
                        const cfFallbackResult = await http.fetchJSON(cfFallbackUrl, cfHeaders);
                        if (cfFallbackResult.data && cfFallbackResult.data.length > 0) {
                            const matching = cfFallbackResult.data.filter(f =>
                                f.gameVersions && f.gameVersions.includes(mcVersion)
                            );
                            const file = matching.length > 0 ? matching[0] : cfFallbackResult.data[0];
                            downloadUrl = file.downloadUrl;
                            fileName = file.fileName;
                        }
                    }
                }
            } catch (e) {
                console.error(`[mods/download] 获取下载链接失败: ${source}/${projectId} - ${e.message}`);
            }

            if (!downloadUrl) { sendError(res, `未找到可下载的文件 (${source}/${projectId}, loader=${loader}, mc=${mcVersion})`); return; }

            const safeName = (fileName || `${projectId}.jar`).replace(/[^a-zA-Z0-9._\-]/g, '_');
            const destPath = path.join(modsDestDir, safeName);

            const sessionId = `mod-${Date.now()}`;
            modDownloadSessions.set(sessionId, {
                status: 'downloading', progress: 0, message: '下载中..',
                fileName: safeName, totalSize: 0, downloaded: 0,
                dependencies: 0, currentDep: 0
            });

            sendJSON(res, { success: true, sessionId, fileName: safeName, path: destPath });

            (async () => {
                try {
                    await http.downloadFile(downloadUrl, destPath, (p) => {
                        const session = modDownloadSessions.get(sessionId);
                        if (session) {
                            session.progress = Math.round(p.progress);
                            session.downloaded = p.bytesDownloaded || 0;
                            session.message = `下载 ${safeName} ${p.progress.toFixed(0)}%`;
                        }
                    }, 2);

                    const session = modDownloadSessions.get(sessionId);
                    if (session) {
                        session.status = 'completed';
                        session.progress = 100;
                        session.message = `${safeName} 下载完成！`;
                    }
                } catch (e) {
                    const session = modDownloadSessions.get(sessionId);
                    if (session) {
                        session.status = 'failed';
                        session.message = `下载失败: ${e.message}`;
                    }
                }
            })();
        });

        // ====================================================================
        // /api/mods/toggle
        // ====================================================================
        registerRoute('POST', '/api/mods/toggle', async (req, res, parsedUrl) => {
            const data = await readBody(req);
            const modId = data.modId;
            const enabled = data.enabled;
            const verId = data.versionId;
            if (!modId) { sendError(res, 'Missing modId', 400); return; }
            let modsPath = verId ? versions.getVersionModsDir(verId) : null;
            if (!modsPath) {
                const settings = versions.loadSettingsCached();
                modsPath = versions.getVersionModsDir(settings.selectedVersion);
            }
            if (!modsPath) {
                const installedVersions = versions.getInstalledVersions();
                if (installedVersions.length > 0) modsPath = versions.getVersionModsDir(installedVersions[0].id);
                if (!modsPath) { sendError(res, '请先安装一个游戏版本'); return; }
            }
            if (!fs.existsSync(modsPath)) { sendError(res, 'mods文件夹不存在'); return; }

            const baseName = modId.endsWith('.disabled') ? modId.replace(/\.disabled$/, '') : modId;
            const cleanPath = path.join(modsPath, baseName);
            const disabledPath = path.join(modsPath, baseName + '.disabled');

            try {
                if (enabled) {
                    if (fs.existsSync(disabledPath)) {
                        fs.renameSync(disabledPath, cleanPath);
                    } else if (fs.existsSync(cleanPath)) {
                    }
                } else {
                    if (fs.existsSync(cleanPath)) {
                        fs.renameSync(cleanPath, disabledPath);
                    }
                }
            } catch (e) {
                sendError(res, `文件操作失败: ${e.message}`);
                return;
            }
            sendJSON(res, { success: true, enabled });
        });

        // ====================================================================
        // /api/mods/delete
        // ====================================================================
        registerRoute('POST', '/api/mods/delete', async (req, res, parsedUrl) => {
            const data = await readBody(req);
            const modId = data.modId;
            if (!modId) { sendError(res, 'Missing modId', 400); return; }
            const settings = versions.loadSettingsCached();
            let modsPath = versions.getVersionModsDir(settings.selectedVersion);
            if (!modsPath) {
                const installedVersions = versions.getInstalledVersions();
                if (installedVersions.length > 0) modsPath = versions.getVersionModsDir(installedVersions[0].id);
            }
            const searchDirs = [modsPath];
            if (modsPath && !versions.resolveVersionIsolation(settings.selectedVersion)) {
                const sharedGameDir = settings.gameDir || DATA_DIR;
                const sharedModsDir = path.join(sharedGameDir, 'mods');
                if (sharedModsDir !== modsPath) searchDirs.push(sharedModsDir);
                const homeMinecraftMods = path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft', 'mods');
                if (homeMinecraftMods !== modsPath && homeMinecraftMods !== sharedModsDir) searchDirs.push(homeMinecraftMods);
            }
            let deletedCount = 0;
            for (const dir of searchDirs) {
                if (!dir || !fs.existsSync(dir)) continue;
                const modFiles = fs.readdirSync(dir).filter(f => {
                    const base = f.toLowerCase().replace('.disabled', '');
                    return base.includes(modId.toLowerCase());
                });
                modFiles.forEach(f => { try { fs.unlinkSync(path.join(dir, f)); deletedCount++; } catch (_) {} });
            }
            sendJSON(res, { success: true, message: `已删除 ${deletedCount} 个文件`, deleted: deletedCount });
        });

        // ====================================================================
        // /api/mods/check-updates
        // ====================================================================
        registerRoute('POST', '/api/mods/check-updates', async (req, res, parsedUrl) => {
            const cuData = await readBody(req);
            const cuVersionId = cuData.versionId;
            if (!cuVersionId) { sendError(res, 'Missing versionId', 400); return; }
            try {
                const result = await mods.checkModUpdates(cuVersionId);
                sendJSON(res, result);
            } catch (e) { sendJSON(res, { updates: [], error: e.message }); }
        });

        // ====================================================================
        // /api/mods/open-save-folder
        // ====================================================================
        registerRoute('GET', '/api/mods/open-save-folder', async (req, res, parsedUrl) => {
            try {
                const settings = versions.loadSettingsCached();
                let modsDir = versions.getVersionModsDir(settings.selectedVersion);

                if (!modsDir) {
                    const installedVersions = versions.getInstalledVersions();
                    if (installedVersions.length > 0) {
                        modsDir = versions.getVersionModsDir(installedVersions[0].id);
                    }
                    if (!modsDir) {
                        sendError(res, '请先安装一个游戏版本');
                        return;
                    }
                }

                if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
                require('child_process').exec(`explorer "${modsDir}"`);
                sendJSON(res, { success: true, path: modsDir });
            } catch (e) { sendJSON(res, { success: false, error: e.message }); }
        });

        // ====================================================================
        // /api/mods/installed
        // ====================================================================
        registerRoute('GET', '/api/mods/installed', async (req, res, parsedUrl) => {
            await new Promise(r => setImmediate(r));
            const imVersionId = parsedUrl.query.versionId;
            if (!imVersionId) { sendError(res, 'Missing versionId', 400); return; }
            try {
                const MAX_MODS = 200;
                const mods = [];
                const seenFiles = new Set();
                const imSettings = versions.loadSettingsCached();

                async function scanInstalledDir(dir, src) {
                    if (!dir || !fs.existsSync(dir)) return;
                    const allFiles = await fs.promises.readdir(dir);
                    const jarFiles = allFiles.filter(f => (f.endsWith('.jar') || f.endsWith('.zip') || f.endsWith('.jar.disabled') || f.endsWith('.zip.disabled')));
                    for (const f of jarFiles) {
                        if (mods.length >= MAX_MODS) break;
                        const isDisabled = f.endsWith('.disabled');
                        const realName = isDisabled ? f.replace('.disabled', '') : f;
                        if (seenFiles.has(realName)) continue;
                        seenFiles.add(realName);
                        const name = realName.replace(/\.(jar|zip)$/, '');
                        let stat;
                        try { stat = await fs.promises.stat(path.join(dir, f)); } catch (e) { stat = { size: 0 }; }
                        const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
                        let icon = '', author = '', description = '', version = '', projectId = '';
                        const jarPath = path.join(dir, f);
                        if (realName.endsWith('.jar') && fs.existsSync(jarPath)) {
                            try {
                                const parsed = mods.parseModJar(jarPath);
                                if (parsed.icon) icon = `/api/mod-icon?hash=${parsed.icon}`;
                                if (parsed.author) author = parsed.author;
                                if (parsed.description) description = parsed.description.substring(0, 200);
                                if (parsed.version) version = parsed.version;
                                if (parsed.id) projectId = parsed.id;
                            } catch (e) {}
                        }
                        mods.push({ id, name, fileName: f, disabled: isDisabled, description: description || (isDisabled ? '已禁用' : '已安装的模组'), version: version || '1.0', size: stat.size || 0, source: src, icon, author, projectId });
                    }
                }

                const imModsDir = versions.getVersionModsDir(imVersionId);
                await scanInstalledDir(imModsDir, '本地');
                if (!versions.resolveVersionIsolation(imVersionId)) {
                    const imSharedGameDir = imSettings.gameDir || DATA_DIR;
                    const imSharedModsDir = path.join(imSharedGameDir, 'mods');
                    if (imSharedModsDir !== imModsDir) await scanInstalledDir(imSharedModsDir, '共享');
                    const imHomeMods = path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft', 'mods');
                    if (imHomeMods !== imModsDir && imHomeMods !== imSharedModsDir) await scanInstalledDir(imHomeMods, '.minecraft');
                }
                sendJSON(res, mods);
            } catch (e) { sendJSON(res, []); }
        });

        // ====================================================================
        // /api/mods/select-modpack-file
        // ====================================================================
        registerRoute('GET', '/api/mods/select-modpack-file', async (req, res, parsedUrl) => {
            try {
                const result = await new Promise((resolve, reject) => {
                    const { dialog, BrowserWindow: BW } = require('electron');
                    dialog.showOpenDialog(BW.getAllWindows()[0] || null, {
                        properties: ['openFile'],
                        filters: [
                            { name: 'Modpack Files', extensions: ['mrpack', 'zip'] },
                            { name: 'All Files', extensions: ['*'] }
                        ]
                    }).then(r => resolve(r)).catch(reject);
                });
                if (result.canceled || !result.filePaths.length) {
                    sendJSON(res, null);
                } else {
                    sendJSON(res, { filePath: result.filePaths[0], fileName: path.basename(result.filePaths[0]) });
                }
            } catch (e) { sendJSON(res, null); }
        });

        // ====================================================================
        // /api/mods/select-file
        // ====================================================================
        registerRoute('GET', '/api/mods/select-file', async (req, res, parsedUrl) => {
            try {
                const result = await new Promise((resolve, reject) => {
                    const { dialog, BrowserWindow: BW } = require('electron');
                    dialog.showOpenDialog(BW.getAllWindows()[0] || null, {
                        properties: ['openFile'],
                        filters: [{ name: 'Mod Files', extensions: ['jar', 'zip'] }]
                    }).then(r => resolve(r)).catch(reject);
                });
                if (result.canceled || !result.filePaths.length) {
                    sendJSON(res, null);
                } else {
                    sendJSON(res, { filePath: result.filePaths[0], fileName: path.basename(result.filePaths[0]) });
                }
            } catch (e) { sendJSON(res, null); }
        });

        // ====================================================================
        // /api/mods/select-save-folder
        // ====================================================================
        registerRoute('POST', '/api/mods/select-save-folder', async (req, res, parsedUrl) => {
            try {
                const ssfData = await readBody(req);
                const ssfDefaultPath = ssfData.defaultPath || '';
                const { ipcMain } = require('electron');
                const allWindows = require('electron').BrowserWindow.getAllWindows();
                const win = allWindows.length > 0 ? allWindows[0] : null;
                let result;
                if (win && win.webContents) {
                    result = await win.webContents.executeJavaScript(`window.electronAPI?.selectSaveFolder?.(${JSON.stringify(ssfDefaultPath)})`).catch(() => null);
                }
                if (!result) {
                    const { dialog } = require('electron');
                    result = await dialog.showOpenDialog(win, {
                        properties: ['openDirectory'],
                        title: '选择模组保存文件夹',
                        defaultPath: ssfDefaultPath || undefined
                    });
                    result = { cancelled: result.canceled || !result.filePaths.length, path: result.filePaths?.[0] || '' };
                }
                if (result.cancelled) {
                    sendJSON(res, { cancelled: true, error: result.error || '' });
                } else {
                    sendJSON(res, { cancelled: false, path: result.path });
                }
            } catch (e) {
                console.error('[select-save-folder] dialog error:', e);
                sendJSON(res, { cancelled: true, error: e.message });
            }
        });

        // ====================================================================
        // /api/mods/get-dependencies
        // ====================================================================
        registerRoute('POST', '/api/mods/get-dependencies', async (req, res, parsedUrl) => {
            const gdData = await readBody(req);
            const gdVersionId = gdData.versionId;
            const gdSource = gdData.source || 'modrinth';
            const gdGameVersion = gdData.gameVersion || '';
            const gdLoader = gdData.loader || '';
            const gdProjectId = gdData.projectId || '';
            try {
                let deps = [];
                if (gdSource === 'modrinth') {
                    if (gdVersionId) {
                        const versionData = await http.cachedFetchJSON(`${MODRINTH_API}/version/${gdVersionId}`, 300000);
                        if (versionData && versionData.dependencies) {
                            const requiredDeps = versionData.dependencies.filter(d =>
                                d.dependency_type === 'required' && d.project_id &&
                                d.project_id !== 'P7dR8mSH' && d.project_id !== 'qvIfYCYJ'
                            );
                            if (requiredDeps.length > 0) {
                                const depIds = requiredDeps.map(d => `"${d.project_id}"`).join(',');
                                let depProjects = [];
                                try { depProjects = await http.cachedFetchJSON(`${MODRINTH_API}/projects?ids=[${depIds}]`, 300000) || []; } catch (e) {}
                                const depProjMap = {};
                                for (const p of depProjects) { depProjMap[p.id] = p; }
                                const missingDepIds = requiredDeps.filter(d => !depProjMap[d.project_id]);
                                if (missingDepIds.length > 0) {
                                    const retries = await Promise.allSettled(missingDepIds.map(d => http.cachedFetchJSON(`${MODRINTH_API}/project/${d.project_id}`, 120000)));
                                    for (let i = 0; i < missingDepIds.length; i++) {
                                        if (retries[i].status === 'fulfilled' && retries[i].value) {
                                            depProjMap[missingDepIds[i].project_id] = retries[i].value;
                                        }
                                    }
                                }
                                const depVersionPromises = requiredDeps.map(async dep => {
                                    const proj = depProjMap[dep.project_id];
                                    let compatibleVersion = null;
                                    if (proj) {
                                        try {
                                            let depVerUrl = `${MODRINTH_API}/project/${dep.project_id}/version`;
                                            let depParams = [];
                                            if (gdGameVersion) depParams.push(`game_versions=["${gdGameVersion}"]`);
                                            if (gdLoader) depParams.push(`loaders=["${gdLoader}"]`);
                                            depParams.push('limit=1');
                                            let depVersions = await http.cachedFetchJSON(depVerUrl + '?' + depParams.join('&'), 120000);
                                            if (!depVersions?.length && gdGameVersion && gdLoader) {
                                                depParams = [`game_versions=["${gdGameVersion}"]`, 'limit=1'];
                                                depVersions = await http.cachedFetchJSON(depVerUrl + '?' + depParams.join('&'), 120000);
                                            }
                                            if (!depVersions?.length && (gdGameVersion || gdLoader)) {
                                                depParams = ['limit=1'];
                                                depVersions = await http.cachedFetchJSON(depVerUrl + '?' + depParams.join('&'), 120000);
                                            }
                                            if (depVersions?.length) {
                                                const depFile = depVersions[0].files?.find(f => f.primary) || depVersions[0].files?.[0];
                                                compatibleVersion = {
                                                    versionId: depVersions[0].id,
                                                    versionNumber: depVersions[0].version_number,
                                                    fileName: depFile?.filename,
                                                    downloadUrl: depFile?.url,
                                                    size: depFile?.size || 0
                                                };
                                            }
                                        } catch (e) {}
                                    }
                                    return {
                                        projectId: dep.project_id,
                                        title: proj?.title || dep.project_id,
                                        icon: proj?.icon_url || '',
                                        description: proj?.description || '',
                                        compatibleVersion
                                    };
                                });
                                deps = await Promise.all(depVersionPromises);
                            }
                        }
                    }
                } else if (gdSource === 'curseforge') {
                    const cfModId = gdProjectId || gdVersionId;
                    if (cfModId && gdVersionId) {
                        const settings = versions.loadSettingsCached();
                        const cfApiKey = settings.curseforgeApiKey || '$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEJQnPnm';
                        try {
                            const fileInfo = await http.cachedFetchJSON(`${CURSEFORGE_API}/mods/${cfModId}/files/${gdVersionId}`, 120000, { 'x-api-key': cfApiKey });
                            const cfDeps = fileInfo?.data?.dependencies || [];
                            const requiredCfDeps = cfDeps.filter(d => d.relationType === 3 && d.modId);
                            if (requiredCfDeps.length > 0) {
                                const cfDepPromises = requiredCfDeps.map(async dep => {
                                    let projInfo = null;
                                    let compatibleVersion = null;
                                    try {
                                        const modInfo = await http.cachedFetchJSON(`${CURSEFORGE_API}/mods/${dep.modId}`, 120000, { 'x-api-key': cfApiKey });
                                        projInfo = modInfo?.data;
                                        if (projInfo && gdGameVersion) {
                                            const filesList = await http.cachedFetchJSON(`${CURSEFORGE_API}/mods/${dep.modId}/files?gameVersion=${encodeURIComponent(gdGameVersion)}&pageSize=1`, 120000, { 'x-api-key': cfApiKey });
                                            const cfFile = filesList?.data?.[0];
                                            if (cfFile) {
                                                compatibleVersion = {
                                                    versionId: String(cfFile.id),
                                                    versionNumber: cfFile.displayName || cfFile.fileName,
                                                    fileName: cfFile.fileName,
                                                    downloadUrl: cfFile.downloadUrl,
                                                    size: cfFile.fileLength || 0
                                                };
                                            }
                                        }
                                    } catch (e) {}
                                    return {
                                        projectId: String(dep.modId),
                                        title: projInfo?.name || String(dep.modId),
                                        icon: projInfo?.logo?.thumbnailUrl || projInfo?.logo?.url || '',
                                        description: projInfo?.summary || '',
                                        compatibleVersion
                                    };
                                });
                                deps = await Promise.all(cfDepPromises);
                            }
                        } catch (e) { console.error(`[ModDeps] CurseForge依赖查询失败: ${e.message}`); }
                    }
                }
                sendJSON(res, { dependencies: deps });
            } catch (e) {
                sendJSON(res, { dependencies: [] });
            }
        });

        // ====================================================================
        // /api/mods/get-dependencies-recursive
        // ====================================================================
        registerRoute('POST', '/api/mods/get-dependencies-recursive', async (req, res, parsedUrl) => {
            const gdrData = await readBody(req);
            const gdrVersionId = gdrData.versionId;
            const gdrSource = gdrData.source || 'modrinth';
            const gdrGameVersion = gdrData.gameVersion || '';
            const gdrLoader = gdrData.loader || '';
            const gdrProjectId = gdrData.projectId || '';
            try {
                const allDeps = [];
                const visited = new Set();
                const SKIP_PROJECTS = new Set(['P7dR8mSH', 'qvIfYCYJ']);
                const settings = versions.loadSettingsCached();
                const cfApiKey = settings.curseforgeApiKey || '$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEJQnPnm';

                async function resolveDeps(versionId, parentProjectId, depth, source) {
                    if (depth > 10) return;
                    const curSource = source || gdrSource;
                    let depList = [];
                    if (curSource === 'modrinth') {
                        let versionData = null;
                        try { versionData = await http.cachedFetchJSON(`${MODRINTH_API}/version/${versionId}`, 300000); } catch (e) {}
                        if (!versionData || !versionData.dependencies) return;
                        for (const d of versionData.dependencies) {
                            if (d.dependency_type !== 'required' || !d.project_id || SKIP_PROJECTS.has(d.project_id)) continue;
                            depList.push({ projectId: d.project_id, modId: d.project_id, source: 'modrinth' });
                        }
                        if (depList.length === 0) return;
                        const depIds = depList.map(d => `"${d.projectId}"`).join(',');
                        let depProjects = [];
                        try { depProjects = await http.cachedFetchJSON(`${MODRINTH_API}/projects?ids=[${depIds}]`, 300000) || []; } catch (e) {}
                        const projMap = {};
                        for (const p of depProjects) { projMap[p.id] = p; }
                        const missingProjects = depList.filter(d => !projMap[d.projectId]);
                        if (missingProjects.length > 0) {
                            const retries = await Promise.allSettled(missingProjects.map(d => http.cachedFetchJSON(`${MODRINTH_API}/project/${d.projectId}`, 120000)));
                            for (let i = 0; i < missingProjects.length; i++) {
                                if (retries[i].status === 'fulfilled' && retries[i].value) {
                                    projMap[missingProjects[i].projectId] = retries[i].value;
                                }
                            }
                        }
                        for (const dep of depList) {
                            if (visited.has(dep.projectId)) continue;
                            visited.add(dep.projectId);
                            const proj = projMap[dep.projectId];
                            let compatibleVersion = null;
                            try {
                                let depVerUrl = `${MODRINTH_API}/project/${dep.projectId}/version`;
                                let depParams = [];
                                if (gdrGameVersion) depParams.push(`game_versions=["${gdrGameVersion}"]`);
                                if (gdrLoader) depParams.push(`loaders=["${gdrLoader}"]`);
                                depParams.push('limit=1');
                                let depVersions = await http.cachedFetchJSON(depVerUrl + '?' + depParams.join('&'), 120000);
                                if (!depVersions?.length && gdrGameVersion && gdrLoader) {
                                    depParams = [`game_versions=["${gdrGameVersion}"]`, 'limit=1'];
                                    depVersions = await http.cachedFetchJSON(depVerUrl + '?' + depParams.join('&'), 120000);
                                }
                                if (!depVersions?.length && (gdrGameVersion || gdrLoader)) {
                                    depParams = ['limit=1'];
                                    depVersions = await http.cachedFetchJSON(depVerUrl + '?' + depParams.join('&'), 120000);
                                }
                                if (depVersions?.length) {
                                    const depFile = depVersions[0].files?.find(f => f.primary) || depVersions[0].files?.[0];
                                    compatibleVersion = {
                                        versionId: depVersions[0].id,
                                        versionNumber: depVersions[0].version_number,
                                        fileName: depFile?.filename,
                                        downloadUrl: depFile?.url,
                                        size: depFile?.size || 0
                                    };
                                    await resolveDeps(depVersions[0].id, dep.projectId, depth + 1, 'modrinth');
                                }
                            } catch (e) {}
                            allDeps.push({
                                projectId: dep.projectId,
                                title: proj?.title || dep.projectId,
                                icon: proj?.icon_url || '',
                                description: proj?.description || '',
                                compatibleVersion,
                                depth,
                                parentProjectId: parentProjectId || null
                            });
                        }
                    } else if (curSource === 'curseforge') {
                        const cfModId = parentProjectId || gdrProjectId || versionId;
                        let fileInfo = null;
                        try { fileInfo = await http.cachedFetchJSON(`${CURSEFORGE_API}/mods/${cfModId}/files/${versionId}`, 120000, { 'x-api-key': cfApiKey }); } catch (e) {}
                        const cfDeps = fileInfo?.data?.dependencies || [];
                        for (const d of cfDeps) {
                            if ((d.relationType !== 3 && d.relationType !== 5) || !d.modId) continue;
                            const modIdStr = String(d.modId);
                            if (visited.has(modIdStr)) continue;
                            visited.add(modIdStr);
                            let projInfo = null;
                            let compatibleVersion = null;
                            try {
                                const modInfo = await http.cachedFetchJSON(`${CURSEFORGE_API}/mods/${modIdStr}`, 120000, { 'x-api-key': cfApiKey });
                                projInfo = modInfo?.data;
                                if (projInfo && gdrGameVersion) {
                                    const filesList = await http.cachedFetchJSON(`${CURSEFORGE_API}/mods/${modIdStr}/files?gameVersion=${encodeURIComponent(gdrGameVersion)}&pageSize=1`, 120000, { 'x-api-key': cfApiKey });
                                    const cfFile = filesList?.data?.[0];
                                    if (cfFile) {
                                        compatibleVersion = {
                                            versionId: String(cfFile.id),
                                            versionNumber: cfFile.displayName || cfFile.fileName,
                                            fileName: cfFile.fileName,
                                            downloadUrl: cfFile.downloadUrl,
                                            size: cfFile.fileLength || 0
                                        };
                                        await resolveDeps(String(cfFile.id), modIdStr, depth + 1, 'curseforge');
                                    }
                                }
                            } catch (e) {}
                            allDeps.push({
                                projectId: modIdStr,
                                title: projInfo?.name || modIdStr,
                                icon: projInfo?.logo?.thumbnailUrl || projInfo?.logo?.url || '',
                                description: projInfo?.summary || '',
                                compatibleVersion,
                                depth,
                                parentProjectId: parentProjectId || null
                            });
                        }
                    }
                }

                await resolveDeps(gdrVersionId, null, 1, null);
                sendJSON(res, { dependencies: allDeps });
            } catch (e) {
                sendJSON(res, { dependencies: [] });
            }
        });

        // ====================================================================
        // /api/mods/project-versions
        // ====================================================================
        registerRoute('*', '/api/mods/project-versions', async (req, res, parsedUrl) => {
            let pvProjectId, pvSource, pvGameVersion, pvLoader;
            if (req.method === 'GET') {
                const q = parsedUrl.query || {};
                pvProjectId = q.projectId;
                pvSource = q.source || 'modrinth';
                pvGameVersion = q.gameVersion || '';
                pvLoader = q.loader || '';
            } else {
                const pvBody = await readBody(req);
                pvProjectId = pvBody.projectId;
                pvSource = pvBody.source || 'modrinth';
                pvGameVersion = pvBody.gameVersion || '';
                pvLoader = pvBody.loader || '';
            }
            try {
                if (pvSource !== 'modrinth' || !pvProjectId) {
                    sendJSON(res, { versions: [] });
                    return;
                }
                let verUrl = `${MODRINTH_API}/project/${pvProjectId}/version`;
                const verParams = [];
                if (pvGameVersion) verParams.push(`game_versions=["${pvGameVersion}"]`);
                if (pvLoader) verParams.push(`loaders=["${pvLoader}"]`);
                if (verParams.length) verUrl += '?' + verParams.join('&');
                const rawVersions = await http.cachedFetchJSON(verUrl, 600000);
                let versions = (rawVersions || []).map(v => ({
                    versionId: v.id,
                    versionNumber: v.version_number,
                    gameVersions: v.game_versions || [],
                    loaders: v.loaders || [],
                    files: (v.files || []).map(f => ({
                        filename: f.filename,
                        url: f.url,
                        size: f.size || 0,
                        primary: !!f.primary
                    })),
                    datePublished: v.date_published,
                    changelog: v.changelog || ''
                }));
                if (versions.length === 0 && (pvGameVersion || pvLoader)) {
                    try {
                        let fallbackUrl = `${MODRINTH_API}/project/${pvProjectId}/version`;
                        const fallbackParams = [];
                        if (pvGameVersion) fallbackParams.push(`game_versions=["${pvGameVersion}"]`);
                        if (fallbackParams.length) fallbackUrl += '?' + fallbackParams.join('&');
                        const fb1 = await http.cachedFetchJSON(fallbackUrl, 600000);
                        versions = (fb1 || []).map(v => ({
                            versionId: v.id,
                            versionNumber: v.version_number,
                            gameVersions: v.game_versions || [],
                            loaders: v.loaders || [],
                            files: (v.files || []).map(f => ({
                                filename: f.filename,
                                url: f.url,
                                size: f.size || 0,
                                primary: !!f.primary
                            })),
                            datePublished: v.date_published,
                            changelog: v.changelog || ''
                        }));
                    } catch (e) {}
                }
                if (versions.length === 0 && (pvGameVersion || pvLoader)) {
                    try {
                        const fb2 = await http.cachedFetchJSON(`${MODRINTH_API}/project/${pvProjectId}/version?limit=10`, 600000);
                        versions = (fb2 || []).map(v => ({
                            versionId: v.id,
                            versionNumber: v.version_number,
                            gameVersions: v.game_versions || [],
                            loaders: v.loaders || [],
                            files: (v.files || []).map(f => ({
                                filename: f.filename,
                                url: f.url,
                                size: f.size || 0,
                                primary: !!f.primary
                            })),
                            datePublished: v.date_published,
                            changelog: v.changelog || ''
                        }));
                    } catch (e) {}
                }
                sendJSON(res, { versions });
            } catch (e) {
                sendJSON(res, { versions: [] });
            }
        });

        // ====================================================================
        // /api/mods/install-from-file
        // ====================================================================
        registerRoute('POST', '/api/mods/install-from-file', async (req, res, parsedUrl) => {
            const mifData = await readBody(req);
            const { versionId, filePath: mifFilePath } = mifData;
            if (!versionId || !mifFilePath) { sendError(res, 'Missing params', 400); return; }
            try {
                const modsDir = versions.getVersionSubDir(versionId, 'mods');
                if (!modsDir) { sendError(res, '无法确定模组目录'); return; }
                if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
                const destPath = path.join(modsDir, path.basename(mifFilePath));
                fs.copyFileSync(mifFilePath, destPath);
                sendJSON(res, { success: true });
            } catch (e) { sendJSON(res, { success: false, error: e.message }); }
        });

        // ====================================================================
        // /api/mods/remove
        // ====================================================================
        registerRoute('POST', '/api/mods/remove', async (req, res, parsedUrl) => {
            const body7 = await readBody(req);
            const { versionId: rmVerId, fileName: rmFile } = body7;
            if (!rmVerId || !rmFile) { sendError(res, 'Missing params', 400); return; }
            if (rmFile.includes('..') || rmFile.includes('/') || rmFile.includes('\\')) { sendError(res, 'Invalid fileName', 400); return; }
            try {
                const modsDir = versions.getVersionModsDir(rmVerId);
                if (!modsDir) { sendError(res, '无法确定模组目录', 400); return; }
                const rmFilePath = path.resolve(path.join(modsDir, rmFile));
                if (!rmFilePath.startsWith(path.resolve(modsDir))) { sendError(res, 'Invalid path', 400); return; }
                if (fs.existsSync(rmFilePath)) { fs.unlinkSync(rmFilePath); }
                sendJSON(res, { success: true });
            } catch (e) { sendJSON(res, { success: false, error: e.message }); }
        });

        // ====================================================================
        // /api/mods/detail
        // ====================================================================
        registerRoute('GET', '/api/mods/detail', async (req, res, parsedUrl) => {
            const modProjectId = parsedUrl.query.projectId;
            const modSource = parsedUrl.query.source || 'modrinth';
            if (!modProjectId) { sendError(res, 'Missing projectId', 400); return; }

            try {
                if (modSource === 'modrinth') {
                    const project = await http.cachedFetchJSON(`${MODRINTH_API}/project/${modProjectId}`, 300000);
                    const detail = {
                        id: project.id,
                        slug: project.slug,
                        title: project.title,
                        description: project.description || '',
                        body: project.body || '',
                        icon: project.icon_url || '',
                        downloads: project.downloads || 0,
                        followers: project.followers || 0,
                        categories: project.categories || [],
                        loaders: project.loaders || [],
                        gameVersions: project.game_versions || [],
                        clientSide: project.client_side || 'unknown',
                        serverSide: project.server_side || 'unknown',
                        license: project.license?.name || '',
                        sourceUrl: project.source_url || '',
                        issuesUrl: project.issues_url || '',
                        wikiUrl: project.wiki_url || '',
                        discordUrl: project.discord_url || '',
                        dateCreated: project.published || '',
                        dateModified: project.updated || '',
                        gallery: (project.gallery || []).map(g => typeof g === 'string' ? g : g.url || ''),
                        source: 'modrinth'
                    };
                    sendJSON(res, detail);
                } else if (modSource === 'curseforge') {
                    const settings = versions.loadSettingsCached();
                    const cfApiKey = settings.curseforgeApiKey || '';
                    const cfHeaders = cfApiKey ? { 'x-api-key': cfApiKey } : {};
                    const cfProject = await http.fetchJSON(`${CURSEFORGE_API}/mods/${modProjectId}`, cfHeaders);
                    const mod = cfProject.data || cfProject;
                    const detail = {
                        id: String(mod.id),
                        slug: mod.slug || '',
                        title: mod.name || 'Unknown',
                        description: mod.summary || '',
                        body: mod.description || mod.summary || '',
                        icon: mod.logo?.url || '',
                        downloads: mod.downloadCount || 0,
                        followers: mod.followers || mod.thumbsUpCount || 0,
                        categories: (mod.categories || []).map(c => typeof c === 'string' ? c : c.name || ''),
                        loaders: (mod.latestFilesIndexes || []).map(f => {
                            if (f.modLoader === 1) return 'forge';
                            if (f.modLoader === 4) return 'fabric';
                            if (f.modLoader === 5) return 'neoforge';
                            return '';
                        }).filter(Boolean),
                        gameVersions: [...new Set((mod.latestFilesIndexes || []).map(f => f.gameVersion))],
                        clientSide: 'unknown',
                        serverSide: 'unknown',
                        license: '',
                        sourceUrl: mod.links?.sourceUrl || '',
                        issuesUrl: mod.links?.issuesUrl || '',
                        wikiUrl: mod.links?.wikiUrl || '',
                        discordUrl: '',
                        dateCreated: mod.dateCreated || '',
                        dateModified: mod.dateModified || '',
                        gallery: (mod.screenshots || []).map(s => typeof s === 'string' ? s : s.url || ''),
                        source: 'curseforge'
                    };
                    sendJSON(res, detail);
                } else {
                    sendError(res, 'Unsupported source', 400);
                }
            } catch (e) {
                sendError(res, '获取模组详情失败: ' + e.message);
            }
        });

        // ====================================================================
        // /api/mods/versions
        // ====================================================================
        registerRoute('GET', '/api/mods/versions', async (req, res, parsedUrl) => {
            const mvProjectId = parsedUrl.query.projectId;
            const mvSource = parsedUrl.query.source || 'modrinth';
            const mvLoader = parsedUrl.query.loader || '';
            const mvGameVer = parsedUrl.query.gameVersion || '';
            if (!mvProjectId) { sendError(res, 'Missing projectId', 400); return; }

            try {
                if (mvSource === 'modrinth') {
                    const encodedId = encodeURIComponent(mvProjectId);
                    let versionUrl = `${MODRINTH_API}/project/${encodedId}/version`;
                    const params = [];
                    if (mvLoader) params.push(`loaders=["${encodeURIComponent(mvLoader)}"]`);
                    if (mvGameVer) params.push(`game_versions=["${encodeURIComponent(mvGameVer)}"]`);
                    if (params.length > 0) versionUrl += '?' + params.join('&');

                    let versions;
                    try {
                        versions = await http.cachedFetchJSON(versionUrl, 600000, 3, 25000);
                    } catch (mirrorErr) {
                        console.warn(`[Modrinth] 镜像请求失败，直接请求官方API: ${mirrorErr.message}`);
                        const officialUrl = `${MODRINTH_API}/project/${encodedId}/version${params.length > 0 ? '?' + params.join('&') : ''}`;
                        versions = await http.fetchJSON(officialUrl, 2, 30000);
                    }
                    const result = (versions || []).map(v => ({
                        id: v.id,
                        versionNumber: v.version_number || '',
                        versionName: v.name || v.version_number || '',
                        gameVersions: v.game_versions || [],
                        loaders: v.loaders || [],
                        releaseType: v.version_type || 'release',
                        datePublished: v.date_published || '',
                        downloads: v.downloads || 0,
                        changelog: v.changelog || '',
                        files: (v.files || []).map(f => ({
                            id: f.id || f.hashes?.sha1 || '',
                            url: f.url,
                            filename: f.filename,
                            size: f.size || 0,
                            primary: f.primary || false,
                            sha1: f.hashes?.sha1 || ''
                        })),
                        dependencies: (v.dependencies || []).map(d => ({
                            projectId: d.project_id,
                            versionId: d.version_id,
                            dependencyType: d.dependency_type,
                            modName: d.project_id || ''
                        }))
                    }));
                    sendJSON(res, { versions: result });
                } else if (mvSource === 'curseforge') {
                    const settings = versions.loadSettingsCached();
                    const cfApiKey = settings.curseforgeApiKey || '';
                    const cfHeaders = cfApiKey ? { 'x-api-key': cfApiKey } : {};

                    let allCfFiles = [];
                    let cfPageIndex = 0;
                    const cfPageSize = 1000;
                    let cfHasMore = true;

                    while (cfHasMore) {
                        let cfUrl = `${CURSEFORGE_API}/mods/${mvProjectId}/files?pageSize=${cfPageSize}&index=${cfPageIndex}`;
                        const cfParams = [];
                        if (mvGameVer) cfParams.push(`gameVersion=${mvGameVer}`);
                        if (mvLoader) {
                            const loaderMap = { fabric: 4, forge: 1, neoforge: 6, quilt: 5 };
                            const loaderType = loaderMap[mvLoader.toLowerCase()];
                            if (loaderType) cfParams.push(`modLoaderType=${loaderType}`);
                        }
                        if (cfParams.length > 0) cfUrl += '&' + cfParams.join('&');

                        const cfRes = await http.fetchJSON(cfUrl, cfHeaders, 25000);
                        const cfBatch = cfRes.data || [];
                        allCfFiles = allCfFiles.concat(cfBatch);

                        const pagination = cfRes.pagination;
                        if (pagination && pagination.totalCount > cfPageIndex + cfPageSize) {
                            cfPageIndex += cfPageSize;
                        } else {
                            cfHasMore = false;
                        }
                        if (cfBatch.length < cfPageSize) cfHasMore = false;
                    }

                    const cfFiles = allCfFiles;
                    const byVersion = new Map();
                    for (const f of cfFiles) {
                        const gv = (f.gameVersions || []).find(v => /^\d+\.\d+/.test(v)) || (f.gameVersions || [])[0] || '';
                        const key = gv || f.id;
                        if (!byVersion.has(key)) {
                            byVersion.set(key, {
                                id: String(f.id),
                                versionNumber: f.displayName || f.fileName || '',
                                versionName: f.displayName || f.fileName || '',
                                gameVersions: f.gameVersions || [],
                                loaders: (f.gameVersions || []).filter(v => ['fabric','forge','neoforge','quilt','fabric-loader','forge-loader'].includes(v.toLowerCase())).map(v => v.toLowerCase().replace('-loader','')),
                                releaseType: f.releaseType === 1 ? 'release' : f.releaseType === 2 ? 'beta' : 'alpha',
                                datePublished: f.fileDate || '',
                                downloads: 0,
                                changelog: '',
                                files: [],
                                dependencies: (f.dependencies || []).map(d => ({
                                    projectId: String(d.modId || ''),
                                    versionId: String(d.fileId || ''),
                                    dependencyType: d.relationType === 3 ? 'required' : d.relationType === 5 ? 'required' : d.relationType === 2 ? 'optional' : d.relationType === 1 ? 'optional' : 'incompatible',
                                    modName: ''
                                }))
                            });
                        }
                        byVersion.get(key).files.push({
                            id: String(f.id),
                            url: f.downloadUrl || '',
                            filename: f.fileName || '',
                            size: f.fileLength || 0,
                            primary: byVersion.get(key).files.length === 0,
                            sha1: ''
                        });
                    }
                    sendJSON(res, { versions: Array.from(byVersion.values()) });
                } else {
                    sendError(res, 'Unsupported source', 400);
                }
            } catch (e) {
                sendError(res, '获取模组版本列表失败: ' + e.message);
            }
        });

        // ====================================================================
        // /api/mods/download-version
        // ====================================================================
        registerRoute('POST', '/api/mods/download-version', async (req, res, parsedUrl) => {
            function isModAlreadyInstalled(modsDir, depFileName, depProjectId) {
                if (!modsDir || !fs.existsSync(modsDir)) return false;
                const exactPath = path.join(modsDir, depFileName);
                if (fs.existsSync(exactPath)) return true;
                const disabledPath = exactPath + '.disabled';
                if (fs.existsSync(disabledPath)) return true;
                try {
                    const existingFiles = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar') || f.endsWith('.jar.disabled'));
                    const baseName = depFileName.replace(/\.jar$/i, '').replace(/[-_](v?\d[\w.\-]*)$/i, '').toLowerCase();
                    for (const f of existingFiles) {
                        const fLower = f.toLowerCase();
                        const fBase = fLower.replace(/\.jar\.disabled$/i, '').replace(/\.jar$/i, '').replace(/[-_](v?\d[\w.\-]*)$/i, '');
                        if (baseName.length >= 3 && fBase.length >= 3) {
                            if (fBase === baseName || fBase.includes(baseName) || baseName.includes(fBase)) return true;
                        }
                    }
                    if (depProjectId) {
                        const slug = depProjectId.toLowerCase();
                        for (const f of existingFiles) {
                            if (f.toLowerCase().includes(slug)) return true;
                        }
                    }
                } catch (e) {}
                return false;
            }

            const dvData = await readBody(req);
            const dvVersionId = dvData.versionId;
            const dvSource = dvData.source || 'modrinth';
            const dvProjectId = dvData.projectId;
            const dvGameVersion = dvData.gameVersion || '';
            const dvLoader = dvData.loader || '';
            const dvSavePath = dvData.savePath || '';
            const dvIncludeDeps = dvData.includeDeps !== false;

            if (!dvVersionId && !dvProjectId) { sendError(res, 'Missing versionId or projectId', 400); return; }

            let destDir = dvSavePath;
            if (!destDir) {
                const settings = versions.loadSettingsCached();
                destDir = versions.getVersionModsDir(settings.selectedVersion);
            }

            if (!destDir) {
                const installedVersions = versions.getInstalledVersions();
                if (installedVersions.length > 0) {
                    destDir = versions.getVersionModsDir(installedVersions[0].id);
                }
                if (!destDir) {
                    sendError(res, '请先安装一个游戏版本');
                    return;
                }
            }

            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

            try {
                let downloadUrl = null;
                let fileName = null;
                let fileSize = 0;

                if (dvSource === 'modrinth') {
                    let versionData;
                    if (dvVersionId) {
                        versionData = await http.fetchJSON(`${MODRINTH_API}/version/${dvVersionId}`);
                    } else {
                        let versionApiUrl = `${MODRINTH_API}/project/${dvProjectId}/version`;
                        const params = [];
                        if (dvGameVersion) params.push(`game_versions=["${dvGameVersion}"]`);
                        if (dvLoader) params.push(`loaders=["${dvLoader}"]`);
                        if (params.length > 0) {
                            versionApiUrl += '?' + params.join('&');
                        } else {
                            versionApiUrl += '?limit=1';
                        }
                        const versions = await http.fetchJSON(versionApiUrl);

                        if (dvGameVersion || dvLoader) {
                            const filtered = (versions || []).filter(v => {
                                const gv = v.game_versions || [];
                                const loaders = (v.loaders || []).map(l => l.toLowerCase());
                                let match = true;
                                if (dvGameVersion && !gv.includes(dvGameVersion)) match = false;
                                if (dvLoader && !loaders.includes(dvLoader.toLowerCase())) match = false;
                                return match;
                            });
                            versionData = filtered[0] || versions?.[0];
                        } else {
                            versionData = versions?.[0];
                        }
                    }

                    if (!versionData) { sendError(res, '未找到匹配的版本信息'); return; }

                    const primaryFile = versionData.files?.find(f => f.primary) || versionData.files?.[0];
                    if (!primaryFile) { sendError(res, '未找到下载文件'); return; }

                    downloadUrl = primaryFile.url;
                    fileName = primaryFile.filename;
                    fileSize = primaryFile.size || 0;

                    const depDownloads = [];
                    if (dvIncludeDeps) {
                    for (const dep of (versionData.dependencies || [])) {
                        if (dep.dependency_type === 'required' && dep.project_id) {
                            try {
                                let depVersionApiUrl = `${MODRINTH_API}/project/${dep.project_id}/version`;
                                const depParams = [];
                                if (dvGameVersion) depParams.push(`game_versions=["${dvGameVersion}"]`);
                                if (dvLoader) depParams.push(`loaders=["${dvLoader}"]`);
                                if (depParams.length > 0) {
                                    depVersionApiUrl += '?' + depParams.join('&');
                                } else {
                                    depVersionApiUrl += '?limit=1';
                                }
                                const depVersions = await http.fetchJSON(depVersionApiUrl);
                                let depVersionData = null;
                                if (dvGameVersion || dvLoader) {
                                    const depFiltered = (depVersions || []).filter(v => {
                                        const gv = v.game_versions || [];
                                        const loaders = (v.loaders || []).map(l => l.toLowerCase());
                                        let match = true;
                                        if (dvGameVersion && !gv.includes(dvGameVersion)) match = false;
                                        if (dvLoader && !loaders.includes(dvLoader.toLowerCase())) match = false;
                                        return match;
                                    });
                                    depVersionData = depFiltered[0] || depVersions?.[0];
                                } else {
                                    depVersionData = depVersions?.[0];
                                }
                                if (depVersionData?.files?.[0]) {
                                    const depFile = depVersionData.files.find(f => f.primary) || depVersionData.files[0];
                                    const depName = depFile.filename;
                                    const depDest = path.join(destDir, depName);
                                    if (isModAlreadyInstalled(destDir, depName, dep.project_id)) {
                                        console.log(`[ModDownload] 前置依赖已安装，跳过下载: ${depName} (project: ${dep.project_id})`);
                                    } else {
                                        depDownloads.push({ url: depFile.url, fileName: depName, dest: depDest, size: depFile.size || 0 });
                                    }
                                }
                            } catch (e) {}
                        }
                    }
                    }

                    const safeName = (fileName || `${dvProjectId}.jar`).replace(/[^a-zA-Z0-9._\-]/g, '_');
                    const destPath = path.join(destDir, safeName);

                    const sessionId = `mod-${Date.now()}`;
                    const totalSteps = depDownloads.length + 1;
                    modDownloadSessions.set(sessionId, {
                        status: 'downloading', progress: 0, message: '下载中..',
                        fileName: safeName, totalSize: fileSize, downloaded: 0,
                        dependencies: depDownloads.length, currentDep: 0
                    });

                    sendJSON(res, { success: true, sessionId, fileName: safeName });

                    (async () => {
                        try {
                            for (let di = 0; di < depDownloads.length; di++) {
                                const dep = depDownloads[di];
                                const session = modDownloadSessions.get(sessionId);
                                if (session) {
                                    session.currentDep = di + 1;
                                    session.message = `下载前置依赖 (${di + 1}/${depDownloads.length}): ${dep.fileName}`;
                                }
                                await http.downloadFile(dep.url, dep.dest, (depProgress) => {
                                    const s = modDownloadSessions.get(sessionId);
                                    if (s) {
                                        const depBase = Math.round((di / totalSteps) * 100);
                                        const depWeight = 100 / totalSteps;
                                        s.progress = Math.min(99, depBase + Math.round(depProgress.progress * depWeight / 100));
                                        s.message = `下载前置依赖 (${di + 1}/${depDownloads.length}): ${dep.fileName} ${depProgress.progress.toFixed(0)}%`;
                                    }
                                }, 2);
                            }

                            const session = modDownloadSessions.get(sessionId);
                            if (session) {
                                session.message = `下载本体: ${safeName}`;
                            }
                            await http.downloadFile(downloadUrl, destPath, (p) => {
                                const s = modDownloadSessions.get(sessionId);
                                if (s) {
                                    const mainBase = Math.round((depDownloads.length / totalSteps) * 100);
                                    const mainWeight = 100 / totalSteps;
                                    s.progress = Math.min(99, mainBase + Math.round(p.progress * mainWeight / 100));
                                    s.downloaded = p.bytesDownloaded || 0;
                                    s.message = `下载本体: ${safeName} ${p.progress.toFixed(0)}%`;
                                }
                            }, 2);

                            const finalSession = modDownloadSessions.get(sessionId);
                            if (finalSession) {
                                finalSession.status = 'completed';
                                finalSession.progress = 100;
                                finalSession.message = `${safeName} 下载完成！`;
                            }
                        } catch (e) {
                            const session = modDownloadSessions.get(sessionId);
                            if (session) {
                                session.status = 'failed';
                                session.message = `下载失败: ${e.message}`;
                            }
                        }
                    })();
                } else if (dvSource === 'curseforge') {
                    const settings = versions.loadSettingsCached();
                    const cfApiKey = settings.curseforgeApiKey || '$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEJQnPnm';
                    const cfHeaders = cfApiKey ? { 'x-api-key': cfApiKey } : {};

                    let cfFileData = null;
                    if (dvVersionId) {
                        try {
                            const fileInfo = await http.fetchJSON(`${CURSEFORGE_API}/mods/${dvProjectId}/files/${dvVersionId}`, cfHeaders);
                            cfFileData = fileInfo?.data;
                        } catch (e) {}
                    }
                    if (!cfFileData && dvProjectId) {
                        let loaderType = 0;
                        if (dvLoader === 'forge') loaderType = 1;
                        else if (dvLoader === 'fabric') loaderType = 4;
                        else if (dvLoader === 'neoforge') loaderType = 6;
                        else if (dvLoader === 'quilt') loaderType = 5;
                        let cfVerUrl = `${CURSEFORGE_API}/mods/${dvProjectId}/files?pageSize=20`;
                        if (dvGameVersion) cfVerUrl += `&gameVersion=${encodeURIComponent(dvGameVersion)}`;
                        if (loaderType) cfVerUrl += `&modLoaderType=${loaderType}`;
                        try {
                            const cfRes = await http.fetchJSON(cfVerUrl, cfHeaders);
                            cfFileData = cfRes?.data?.[0];
                        } catch (e) {}
                    }

                    if (!cfFileData) { sendError(res, '未找到匹配的 CurseForge 文件'); return; }

                    downloadUrl = cfFileData.downloadUrl;
                    fileName = cfFileData.fileName;
                    fileSize = cfFileData.fileLength || 0;

                    if (!downloadUrl) { sendError(res, 'CurseForge 未提供下载链接（可能需要浏览器下载）'); return; }

                    const depDownloads = [];
                    if (dvIncludeDeps) {
                        const cfDeps = cfFileData.dependencies || [];
                        const requiredDeps = cfDeps.filter(d => (d.relationType === 3 || d.relationType === 5) && d.modId);
                        for (const dep of requiredDeps) {
                            try {
                                const depModInfo = await http.fetchJSON(`${CURSEFORGE_API}/mods/${dep.modId}`, cfHeaders);
                                let depFileUrl = `${CURSEFORGE_API}/mods/${dep.modId}/files?pageSize=5`;
                                if (dvGameVersion) depFileUrl += `&gameVersion=${encodeURIComponent(dvGameVersion)}`;
                                const depFiles = await http.fetchJSON(depFileUrl, cfHeaders);
                                const depFile = depFiles?.data?.[0];
                                if (depFile && depFile.downloadUrl) {
                                    const depName = depFile.fileName;
                                    const depDest = path.join(destDir, depName);
                                    if (isModAlreadyInstalled(destDir, depName, String(dep.modId))) {
                                        console.log(`[ModDownload] CurseForge前置已安装，跳过: ${depName} (modId: ${dep.modId})`);
                                    } else {
                                        depDownloads.push({ url: depFile.downloadUrl, fileName: depName, dest: depDest, size: depFile.fileLength || 0 });
                                    }
                                }
                            } catch (e) {
                                console.warn(`[ModDownload] CurseForge依赖查询失败: modId=${dep.modId} - ${e.message}`);
                            }
                        }
                    }

                    const safeName = (fileName || `${dvProjectId}.jar`).replace(/[^a-zA-Z0-9._\-]/g, '_');
                    const destPath = path.join(destDir, safeName);

                    const sessionId = `mod-${Date.now()}`;
                    const totalSteps = depDownloads.length + 1;
                    modDownloadSessions.set(sessionId, {
                        status: 'downloading', progress: 0, message: '下载中..',
                        fileName: safeName, totalSize: fileSize, downloaded: 0,
                        dependencies: depDownloads.length, currentDep: 0
                    });

                    sendJSON(res, { success: true, sessionId, fileName: safeName });

                    (async () => {
                        try {
                            for (let di = 0; di < depDownloads.length; di++) {
                                const dep = depDownloads[di];
                                const session = modDownloadSessions.get(sessionId);
                                if (session) {
                                    session.currentDep = di + 1;
                                    session.message = `下载前置依赖 (${di + 1}/${depDownloads.length}): ${dep.fileName}`;
                                }
                                await http.downloadFile(dep.url, dep.dest, (depProgress) => {
                                    const s = modDownloadSessions.get(sessionId);
                                    if (s) {
                                        const depBase = Math.round((di / totalSteps) * 100);
                                        const depWeight = 100 / totalSteps;
                                        s.progress = Math.min(99, depBase + Math.round(depProgress.progress * depWeight / 100));
                                        s.message = `下载前置依赖 (${di + 1}/${depDownloads.length}): ${dep.fileName} ${depProgress.progress.toFixed(0)}%`;
                                    }
                                }, 2);
                            }

                            const session = modDownloadSessions.get(sessionId);
                            if (session) {
                                session.message = `下载本体: ${safeName}`;
                            }
                            await http.downloadFile(downloadUrl, destPath, (p) => {
                                const s = modDownloadSessions.get(sessionId);
                                if (s) {
                                    const mainBase = Math.round((depDownloads.length / totalSteps) * 100);
                                    const mainWeight = 100 / totalSteps;
                                    s.progress = Math.min(99, mainBase + Math.round(p.progress * mainWeight / 100));
                                    s.downloaded = p.bytesDownloaded || 0;
                                    s.message = `下载本体: ${safeName} ${p.progress.toFixed(0)}%`;
                                }
                            }, 2);

                            const finalSession = modDownloadSessions.get(sessionId);
                            if (finalSession) {
                                finalSession.status = 'completed';
                                finalSession.progress = 100;
                                finalSession.message = `${safeName} 下载完成！`;
                            }
                        } catch (e) {
                            const session = modDownloadSessions.get(sessionId);
                            if (session) {
                                session.status = 'failed';
                                session.message = `下载失败: ${e.message}`;
                            }
                        }
                    })();
                } else {
                    sendError(res, 'Unsupported source', 400);
                }
            } catch (e) {
                sendError(res, '下载失败: ' + e.message);
            }
        });

        // ====================================================================
        // /api/mods/download-status
        // ====================================================================
        registerRoute('GET', '/api/mods/download-status', async (req, res, parsedUrl) => {
            const dsSessionId = parsedUrl.query.sessionId;
            if (!dsSessionId || !modDownloadSessions.has(dsSessionId)) {
                sendJSON(res, { status: 'unknown', progress: 0, message: '' });
                return;
            }
            const dsSession = modDownloadSessions.get(dsSessionId);
            sendJSON(res, { ...dsSession });
            if (dsSession.status === 'completed' || dsSession.status === 'failed') {
                setTimeout(() => modDownloadSessions.delete(dsSessionId), 120000);
            }
        });

        // ====================================================================
        // /api/mods/resolve-deps
        // ====================================================================
        registerRoute('GET', '/api/mods/resolve-deps', async (req, res, parsedUrl) => {
            const depIds = parsedUrl.query.ids;
            if (!depIds) { sendJSON(res, {}); return; }
            try {
                const ids = depIds.split(',').filter(Boolean);
                if (ids.length === 0) { sendJSON(res, {}); return; }
                const result = {};
                try {
                    const batchIds = JSON.stringify(ids);
                    const projects = await http.cachedFetchJSON(`${MODRINTH_API}/projects?ids=${encodeURIComponent(batchIds)}`, 300000);
                    if (Array.isArray(projects)) {
                        for (const project of projects) {
                            result[project.id] = {
                                id: project.id,
                                title: project.title || project.id,
                                icon: project.icon_url || '',
                                description: (project.description || '').substring(0, 100),
                                downloads: project.downloads || 0
                            };
                        }
                    }
                    for (const pid of ids) {
                        if (!result[pid]) {
                            result[pid] = { id: pid, title: pid, icon: '', description: '', downloads: 0 };
                        }
                    }
                } catch (batchErr) {
                    await Promise.all(ids.map(async (pid) => {
                        try {
                            const project = await http.cachedFetchJSON(`${MODRINTH_API}/project/${pid}`, 300000);
                            result[pid] = {
                                id: project.id,
                                title: project.title || pid,
                                icon: project.icon_url || '',
                                description: (project.description || '').substring(0, 100),
                                downloads: project.downloads || 0
                            };
                        } catch (e) {
                            result[pid] = { id: pid, title: pid, icon: '', description: '', downloads: 0 };
                        }
                    }));
                }
                sendJSON(res, result);
            } catch (e) { sendJSON(res, {}); }
        });

        // ====================================================================
        // /api/mods/resolve-deps-versions
        // ====================================================================
        registerRoute('POST', '/api/mods/resolve-deps-versions', async (req, res, parsedUrl) => {
            const rdvData = await readBody(req);
            const rdvIds = rdvData.ids || [];
            const rdvGameVersion = rdvData.gameVersion || '';
            const rdvLoader = rdvData.loader || '';
            const rdvSource = rdvData.source || 'modrinth';
            if (!rdvIds.length) { sendJSON(res, {}); return; }
            try {
                const result = {};
                let projectMap = {};
                const settings = versions.loadSettingsCached();
                const cfApiKey = settings.curseforgeApiKey || '$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEJQnPnm';
                try {
                    const batchIds = JSON.stringify(rdvIds);
                    const projects = await http.cachedFetchJSON(`${MODRINTH_API}/projects?ids=${encodeURIComponent(batchIds)}`, 300000);
                    if (Array.isArray(projects)) {
                        for (const p of projects) {
                            projectMap[p.id] = p;
                        }
                    }
                } catch (batchErr) {
                    const projectResults = await Promise.allSettled(rdvIds.map(pid => http.cachedFetchJSON(`${MODRINTH_API}/project/${pid}`, 300000)));
                    for (let i = 0; i < rdvIds.length; i++) {
                        if (projectResults[i].status === 'fulfilled') {
                            projectMap[rdvIds[i]] = projectResults[i].value;
                        }
                    }
                }
                const versionParams = [];
                if (rdvGameVersion) versionParams.push(`game_versions=["${rdvGameVersion}"]`);
                if (rdvLoader) versionParams.push(`loaders=["${rdvLoader}"]`);
                const versionQueryString = versionParams.length > 0 ? '?' + versionParams.join('&') : '';
                const versionResults = await Promise.allSettled(rdvIds.map(pid =>
                    http.cachedFetchJSON(`${MODRINTH_API}/project/${pid}/version${versionQueryString}`, 120000)
                ));
                for (let i = 0; i < rdvIds.length; i++) {
                    const pid = rdvIds[i];
                    const project = projectMap[pid];
                    const versionsRes = versionResults[i];
                    try {
                        const versions = versionsRes.status === 'fulfilled' ? versionsRes.value : [];
                        let compatibleVersion = null;
                        if (rdvGameVersion || rdvLoader) {
                            const filtered = (versions || []).filter(v => {
                                const gv = v.game_versions || [];
                                const loaders = (v.loaders || []).map(l => l.toLowerCase());
                                let match = true;
                                if (rdvGameVersion && !gv.includes(rdvGameVersion)) match = false;
                                if (rdvLoader && !loaders.includes(rdvLoader.toLowerCase())) match = false;
                                return match;
                            });
                            compatibleVersion = filtered[0] || null;
                        } else {
                            compatibleVersion = versions?.[0] || null;
                        }
                        result[pid] = {
                            id: project?.id || pid,
                            title: project?.title || pid,
                            slug: project?.slug || '',
                            icon: project?.icon_url || '',
                            description: (project?.description || '').substring(0, 100),
                            downloads: project?.downloads || 0,
                            hasCompatibleVersion: !!compatibleVersion,
                            versionId: compatibleVersion?.id || '',
                            versionNumber: compatibleVersion?.version_number || '',
                            fileName: compatibleVersion?.files?.find(f => f.primary)?.filename || compatibleVersion?.files?.[0]?.filename || '',
                            gameVersions: compatibleVersion?.game_versions || [],
                            loaders: compatibleVersion?.loaders || []
                        };
                    } catch (e) {
                        result[pid] = {
                            id: pid, title: pid, icon: '', description: '', downloads: 0,
                            hasCompatibleVersion: false, versionId: '', versionNumber: '',
                            fileName: '', gameVersions: [], loaders: []
                        };
                    }
                }
                const missingIds = rdvIds.filter(pid => !result[pid] || !result[pid].title || result[pid].title === pid);
                if (missingIds.length > 0) {
                    // 策略1: 对缺失的ID逐个重试 Modrinth 单项目查询
                    const retryResults = await Promise.allSettled(missingIds.map(async rid => {
                        try {
                            const proj = await http.cachedFetchJSON(`${MODRINTH_API}/project/${rid}`, 120000);
                            if (proj && proj.title) {
                                let compatibleVersion = null;
                                if (rdvGameVersion || rdvLoader) {
                                    const vr = await http.cachedFetchJSON(`${MODRINTH_API}/project/${rid}/version${versionQueryString}`, 120000);
                                    const filtered = (vr || []).filter(v => {
                                        const gv = v.game_versions || [];
                                        const loaders = (v.loaders || []).map(l => l.toLowerCase());
                                        let match = true;
                                        if (rdvGameVersion && !gv.includes(rdvGameVersion)) match = false;
                                        if (rdvLoader && !loaders.includes(rdvLoader.toLowerCase())) match = false;
                                        return match;
                                    });
                                    compatibleVersion = filtered[0] || null;
                                }
                                return {
                                    rid,
                                    data: {
                                        id: proj.id || rid,
                                        title: proj.title,
                                        icon: proj.icon_url || '',
                                        description: (proj.description || '').substring(0, 100),
                                        downloads: proj.downloads || 0,
                                        hasCompatibleVersion: !!compatibleVersion,
                                        versionId: compatibleVersion?.id || '',
                                        versionNumber: compatibleVersion?.version_number || '',
                                        fileName: compatibleVersion?.files?.find(f => f.primary)?.filename || compatibleVersion?.files?.[0]?.filename || '',
                                        gameVersions: compatibleVersion?.game_versions || [],
                                        loaders: compatibleVersion?.loaders || []
                                    }
                                };
                            }
                        } catch (e) {}
                        return null;
                    }));
                    for (const r of retryResults) {
                        if (r.status === 'fulfilled' && r.value) {
                            result[r.value.rid] = r.value.data;
                        }
                    }

                    // 策略2: 对仍然缺失的ID，用 Modrinth search 按 slug 搜索
                    const stillMissing = rdvIds.filter(pid => !result[pid] || !result[pid].title || result[pid].title === pid);
                    if (stillMissing.length > 0) {
                        const searchResults = await Promise.allSettled(stillMissing.map(async sid => {
                            try {
                                const sr = await http.cachedFetchJSON(`${MODRINTH_API}/search?query=${encodeURIComponent(sid)}&limit=1`, 60000);
                                const hit = sr?.hits?.[0];
                                if (hit && hit.title) {
                                    return { sid, data: { id: hit.project_id || sid, title: hit.title, icon: hit.icon_url || '', description: (hit.description || '').substring(0, 100), downloads: hit.downloads || 0 } };
                                }
                            } catch (e) {}
                            return null;
                        }));
                        for (const r of searchResults) {
                            if (r.status === 'fulfilled' && r.value) {
                                const v = r.value.data;
                                result[r.value.sid] = { ...result[r.value.sid], ...v, hasCompatibleVersion: false, versionId: '', versionNumber: '', fileName: '', gameVersions: [], loaders: [] };
                            }
                        }
                    }

                    // 策略3: 对仍然缺失的ID，仅对数字ID尝试 CurseForge
                    const cfMissing = rdvIds.filter(pid => (!result[pid] || !result[pid].title || result[pid].title === pid) && /^\d+$/.test(pid));
                    if (cfMissing.length > 0) {
                        const cfResults = await Promise.allSettled(cfMissing.map(async cid => {
                            try {
                                const modInfo = await http.cachedFetchJSON(`${CURSEFORGE_API}/mods/${cid}`, 120000, { 'x-api-key': cfApiKey });
                                const proj = modInfo?.data;
                                if (!proj) return null;
                                let compatibleVersion = null;
                                if (rdvGameVersion) {
                                    const filesList = await http.cachedFetchJSON(`${CURSEFORGE_API}/mods/${cid}/files?gameVersion=${encodeURIComponent(rdvGameVersion)}&pageSize=5`, 120000, { 'x-api-key': cfApiKey });
                                    const cfFiles = filesList?.data || [];
                                    const cfFile = cfFiles[0] || null;
                                    if (cfFile) {
                                        compatibleVersion = { id: String(cfFile.id), version_number: cfFile.displayName || cfFile.fileName, files: [{ filename: cfFile.fileName, primary: true }], game_versions: cfFile.gameVersions || [], loaders: cfFile.sortableGameVersions?.map(s => s.gameVersionTypeId) || [] };
                                    }
                                }
                                return { cid, data: { id: String(proj.id), title: proj.name, icon: proj.logo?.thumbnailUrl || proj.logo?.url || '', description: (proj.summary || '').substring(0, 100), downloads: proj.downloadCount || 0, hasCompatibleVersion: !!compatibleVersion, versionId: compatibleVersion?.id || '', versionNumber: compatibleVersion?.version_number || '', fileName: compatibleVersion?.files?.[0]?.filename || '', gameVersions: compatibleVersion?.game_versions || [], loaders: compatibleVersion?.loaders || [] } };
                            } catch (e) { return null; }
                        }));
                        for (const r of cfResults) {
                            if (r.status === 'fulfilled' && r.value) {
                                result[r.value.cid] = r.value.data;
                            }
                        }
                    }
                }
                sendJSON(res, result);
            } catch (e) { sendJSON(res, {}); }
        });

        // ====================================================================
        // /api/mods/categories
        // ====================================================================
        registerRoute('GET', '/api/mods/categories', async (req, res, parsedUrl) => {
            const catSource = parsedUrl.query.source || 'modrinth';
            try {
                if (catSource === 'modrinth') {
                    const tags = await http.fetchJSON(`${MODRINTH_API}/tag/category`);
                    const categories = tags.filter(t => t.project_type === 'mod').map(t => ({
                        name: t.name,
                        icon: t.icon || ''
                    }));
                    sendJSON(res, { categories });
                } else {
                    sendJSON(res, { categories: [] });
                }
            } catch (e) {
                sendJSON(res, { categories: [] });
            }
        });

        // ====================================================================
        // /api/mods/featured
        // ====================================================================
        registerRoute('GET', '/api/mods/featured', async (req, res, parsedUrl) => {
            const ftLoader = parsedUrl.query.loader || '';
            const ftVersion = parsedUrl.query.gameVersion || '';
            try {
                const facets = [['project_type:mod']];
                if (ftLoader) facets.push([`categories:${ftLoader}`]);
                if (ftVersion) facets.push([`versions:${ftVersion}`]);
                let featUrl = `${MODRINTH_API}/search?query=&index=downloads&limit=10&offset=0`;
                featUrl += `&facets=${encodeURIComponent(JSON.stringify(facets))}`;
                const result = await http.fetchJSON(featUrl);
                const hits = (result.hits || []).map(hit => ({
                    id: hit.project_id, slug: hit.slug, title: hit.title,
                    description: hit.description || '', icon: hit.icon_url || '',
                    downloads: hit.downloads || 0, author: (hit.author || '').replace(/_/g, ''),
                    categories: hit.categories || [], source: 'modrinth'
                }));
                sendJSON(res, { hits });
            } catch (e) {
                sendJSON(res, { hits: [] });
            }
        });
    }
};
