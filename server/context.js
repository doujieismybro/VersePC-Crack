/**
 * server/context.js - 共享上下文模块
 * ============================================================================
 * 集中管理 server.js 及其子模块的全局状态、路径常量、缓存、会话等。
 * 所有子模块通过 require('./context') 获取共享状态。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

const PKG_VERSION = require('../package.json').version;

// ============================================================================
// 目录路径 - 可在 DATA_DIR 变更时重新计算
// ============================================================================
const DEFAULT_OLD_DATA_DIR = path.join(os.homedir(), '.versepc');
const APP_DIR = path.dirname(process.execPath);
const DATA_DIR_CONFIG_FILE = path.join(APP_DIR, 'data-config.json');

function hasNonASCII(str) {
    for (let i = 0; i < str.length; i++) {
        if (str.charCodeAt(i) > 127) return true;
    }
    return false;
}

function resolveDataDir() {
    try {
        if (fs.existsSync(DATA_DIR_CONFIG_FILE)) {
            const cfg = JSON.parse(fs.readFileSync(DATA_DIR_CONFIG_FILE, 'utf8'));
            if (cfg.dataDir && typeof cfg.dataDir === 'string' && fs.existsSync(cfg.dataDir)) {
                return cfg.dataDir;
            }
        }
    } catch (e) {}
    if (fs.existsSync(DEFAULT_OLD_DATA_DIR)) return DEFAULT_OLD_DATA_DIR;
    return path.join(APP_DIR, 'data');
}

function getSafeJavaDir() {
    const defaultDir = path.join(ctx.dirs.DATA_DIR, 'java');
    if (!hasNonASCII(defaultDir)) return defaultDir;
    const candidates = [
        path.join(process.env.ProgramData || 'C:\\ProgramData', 'VersePC', 'java'),
        path.join('C:\\VersePC', 'java'),
        path.join(process.env.ALLUSERSPROFILE || 'C:\\ProgramData', 'VersePC', 'java')
    ];
    for (const dir of candidates) {
        if (!hasNonASCII(dir)) return dir;
    }
    return defaultDir;
}

const MINECRAFT_DIR = process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft')
    : path.join(os.homedir(), '.minecraft');

const MINECRAFT_DIR_ORIG = MINECRAFT_DIR;

// ============================================================================
// 共享上下文对象
// ============================================================================
const ctx = {
    pkgVersion: PKG_VERSION,
    mainWindow: null,

    dirs: {
        APP_DIR,
        DATA_DIR_CONFIG_FILE,
        DATA_DIR: resolveDataDir(),
        APP_DATA_PATH: null, // 设置为 DATA_DIR
        MINECRAFT_DIR,
        MINECRAFT_DIR_ORIG,
        VERSIONS_DIR: null,
        LIBRARIES_DIR: null,
        ASSETS_DIR: null,
        MODS_DIR: null,
        NATIVES_DIR: null,
        ACCOUNTS_FILE: null,
        SETTINGS_FILE: null,
        JAVA_DIR: null,
        LOGS_DIR: null,
        ICON_CACHE_DIR: null,
        FAVORITES_FILE: null,
        VERSIONS_DATA_FILE: null,
        EXTERNAL_FOLDERS_FILE: null,
        DISK_CACHE_PATH: null,
        SKIN_BACKUP_DIR: null,
        TERRACOTTA_DIR: path.join(__dirname, '..', 'tools', 'terracotta'),
        TERRACOTTA_DATA_DIR: null,
        TERRACOTTA_LOG_FILE: null,
        APP_IMG_DIR: path.join(__dirname, '..', 'img'),
        STEVE_SKIN_LOCAL_PATH: path.join(__dirname, '..', 'img', 'steve_head.png'),
    },

    // API URLs 和镜像
    urls: {
        MOJANG_API: 'https://piston-meta.mojang.com',
        VERSION_MANIFEST_URL: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
        VERSION_MANIFEST_MIRROR: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
        MODRINTH_API: 'https://api.modrinth.com/v2',
        MODRINTH_API_MIRROR: 'https://mod.mcimirror.top/modrinth/v2',
        CURSEFORGE_API: 'https://api.curseforge.com/v1',
        CURSEFORGE_API_MIRROR: 'https://mod.mcimirror.top/curseforge/v1',
        JAVA_RUNTIME_URL: 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json',
        FABRIC_META_URL: 'https://meta.fabricmc.net/v2',
        FORGE_MAVEN_URL: 'https://maven.minecraftforge.net/net/minecraftforge/forge',
        NEOFORGE_API_URL: 'https://maven.neoforged.net/api/maven',
        TEMURIN_API: 'https://api.adoptium.net/v3',
        LIBERICA_BASE: 'https://download.bell-sw.com/java/',
        MS_CLIENT_ID: '9c1f1f43-58d5-4b7a-af0d-4e487f073441',
    },

    mirrors: {
        BMCLAPI_MIRROR: {
            'https://piston-data.mojang.com/': 'https://bmclapi2.bangbang93.com/',
            'https://piston-meta.mojang.com/': 'https://bmclapi2.bangbang93.com/',
            'https://libraries.minecraft.net/': 'https://bmclapi2.bangbang93.com/libraries/',
            'https://resources.download.minecraft.net/': 'https://bmclapi2.bangbang93.com/assets/',
            'https://launchermeta.mojang.com/': 'https://bmclapi2.bangbang93.com/',
            'https://launcher.mojang.com/': 'https://bmclapi2.bangbang93.com/',
            'https://meta.fabricmc.net/': 'https://bmclapi2.bangbang93.com/fabric-meta/',
            'https://maven.minecraftforge.net/': 'https://bmclapi2.bangbang93.com/maven/',
            'https://maven.neoforged.net/': 'https://bmclapi2.bangbang93.com/maven/',
            'https://maven.fabricmc.net/': 'https://bmclapi2.bangbang93.com/maven/',
            'https://cdn.modrinth.com/': 'https://mod.mcimirror.top/',
            'https://edge.forgecdn.net/': 'https://mod.mcimirror.top/',
            'https://mediafilez.forgecdn.net/': 'https://mod.mcimirror.top/',
            'https://media.forgecdn.net/': 'https://mod.mcimirror.top/',
        },
        MCIM_MIRROR: {
            'https://cdn.modrinth.com/': 'https://mod.mcimirror.top/',
            'https://edge.forgecdn.net/': 'https://mod.mcimirror.top/',
            'https://mediafilez.forgecdn.net/': 'https://mod.mcimirror.top/',
            'https://media.forgecdn.net/': 'https://mod.mcimirror.top/',
        },
        JAVA_DOWNLOAD_MIRRORS: [
            { name: 'BMCLAPI', urlMap: {
                'https://launchermeta.mojang.com/': 'https://bmclapi2.bangbang93.com/',
                'https://piston-data.mojang.com/': 'https://bmclapi2.bangbang93.com/',
            }},
            { name: 'Mojang官方', prefix: '' },
            { name: 'Adoptium (Temurin)', type: 'temurin' },
        ],
        FORGE_MAVEN_BASES: [
            'https://bmclapi2.bangbang93.com/maven/',
            'https://maven.minecraftforge.net/',
        ],
    },

    // 缓存
    caches: {
        versionCache: null,
        versionCacheTime: 0,
        CACHE_DURATION: 5 * 60 * 1000,
        versionDetailsCache: {},
        _versionsCache: null,
        _versionsCacheTime: 0,
        VERSIONS_CACHE_TTL: 5000,
        _settingsCache: null,
        _settingsCacheTime: 0,
        SETTINGS_CACHE_TTL: 2000,
        _accountsCache: null,
        _accountsCacheTime: 0,
        ACCOUNTS_CACHE_TTL: 5000,
        _resolvedJsonCache: new Map(),
        _resolvedJsonCacheTime: new Map(),
        RESOLVED_JSON_CACHE_TTL: 60000,
        _depCheckCache: new Map(),
        _DEP_CHECK_CACHE_TTL: 30000,
        _apiCache: new Map(),
        _mirrorHealth: { down: false, until: 0, fails: 0 },
        AVATAR_CACHE: new Map(),
        AVATAR_CACHE_DURATION: 30 * 60 * 1000,
        VERSION_ICON_CACHE: new Map(),
        VERSION_ICON_CACHE_DURATION: 24 * 60 * 60 * 1000,
        modIconCache: new Map(),
        MOD_ICON_CACHE_MAX: 500,
        MOD_META_CACHE: new Map(),
        MOD_META_CACHE_MAX: 500,
        diskCache: null,
        cacheDirty: false,
        _cachedSystemInfo: null,
        _tokenEncKey: null,
        cachedSteveHead: null,
        steveHeadPromise: null,
        _steveSkinFull: null,
        _steveSkinFullPromise: null,
        dnsCache: new Map(),
        DNS_CACHE_TTL: 60000,
        dirCache: new Set(),
    },

    // 会话状态
    sessions: {
        installSessions: new Map(),
        javaInstallSessions: new Map(),
        javaDownloadAbortControllers: new Map(),
        modDownloadSessions: new Map(),
        customDownloadSessions: new Map(),
        repairSessions: new Map(),
        gameInstances: new Map(),
        gameLogBuffer: [],
        lastGameExitAnalysis: null,
        detectedLanPort: null,
        gameInstanceCounter: 0,
        launchSessions: new Map(),
    },

    // 网络状态 (Terracotta + UPnP + WS relay)
    network: {
        // Terracotta
        TERRACOTTA_VERSION: '0.4.2',
        terracottaProcess: null,
        terracottaHttpPort: 0,
        terracottaPortFilePath: '',
        terracottaStatus: { running: false, mode: null, roomCode: '', virtualIP: '', guestPort: 25565, gamePort: 0, state: null, stateIndex: -1 },
        terracottaPublicNodes: null,
        terracottaPublicNodesExpiry: 0,
        _terracottaOrigConsole: { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) },
        _terracottaDaemonTimer: null,
        _terracottaCrashCount: 0,
        _terracottaSavedMode: null,
        _terracottaSavedGamePort: 0,
        _terracottaSavedRoomCode: '',
        TERRACOTTA_MAX_CRASH_RECOVERY: 3,
        TERRACOTTA_ERROR_MAP: {
            1: '配置错误',
            2: '网络错误',
            3: '版本不兼容',
            4: '房间已满',
            5: '房间不存在',
            6: '密码错误',
            7: '被踢出',
            8: '连接超时',
            9: '服务器关闭',
            10: '协议错误',
        },
        TERRACOTTA_FATAL_MAP: {
            1: '配置错误，请检查参数',
            3: '版本不兼容，请更新 Terracotta',
        },

        // UPnP
        upnpMappings: new Map(),
        upnpGatewayCache: null,

        // WS Relay
        wsRelayServer: null,
        wsRelayRooms: new Map(),

        // LAN Rooms
        lanRooms: new Map(),
        lanRelayServers: new Map(),
    },

    // JVM 预热
    jvm: {
        preheatedJvm: null,
        preheatTimer: null,
    },

    // 安装互斥锁
    _installMutex: null,

    // 常量
    constants: {
        APRIL_FOOLS_IDS: new Set([
            '1.4.2', '1.4.2-pre', '1.4.2-pre2', '1.4.2-pre3', '1.4.2-pre4', '1.4.2-pre5',
            '1.4.2-pre6', '1.4.2-pre7', '1.4.2-pre8', '1.4.2-pre9', '1.4.2-pre10',
        ]),
        NO_CHUNK_HOSTS: ['github.com', 'raw.githubusercontent.com', 'githubusercontent.com'],
        AVATAR_SERVICES: [
            (uuid) => `https://minotar.net/helm/${uuid}.png`,
            (uuid) => `https://mc-heads.net/avatar/${uuid}/64`,
            (uuid) => `https://crafatar.com/avatars/${uuid}?size=64&overlay`,
            (uuid) => `https://visage.surgeplay.com/face/64/${uuid}`,
        ],
        SENSITIVE_PATTERNS: [
            /--accessToken\s+\S+/gi,
            /--uuid\s+\S+/gi,
            /--username\s+\S+/gi,
            /token["\s:=]+[a-zA-Z0-9._-]{20,}/gi,
            /access_token["\s:=]+[a-zA-Z0-9._-]{20,}/gi,
        ],
        _WIN_RESERVED_NAMES: /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i,
        TOKEN_ENC_ALGO: 'aes-256-cbc',
    },
};

// ============================================================================
// 初始化派生路径
// ============================================================================
function reinitPaths() {
    const d = ctx.dirs;
    d.DATA_DIR = resolveDataDir();
    d.APP_DATA_PATH = d.DATA_DIR;
    d.VERSIONS_DIR = path.join(d.DATA_DIR, 'versions');
    d.LIBRARIES_DIR = path.join(d.DATA_DIR, 'libraries');
    d.ASSETS_DIR = path.join(d.DATA_DIR, 'assets');
    d.MODS_DIR = path.join(d.DATA_DIR, 'mods');
    d.NATIVES_DIR = path.join(d.DATA_DIR, 'natives');
    d.ACCOUNTS_FILE = path.join(d.DATA_DIR, 'accounts.json');
    d.SETTINGS_FILE = path.join(d.DATA_DIR, 'settings.json');
    d.JAVA_DIR = getSafeJavaDir();
    d.LOGS_DIR = path.join(d.DATA_DIR, 'logs');
    d.ICON_CACHE_DIR = path.join(d.DATA_DIR, 'cache', 'mod-icons');
    d.FAVORITES_FILE = path.join(d.DATA_DIR, 'favorites.json');
    d.VERSIONS_DATA_FILE = path.join(d.DATA_DIR, 'versions-data.json');
    d.EXTERNAL_FOLDERS_FILE = path.join(d.DATA_DIR, 'external-folders.json');
    d.DISK_CACHE_PATH = path.join(d.DATA_DIR, 'cache', 'version-manifest.json');
    d.SKIN_BACKUP_DIR = path.join(d.DATA_DIR, 'skin-backups');
    d.TERRACOTTA_DATA_DIR = path.join(d.DATA_DIR, 'tools', 'terracotta');
    d.TERRACOTTA_LOG_FILE = path.join(d.DATA_DIR, 'terracotta.log');
}

reinitPaths();

// ============================================================================
// 共享 HTTP Agents (带连接池)
// ============================================================================
function cachedLookup(hostname, opts, callback) {
    if (typeof opts === 'function') {
        callback = opts;
        opts = undefined;
    }
    const dnsCache = ctx.caches.dnsCache;
    const cached = dnsCache.get(hostname);
    if (cached && Date.now() - cached.time < ctx.caches.DNS_CACHE_TTL) {
        return callback(null, cached.address, cached.family);
    }
    require('dns').lookup(hostname, opts, (err, address, family) => {
        if (err) return callback(err);
        dnsCache.set(hostname, { address, family, time: Date.now() });
        callback(null, address, family);
    });
}

const SHARED_HTTPS_AGENT = new https.Agent({
    keepAlive: true,
    maxSockets: 256,
    maxFreeSockets: 128,
    timeout: 120000,
    keepAliveMsecs: 300000,
    scheduling: 'fifo',
    lookup: cachedLookup
});

const SHARED_HTTP_AGENT = new http.Agent({
    keepAlive: true,
    maxSockets: 256,
    maxFreeSockets: 128,
    timeout: 120000,
    keepAliveMsecs: 300000,
    scheduling: 'fifo',
    lookup: cachedLookup
});

ctx.httpAgents = { SHARED_HTTPS_AGENT, SHARED_HTTP_AGENT, cachedLookup };

// ============================================================================
// setMainWindow
// ============================================================================
function setMainWindow(win) { ctx.mainWindow = win; }
ctx.setMainWindow = setMainWindow;

// ============================================================================
// DownloadManager (连接池 + 令牌桶限速)
// ============================================================================
const DownloadManager = {
    activeConnections: 0,
    connectionLimit: 64,
    speedHistory: [],
    totalBytesDownloaded: 0,
    lastBytesSnapshot: 0,
    lastSnapshotTime: 0,
    currentSpeed: 0,
    speedLimitBytes: 0,
    tokenBucket: 0,
    tokenBucketMax: 0,
    tokenBucketRefillRate: 0,
    lastTokenRefill: 0,
    downloadQueue: [],
    queueProcessing: false,
    totalFiles: 0,
    completedFiles: 0,
    failedFiles: 0,
    skippedFiles: 0,
    startTime: 0,
    _speedTimer: null,

    _startSpeedTimer() {
        if (this._speedTimer) return;
        this._speedTimer = setInterval(() => { this.refreshSpeed(); }, 100);
    },
    _stopSpeedTimer() {
        if (this._speedTimer) {
            clearInterval(this._speedTimer);
            this._speedTimer = null;
            this.currentSpeed = 0;
            this.speedHistory = [];
        }
    },
    acquireConnection() {
        if (this.activeConnections >= this.connectionLimit) return false;
        this.activeConnections++;
        this._startSpeedTimer();
        return true;
    },
    releaseConnection() {
        this.activeConnections = Math.max(0, this.activeConnections - 1);
        if (this.activeConnections <= 0) this._stopSpeedTimer();
    },
    recordProgress(bytes) {
        this.totalBytesDownloaded += bytes;
        if (this.speedLimitBytes > 0) {
            const now = Date.now();
            if (now - this.lastTokenRefill > 50) {
                const elapsed = now - this.lastTokenRefill;
                this.tokenBucket = Math.min(this.tokenBucketMax, this.tokenBucket + (this.tokenBucketRefillRate * elapsed / 1000));
                this.lastTokenRefill = now;
            }
            if (this.tokenBucket >= bytes) {
                this.tokenBucket -= bytes;
            }
        }
    },
    refreshSpeed() {
        const now = Date.now();
        if (this.lastSnapshotTime === 0) {
            this.lastSnapshotTime = now;
            this.lastBytesSnapshot = this.totalBytesDownloaded;
            return;
        }
        const elapsed = (now - this.lastSnapshotTime) / 1000;
        if (elapsed < 0.1) return;
        this.currentSpeed = Math.round((this.totalBytesDownloaded - this.lastBytesSnapshot) / elapsed);
        this.speedHistory.push(this.currentSpeed);
        if (this.speedHistory.length > 100) this.speedHistory.shift();
        this.lastBytesSnapshot = this.totalBytesDownloaded;
        this.lastSnapshotTime = now;
    },
    setSpeedLimit(mbps) {
        if (mbps <= 0) {
            this.speedLimitBytes = 0;
            this.tokenBucket = Infinity;
            this.tokenBucketMax = Infinity;
            this.tokenBucketRefillRate = Infinity;
        } else {
            this.speedLimitBytes = mbps * 1024 * 1024;
            this.tokenBucketMax = this.speedLimitBytes;
            this.tokenBucket = this.speedLimitBytes;
            this.tokenBucketRefillRate = this.speedLimitBytes;
            this.lastTokenRefill = Date.now();
        }
    },
    getSpeed() { return this.currentSpeed; },
    getStats() {
        return {
            activeConnections: this.activeConnections,
            connectionLimit: this.connectionLimit,
            currentSpeed: this.currentSpeed,
            totalBytesDownloaded: this.totalBytesDownloaded,
            totalFiles: this.totalFiles,
            completedFiles: this.completedFiles,
            failedFiles: this.failedFiles,
            skippedFiles: this.skippedFiles,
            startTime: this.startTime,
            speedLimitBytes: this.speedLimitBytes
        };
    },
    resetCounters() {
        this.totalFiles = 0;
        this.completedFiles = 0;
        this.failedFiles = 0;
        this.skippedFiles = 0;
        this.totalBytesDownloaded = 0;
        this.startTime = Date.now();
        this.lastBytesSnapshot = 0;
        this.lastSnapshotTime = 0;
        this.speedHistory = [];
    },
    reset() {
        this.totalBytesDownloaded = 0;
        this.lastBytesSnapshot = 0;
        this.lastSnapshotTime = 0;
        this.speedHistory = [];
        this.currentSpeed = 0;
        this.totalFiles = 0;
        this.completedFiles = 0;
        this.failedFiles = 0;
        this.skippedFiles = 0;
        this.startTime = Date.now();
    }
};

ctx.DownloadManager = DownloadManager;

module.exports = ctx;
