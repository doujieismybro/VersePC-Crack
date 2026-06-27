/**
 * server/utils.js - 通用工具函数模块
 * ============================================================================
 * 文件系统辅助、格式化、UUID、PNG 编解码、字符串转义、系统信息等。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { execSync } = require('child_process');
const ctx = require('./context');

// ============================================================================
// AdmZip 延迟加载
// ============================================================================
let AdmZipModule = null;
function getAdmZip() {
    if (!AdmZipModule) {
        try {
            AdmZipModule = require('adm-zip');
        } catch (e) {
            throw new Error('缺少 adm-zip 依赖，请运行 npm install adm-zip');
        }
    }
    return AdmZipModule;
}

// ============================================================================
// 文件系统辅助
// ============================================================================
function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    const dirCache = ctx.caches.dirCache;
    if (dirCache.has(dir)) return;
    let dirExists = false;
    try {
        dirExists = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    } catch (_) {}
    if (!dirExists) {
        const parts = dir.split(path.sep);
        for (let i = 1; i <= parts.length; i++) {
            const partial = parts.slice(0, i).join(path.sep);
            if (partial) {
                try {
                    if (fs.existsSync(partial) && !fs.statSync(partial).isDirectory()) {
                        fs.unlinkSync(partial);
                    }
                } catch (_) {}
            }
        }
        fs.mkdirSync(dir, { recursive: true });
    }
    dirCache.add(dir);
}

async function asyncEnsureDir(filePath) {
    const dir = path.dirname(filePath);
    const dirCache = ctx.caches.dirCache;
    if (dirCache.has(dir)) return;
    let dirExists = false;
    try {
        const st = await fs.promises.stat(dir);
        dirExists = st.isDirectory();
    } catch (_) {}
    if (!dirExists) {
        const parts = dir.split(path.sep);
        for (let i = 1; i <= parts.length; i++) {
            const partial = parts.slice(0, i).join(path.sep);
            if (partial) {
                try {
                    const stat = await fs.promises.stat(partial);
                    if (!stat.isDirectory()) {
                        await fs.promises.unlink(partial);
                    }
                } catch (_) {}
            }
        }
        await fs.promises.mkdir(dir, { recursive: true });
    }
    dirCache.add(dir);
}

function ensureDirForFile(filePath) {
    const parts = filePath.split(path.sep);
    let current = parts[0] || path.sep;
    for (let i = 1; i < parts.length - 1; i++) {
        current = path.join(current, parts[i]);
        if (fs.existsSync(current) && !fs.statSync(current).isDirectory()) {
            fs.unlinkSync(current);
        }
    }
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function yieldToEventLoop() {
    return new Promise(resolve => setImmediate(resolve));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function generateUUID() {
    return crypto.randomUUID();
}

// ============================================================================
// 安全文件 I/O
// ============================================================================
function safeWriteFileSync(filePath, content) {
    try {
        ensureDir(filePath);
        const tmpPath = filePath + '.tmp';
        fs.writeFileSync(tmpPath, content);
        try { fs.unlinkSync(filePath); } catch (_) {}
        try { fs.renameSync(tmpPath, filePath); } catch (e) {
            try { fs.copyFileSync(tmpPath, filePath); fs.unlinkSync(tmpPath); } catch (_) {}
        }
    } catch (e) {
        console.error(`[Utils] safeWriteFileSync failed: ${filePath}`, e.message);
    }
}

function safeReadJsonFile(filePath, defaults) {
    try {
        if (!fs.existsSync(filePath)) return defaults;
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return defaults;
    }
}

// ============================================================================
// 路径安全
// ============================================================================
function safeLibPath(artifactPath, baseDir) {
    if (!artifactPath || typeof artifactPath !== 'string') return null;
    const LIBRARIES_DIR = ctx.dirs.LIBRARIES_DIR;
    const rawPath = artifactPath.replace(/\//g, path.sep);
    const resolved = path.resolve(baseDir || LIBRARIES_DIR, rawPath);
    const base = path.resolve(baseDir || LIBRARIES_DIR);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
        console.warn(`[Security] Blocked path traversal in artifact path: ${artifactPath}`);
        return null;
    }
    return resolved;
}

// ============================================================================
// 日志轮转
// ============================================================================
function rotateLogs() {
    try {
        const LOGS_DIR = ctx.dirs.LOGS_DIR;
        if (!fs.existsSync(LOGS_DIR)) return;
        const MAX_LOG_FILES = 16;
        const MAX_LOG_SIZE = 32 * 1024 * 1024;
        const files = fs.readdirSync(LOGS_DIR)
            .filter(f => f.endsWith('.log') || f.endsWith('.json'))
            .map(f => {
                const p = path.join(LOGS_DIR, f);
                try { const s = fs.statSync(p); return { path: p, time: s.mtimeMs, size: s.size }; } catch (_) { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => a.time - b.time);
        for (const f of files) {
            if (f.size > MAX_LOG_SIZE) { try { fs.unlinkSync(f.path); } catch (_) {} }
        }
        const remaining = files.filter(f => { try { return fs.existsSync(f.path); } catch (_) { return false; } });
        while (remaining.length > MAX_LOG_FILES) { try { fs.unlinkSync(remaining.shift().path); } catch (_) {} }
    } catch (_) {}
}

// ============================================================================
// 整合包导入日志
// ============================================================================
const _importLogDir = (() => {
    try {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, 'VersePC');
    } catch (_) { return ''; }
})();
const _importLogFile = _importLogDir ? path.join(_importLogDir, 'import.log') : '';

function _writeImportLog(msg) {
    if (!_importLogFile) return;
    try {
        if (!_importLogDir) return;
        const dir = path.dirname(_importLogFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(_importLogFile, '[' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] ' + msg + '\n', 'utf8');
    } catch (_) {}
}

function _clearImportLog() {
    if (!_importLogFile) return;
    try { fs.writeFileSync(_importLogFile, '', 'utf8'); } catch (_) {}
}

// ============================================================================
// 格式化
// ============================================================================
function formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatPlayTime(totalSeconds) {
    if (!totalSeconds || totalSeconds <= 0) return '0 分钟';
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    let result = '';
    if (days > 0) result += days + ' 天 ';
    if (hours > 0) result += hours + ' 小时 ';
    result += minutes + ' 分钟';
    return result;
}

function formatDriveSize(bytes) {
    if (!bytes || bytes === 0) return '';
    const tb = bytes / (1024 * 1024 * 1024 * 1024);
    if (tb >= 1) return tb.toFixed(1) + ' TB';
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return gb.toFixed(0) + ' GB';
    return formatSize(bytes);
}

function getPlatformKey() {
    const platform = process.platform;
    const arch = process.arch;
    if (platform === 'win32') {
        if (arch === 'x64') return 'windows-x64';
        if (arch === 'arm64') return 'windows-arm64';
        return 'windows-x86';
    }
    if (platform === 'darwin') {
        if (arch === 'arm64') return 'mac-os-arm64';
        return 'mac-os';
    }
    if (arch === 'x64') return 'linux';
    return 'linux-i386';
}

// ============================================================================
// 字符串转义
// ============================================================================
function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeReplaceValue(str) {
    return str.replace(/\$/g, '$$$$');
}

function replaceVariables(str, vars) {
    let result = str;
    for (const [key, value] of Object.entries(vars)) {
        const escapedKey = escapeRegExp(key);
        const escapedValue = escapeReplaceValue(String(value));
        result = result.replace(new RegExp(`\\$\\{${escapedKey}\\}`, 'g'), escapedValue);
        result = result.replace(new RegExp(`\\$${escapedKey}(?![a-zA-Z0-9_])`, 'g'), escapedValue);
    }
    return result;
}

// ============================================================================
// 目录大小
// ============================================================================
function getDirSize(dirPath, depth = 0) {
    if (depth > 20) return 0;
    let size = 0;
    try {
        fs.readdirSync(dirPath).forEach(file => {
            const filePath = path.join(dirPath, file);
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) size += getDirSize(filePath, depth + 1);
            else size += stat.size;
        });
    } catch (e) {}
    return size;
}

// ============================================================================
// 系统信息
// ============================================================================
function getSystemInfo() {
    if (ctx.caches._cachedSystemInfo) return ctx.caches._cachedSystemInfo;
    const cpus = os.cpus();
    const cpuModel = cpus.length > 0 ? cpus[0].model.trim() : 'Unknown';
    const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
    const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
    const osRelease = os.release();
    const osType = os.type();
    const osArch = os.arch();
    let gpuInfo = 'Unknown';
    try {
        const wmic = execSync('chcp 65001 >nul 2>nul && wmic path win32_VideoController get Name,DriverVersion,AdapterRAM /format:csv', { encoding: 'utf8', timeout: 5000, windowsHide: true });
        const lines = wmic.split('\n').filter(l => l.trim() && !l.startsWith('Node'));
        const gpus = lines.map(l => {
            const parts = l.trim().split(',');
            const name = (parts[2] || '').trim();
            const driver = (parts[1] || '').trim();
            const ram = parseInt(parts[3], 10);
            if (!name) return null;
            const ramMB = ram > 0 ? Math.round(ram / 1024 / 1024) : null;
            return ramMB ? `${name} (${ramMB}MB, driver: ${driver})` : `${name} (driver: ${driver})`;
        }).filter(Boolean);
        if (gpus.length > 0) gpuInfo = gpus.join(' | ');
    } catch (e) {}
    ctx.caches._cachedSystemInfo = { cpuModel, totalMemMB, freeMemMB, osRelease, osType, osArch, gpuInfo };
    return ctx.caches._cachedSystemInfo;
}

// ============================================================================
// 敏感信息过滤
// ============================================================================
const SENSITIVE_PATTERNS = [
    { pattern: /--accessToken\s+\S+/g, replacement: '--accessToken ***' },
    { pattern: /--uuid\s+\S+/g, replacement: '--uuid ***' },
    { pattern: /auth_access_token[=:]\s*\S+/g, replacement: 'auth_access_token=***' },
    { pattern: /auth_uuid[=:]\s*\S+/g, replacement: 'auth_uuid=***' },
    { pattern: /accessToken['"]\s*:\s*['"][^'"]+['"]/g, replacement: 'accessToken":"***"' },
    { pattern: /refreshToken['"]\s*:\s*['"][^'"]+['"]/g, replacement: 'refreshToken":"***"' },
    { pattern: /token\s*[=:]\s*['"]?[a-zA-Z0-9._-]{20,}['"]?/gi, replacement: 'token=***' },
    { pattern: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, replacement: 'eyJ***' },
];

function filterSensitiveInfo(line) {
    if (!line || typeof line !== 'string') return line;
    let filtered = line;
    for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
        filtered = filtered.replace(pattern, replacement);
    }
    return filtered;
}

// ============================================================================
// PNG 编解码 (用于皮肤头像处理)
// ============================================================================
function decodePngPixels(buf) {
    try {
        let offset = 8;
        let width = 0, height = 0, bitDepth = 0, colorType = 0;
        const idatChunks = [];

        while (offset < buf.length) {
            if (offset + 8 > buf.length) break;
            const chunkLen = buf.readUInt32BE(offset);
            const chunkType = buf.slice(offset + 4, offset + 8).toString('ascii');
            if (chunkType === 'IHDR') {
                width = buf.readUInt32BE(offset + 8);
                height = buf.readUInt32BE(offset + 12);
                bitDepth = buf[offset + 16];
                colorType = buf[offset + 17];
            } else if (chunkType === 'IDAT') {
                idatChunks.push(buf.slice(offset + 8, offset + 8 + chunkLen));
            }
            offset += 12 + chunkLen;
        }

        if (width === 0 || height === 0) return null;

        const compressed = Buffer.concat(idatChunks);
        const raw = zlib.inflateSync(compressed);

        const bpp = (colorType === 6) ? 4 : (colorType === 2) ? 3 : (colorType === 0) ? 1 : 4;
        const outBpp = 4;
        const pixels = Buffer.alloc(width * height * outBpp, 0);
        const prevRow = Buffer.alloc(width * outBpp, 0);
        let srcIdx = 0;

        function paethPredictor(a, b, c) {
            const p = a + b - c;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - c);
            if (pa <= pb && pa <= pc) return a;
            if (pb <= pc) return b;
            return c;
        }

        for (let y = 0; y < height; y++) {
            if (srcIdx >= raw.length) break;
            const filter = raw[srcIdx++];
            const curRow = Buffer.alloc(width * outBpp, 0);

            for (let x = 0; x < width; x++) {
                const curIdx = x * outBpp;
                for (let c = 0; c < bpp; c++) {
                    if (srcIdx >= raw.length) break;
                    let val = raw[srcIdx++];

                    const leftIdx = (x - 1) * outBpp;
                    const aboveIdx = x * outBpp;
                    const aboveLeftIdx = (x - 1) * outBpp;

                    const left = x > 0 ? curRow[leftIdx + c] : 0;
                    const above = prevRow[aboveIdx + c];
                    const aboveLeft = x > 0 ? prevRow[aboveLeftIdx + c] : 0;

                    switch (filter) {
                        case 0: break;
                        case 1: val = (val + left) & 0xFF; break;
                        case 2: val = (val + above) & 0xFF; break;
                        case 3: val = (val + Math.floor((left + above) / 2)) & 0xFF; break;
                        case 4: val = (val + paethPredictor(left, above, aboveLeft)) & 0xFF; break;
                    }

                    if (c < outBpp) curRow[curIdx + c] = val;
                }
                if (bpp === 3) curRow[x * outBpp + 3] = 255;
                if (bpp === 1) {
                    const v = curRow[x * outBpp];
                    curRow[x * outBpp + 1] = v;
                    curRow[x * outBpp + 2] = v;
                    curRow[x * outBpp + 3] = 255;
                }
            }

            curRow.copy(pixels, y * width * outBpp);
            curRow.copy(prevRow);
        }

        return pixels;
    } catch (e) {
        console.log('[Avatar] decodePngPixels失败:', e.message);
        return null;
    }
}

function encodePng(pixels, width, height) {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const rawData = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y++) {
        rawData[y * (1 + width * 4)] = 0;
        pixels.copy(rawData, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
    }

    const compressed = zlib.deflateSync(rawData);

    const chunks = [
        makePngChunk('IHDR', ihdr),
        makePngChunk('IDAT', compressed),
        makePngChunk('IEND', Buffer.alloc(0))
    ];

    return Buffer.concat([signature, ...chunks]);
}

function makePngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcData = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcData), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
}

function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
        }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ============================================================================
// JAR 完整性检查
// ============================================================================
function isJarIntact(filePath) {
    try {
        if (!fs.existsSync(filePath)) return false;
        const fd = fs.openSync(filePath, 'r');
        const hdr = Buffer.alloc(4);
        fs.readSync(fd, hdr, 0, 4, 0);
        const stat = fs.fstatSync(fd);
        fs.closeSync(fd);
        if (stat.size < 200) return false;
        if (hdr[0] !== 0x50 || hdr[1] !== 0x4B || hdr[2] !== 0x03 || hdr[3] !== 0x04) return false;
        if (stat.size < 22) return stat.size >= 200;
        const buf = Buffer.alloc(Math.min(65557, stat.size));
        const searchStart = Math.max(0, stat.size - buf.length);
        const fd2 = fs.openSync(filePath, 'r');
        fs.readSync(fd2, buf, 0, buf.length, searchStart);
        fs.closeSync(fd2);
        for (let i = buf.length - 22; i >= 0; i--) {
            if (buf.readUInt32LE(i) === 0x06054B50) return true;
        }
        return false;
    } catch (e) {
        return false;
    }
}

// ============================================================================
// SHA1 计算
// ============================================================================
function calculateSHA1(filePath) {
    try {
        const data = fs.readFileSync(filePath);
        return crypto.createHash('sha1').update(data).digest('hex');
    } catch (e) {
        return null;
    }
}

async function verifyFileSha1(filePath, expectedSha1) {
    if (!expectedSha1) return true;
    const actual = calculateSHA1(filePath);
    return actual === expectedSha1;
}

function verifyFileSha1Sync(filePath, expectedSha1) {
    if (!expectedSha1) return true;
    const actual = calculateSHA1(filePath);
    return actual === expectedSha1;
}

// ============================================================================
// 初始化
// ============================================================================
setInterval(() => { ctx.caches.dirCache.clear(); }, 5 * 60 * 1000);
rotateLogs();

module.exports = {
    getAdmZip,
    ensureDir,
    asyncEnsureDir,
    ensureDirForFile,
    yieldToEventLoop,
    sleep,
    generateUUID,
    safeWriteFileSync,
    safeReadJsonFile,
    safeLibPath,
    rotateLogs,
    _writeImportLog,
    _clearImportLog,
    formatSize,
    formatPlayTime,
    formatDriveSize,
    getPlatformKey,
    escapeRegExp,
    escapeReplaceValue,
    replaceVariables,
    getDirSize,
    getSystemInfo,
    filterSensitiveInfo,
    decodePngPixels,
    encodePng,
    makePngChunk,
    crc32,
    isJarIntact,
    calculateSHA1,
    verifyFileSha1,
    verifyFileSha1Sync,
};
