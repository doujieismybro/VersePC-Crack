/**
 * server/api/routes/modloaders.js - 模组加载器路由
 * ============================================================================
 * 从 server.js handleAPI switch 语句抽取的模组加载器相关端点。
 * 包含 Fabric、Forge、NeoForge、OptiFine 版本查询与安装。
 */

const fs = require('fs');
const path = require('path');

module.exports = {
    register(registerRoute, deps) {
        const { ctx, sendJSON, sendError, readBody } = deps;
        const { modloaders, versions, http } = deps;

        const DATA_DIR = ctx.dirs.DATA_DIR;
        const VERSIONS_DIR = ctx.dirs.VERSIONS_DIR;
        const LIBRARIES_DIR = ctx.dirs.LIBRARIES_DIR;

        // ====================================================================
        // /api/fabric/versions
        // ====================================================================
        registerRoute('GET', '/api/fabric/versions', async (req, res, parsedUrl) => {
            const gameVersion = parsedUrl.query.game;
            if (gameVersion) {
                const fabricVersions = await modloaders.getFabricLoaderVersionsForGame(gameVersion);
                sendJSON(res, { versions: fabricVersions });
            } else {
                const fabricVersions = await modloaders.getFabricLoaderVersions();
                sendJSON(res, { versions: fabricVersions });
            }
        });

        // ====================================================================
        // /api/fabric/install
        // ====================================================================
        registerRoute('POST', '/api/fabric/install', async (req, res, parsedUrl) => {
            const data = await readBody(req);
            const gameVersion = data.gameVersion;
            const loaderVersion = data.loaderVersion;
            if (!gameVersion) { sendError(res, 'Missing gameVersion', 400); return; }

            if (!loaderVersion) {
                const fabricVersions = await modloaders.getFabricLoaderVersionsForGame(gameVersion);
                if (fabricVersions.length === 0) { sendError(res, '没有可用的Fabric Loader版本', 400); return; }
                const stable = fabricVersions.find(v => v.stable) || fabricVersions[0];
                const result = await modloaders.installFabric(gameVersion, stable.version);
                sendJSON(res, result);
            } else {
                const result = await modloaders.installFabric(gameVersion, loaderVersion);
                sendJSON(res, result);
            }
        });

        // ====================================================================
        // /api/forge/versions
        // ====================================================================
        registerRoute('GET', '/api/forge/versions', async (req, res, parsedUrl) => {
            const gameVersion = parsedUrl.query.game;
            if (!gameVersion) { sendError(res, 'Missing game parameter', 400); return; }
            try {
                const metadataUrl = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
                console.log('[Forge] Fetching metadata from:', metadataUrl);
                let metadataXml = null;
                const forgeUrls = [
                    metadataUrl,
                    'https://mirror.ghproxy.com/' + metadataUrl,
                    'https://ghproxy.net/' + metadataUrl,
                    'https://ghfast.top/' + metadataUrl,
                    'https://raw.gitmirror.com/Anzhiyuan/MinecraftForgeMaven/main/maven/net/minecraftforge/forge/maven-metadata.xml'
                ];
                for (const tryUrl of forgeUrls) {
                    try {
                        const xml = await http.fetchText(tryUrl);
                        if (!xml) continue;
                        const testMatches = xml.match(new RegExp(`<version>${gameVersion.replace(/\./g, '\\.')}-[^<]+<\\/version>`, 'g'));
                        if (testMatches && testMatches.length > 0) {
                            metadataXml = xml;
                            console.log('[Forge] Got metadata from:', tryUrl, `(${testMatches.length} versions for ${gameVersion})`);
                            break;
                        }
                        console.log('[Forge] Metadata from', tryUrl, 'has no versions for', gameVersion, ', trying next...');
                    } catch (e) { console.log('[Forge] Metadata fetch failed from:', tryUrl, e.message); }
                }
                if (!metadataXml) throw new Error('所有Forge元数据源均不可用');
                console.log('[Forge] Got metadata, length:', metadataXml?.length || 0);
                const forgeVersions = [];

                const versionMatches = metadataXml.match(/<version>([^<]+)<\/version>/g) || [];
                console.log('[Forge] Found', versionMatches.length, 'version tags');

                for (const match of versionMatches) {
                    const ver = match.replace(/<\/?version>/g, '');
                    if (ver.startsWith(gameVersion + '-')) {
                        const forgeVer = ver.split('-')[1];
                        if (forgeVer) {
                            forgeVersions.push({ version: forgeVer, gameVersion: gameVersion, type: 'release' });
                        }
                    }
                }

                console.log('[Forge] Found', forgeVersions.length, 'versions for MC', gameVersion);
                forgeVersions.reverse();
                if (forgeVersions.length > 0) {
                    forgeVersions[0].type = '推荐';
                    if (forgeVersions.length > 1) forgeVersions[1].type = '最新';
                }

                sendJSON(res, { versions: forgeVersions.slice(0, 30) });
            } catch (e) {
                console.error('[Forge] Error fetching versions:', e.message);
                sendJSON(res, { versions: [] });
            }
        });

        // ====================================================================
        // /api/forge/install
        // ====================================================================
        registerRoute('POST', '/api/forge/install', async (req, res, parsedUrl) => {
            const data = await readBody(req);
            const gameVersion = data.gameVersion;
            const forgeVersion = data.forgeVersion;
            if (!gameVersion || !forgeVersion) { sendError(res, 'Missing parameters', 400); return; }
            if (!/^\d+\.\d+/.test(gameVersion)) { sendJSON(res, { success: false, error: `无效的 Minecraft 版本: ${gameVersion}` }); return; }
            const result = await modloaders.installForge(gameVersion, forgeVersion);
            sendJSON(res, result);
        });

        // ====================================================================
        // /api/neoforge/install
        // ====================================================================
        registerRoute('POST', '/api/neoforge/install', async (req, res, parsedUrl) => {
            const data = await readBody(req);
            const gameVersion = data.gameVersion;
            const neoVersion = data.neoVersion;
            if (!gameVersion || !neoVersion) { sendError(res, 'Missing parameters', 400); return; }
            try {
                const result = await modloaders.installNeoForge(gameVersion, neoVersion);
                sendJSON(res, result);
            } catch (e) {
                sendJSON(res, { success: false, error: e.message });
            }
        });

        // ====================================================================
        // /api/neoforge/versions
        // ====================================================================
        registerRoute('GET', '/api/neoforge/versions', async (req, res, parsedUrl) => {
            const gameVersion = parsedUrl.query.game;
            if (!gameVersion) { sendError(res, 'Missing game parameter', 400); return; }
            try {
                const neoForgeVersions = await modloaders.getNeoForgeVersionsForGame(gameVersion);
                sendJSON(res, { versions: neoForgeVersions });
            } catch (e) {
                sendJSON(res, { versions: [] });
            }
        });

        // ====================================================================
        // /api/optifine/versions
        // ====================================================================
        registerRoute('GET', '/api/optifine/versions', async (req, res, parsedUrl) => {
            const ofGameVer = parsedUrl.query.game;
            if (!ofGameVer) { sendError(res, 'Missing game parameter', 400); return; }
            try {
                const ofData = await http.fetchJSON(`https://optifine.net/downloads?f=${ofGameVer}`);
                const regex = new RegExp(`OptiFine_${ofGameVer.replace(/\./g, '\\.')}_(HD_U_[A-Za-z0-9]+)\\.jar`, 'g');
                const ofVersions = [];
                let match;
                const pageHtml = ofData;
                while ((match = regex.exec(pageHtml)) !== null) {
                    ofVersions.push({ version: match[1], gameVersion: ofGameVer });
                }
                if (ofVersions.length === 0) {
                    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
                    for (let i = letters.length - 1; i >= 0; i--) {
                        ofVersions.push({ version: `HD_U_${letters[i]}`, gameVersion: ofGameVer });
                    }
                }
                sendJSON(res, { versions: ofVersions.slice(0, 10) });
            } catch (e) {
                sendJSON(res, { versions: [{ version: 'HD_U_Z', gameVersion: ofGameVer }] });
            }
        });

        // ====================================================================
        // /api/optifine/install
        // ====================================================================
        registerRoute('POST', '/api/optifine/install', async (req, res, parsedUrl) => {
            const ofData2 = await readBody(req);
            const ofGameVer2 = ofData2.gameVersion;
            const ofType = ofData2.optifineType || 'HD_U_Z';
            if (!ofGameVer2) { sendError(res, 'Missing gameVersion', 400); return; }

            const ofVersionId = `OptiFine_${ofGameVer2}_${ofType}`;
            try {
                const ofJarUrl = `https://optifine.net/downloadx?f=OptiFine_${ofGameVer2}_${ofType}.jar&k=`;
                const ofInstallerPath = path.join(DATA_DIR, 'temp', `optifine-installer-${ofGameVer2}-${ofType}.jar`);
                if (!fs.existsSync(path.dirname(ofInstallerPath))) fs.mkdirSync(path.dirname(ofInstallerPath), { recursive: true });

                await http.downloadFile(ofJarUrl, ofInstallerPath, null, 2);

                const ofVersionDir = path.join(VERSIONS_DIR, ofVersionId);
                if (!fs.existsSync(ofVersionDir)) fs.mkdirSync(ofVersionDir, { recursive: true });

                let ofVersionJson = null;
                try {
                    const AdmZip = require('adm-zip');
                    const ofZip = new AdmZip(ofInstallerPath);
                    const ofEntry = ofZip.getEntry('version.json') || ofZip.getEntry(`${ofVersionId}.json`);
                    if (ofEntry) {
                        ofVersionJson = JSON.parse(ofEntry.getData().toString('utf8'));
                    }
                } catch (e) {}

                if (ofVersionJson) {
                    ofVersionJson.id = ofVersionId;
                    ofVersionJson.inheritsFrom = ofGameVer2;
                    if (!ofVersionJson.type) ofVersionJson.type = 'release';

                    // 兼容旧格式：minecraftArguments → arguments
                    if (ofVersionJson.minecraftArguments && !ofVersionJson.arguments) {
                        const gameArgs = ofVersionJson.minecraftArguments.split(' ');
                        ofVersionJson.arguments = { game: gameArgs, jvm: [] };
                        console.log(`[OptiFine] 转换 minecraftArguments → arguments: ${gameArgs.length} args`);
                    }

                    for (const lib of (ofVersionJson.libraries || [])) {
                        if (lib.downloads?.artifact?.url) {
                            const libPath = path.join(LIBRARIES_DIR, lib.downloads.artifact.path);
                            if (!fs.existsSync(libPath)) {
                                try { await http.downloadFile(lib.downloads.artifact.url, libPath); } catch (e) {}
                            }
                        }
                    }

                    const ofLibName = `optifine:OptiFine:${ofGameVer2}_${ofType}`;
                    const ofLibPath = path.join(LIBRARIES_DIR, 'optifine', 'OptiFine', `${ofGameVer2}_${ofType}`, `OptiFine-${ofGameVer2}_${ofType}.jar`);
                    if (!fs.existsSync(path.dirname(ofLibPath))) fs.mkdirSync(path.dirname(ofLibPath), { recursive: true });
                    fs.copyFileSync(ofInstallerPath, ofLibPath);

                    if (!ofVersionJson.libraries) ofVersionJson.libraries = [];
                    // 避免重复添加
                    if (!ofVersionJson.libraries.some(l => l.name === ofLibName)) {
                        ofVersionJson.libraries.push({
                            name: ofLibName,
                            downloads: { artifact: { path: `optifine/OptiFine/${ofGameVer2}_${ofType}/OptiFine-${ofGameVer2}_${ofType}.jar` } }
                        });
                    }

                    const jsonPath = path.join(ofVersionDir, `${ofVersionId}.json`);
                    fs.writeFileSync(jsonPath, JSON.stringify(ofVersionJson, null, 2));
                    versions._invalidateResolvedJsonCache(ofVersionId);
                } else {
                    // 降级：手动构建 OptiFine 版本 JSON
                    const AdmZip = require('adm-zip');
                    const ofZip = new AdmZip(ofInstallerPath);

                    // 尝试从 installer 中提取 launchwrapper（OptiFine 依赖它来注入 tweakClass）
                    let launchWrapperPath = null;
                    const lwEntries = ofZip.getEntries().filter(e => e.entryName.startsWith('launchwrapper'));
                    for (const lwEntry of lwEntries) {
                        const lwName = path.basename(lwEntry.entryName);
                        launchWrapperPath = path.join(LIBRARIES_DIR, 'net', 'minecraft', 'launchwrapper', '1.12', lwName);
                        if (!fs.existsSync(launchWrapperPath)) {
                            fs.mkdirSync(path.dirname(launchWrapperPath), { recursive: true });
                            fs.writeFileSync(launchWrapperPath, lwEntry.getData());
                            console.log(`[OptiFine] 提取 launchwrapper: ${lwName}`);
                        }
                    }

                    const ofLibName = `optifine:OptiFine:${ofGameVer2}_${ofType}`;
                    const ofLibPathRel = `optifine/OptiFine/${ofGameVer2}_${ofType}/OptiFine-${ofGameVer2}_${ofType}.jar`;
                    const ofLibPath = path.join(LIBRARIES_DIR, ofLibPathRel);
                    if (!fs.existsSync(path.dirname(ofLibPath))) fs.mkdirSync(path.dirname(ofLibPath), { recursive: true });
                    fs.copyFileSync(ofInstallerPath, ofLibPath);

                    const fallbackJson = {
                        id: ofVersionId,
                        inheritsFrom: ofGameVer2,
                        mainClass: 'net.minecraft.launchwrapper.Launch',
                        type: 'release',
                        libraries: [
                            {
                                name: 'net.minecraft:launchwrapper:1.12',
                                downloads: {
                                    artifact: {
                                        path: 'net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar',
                                        url: 'https://libraries.minecraft.net/net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar'
                                    }
                                }
                            },
                            {
                                name: ofLibName,
                                downloads: { artifact: { path: ofLibPathRel } }
                            }
                        ],
                        minecraftArguments: '--tweakClass optifine.OptiFineTweaker'
                    };
                    const jsonPath = path.join(ofVersionDir, `${ofVersionId}.json`);
                    fs.writeFileSync(jsonPath, JSON.stringify(fallbackJson, null, 2));
                    versions._invalidateResolvedJsonCache(ofVersionId);
                }

                try { fs.unlinkSync(ofInstallerPath); } catch (e) {}
                sendJSON(res, { success: true, versionId: ofVersionId });
            } catch (e) {
                sendError(res, 'OptiFine安装失败: ' + e.message);
            }
        });
    }
};
