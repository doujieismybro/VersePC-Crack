/**
 * server/api/routes/favorites.js - 收藏夹路由
 * ============================================================================
 * 从 server.js handleAPI switch 语句抽取的收藏夹相关端点。
 */

module.exports = {
    register(registerRoute, deps) {
        const { ctx, sendJSON, sendError, readBody } = deps;
        const { accounts, utils } = deps;

        // ====================================================================
        // /api/favorites
        // ====================================================================
        registerRoute('GET', '/api/favorites', async (req, res, parsedUrl) => {
            console.log('[Fav] GET /api/favorites hit');
            sendJSON(res, accounts.loadFavorites());
        });

        // ====================================================================
        // /api/favorites/create
        // ====================================================================
        registerRoute('POST', '/api/favorites/create', async (req, res, parsedUrl) => {
            const body = await readBody(req);
            if (!body.name) { sendError(res, 'Missing name', 400); return; }
            const favorites = accounts.loadFavorites();
            const newFav = { name: body.name, id: utils.generateUUID(), favs: [], notes: {} };
            favorites.push(newFav);
            accounts.saveFavorites(favorites);
            sendJSON(res, { success: true, favorite: newFav });
        });

        // ====================================================================
        // /api/favorites/rename
        // ====================================================================
        registerRoute('POST', '/api/favorites/rename', async (req, res, parsedUrl) => {
            const body = await readBody(req);
            if (!body.id || !body.name) { sendError(res, 'Missing id or name', 400); return; }
            const favorites = accounts.loadFavorites();
            const fav = favorites.find(f => f.id === body.id);
            if (!fav) { sendError(res, '收藏夹不存在', 404); return; }
            fav.name = body.name;
            accounts.saveFavorites(favorites);
            sendJSON(res, { success: true });
        });

        // ====================================================================
        // /api/favorites/delete
        // ====================================================================
        registerRoute('POST', '/api/favorites/delete', async (req, res, parsedUrl) => {
            const body = await readBody(req);
            if (!body.id) { sendError(res, 'Missing id', 400); return; }
            const favorites = accounts.loadFavorites();
            if (favorites.length <= 1) { sendError(res, '至少保留一个收藏夹', 400); return; }
            const idx = favorites.findIndex(f => f.id === body.id);
            if (idx < 0) { sendError(res, '收藏夹不存在', 404); return; }
            favorites.splice(idx, 1);
            accounts.saveFavorites(favorites);
            sendJSON(res, { success: true });
        });

        // ====================================================================
        // /api/favorites/add
        // ====================================================================
        registerRoute('POST', '/api/favorites/add', async (req, res, parsedUrl) => {
            const body = await readBody(req);
            if (!body.favId || !body.projectId) { sendError(res, 'Missing favId or projectId', 400); return; }
            const favorites = accounts.loadFavorites();
            const fav = favorites.find(f => f.id === body.favId);
            if (!fav) { sendError(res, '收藏夹不存在', 404); return; }
            if (!fav.favs.includes(body.projectId)) fav.favs.push(body.projectId);
            accounts.saveFavorites(favorites);
            sendJSON(res, { success: true });
        });

        // ====================================================================
        // /api/favorites/remove
        // ====================================================================
        registerRoute('POST', '/api/favorites/remove', async (req, res, parsedUrl) => {
            const body = await readBody(req);
            if (!body.favId || !body.projectId) { sendError(res, 'Missing favId or projectId', 400); return; }
            const favorites = accounts.loadFavorites();
            const fav = favorites.find(f => f.id === body.favId);
            if (!fav) { sendError(res, '收藏夹不存在', 404); return; }
            fav.favs = fav.favs.filter(id => id !== body.projectId);
            accounts.saveFavorites(favorites);
            sendJSON(res, { success: true });
        });

        // ====================================================================
        // /api/favorites/note
        // ====================================================================
        registerRoute('POST', '/api/favorites/note', async (req, res, parsedUrl) => {
            const body = await readBody(req);
            if (!body.favId || !body.projectId) { sendError(res, 'Missing favId or projectId', 400); return; }
            const favorites = accounts.loadFavorites();
            const fav = favorites.find(f => f.id === body.favId);
            if (!fav) { sendError(res, '收藏夹不存在', 404); return; }
            if (!fav.notes) fav.notes = {};
            if (body.note) fav.notes[body.projectId] = body.note;
            else delete fav.notes[body.projectId];
            accounts.saveFavorites(favorites);
            sendJSON(res, { success: true });
        });

        // ====================================================================
        // /api/favorites/export
        // ====================================================================
        registerRoute('GET', '/api/favorites/export', async (req, res, parsedUrl) => {
            const exportId = parsedUrl.query.id;
            const favorites = accounts.loadFavorites();
            if (exportId) {
                const fav = favorites.find(f => f.id === exportId);
                if (fav) sendJSON(res, { success: true, data: fav.favs });
                else sendError(res, '收藏夹不存在', 404);
            } else {
                sendJSON(res, { success: true, data: favorites });
            }
        });

        // ====================================================================
        // /api/favorites/import
        // ====================================================================
        registerRoute('POST', '/api/favorites/import', async (req, res, parsedUrl) => {
            const body = await readBody(req);
            if (!body.data) { sendError(res, 'Missing data', 400); return; }
            const favorites = accounts.loadFavorites();
            let ids = [];
            if (Array.isArray(body.data)) ids = body.data;
            else if (typeof body.data === 'string') {
                try {
                    const parsed = JSON.parse(body.data);
                    ids = Array.isArray(parsed) ? parsed : Object.keys(parsed).filter(k => parsed[k]);
                } catch (e) {}
            }
            if (ids.length === 0) { sendError(res, '无有效数据', 400); return; }
            let target = body.targetFavId ? favorites.find(f => f.id === body.targetFavId) : favorites[0];
            if (!target) target = favorites[0];
            ids.forEach(id => { if (!target.favs.includes(id)) target.favs.push(id); });
            accounts.saveFavorites(favorites);
            sendJSON(res, { success: true, imported: ids.length });
        });

        // ====================================================================
        // /api/favorites/check
        // ====================================================================
        registerRoute('GET', '/api/favorites/check', async (req, res, parsedUrl) => {
            const checkId = parsedUrl.query.projectId;
            if (!checkId) { sendError(res, 'Missing projectId', 400); return; }
            const favorites = accounts.loadFavorites();
            const result = {};
            favorites.forEach(f => { result[f.id] = f.favs.includes(checkId); });
            sendJSON(res, { success: true, result });
        });
    }
};
