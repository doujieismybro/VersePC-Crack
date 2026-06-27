/**
 * server/api/routes/resources.js - 资源搜索/下载路由
 * ============================================================================
 * 从 server.js handleAPI switch 语句抽取的 Modrinth 资源搜索、详情、版本、下载端点。
 */

const fs = require('fs');
const path = require('path');

module.exports = {
    register(registerRoute, deps) {
        const { ctx, sendJSON, sendError, readBody } = deps;
        const { http, versions, modpack } = deps;

        const MODRINTH_API = ctx.urls.MODRINTH_API;
        const DATA_DIR = ctx.dirs.DATA_DIR;

        // ====================================================================
        // /api/resources/search
        // ====================================================================
        registerRoute('GET', '/api/resources/search', async (req, res, parsedUrl) => {
            const resQuery = parsedUrl.query.query || '';
            const resType = parsedUrl.query.type || 'modpack';
            const resLoader = parsedUrl.query.loader || '';
            const resVersion = parsedUrl.query.version || '';
            const resCategory = parsedUrl.query.category || '';
            const resSort = parsedUrl.query.sort || 'downloads';
            const resLimit = parseInt(parsedUrl.query.limit || '15', 10);
            const resOffset = parseInt(parsedUrl.query.offset || '0', 10);

            try {
                const facets = [[`project_type:${resType}`]];
                if (resLoader) facets.push([`categories:${resLoader}`]);
                if (resVersion) facets.push([`versions:${resVersion}`]);
                if (resCategory) facets.push([`categories:${resCategory}`]);

                const sortMap = { relevance: 'relevance', downloads: 'downloads', newest: 'newest', updated: 'updated' };
                const sortField = sortMap[resSort] || (resQuery ? 'relevance' : 'downloads');

                let searchUrl = `${MODRINTH_API}/search?query=${encodeURIComponent(resQuery)}&index=${sortField}&limit=${resLimit}&offset=${resOffset}`;
                searchUrl += `&facets=${encodeURIComponent(JSON.stringify(facets))}`;

                const result = await http.cachedFetchJSON(searchUrl, 60000);
                const hits = (result.hits || []).map(hit => ({
                    id: hit.project_id, slug: hit.slug, title: hit.title,
                    description: hit.description || '', author: (hit.author || '').replace(/_/g, ''),
                    icon: hit.icon_url || '', downloads: hit.downloads || 0, followers: hit.followers || 0,
                    categories: hit.categories || [], versions: hit.versions || [],
                    dateCreated: hit.date_created || '', dateModified: hit.date_modified || '',
                    source: 'modrinth', projectType: resType
                }));
                sendJSON(res, { hits, total: result.total_hits || hits.length, offset: resOffset });
            } catch (e) {
                sendError(res, '搜索失败: ' + e.message);
            }
        });

        // ====================================================================
        // /api/resources/detail
        // ====================================================================
        registerRoute('GET', '/api/resources/detail', async (req, res, parsedUrl) => {
            const resProjectId = parsedUrl.query.projectId;
            if (!resProjectId) { sendError(res, 'Missing projectId', 400); return; }
            try {
                const project = await http.cachedFetchJSON(`${MODRINTH_API}/project/${resProjectId}`, 300000);
                const detail = {
                    id: project.id, slug: project.slug, title: project.title,
                    description: project.description || '', body: project.body || '',
                    icon: project.icon_url || '', downloads: project.downloads || 0,
                    followers: project.followers || 0, categories: project.categories || [],
                    loaders: project.loaders || [], gameVersions: project.game_versions || [],
                    license: project.license?.name || '', sourceUrl: project.source_url || '',
                    dateCreated: project.published || '', dateModified: project.updated || '',
                    gallery: (project.gallery || []).map(g => typeof g === 'string' ? g : g.url || ''),
                    source: 'modrinth', projectType: project.project_type || ''
                };
                sendJSON(res, detail);
            } catch (e) {
                sendError(res, '获取详情失败: ' + e.message);
            }
        });

        // ====================================================================
        // /api/resources/versions
        // ====================================================================
        registerRoute('GET', '/api/resources/versions', async (req, res, parsedUrl) => {
            const rvProjectId = parsedUrl.query.projectId;
            const rvLoader = parsedUrl.query.loader || '';
            const rvGameVer = parsedUrl.query.gameVersion || '';
            if (!rvProjectId) { sendError(res, 'Missing projectId', 400); return; }
            try {
                let versionUrl = `${MODRINTH_API}/project/${rvProjectId}/version`;
                const params = [];
                if (rvLoader) params.push(`loaders=["${rvLoader}"]`);
                if (rvGameVer) params.push(`game_versions=["${rvGameVer}"]`);
                if (params.length > 0) versionUrl += '?' + params.join('&');

                const versions = await http.cachedFetchJSON(versionUrl, 600000);
                const result = (versions || []).map(v => ({
                    id: v.id, versionNumber: v.version_number || '',
                    versionName: v.name || v.version_number || '',
                    gameVersions: v.game_versions || [], loaders: v.loaders || [],
                    releaseType: v.version_type || 'release',
                    datePublished: v.date_published || '', downloads: v.downloads || 0,
                    changelog: v.changelog || '',
                    files: (v.files || []).map(f => ({
                        url: f.url, filename: f.filename, size: f.size || 0,
                        primary: f.primary || false, sha1: f.hashes?.sha1 || ''
                    })),
                    dependencies: (v.dependencies || []).map(d => ({
                        projectId: d.project_id, versionId: d.version_id,
                        dependencyType: d.dependency_type
                    }))
                }));
                sendJSON(res, { versions: result });
            } catch (e) {
                sendError(res, '获取版本列表失败: ' + e.message);
            }
        });

        // ====================================================================
        // /api/resources/download
        // ====================================================================
        registerRoute('POST', '/api/resources/download', async (req, res, parsedUrl) => {
            const rdData = await readBody(req);
            const rdVersionId = rdData.versionId;
            const rdProjectId = rdData.projectId;
            const rdType = rdData.projectType || 'mod';
            const rdSavePath = rdData.savePath || '';
            const rdCustomName = rdData.customName || '';

            if (!rdVersionId && !rdProjectId) { sendError(res, 'Missing versionId or projectId', 400); return; }

            const settings = versions.loadSettingsCached();
            let destDir;

            let targetVersionId = rdData.targetVersionId || '';
            if (!targetVersionId && rdType !== 'modpack') {
                targetVersionId = settings.selectedVersion || '';
            }

            if (rdSavePath) {
                destDir = rdSavePath;
            } else if (rdType === 'modpack') {
                destDir = versions.getVersionSubDir(targetVersionId, 'modpacks') || path.join(settings.gameDir || DATA_DIR, 'modpacks');
            } else if (rdType === 'resourcepack') {
                destDir = targetVersionId ? versions.getVersionSubDir(targetVersionId, 'resourcepacks') : null;
                if (!destDir) destDir = path.join(settings.gameDir || DATA_DIR, 'resourcepacks');
            } else if (rdType === 'shader') {
                destDir = targetVersionId ? versions.getVersionSubDir(targetVersionId, 'shaderpacks') : null;
                if (!destDir) destDir = path.join(settings.gameDir || DATA_DIR, 'shaderpacks');
            } else if (rdType === 'datapack') {
                destDir = targetVersionId ? versions.getVersionSubDir(targetVersionId, 'datapacks') : null;
                if (!destDir) destDir = path.join(settings.gameDir || DATA_DIR, 'datapacks');
            } else {
                destDir = versions.getVersionModsDir(targetVersionId);
                if (!destDir) {
                    sendError(res, '请先安装一个游戏版本'); return;
                }
            }
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

            try {
                let downloadUrl = null;
                let fileName = null;
                let fileSize = 0;
                let mcVersion = '';
                let packName = '';

                let versionData;
                if (rdVersionId) {
                    versionData = await http.fetchJSON(`${MODRINTH_API}/version/${rdVersionId}`);
                } else {
                    const versions = await http.fetchJSON(`${MODRINTH_API}/project/${rdProjectId}/version?limit=1`);
                    versionData = versions?.[0];
                }

                if (!versionData) { sendError(res, '未找到版本信息，请检查网络连接或稍后重试'); return; }

                console.log('[Download] Version data:', JSON.stringify(versionData).substring(0, 500));

                const primaryFile = versionData.files?.find(f => f.primary) || versionData.files?.[0];
                if (!primaryFile) {
                    console.error('[Download] No files in version data, files:', versionData.files);
                    sendError(res, '未找到下载文件，该版本可能已被下架或不存在');
                    return;
                }

                downloadUrl = primaryFile.url;
                fileName = primaryFile.filename;
                fileSize = primaryFile.size || 0;
                const expectedSha1 = primaryFile.hashes?.sha1 || '';

                if (!downloadUrl) {
                    console.error('[Download] File URL is empty, file data:', JSON.stringify(primaryFile));
                    sendError(res, '下载链接为空，该资源可能暂时不可用');
                    return;
                }

                // 获取整合包的 Minecraft 版本信息
                if (rdType === 'modpack') {
                    mcVersion = versionData.game_versions?.[0] || '';
                    const projectInfo = await http.fetchJSON(`${MODRINTH_API}/project/${rdProjectId}`).catch(() => null);
                    packName = projectInfo?.title || rdProjectId;
                }

                const safeName = (fileName || `${rdProjectId}.jar`).replace(/[^a-zA-Z0-9._\-]/g, '_');
                const destPath = path.join(destDir, safeName);

                const sessionId = `res-${Date.now()}`;
                const abortController = new AbortController();
                ctx.sessions.modDownloadSessions.set(sessionId, {
                    status: 'downloading', progress: 0, message: '下载中..',
                    fileName: safeName, totalSize: fileSize, downloaded: 0,
                    downloadSpeed: 0, bytesDownloaded: 0,
                    projectType: rdType, projectId: rdProjectId, packName, mcVersion,
                    phase: 'download', currentFile: safeName, files: [{ name: safeName, status: 'downloading', progress: 0, size: fileSize }],
                    _abortController: abortController
                });

                sendJSON(res, { success: true, sessionId, fileName: safeName });
                console.log(`[Modpack] 开始下载: ${safeName} (${fileSize} bytes, URL: ${downloadUrl?.substring(0, 80)}...)`);

                (async () => {
                    try {
                        const _mpTimeout = fileSize > 50 * 1024 * 1024 ? 600000 : fileSize > 20 * 1024 * 1024 ? 300000 : 120000;
                        const _mpOverallTimeout = Math.max(_mpTimeout * 2, 300000);
                        const _mpOverallTimer = setTimeout(() => {
                            console.error(`[Modpack] ⚠ 总下载超时 (${Math.round(_mpOverallTimeout / 1000)}s), 中止`);
                            abortController.abort();
                        }, _mpOverallTimeout);
                        let _mpMaxPct = 0;
                        let _mpMaxBytes = 0;
                        const _mpOnProgress = (p) => {
                            try {
                                const session = ctx.sessions.modDownloadSessions.get(sessionId);
                                if (session) {
                                    if (session.status === 'cancelled') { session._abortController?.abort(); return; }
                                    const rawPct = Math.round(p.progress || 0);
                                    const pct = Math.max(rawPct, _mpMaxPct);
                                    if (rawPct >= _mpMaxPct) _mpMaxPct = rawPct;
                                    const curBytes = p.bytesDownloaded || 0;
                                    if (curBytes >= _mpMaxBytes) _mpMaxBytes = curBytes;
                                    session.progress = rdType === 'modpack' ? Math.round(pct * 0.45) : pct;
                                    session.downloadSpeed = p.speed || 0;
                                    session.bytesDownloaded = _mpMaxBytes;
                                    session.totalSize = p.totalBytes || fileSize;
                                    const speedKB = p.speed ? Math.round(p.speed / 1024) : 0;
                                    session.message = `下载 ${safeName} ${pct}% (${speedKB}KB/s)`;
                                    session.currentFile = safeName;
                                    session.phase = 'download';
                                    if (!session._lastLogPct || pct - session._lastLogPct >= 10 || pct === 100) {
                                        session._lastLogPct = pct;
                                        console.log(`[Modpack] 下载进度: ${safeName} ${pct}% (${speedKB}KB/s)`);
                                    }
                                    if (rdType === 'modpack') {
                                        if (!session.stageHistory) session.stageHistory = [];
                                        const dlIdx = session.stageHistory.findIndex(s => s.stage === 'download');
                                        const dlStage = { stage: 'download', message: `下载整合包 ${safeName} ${pct}%`, progress: pct };
                                        if (dlIdx >= 0) { session.stageHistory[dlIdx] = dlStage; } else { session.stageHistory.push(dlStage); }
                                    }
                                    if (session.files && session.files[0]) {
                                        session.files[0].progress = pct;
                                        session.files[0].status = 'downloading';
                                        session.files[0].size = p.totalBytes || fileSize;
                                    }
                                }
                            } catch (_) {}
                        };
                        console.log(`[Modpack] 开始下载: ${safeName} (URL: ${downloadUrl?.substring(0, 80)}...)`);
                        const _mpUrls = http.getMirrorUrls(downloadUrl);
                        // probe mirrors and sort by speed before downloading
                        let _sortedUrls = _mpUrls;
                        try {
                            const _probed = await http.probeMirrorSpeed(_mpUrls, 65536, 5000);
                            _sortedUrls = _probed;
                        } catch (e) { console.warn(`[Modpack] 测速失败，使用默认顺序: ${e.message}`); }
                        console.log(`[Modpack] 下载源顺序: ${_sortedUrls.map(u => u.substring(0, 60)).join(' -> ')}`);

                        // Dynamic chunk count based on file size
                        let _maxChunks = 16;
                        if (fileSize > 0) {
                            if (fileSize <= 1 * 1024 * 1024) _maxChunks = 1;
                            else if (fileSize <= 10 * 1024 * 1024) _maxChunks = 4;
                            else if (fileSize <= 50 * 1024 * 1024) _maxChunks = 8;
                            else _maxChunks = 16;
                        }
                        console.log(`[Modpack] 文件大小 ${(fileSize / 1024 / 1024).toFixed(1)}MB，分块数 ${_maxChunks}`);

                        // 单次调用，重试和镜像切换由 downloadFileChunked 内部处理
                        let _dlSuccess = false;
                        try {
                            if (abortController.signal && abortController.signal.aborted) {
                                clearTimeout(_mpOverallTimer);
                                return;
                            }
                            await http.downloadFileChunked(_sortedUrls[0], destPath, {
                                onProgress: _mpOnProgress,
                                retries: 3,
                                abortSignal: abortController.signal,
                                timeout: _mpTimeout,
                                mirrors: _sortedUrls,          // 传入排序后的镜像列表
                                maxChunks: _maxChunks,
                                sha1: expectedSha1 || null    // 传入 SHA1 供内部校验
                            });
                            if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
                                _dlSuccess = true;
                                console.log(`[Modpack] 下载成功: ${safeName}`);
                            }
                        } catch (e) {
                            if (abortController.signal && abortController.signal.aborted) {
                                clearTimeout(_mpOverallTimer);
                                return;
                            }
                            console.warn(`[Modpack] 下载失败: ${e.message}`);
                        }
                        clearTimeout(_mpOverallTimer);

                        if (!fs.existsSync(destPath) || fs.statSync(destPath).size === 0) {
                            console.error(`[Modpack] 下载失败: ${safeName}`);
                            const sFail = ctx.sessions.modDownloadSessions.get(sessionId);
                            if (sFail && sFail.status !== 'cancelled') {
                                sFail.status = 'failed'; sFail.progress = 100;
                                sFail.message = '整合包文件下载失败，请检查网络连接后重试';
                            }
                            return;
                        }

                        const sessionBeforeImport = ctx.sessions.modDownloadSessions.get(sessionId);
                        if (sessionBeforeImport && sessionBeforeImport.status === 'cancelled') {
                            try { fs.unlinkSync(destPath); } catch (e) {}
                            return;
                        }

                        const safeNameLower = safeName.toLowerCase();
                        const isModpackExt = safeNameLower.endsWith('.mrpack') || safeNameLower.endsWith('.zip');
                        let isModpackByMagic = false;
                        if (!isModpackExt && rdType === 'modpack' && fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
                            try {
                                const fd = fs.openSync(destPath, 'r');
                                const buf = Buffer.alloc(4);
                                fs.readSync(fd, buf, 0, 4, 0);
                                fs.closeSync(fd);
                                if (buf[0] === 0x50 && buf[1] === 0x4B) { isModpackByMagic = true; console.log(`[Modpack] 文件扩展名 "${safeName}" 不匹配，但检测到 ZIP magic bytes，视为整合包`); }
                            } catch (_mfErr) {}
                        }
                        console.log(`[Modpack] 扩展名检查: safeName="${safeName}" rdType="${rdType}" isModpackExt=${isModpackExt} isModpackByMagic=${isModpackByMagic}`);
                        if (rdType === 'modpack') {
                            try {
                                // downloadFileChunked 已完成 SHA1 校验，这里只做 ZIP magic 检测
                                const headBuf = Buffer.alloc(4);
                                const fd2 = fs.openSync(destPath, 'r');
                                fs.readSync(fd2, headBuf, 0, 4, 0);
                                fs.closeSync(fd2);
                                if (headBuf[0] !== 0x50 || headBuf[1] !== 0x4B) {
                                    console.error(`[Modpack] ZIP magic bytes 无效: ${headBuf.toString('hex')}`);
                                    const sFail = ctx.sessions.modDownloadSessions.get(sessionId);
                                    if (sFail) {
                                        sFail.status = 'failed'; sFail.progress = 100;
                                        sFail.message = '整合包文件格式无效，请检查网络连接后重试';
                                    }
                                    try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (e) {}
                                    return;
                                }

                                const session = ctx.sessions.modDownloadSessions.get(sessionId);
                                if (session) {
                                    if (session.status === 'cancelled') {
                                        try { fs.unlinkSync(destPath); } catch (e) {}
                                        return;
                                    }
                                    session.progress = 45;
                                    session.message = '正在解析整合包...';
                                    session.phase = 'install';
                                    if (session.files && session.files[0]) {
                                        session.files[0].status = 'completed';
                                        session.files[0].progress = 100;
                                    }
                                }

                                const importResult = await modpack.importModpackFromPath(destPath, (p) => {
                                    try {
                                        const s = ctx.sessions.modDownloadSessions.get(sessionId);
                                        if (s) {
                                            if (s.status === 'cancelled') return;
                                            const np = 45 + Math.round(p.progress * 0.55);
                                            s.progress = Math.max(s.progress || 0, np);
                                            s.message = p.message || '安装中...';
                                            s.phase = p.stage || 'install';
                                            s.currentFile = p.currentFile || '';
                                            if (p.files && p.files.length > 0) s.files = p.files;
                                            if (p.stageHistory && p.stageHistory.length > 0) s.stageHistory = p.stageHistory;
                                            if (!s._lastImportLog || Date.now() - s._lastImportLog >= 3000) {
                                                s._lastImportLog = Date.now();
                                                console.log(`[Modpack] 导入进度: ${p.stage} ${Math.round(p.progress)}% - ${p.message || ''}`);
                                            }
                                        }
                                    } catch (_) {}
                                }, rdType === 'modpack' ? rdCustomName : targetVersionId, abortController.signal);

                                const s = ctx.sessions.modDownloadSessions.get(sessionId);
                                if (s && s.status === 'cancelled') {
                                    try { fs.unlinkSync(destPath); } catch (e) {}
                                    return;
                                }

                                if (importResult.success) {
                                    console.log(`[Modpack] 导入完成: "${importResult.name || packName}" (${importResult.versionId || ''})${importResult.warning ? ' 警告: ' + importResult.warning : ''}`);
                                    if (s) {
                                        s.status = 'completed'; s.progress = 100;
                                        s.message = `整合包 "${importResult.name || packName}" 安装完成！`;
                                        if (importResult.warning) s.warning = importResult.warning;
                                    }
                                    ctx.caches._versionsCache = null;
                                    ctx.caches._versionsCacheTime = 0;
                                    try { fs.unlinkSync(destPath); } catch (e) {}
                                } else {
                                    if (s) {
                                        s.status = 'failed';
                                        s.progress = 100;
                                        s.message = `整合包导入失败: ${importResult.error || '未知错误'}`;
                                        console.error('[Modpack] importModpackFromPath failed:', importResult.error, 'versionId:', importResult.versionId);
                                    }
                                    try { fs.unlinkSync(destPath); } catch (e) {}
                                }
                            } catch (e2) {
                                console.error('[Modpack] importModpackFromPath error:', e2.stack || e2.message || e2);
                                const s = ctx.sessions.modDownloadSessions.get(sessionId);
                                if (s) { s.status = 'failed'; s.progress = 100; s.message = `整合包导入异常: ${e2.message || e2}`; }
                                try { fs.unlinkSync(destPath); } catch (e) {}
                            }
                        } else {
                            const session = ctx.sessions.modDownloadSessions.get(sessionId);
                            if (session) { session.status = 'completed'; session.progress = 100; session.message = `${safeName} 下载完成！`; }
                        }
                    } catch (e) {
                        const session = ctx.sessions.modDownloadSessions.get(sessionId);
                        if (session) {
                            if (session.status === 'cancelled') {
                                try { fs.unlinkSync(destPath); } catch (ex) {}
                            } else {
                                session.status = 'failed'; session.progress = 100;
                                session.message = `下载整合包文件失败: ${e.message}`;
                                console.error('[Modpack] Download failed:', e.message, 'url:', downloadUrl);
                            }
                        }
                    }
                })();
            } catch (e) {
                console.error('[Modpack] Request error:', e.stack || e.message || e);
                sendError(res, '下载失败: ' + e.message);
            }
        });
    }
};
