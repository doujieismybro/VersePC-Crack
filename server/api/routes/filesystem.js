/**
 * server/api/routes/filesystem.js - 文件系统浏览路由
 * ============================================================================
 * 从 server.js handleAPI switch 语句抽取的文件系统浏览、目录打开相关端点。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

module.exports = {
    register(registerRoute, deps) {
        const { ctx, sendJSON, sendError, readBody } = deps;
        const { utils, versions } = deps;

        const DATA_DIR = ctx.dirs.DATA_DIR;
        const MINECRAFT_DIR = ctx.dirs.MINECRAFT_DIR;
        const VERSIONS_DIR = ctx.dirs.VERSIONS_DIR;
        const ASSETS_DIR = ctx.dirs.ASSETS_DIR;
        const LOGS_DIR = ctx.dirs.LOGS_DIR;

        // ====================================================================
        // /api/fs/browse
        // ====================================================================
        registerRoute('GET', '/api/fs/browse', async (req, res, parsedUrl) => {
            await new Promise(r => setImmediate(r));
            const browsePath = parsedUrl.query.path || '';
            const browseType = parsedUrl.query.type || 'dir';
            const browsePattern = parsedUrl.query.pattern || '';

            if (!browsePath) {
                const settings = versions.loadSettingsCached();
                const homeDir = os.homedir();
                const defaultPaths = [
                    { name: 'VersePC 数据目录', path: DATA_DIR, type: 'app' },
                    { name: '用户主目录', path: homeDir, type: 'home' },
                ];
                if (settings.selectedVersion) {
                    const vDir = versions.getVersionSubDir(settings.selectedVersion, '') || path.join(VERSIONS_DIR, settings.selectedVersion);
                    if (fs.existsSync(vDir)) {
                        defaultPaths.push({ name: `版本: ${settings.selectedVersion}`, path: vDir, type: 'version' });
                        const modsDir = path.join(vDir, 'mods');
                        if (fs.existsSync(modsDir)) {
                            defaultPaths.push({ name: '模组目录', path: modsDir, type: 'mods' });
                        }
                        const savesDir = path.join(vDir, 'saves');
                        if (fs.existsSync(savesDir)) {
                            defaultPaths.push({ name: '存档目录', path: savesDir, type: 'saves' });
                        }
                        const rpDir = path.join(vDir, 'resourcepacks');
                        if (fs.existsSync(rpDir)) {
                            defaultPaths.push({ name: '资源包目录', path: rpDir, type: 'resourcepacks' });
                        }
                    }
                }
                sendJSON(res, { success: true, quickAccess: defaultPaths });
                return;
            }

            try {
                const resolvedPath = path.resolve(browsePath);
                const lowerPath = resolvedPath.toLowerCase();
                const allowedPrefixes = [
                    DATA_DIR.toLowerCase(),
                    path.join(os.homedir(), '.minecraft').toLowerCase(),
                    os.homedir().toLowerCase(),
                    path.join(os.homedir(), 'Desktop').toLowerCase(),
                    path.join(os.homedir(), 'Documents').toLowerCase(),
                    path.join(os.homedir(), 'Downloads').toLowerCase()
                ];
                let allowed = false;
                for (const prefix of allowedPrefixes) {
                    if (lowerPath.startsWith(prefix) || lowerPath === prefix) {
                        allowed = true;
                        break;
                    }
                }
                if (!allowed) {
                    sendJSON(res, { success: false, error: '无权访问该路径，仅限 VersePC 数据目录、.minecraft 目录和用户主目录' });
                    return;
                }

                if (!fs.existsSync(resolvedPath)) {
                    sendJSON(res, { success: false, error: '路径不存在' });
                    return;
                }

                const stat = await fs.promises.stat(resolvedPath);
                if (!stat.isDirectory()) {
                    sendJSON(res, { success: false, error: '路径不是目录' });
                    return;
                }

                const MAX_ENTRIES = 300;
                const entries = await fs.promises.readdir(resolvedPath);
                const filtered = entries.filter(e => {
                    if (!e.startsWith('.') || e === '.minecraft') return true;
                    return false;
                }).slice(0, MAX_ENTRIES);

                const items = [];
                for (let i = 0; i < filtered.length; i++) {
                    const entry = filtered[i];
                    const fullPath = path.join(resolvedPath, entry);
                    try {
                        const entryStat = await fs.promises.stat(fullPath);
                        const isDir = entryStat.isDirectory();
                        if (browseType === 'dir' && !isDir) continue;
                        if (browsePattern) {
                            const regex = new RegExp(browsePattern.replace(/\*/g, '.*').replace(/\?/g, '.'), 'i');
                            if (!regex.test(entry)) continue;
                        }
                        items.push({
                            name: entry,
                            path: fullPath,
                            isDirectory: isDir,
                            size: isDir ? 0 : entryStat.size,
                            modified: entryStat.mtimeMs
                        });
                    } catch (e) {}

                    if (i % 50 === 49) {
                        await new Promise(r => setImmediate(r));
                    }
                }

                items.sort((a, b) => {
                    if (a.isDirectory !== b.isDirectory) return b.isDirectory ? 1 : -1;
                    return a.name.localeCompare(b.name);
                });

                sendJSON(res, {
                    success: true,
                    path: resolvedPath,
                    parent: path.dirname(resolvedPath),
                    items,
                    total: items.length
                });
            } catch (e) {
                sendJSON(res, { success: false, error: e.message });
            }
        });

        // ====================================================================
        // /api/open-folder
        // ====================================================================
        registerRoute('POST', '/api/open-folder', async (req, res, parsedUrl) => {
            const data = await readBody(req);
            const folder = data.folder || 'data';
            const _ofSettings = versions.loadSettingsCached();
            const _ofGameDir = _ofSettings.gameDir || DATA_DIR;
            let targetPath = _ofGameDir;
            switch (folder) {
                case 'minecraft': targetPath = MINECRAFT_DIR; break;
                case 'versions': targetPath = VERSIONS_DIR; break;
                case 'mods': {
                    const modsDir = versions.getVersionModsDir(_ofSettings.selectedVersion);
                    targetPath = modsDir || path.join(_ofGameDir, 'mods');
                    break;
                }
                case 'assets': targetPath = ASSETS_DIR; break;
                case 'logs': targetPath = LOGS_DIR; break;
                case 'crash-reports': {
                    const crDir = versions.getVersionSubDir(null, 'crash-reports');
                    targetPath = crDir || path.join(_ofGameDir, 'crash-reports');
                    break;
                }
                case 'shaderpacks': {
                    const spDir = versions.getVersionSubDir(null, 'shaderpacks');
                    if (spDir) {
                        if (!fs.existsSync(spDir)) fs.mkdirSync(spDir, { recursive: true });
                        targetPath = spDir;
                    } else {
                        targetPath = path.join(_ofGameDir, 'shaderpacks');
                    }
                    break;
                }
                case 'resourcepacks': {
                    const rpDir = versions.getVersionSubDir(null, 'resourcepacks');
                    if (rpDir) {
                        if (!fs.existsSync(rpDir)) fs.mkdirSync(rpDir, { recursive: true });
                        targetPath = rpDir;
                    } else {
                        targetPath = path.join(_ofGameDir, 'resourcepacks');
                    }
                    break;
                }
                case 'datapacks': {
                    const dpDir = versions.getVersionSubDir(null, 'datapacks');
                    if (dpDir) {
                        if (!fs.existsSync(dpDir)) fs.mkdirSync(dpDir, { recursive: true });
                        targetPath = dpDir;
                    } else {
                        targetPath = path.join(_ofGameDir, 'datapacks');
                    }
                    break;
                }
                case 'game': {
                    const gameDir = versions.getVersionSubDir(null, '');
                    if (gameDir) {
                        targetPath = gameDir;
                    } else {
                        const settings = versions.loadSettingsCached();
                        targetPath = settings.gameDir || DATA_DIR;
                    }
                    break;
                }
                case 'custom': {
                    const customPath = data.customPath || '';
                    if (customPath && fs.existsSync(customPath)) {
                        targetPath = customPath;
                    }
                    break;
                }
            }
            if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });
            try {
                if (process.platform === 'win32') {
                    const { shell } = require('electron');
                    shell.openPath(targetPath);
                } else if (process.platform === 'darwin') {
                    require('child_process').execFile('open', [targetPath]);
                } else {
                    require('child_process').execFile('xdg-open', [targetPath]);
                }
                sendJSON(res, { success: true, path: targetPath });
            } catch (e) {
                sendJSON(res, { success: true, path: targetPath });
            }
        });

        // ====================================================================
        // /api/filesystem/browse
        // ====================================================================
        registerRoute('POST', '/api/filesystem/browse', async (req, res, parsedUrl) => {
            const fsBody = await readBody(req);
            const { path: browsePath, showHidden = false } = fsBody;

            if (!browsePath) {
                sendError(res, 'Missing path parameter', 400);
                return;
            }

            const resolvedBrowse = path.resolve(browsePath);
            const allowedBrowseBases = [DATA_DIR, ...Object.values(VERSIONS_DIR), os.homedir()].map(d => path.resolve(d));
            const isBrowseAllowed = allowedBrowseBases.some(base => resolvedBrowse.toLowerCase().startsWith(base.toLowerCase()));
            if (!isBrowseAllowed) {
                sendError(res, 'Forbidden: 不允许访问此路径', 403);
                return;
            }

            try {
                if (!fs.existsSync(browsePath)) {
                    sendJSON(res, { error: 'Path does not exist', files: [], folders: [] });
                    return;
                }

                const stat = fs.statSync(browsePath);
                if (!stat.isDirectory()) {
                    sendJSON(res, { error: 'Path is not a directory', files: [], folders: [] });
                    return;
                }

                const entries = fs.readdirSync(browsePath, { withFileTypes: true });
                const files = [];
                const folders = [];

                for (const entry of entries) {
                    // 跳过隐藏文件（如果未启用显示隐藏）
                    if (!showHidden && entry.name.startsWith('.')) continue;

                    const entryPath = path.join(browsePath, entry.name);
                    let entryStat;
                    try {
                        entryStat = fs.statSync(entryPath);
                    } catch (e) {
                        continue; // 跳过无法访问的文件
                    }

                    const item = {
                        name: entry.name,
                        path: entryPath,
                        modifiedTime: entryStat.mtime.getTime(),
                        size: entryStat.size,
                        extension: path.extname(entry.name).toLowerCase()
                    };

                    if (entry.isDirectory()) {
                        folders.push(item);
                    } else {
                        files.push(item);
                    }
                }

                // 排序：文件夹在前，然后按名称排序
                folders.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
                files.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

                sendJSON(res, { files, folders, currentPath: browsePath });
            } catch (e) {
                sendJSON(res, { error: e.message, files: [], folders: [] });
            }
        });

        // ====================================================================
        // /api/filesystem/quick-access
        // ====================================================================
        registerRoute('GET', '/api/filesystem/quick-access', async (req, res, parsedUrl) => {
            try {
                const homeDir = os.homedir();
                const quickAccessPaths = [
                    { name: '桌面', path: path.join(homeDir, 'Desktop'), icon: 'desktop' },
                    { name: '文档', path: path.join(homeDir, 'Documents'), icon: 'docs' },
                    { name: '下载', path: path.join(homeDir, 'Downloads'), icon: 'downloads' },
                    { name: '.minecraft', path: MINECRAFT_DIR, icon: 'minecraft' },
                    { name: 'VersePC 数据', path: DATA_DIR, icon: 'versepc' }
                ];

                sendJSON(res, quickAccessPaths);
            } catch (e) {
                sendError(res, e.message);
            }
        });

        // ====================================================================
        // /api/filesystem/drives
        // ====================================================================
        registerRoute('GET', '/api/filesystem/drives', async (req, res, parsedUrl) => {
            try {
                const drives = [];

                if (process.platform === 'win32') {
                    let output;
                    try {
                        output = execSync('wmic logicaldevice get name,size,description /format:list', {
                            encoding: 'utf8',
                            timeout: 3000
                        }).toString();
                    } catch (e) {
                        output = '';
                    }

                    // 解析驱动器信息
                    const driveLetters = ['C:', 'D:', 'E:', 'F:', 'G:', 'H:'];
                    for (const letter of driveLetters) {
                        try {
                            if (fs.existsSync(letter)) {
                                const stats = fs.statSync(letter);
                                drives.push({
                                    name: letter.replace(':', ''),
                                    path: letter,
                                    type: 'fixed',
                                    totalSize: utils.formatDriveSize(stats.size || 0)
                                });
                            }
                        } catch (e) {}
                    }
                } else {
                    // macOS/Linux
                    drives.push({
                        name: '/',
                        path: '/',
                        type: 'fixed',
                        totalSize: ''
                    });

                    // 添加常见挂载点
                    ['/home', '/mnt', '/Volumes'].forEach(mount => {
                        if (fs.existsSync(mount)) {
                            drives.push({
                                name: mount.split('/').pop() || mount,
                                path: mount,
                                type: 'fixed',
                                totalSize: ''
                            });
                        }
                    });
                }

                sendJSON(res, drives);
            } catch (e) {
                sendError(res, e.message);
            }
        });

        // ====================================================================
        // /api/filesystem/create-directory
        // ====================================================================
        registerRoute('POST', '/api/filesystem/create-directory', async (req, res, parsedUrl) => {
            const cdBody = await readBody(req);
            const { parentPath, name } = cdBody;

            if (!parentPath || !name) {
                sendError(res, 'Missing parameters', 400);
                return;
            }

            try {
                const newPath = path.join(parentPath, name);
                if (fs.existsSync(newPath)) {
                    sendJSON(res, { success: false, error: 'Directory already exists' });
                    return;
                }

                fs.mkdirSync(newPath, { recursive: true });
                sendJSON(res, { success: true, path: newPath });
            } catch (e) {
                sendJSON(res, { success: false, error: e.message });
            }
        });

        // ====================================================================
        // /api/filesystem/default-mod-path
        // ====================================================================
        registerRoute('GET', '/api/filesystem/default-mod-path', async (req, res, parsedUrl) => {
            try {
                const reqVid = parsedUrl.query.versionId || null;
                let defaultPath = versions.getVersionSubDir(reqVid, 'mods');
                if (!defaultPath) {
                    const installedVersions = versions.getInstalledVersions();
                    const fallbackBase = settings.gameDir || DATA_DIR;
                    if (installedVersions.length > 0) {
                        defaultPath = versions.getVersionSubDir(installedVersions[0].id, 'mods') || path.join(fallbackBase, 'mods');
                    } else {
                        defaultPath = path.join(fallbackBase, 'mods');
                    }
                }
                sendJSON(res, defaultPath);
            } catch (e) {
                sendError(res, e.message);
            }
        });

        // ====================================================================
        // /api/filesystem/default-resource-path
        // ====================================================================
        registerRoute('GET', '/api/filesystem/default-resource-path', async (req, res, parsedUrl) => {
            try {
                const drpType = parsedUrl.query.type || '';
                const folderMap = { resourcepack: 'resourcepacks', shader: 'shaderpacks', datapack: 'datapacks' };
                const folderName = folderMap[drpType];
                if (!folderName) { sendError(res, 'Invalid resource type', 400); return; }

                let defaultPath = versions.getVersionSubDir(null, folderName);
                if (!defaultPath) {
                    const installedVersions = versions.getInstalledVersions();
                    if (installedVersions.length > 0) {
                        defaultPath = versions.getVersionSubDir(installedVersions[0].id, folderName) || path.join(DATA_DIR, folderName);
                    } else {
                        defaultPath = path.join(DATA_DIR, folderName);
                    }
                }
                sendJSON(res, defaultPath);
            } catch (e) {
                sendError(res, e.message);
            }
        });

        // ====================================================================
        // /api/filesystem/open-in-explorer
        // ====================================================================
        registerRoute('POST', '/api/filesystem/open-in-explorer', async (req, res, parsedUrl) => {
            const oieBody = await readBody(req);
            const { targetPath } = oieBody;

            if (!targetPath || !fs.existsSync(targetPath)) {
                sendError(res, 'Invalid or non-existent path', 400);
                return;
            }

            try {
                const { shell } = require('electron');
                await shell.openPath(targetPath);
                sendJSON(res, { success: true });
            } catch (e) {
                sendError(res, e.message);
            }
        });
    }
};
