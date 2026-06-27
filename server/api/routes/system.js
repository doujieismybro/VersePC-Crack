/**
 * server/api/routes/system.js - 系统/JVM/清理路由
 * ============================================================================
 * 从 server.js handleAPI switch 语句抽取的系统状态、JVM 预热/CDS、清理相关端点。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

module.exports = {
    register(registerRoute, deps) {
        const { ctx, sendJSON, sendError, readBody } = deps;
        const { utils, versions, java, launch } = deps;

        const DATA_DIR = ctx.dirs.DATA_DIR;
        const MINECRAFT_DIR = ctx.dirs.MINECRAFT_DIR;
        const VERSIONS_DIR = ctx.dirs.VERSIONS_DIR;
        const NATIVES_DIR = ctx.dirs.NATIVES_DIR;
        const ICON_CACHE_DIR = ctx.dirs.ICON_CACHE_DIR;

        // ====================================================================
        // /api/status
        // ====================================================================
        registerRoute('GET', '/api/status', async (req, res, parsedUrl) => {
            sendJSON(res, {
                version: '1.0.0',
                platform: utils.getPlatformKey(),
                dataDir: DATA_DIR,
                minecraftDir: MINECRAFT_DIR,
                gameRunning: ctx.sessions.gameInstances.size > 0,
                gameInstanceCount: ctx.sessions.gameInstances.size,
                uptime: process.uptime(),
                latestRelease: ctx.caches.versionCache?.latest?.release || 'unknown',
                latestSnapshot: ctx.caches.versionCache?.latest?.snapshot || 'unknown',
                downloadEngine: {
                    activeConnections: ctx.DownloadManager.activeConnections,
                    connectionLimit: ctx.DownloadManager.connectionLimit,
                    speed: ctx.DownloadManager.getSpeed(),
                    totalBytesDownloaded: ctx.DownloadManager.totalBytesDownloaded
                }
            });
        });

        // ====================================================================
        // /api/system/memory
        // ====================================================================
        registerRoute('GET', '/api/system/memory', async (req, res, parsedUrl) => {
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const totalMB = Math.floor(totalMem / 1024 / 1024);
            const freeMB = Math.floor(freeMem / 1024 / 1024);
            const usedMB = totalMB - freeMB;
            let autoMB;
            if (totalMB <= 2500) {
                autoMB = 1024;
            } else if (totalMB <= 4500) {
                autoMB = totalMB - 1500;
            } else if (totalMB <= 8500) {
                autoMB = totalMB - 2048;
            } else {
                autoMB = totalMB - 4096;
            }
            autoMB = Math.max(512, Math.min(autoMB, 32768));
            autoMB = Math.floor(autoMB / 256) * 256;
            sendJSON(res, {
                totalBytes: totalMem,
                freeBytes: freeMem,
                totalMB, freeMB, usedMB,
                totalGB: Math.round(totalMem / 1024 / 1024 / 1024 * 10) / 10,
                freeGB: Math.round(freeMem / 1024 / 1024 / 1024 * 10) / 10,
                usedGB: Math.round(usedMB / 1024 * 10) / 10,
                autoMB,
                autoGB: Math.round(autoMB / 1024 * 10) / 10
            });
        });

        // ====================================================================
        // /api/system/memory-info
        // ====================================================================
        registerRoute('GET', '/api/system/memory-info', async (req, res, parsedUrl) => {
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedMem = totalMem - freeMem;
            sendJSON(res, {
                totalMB: Math.round(totalMem / 1024 / 1024),
                usedMB: Math.round(usedMem / 1024 / 1024),
                freeMB: Math.round(freeMem / 1024 / 1024),
                loadPercent: Math.round((usedMem / totalMem) * 100)
            });
        });

        // ====================================================================
        // /api/jvm/preheat
        // ====================================================================
        registerRoute('POST', '/api/jvm/preheat', async (req, res, parsedUrl) => {
            const preheatBody = await readBody(req);
            const preheatJavaPath = preheatBody.javaPath;
            const preheatMemMB = preheatBody.maxMemMB || 1024;
            if (preheatJavaPath && fs.existsSync(preheatJavaPath)) {
                launch.preheatJvm(preheatJavaPath, preheatMemMB);
                sendJSON(res, { success: true });
            } else {
                sendJSON(res, { success: false, error: 'Java path not found' });
            }
        });

        // ====================================================================
        // /api/jvm/generate-cds
        // ====================================================================
        registerRoute('POST', '/api/jvm/generate-cds', async (req, res, parsedUrl) => {
            const cdsBody = await readBody(req);
            const cdsVersionId = cdsBody.versionId;
            if (!cdsVersionId) { sendJSON(res, { success: false, error: 'versionId required' }); return; }

            const cdsDir = path.join(DATA_DIR, 'cds');
            if (!fs.existsSync(cdsDir)) fs.mkdirSync(cdsDir, { recursive: true });

            const cdsArchive = path.join(cdsDir, `${cdsVersionId}.jsa`);
            const cdsClassList = path.join(cdsDir, `${cdsVersionId}.cls`);

            const cdsVersionJson = versions.resolveVersionJson(cdsVersionId);
            if (!cdsVersionJson) { sendJSON(res, { success: false, error: 'Version not found' }); return; }

            const cdsSettings = versions.loadSettingsCached();
            const cdsJavaPath = java.selectJavaForVersion(cdsVersionId, cdsSettings, cdsVersionJson) || 'java';
            if (!cdsJavaPath || !fs.existsSync(cdsJavaPath)) { sendJSON(res, { success: false, error: 'Java not found' }); return; }

            const cdsMajorVer = java.getJavaMajorVersion(cdsJavaPath);
            if (cdsMajorVer < 8) { sendJSON(res, { success: false, error: 'CDS requires Java 8+' }); return; }

            try {
                console.log(`[CDS] 开始为 ${cdsVersionId} 生成类共享归档...`);

                const defaultJsa = path.join(path.dirname(path.dirname(cdsJavaPath)), 'lib', 'server', 'classes.jsa');
                if (fs.existsSync(defaultJsa)) {
                    try {
                        fs.copyFileSync(defaultJsa, cdsArchive);
                        console.log(`[CDS] 已复制默认CDS归档: ${defaultJsa}`);
                        sendJSON(res, { success: true, archive: cdsArchive, source: 'default' });
                        return;
                    } catch(e) {}
                }

                const dumpArgs = [cdsJavaPath, '-Xshare:dump', `-XX:SharedArchiveFile=${cdsArchive}`];
                const dumpResult = execSync(dumpArgs.join(' '), { encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
                console.log(`[CDS] 默认归档生成完成`);

                if (fs.existsSync(cdsArchive) && fs.statSync(cdsArchive).size > 1024) {
                    sendJSON(res, { success: true, archive: cdsArchive, source: 'generated', sizeKB: Math.round(fs.statSync(cdsArchive).size / 1024) });
                } else {
                    sendJSON(res, { success: false, error: 'Archive generation failed - file too small or missing' });
                }
            } catch (e) {
                const errMsg = e.stderr?.toString() || e.message;
                console.error(`[CDS] 归档生成失败: ${errMsg}`);
                if (fs.existsSync(cdsArchive) && fs.statSync(cdsArchive).size > 1024) {
                    sendJSON(res, { success: true, archive: cdsArchive, source: 'partial', warning: errMsg.substring(0, 200) });
                } else {
                    sendJSON(res, { success: false, error: errMsg.substring(0, 300) });
                }
            }
        });

        // ====================================================================
        // /api/jvm/cds-status
        // ====================================================================
        registerRoute('GET', '/api/jvm/cds-status', async (req, res, parsedUrl) => {
            const statusVersionId = parsedUrl.query.versionId;
            if (!statusVersionId) { sendJSON(res, { available: false }); return; }
            const statusArchive = path.join(DATA_DIR, 'cds', `${statusVersionId}.jsa`);
            if (fs.existsSync(statusArchive)) {
                const stat = fs.statSync(statusArchive);
                sendJSON(res, { available: true, archive: statusArchive, sizeKB: Math.round(stat.size / 1024), modified: stat.mtimeMs });
            } else {
                sendJSON(res, { available: false });
            }
        });

        // ====================================================================
        // /api/jvm/optimize-args
        // ====================================================================
        registerRoute('GET', '/api/jvm/optimize-args', async (req, res, parsedUrl) => {
            try {
                const versionId = parsedUrl.query.versionId;
                if (!versionId) {
                    sendError(res, '缺少versionId参数', 400);
                    return;
                }

                const totalMem = os.totalmem();
                const freeMem = os.freemem();
                const availableGB = freeMem / 1073741824;

                let modCount = 0;
                const versionDir = path.join(VERSIONS_DIR, versionId);
                const modsDir = path.join(versionDir, 'mods');
                if (fs.existsSync(modsDir)) {
                    modCount = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar')).length;
                }

                let t0, t1, t2, t3;
                if (modCount > 0) {
                    t0 = 0.5 + modCount / 150;
                    t1 = 1.5 + modCount / 90;
                    t2 = 2.7 + modCount / 50;
                    t3 = 4.5 + modCount / 25;
                } else {
                    t0 = 0.5; t1 = 1.5; t2 = 2.5; t3 = 4;
                }

                let ramGive = 0;
                let ramAvailable = availableGB;

                let delta = t1;
                ramGive += Math.min(ramAvailable, delta);
                ramAvailable -= delta;

                delta = t2 - t1;
                ramGive += Math.min(ramAvailable * 0.7, delta);
                ramAvailable -= delta / 0.7;

                delta = t3 - t2;
                ramGive += Math.min(ramAvailable * 0.4, delta);
                ramAvailable -= delta / 0.4;

                delta = t3;
                ramGive += Math.min(ramAvailable * 0.15, delta);

                ramGive = Math.max(ramGive, t0);
                ramGive = Math.round(ramGive * 10) / 10;

                const maxGB = totalMem / 1073741824 * 0.7;
                ramGive = Math.min(ramGive, maxGB);

                const totalRamMB = Math.floor(ramGive * 1024);
                const newGenMB = Math.floor(totalRamMB * 0.15);

                const args = [
                    `-Xmx${totalRamMB}m`,
                    `-Xmn${newGenMB}m`,
                    '-XX:+UseG1GC',
                    '-XX:-UseAdaptiveSizePolicy',
                    '-XX:-OmitStackTraceInFastThrow',
                    '-Djdk.lang.Process.allowAmbiguousCommands=true',
                    '-Dfml.ignoreInvalidMinecraftCertificates=True',
                    '-Dfml.ignorePatchDiscrepancies=True',
                    '-Dlog4j2.formatMsgNoLookups=true'
                ];

                sendJSON(res, {
                    args: args.join(' '),
                    xmxMB: totalRamMB,
                    xmnMB: newGenMB,
                    ramGB: ramGive,
                    modCount,
                    totalMemGB: totalMem / 1073741824,
                    freeMemGB: freeMem / 1073741824
                });
            } catch (e) {
                sendError(res, '优化JVM参数失败: ' + e.message);
            }
        });

        // ====================================================================
        // /api/cleanup
        // ====================================================================
        registerRoute('POST', '/api/cleanup', async (req, res, parsedUrl) => {
            const settings = versions.loadSettingsCached();
            const gameDir = settings.gameDir || DATA_DIR;
            const results = {};
            let totalBytes = 0;

            const safeRmDir = (dir) => {
                if (!fs.existsSync(dir)) return 0;
                let bytes = 0;
                try {
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fp = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                            bytes += safeRmDir(fp);
                        } else {
                            try {
                                bytes += fs.statSync(fp).size;
                                fs.unlinkSync(fp);
                            } catch (e) {}
                        }
                    }
                    try { fs.rmdirSync(dir); } catch (e) {}
                } catch (e) {}
                return bytes;
            };

            const scanDirSize = (dir) => {
                if (!fs.existsSync(dir)) return 0;
                let bytes = 0;
                try {
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fp = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                            bytes += scanDirSize(fp);
                        } else {
                            try { bytes += fs.statSync(fp).size; } catch (e) {}
                        }
                    }
                } catch (e) {}
                return bytes;
            };

            const cleanVersionLogs = () => {
                let bytes = 0;
                const verDir = path.join(DATA_DIR, 'versions');
                if (!fs.existsSync(verDir)) return 0;
                try {
                    const versions = fs.readdirSync(verDir);
                    for (const v of versions) {
                        for (const sub of ['logs', 'crash-reports']) {
                            const d = path.join(verDir, v, sub);
                            if (fs.existsSync(d)) bytes += safeRmDir(d);
                        }
                        const mcLog = path.join(verDir, v, 'latest.log');
                        if (fs.existsSync(mcLog)) {
                            try { bytes += fs.statSync(mcLog).size; fs.unlinkSync(mcLog); } catch (e) {}
                        }
                    }
                } catch (e) {}
                return bytes;
            };

            const cleanTempDir = () => {
                const tmpDir = path.join(DATA_DIR, 'temp');
                if (!fs.existsSync(tmpDir)) return 0;
                return safeRmDir(tmpDir);
            };

            const cleanNatives = () => {
                if (!fs.existsSync(NATIVES_DIR)) return 0;
                let bytes = 0;
                try {
                    const entries = fs.readdirSync(NATIVES_DIR, { withFileTypes: true });
                    for (const entry of entries) {
                        if (entry.isDirectory()) {
                            bytes += safeRmDir(path.join(NATIVES_DIR, entry.name));
                        }
                    }
                } catch (e) {}
                return bytes;
            };

            const cleanIconCache = () => {
                if (!fs.existsSync(ICON_CACHE_DIR)) return 0;
                return safeRmDir(ICON_CACHE_DIR);
            };

            const cleanModpackCache = () => {
                const mpDir = path.join(gameDir, 'modpacks');
                if (!fs.existsSync(mpDir)) return 0;
                let bytes = 0;
                try {
                    const files = fs.readdirSync(mpDir);
                    for (const f of files) {
                        if (f.endsWith('.mrpack') || f.endsWith('.zip')) {
                            const fp = path.join(mpDir, f);
                            try { bytes += fs.statSync(fp).size; fs.unlinkSync(fp); } catch (e) {}
                        }
                    }
                } catch (e) {}
                return bytes;
            };

            const cleanDownloadCache = () => {
                const cacheDir = path.join(DATA_DIR, 'cache');
                if (!fs.existsSync(cacheDir)) return 0;
                let bytes = 0;
                try {
                    const entries = fs.readdirSync(cacheDir, { withFileTypes: true });
                    for (const entry of entries) {
                        if (entry.isFile() && entry.name !== '.gitkeep') {
                            const fp = path.join(cacheDir, entry.name);
                            try { bytes += fs.statSync(fp).size; fs.unlinkSync(fp); } catch (e) {}
                        }
                    }
                } catch (e) {}
                return bytes;
            };

            results.gameLogs = cleanVersionLogs();
            results.tempFiles = cleanTempDir();
            results.natives = cleanNatives();
            results.iconCache = cleanIconCache();
            results.modpackCache = cleanModpackCache();
            results.downloadCache = cleanDownloadCache();
            totalBytes = Object.values(results).reduce((a, b) => a + b, 0);

            sendJSON(res, {
                success: true,
                freedBytes: totalBytes,
                freedMB: Math.round(totalBytes / (1024 * 1024) * 100) / 100,
                details: results,
                message: `清理完成，释放 ${Math.round(totalBytes / (1024 * 1024) * 100) / 100} MB 空间`
            });
        });

        // ====================================================================
        // /api/cleanup/scan
        // ====================================================================
        registerRoute('GET', '/api/cleanup/scan', async (req, res, parsedUrl) => {
            const scanResults = {};
            let scanTotal = 0;
            const scanDir = (dir) => {
                if (!fs.existsSync(dir)) return 0;
                let b = 0;
                try {
                    const e = fs.readdirSync(dir, { withFileTypes: true });
                    for (const f of e) {
                        const fp = path.join(dir, f.name);
                        if (f.isDirectory()) b += scanDir(fp);
                        else try { b += fs.statSync(fp).size; } catch (_) {}
                    }
                } catch (_) {}
                return b;
            };
            const verDir = path.join(DATA_DIR, 'versions');
            if (fs.existsSync(verDir)) {
                try {
                    for (const v of fs.readdirSync(verDir)) {
                        for (const sub of ['logs', 'crash-reports']) {
                            const d = path.join(verDir, v, sub);
                            scanResults[`${v}/${sub}`] = scanDir(d);
                        }
                    }
                } catch (_) {}
            }
            scanResults['temp'] = scanDir(path.join(DATA_DIR, 'temp'));
            scanResults['natives'] = scanDir(NATIVES_DIR);
            scanResults['iconCache'] = scanDir(ICON_CACHE_DIR);
            scanResults['cache'] = scanDir(path.join(DATA_DIR, 'cache'));
            const settings = versions.loadSettingsCached();
            const gDir = settings.gameDir || DATA_DIR;
            const mpDir = path.join(gDir, 'modpacks');
            if (fs.existsSync(mpDir)) {
                try {
                    for (const f of fs.readdirSync(mpDir)) {
                        if (f.endsWith('.mrpack') || f.endsWith('.zip')) {
                            try { scanResults['modpacks'] = (scanResults['modpacks'] || 0) + fs.statSync(path.join(mpDir, f)).size; } catch (_) {}
                        }
                    }
                } catch (_) {}
            }
            scanTotal = Object.values(scanResults).reduce((a, b) => a + b, 0);
            sendJSON(res, { success: true, details: scanResults, totalBytes: scanTotal, totalMB: Math.round(scanTotal / (1024 * 1024) * 100) / 100 });
        });
    }
};
