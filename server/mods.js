/**
 * server/mods.js - 模组管理功能模块
 * ============================================================================
 * 从 server.js 抽取的模组管理相关函数（解析 JAR、提取图标、检查更新、列出已安装模组等）。
 * 通过 ctx (./context) 访问共享状态，通过 utils (./utils) 访问工具函数，
 * 通过 http (./http-client) 访问 HTTP 请求功能，通过 versions (./versions) 访问版本管理。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ctx = require('./context');
const utils = require('./utils');
const http = require('./http-client');
const versions = require('./versions');

// ============================================================================
// 存档目录解析
// ============================================================================

function resolveSavesDir(versionId) {
    if (!versionId) {
        const settings = versions.loadSettingsCached();
        versionId = settings.selectedVersion || '';
    }
    if (!versionId) return path.join(ctx.dirs.DATA_DIR, 'saves');

    const gameDir = versions.getVersionGameDir(versionId);
    if (gameDir) return path.join(gameDir, 'saves');
    return path.join(ctx.dirs.DATA_DIR, 'saves');
}

// ============================================================================
// 模组更新检查
// ============================================================================

async function checkModUpdates(versionId) {
    const modsDir = versions.getVersionModsDir(versionId);
    if (!modsDir || !fs.existsSync(modsDir)) return { updates: [], total: 0, checked: 0 };

    const modFiles = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar') && !f.endsWith('.jar.disabled'));
    if (modFiles.length === 0) return { updates: [], total: 0, checked: 0 };

    const hashes = {};
    for (const file of modFiles) {
        try {
            const filePath = path.join(modsDir, file);
            const hash = crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
            hashes[hash] = { fileName: file, filePath, hash };
        } catch (e) {}
    }

    const hashList = Object.keys(hashes);
    if (hashList.length === 0) return { updates: [], total: modFiles.length, checked: 0 };

    try {
        const versionRes = await http.fetchJSONWithMethod(
            `${ctx.urls.MODRINTH_API}/version_files`,
            'POST',
            JSON.stringify({ hashes: hashList, algorithm: 'sha1' }),
            { 'Content-Type': 'application/json', 'User-Agent': 'VersePC/2.0 (PCL2)' }
        );

        const projectIds = [...new Set(Object.values(versionRes).map(v => v.project_id))];
        let projectMap = {};
        if (projectIds.length > 0) {
            try {
                const projects = await http.fetchJSON(`${ctx.urls.MODRINTH_API}/projects?ids=${encodeURIComponent(JSON.stringify(projectIds))}`);
                projects.forEach(p => projectMap[p.id] = p);
            } catch (e) {}
        }

        const updates = [];
        for (const [hash, info] of Object.entries(versionRes)) {
            const local = hashes[hash];
            if (!local) continue;
            const project = projectMap[info.project_id];
            updates.push({
                fileName: local.fileName,
                modName: project?.title || info.project_id,
                currentVersion: info.version_number || '',
                currentVersionId: info.id || '',
                projectUrl: `https://modrinth.com/mod/${info.project_id}`,
                projectId: info.project_id
            });
        }

        return { updates, total: modFiles.length, checked: hashList.length };
    } catch (e) {
        return { updates: [], total: modFiles.length, checked: hashList.length, error: e.message };
    }
}

// ============================================================================
// 解析模组 JAR 文件
// ============================================================================

function parseModJar(jarPath) {
    var cached = ctx.caches.MOD_META_CACHE.get(jarPath);
    if (cached) return cached;
    if (ctx.caches.MOD_META_CACHE.size > ctx.caches.MOD_META_CACHE_MAX) {
        var keys = Array.from(ctx.caches.MOD_META_CACHE.keys());
        for (var i = 0; i < 100; i++) ctx.caches.MOD_META_CACHE.delete(keys[i]);
    }

    var result = { icon: '', name: '', desc: '', version: '1.0', author: '', projectId: '' };
    try {
        var stat = fs.statSync(jarPath);
        if (stat.size > 100 * 1024 * 1024) {
            ctx.caches.MOD_META_CACHE.set(jarPath, result);
            return result;
        }
        var AdmZip = utils.getAdmZip();
        var zip = new AdmZip(jarPath);
        var entries = zip.getEntries();
        var fabricModJson = null;
        var modsToml = null;
        var neoForgeModsToml = null;
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (entry.isDirectory) continue;
            var name = entry.entryName;
            if (name === 'fabric.mod.json') fabricModJson = entry;
            else if (name === 'META-INF/neoforge.mods.toml') neoForgeModsToml = entry;
            else if (name === 'META-INF/mods.toml') modsToml = entry;
        }

        var iconPath = null;

        if (fabricModJson) {
            try {
                var json = JSON.parse(fabricModJson.getData().toString('utf8'));
                result.name = json.name || '';
                result.desc = json.description || '';
                result.version = json.version || '1.0';
                result.author = (json.authors || []).map(function (a) { return typeof a === 'string' ? a : a.name; }).join(', ') || '';
                result.projectId = json.id || '';
                var rawIcon = json.icon || '';
                if (rawIcon) {
                    if (typeof rawIcon === 'object') {
                        var bestKey = null;
                        var bestSize = 0;
                        var iconKeys = Object.keys(rawIcon);
                        for (var ki = 0; ki < iconKeys.length; ki++) {
                            var k = iconKeys[ki];
                            var size = parseInt(k) || 0;
                            if (size <= 128 && size > bestSize) {
                                bestSize = size;
                                bestKey = k;
                            }
                        }
                        iconPath = bestKey ? rawIcon[bestKey] : rawIcon[iconKeys[0]] || '';
                    } else {
                        iconPath = rawIcon;
                    }
                }
                if (!iconPath && json.id) {
                    for (var ei = 0; ei < entries.length; ei++) {
                        var entryName = entries[ei].entryName;
                        if (entryName === 'assets/' + json.id + '/icon.png') {
                            iconPath = entryName;
                            break;
                        }
                    }
                }
            } catch (e) {}
        }

        var parseTomlMod = function (tomlText) {
            if (!tomlText) return;
            var nm = tomlText.match(/displayName\s*=\s*"([^"]+)"/);
            if (nm && !result.name) result.name = nm[1];
            var dm = tomlText.match(/description\s*=\s*"""([\s\S]*?)"""/);
            if (!dm) dm = tomlText.match(/description\s*=\s*"([^"]+)"/);
            if (dm && !result.desc) result.desc = dm[1].trim();
            var vm = tomlText.match(/version\s*=\s*"([^"]+)"/);
            if (vm && result.version === '1.0') result.version = vm[1];
            var am = tomlText.match(/authors\s*=\s*\[([^\]]+)\]/);
            if (am && !result.author) {
                result.author = am[1].split(',').map(function(s){ return s.trim().replace(/^"|"$/g, ''); }).join(', ');
            } else if (!result.author) {
                var am2 = tomlText.match(/author\s*=\s*"([^"]+)"/);
                if (am2) result.author = am2[1];
            }
            var mm = tomlText.match(/modId\s*=\s*"([^"]+)"/);
            if (mm && !result.projectId) result.projectId = mm[1];
            var lm = tomlText.match(/logoFile\s*=\s*"([^"]+)"/);
            if (lm && !iconPath) iconPath = lm[1];
        };

        if (neoForgeModsToml) {
            try { parseTomlMod(neoForgeModsToml.getData().toString('utf8')); } catch (e) {}
        }
        if (modsToml) {
            try { parseTomlMod(modsToml.getData().toString('utf8')); } catch (e) {}
        }

        if (!iconPath) {
            for (var ei2 = 0; ei2 < entries.length; ei2++) {
                var en = entries[ei2].entryName;
                if (en === 'pack.png' || en === 'logo.png' || en === 'icon.png' || en.endsWith('/icon.png')) {
                    iconPath = en;
                    break;
                }
            }
        }

        if (iconPath) {
            iconPath = iconPath.replace(/\\/g, '/');
            var iconEntry = zip.getEntry(iconPath);
            if (!iconEntry) {
                for (var ei3 = 0; ei3 < entries.length; ei3++) {
                    if (entries[ei3].entryName.replace(/\\/g, '/') === iconPath) {
                        iconEntry = entries[ei3];
                        break;
                    }
                }
            }
            if (iconEntry && !iconEntry.isDirectory) {
                var data = iconEntry.getData();
                var hash = crypto.createHash('md5').update(jarPath + '|' + iconPath).digest('hex');
                var cacheFilePath = path.join(ctx.dirs.ICON_CACHE_DIR, hash + '.png');
                if (!fs.existsSync(cacheFilePath)) {
                    fs.writeFileSync(cacheFilePath, data);
                }
                result.icon = hash;
            }
        }

        ctx.caches.MOD_META_CACHE.set(jarPath, result);
        return result;
    } catch (e) {
        ctx.caches.MOD_META_CACHE.set(jarPath, result);
        return result;
    }
}

// ============================================================================
// 提取模组图标
// ============================================================================

function extractModIcon(jarPath) {
    var parsed = parseModJar(jarPath);
    return parsed.icon || '';
}

// ============================================================================
// 获取已安装模组列表
// ============================================================================

function getInstalledMods() {
    const mods = [];
    const settings = versions.loadSettingsCached();
    const versionId = settings.selectedVersion;
    const modsPath = versions.getVersionModsDir(versionId);
    const seenFiles = new Set();

    function scanModsDir(dir, source) {
        if (!dir || !fs.existsSync(dir)) return;
        fs.readdirSync(dir).forEach(file => {
            const isDisabled = file.endsWith('.disabled');
            const fileName = isDisabled ? file.replace('.disabled', '') : file;
            if (!fileName.endsWith('.jar')) return;
            if (seenFiles.has(fileName)) return;
            seenFiles.add(fileName);

            const name = fileName.replace('.jar', '');
            const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
            const stat = fs.statSync(path.join(dir, file));
            const jarPath = path.join(dir, file);

            const parsed = parseModJar(jarPath);

            mods.push({
                id: id,
                slug: parsed.projectId || '',
                name: parsed.name || name,
                fileName: file,
                description: parsed.desc || (isDisabled ? '已禁用' : '已安装的模组'),
                version: parsed.version || '1.0',
                enabled: !isDisabled,
                disabled: isDisabled,
                installed: true,
                size: utils.formatSize(stat.size),
                source: source,
                icon: parsed.icon ? `/api/mod-icon?hash=${parsed.icon}` : '',
                author: parsed.author || '',
                projectId: parsed.projectId || ''
            });
        });
    }

    scanModsDir(modsPath, '本地');

    if (modsPath) {
        const isolated = versions.resolveVersionIsolation(versionId);
        if (!isolated) {
            const settings = versions.loadSettingsCached();
            const sharedGameDir = settings.gameDir || ctx.dirs.DATA_DIR;
            const sharedModsDir = path.join(sharedGameDir, 'mods');
            if (sharedModsDir !== modsPath) {
                scanModsDir(sharedModsDir, '共享');
            }
            const homeMinecraftMods = path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft', 'mods');
            if (homeMinecraftMods !== modsPath && homeMinecraftMods !== sharedModsDir) {
                scanModsDir(homeMinecraftMods, '.minecraft');
            }
        }
    }

    const modIdMap = new Map();
    const warnings = [];
    for (const mod of mods) {
        if (mod.projectId) {
            if (modIdMap.has(mod.projectId)) {
                const existing = modIdMap.get(mod.projectId);
                if (existing.enabled && mod.enabled) {
                    warnings.push({
                        type: 'duplicate',
                        modId: mod.projectId,
                        message: `重复模组: ${mod.name} 与 ${existing.name} 使用相同的ID (${mod.projectId})`,
                        mods: [mod.fileName, existing.fileName]
                    });
                }
            } else {
                modIdMap.set(mod.projectId, mod);
            }
        }
    }

    const CONFLICT_GROUPS = [
        { ids: ['sodium', 'rubidium', 'embeddium'], name: '渲染优化', message: '多个渲染优化模组可能冲突' },
        { ids: ['lithium', 'canary', 'hamlib'], name: '服务端优化', message: '多个服务端优化模组可能冲突' },
        { ids: ['iris', 'oculus'], name: '光影', message: 'Iris和Oculus不能同时使用' },
        { ids: ['sodium', 'optifine', 'optifabric'], name: '渲染', message: 'Sodium和OptiFine不能同时使用' },
        { ids: ['fabric-api', 'fabric', 'quilted_fabric_api'], name: 'API', message: '多个Fabric/Quilt API可能冲突' },
        { ids: ['forge', 'neoforge', 'fmlloader'], name: '加载器', message: '不能同时使用多个模组加载器' },
    ];

    for (const group of CONFLICT_GROUPS) {
        const found = mods.filter(m => m.enabled && group.ids.some(id =>
            m.projectId.toLowerCase().includes(id) || m.name.toLowerCase().includes(id) || m.fileName.toLowerCase().includes(id)
        ));
        if (found.length > 1) {
            warnings.push({
                type: 'conflict',
                group: group.name,
                message: `${group.message}: ${found.map(m => m.name).join(', ')}`,
                mods: found.map(m => m.fileName)
            });
        }
    }

    if (warnings.length > 0) {
        console.log(`[Mods] 检测到 ${warnings.length} 个模组警告`);
    }

    return { mods, warnings };
}

module.exports = {
    resolveSavesDir,
    checkModUpdates,
    parseModJar,
    extractModIcon,
    getInstalledMods,
};
