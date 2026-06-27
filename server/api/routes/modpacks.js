/**
 * server/api/routes/modpacks.js - 整合包路由
 * ============================================================================
 * 从 server.js handleAPI switch 语句抽取的整合包相关端点。
 */

const fs = require('fs');
const path = require('path');

module.exports = {
    register(registerRoute, deps) {
        const { ctx, sendJSON, sendError, readBody } = deps;
        const { modpack, http, versions } = deps;

        const MODRINTH_API = ctx.urls.MODRINTH_API;
        const DATA_DIR = ctx.dirs.DATA_DIR;

        // ====================================================================
        // /api/modpack/import
        // ====================================================================
        registerRoute('POST', '/api/modpack/import', async (req, res, parsedUrl) => {
            const importData = await readBody(req);
            const importFilePath = importData.filePath;
            const targetVersion = importData.targetVersion || '';
            if (!importFilePath) { sendError(res, 'Missing filePath', 400); return; }
            try {
                const result = await modpack.importModpackFromPath(importFilePath, null, targetVersion);
                sendJSON(res, result);
            } catch (e) {
                sendJSON(res, { success: false, error: e.message });
            }
        });

        // ====================================================================
        // /api/modpacks/search
        // ====================================================================
        registerRoute('GET', '/api/modpacks/search', async (req, res, parsedUrl) => {
            let mpQuery = parsedUrl.query.query || '';
            const mpLoader = parsedUrl.query.loader || '';
            const mpVersion = parsedUrl.query.version || '';
            const mpLimit = parseInt(parsedUrl.query.limit || '10', 10);
            const mpOffset = parseInt(parsedUrl.query.offset || '0', 10);

            if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(mpQuery)) {
                try {
                    const cnMod = require('../../../js/mod-chinese-names.js');
                    const translated = cnMod.translateChineseSearch(mpQuery, 'modpack');
                    if (translated) mpQuery = translated;
                } catch (e) {
                    try {
                        const cnKeys = Object.entries(require('../../../js/mod-chinese-names.js').CHINESE_SEARCH_KEYWORDS_MODPACK || {});
                        for (const [cn, enList] of cnKeys) {
                            if (mpQuery.includes(cn) || cn.includes(mpQuery)) { mpQuery = enList.join(' '); break; }
                        }
                    } catch (_) {}
                }
            }

            try {
                const facets = [['project_type:modpack']];
                if (mpLoader) facets.push([`categories:${mpLoader}`]);
                if (mpVersion) facets.push([`versions:${mpVersion}`]);
                let mpSearchUrl = `${MODRINTH_API}/search?query=${encodeURIComponent(mpQuery)}&index=relevance&limit=${mpLimit}&offset=${mpOffset}`;
                mpSearchUrl += `&facets=${encodeURIComponent(JSON.stringify(facets))}`;
                const mpResult = await http.cachedFetchJSON(mpSearchUrl, 60000);
                const mpHits = (mpResult.hits || []).map(hit => ({
                    id: hit.project_id, slug: hit.slug, title: hit.title,
                    description: hit.description || '', author: (hit.author || '').replace(/_/g, ''),
                    icon: hit.icon_url || '', downloads: hit.downloads || 0,
                    categories: hit.categories || [], versions: hit.versions || [],
                    source: 'modrinth'
                }));
                sendJSON(res, { hits: mpHits, total: mpResult.total_hits || mpHits.length, offset: mpOffset });
            } catch (e) {
                sendJSON(res, { hits: [], total: 0, error: e.message });
            }
        });

        // ====================================================================
        // /api/modpacks/install
        // ====================================================================
        registerRoute('POST', '/api/modpacks/install', async (req, res, parsedUrl) => {
            const mpData = await readBody(req);
            const mpProjectId = mpData.projectId;
            const mpMcVersion = mpData.mcVersion || '';
            if (!mpProjectId) { sendError(res, 'Missing projectId', 400); return; }
            try {
                let versionUrl = `${MODRINTH_API}/project/${mpProjectId}/version`;
                const versionParams = [];
                if (mpMcVersion) versionParams.push(`game_versions=["${mpMcVersion}"]`);
                if (versionParams.length > 0) versionUrl += '?' + versionParams.join('&');
                const versionData = await http.fetchJSON(versionUrl);
                if (!versionData || versionData.length === 0) {
                    sendJSON(res, { success: false, error: '未找到可用版本' });
                    return;
                }
                const targetVersion = versionData[0];
                const primaryFile = targetVersion.files?.find(f => f.primary) || targetVersion.files?.[0];
                if (!primaryFile || !primaryFile.url) {
                    sendJSON(res, { success: false, error: '未找到下载链接' });
                    return;
                }
                const fileName = primaryFile.filename || `${mpProjectId}.mrpack`;
                const _mpSettings = versions.loadSettingsCached();
                const downloadDir = versions.getVersionSubDir(_mpSettings.selectedVersion, 'modpacks') || path.join(_mpSettings.gameDir || DATA_DIR, 'modpacks');
                if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });
                const destPath = path.join(downloadDir, fileName);
                const downloadUrl = primaryFile.url;
                const modpackName = targetVersion.name || mpProjectId;

                sendJSON(res, {
                    success: true,
                    name: modpackName,
                    versionId: targetVersion.id,
                    fileName,
                    downloadUrl,
                    destPath,
                    size: primaryFile.size || 0,
                    mcVersion: targetVersion.game_versions?.[0] || mpMcVersion,
                    loaders: targetVersion.loaders || [],
                    message: '整合包下载链接已获取，请使用 modpack/import 接口导入'
                });
            } catch (e) {
                sendJSON(res, { success: false, error: e.message });
            }
        });
    }
};
