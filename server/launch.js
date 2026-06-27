/**
 * server/launch.js - 游戏启动核心模块
 * ============================================================================
 * 从 server.js 抽取的游戏启动相关函数：JVM 参数构建、Natives 提取调用、
 * 进程启动管理、性能优化、退出码分析等。
 * 通过 ctx (./context) 访问共享状态，通过 utils (./utils) 访问工具函数，
 * 通过 http (./http-client) 访问 HTTP 请求功能，通过 versions (./versions) 访问版本管理，
 * 通过 java (./java) 访问 Java 检测，通过 dependencies (./dependencies) 访问依赖下载，
 * 通过 modloaders (./modloaders) 访问模组加载器，通过 natives (./natives) 访问 Natives 处理。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync, exec, spawn } = require('child_process');

const ctx = require('./context');
const utils = require('./utils');
const http = require('./http-client');
const versions = require('./versions');
const java = require('./java');
const dependencies = require('./dependencies');
const modloaders = require('./modloaders');
const natives = require('./natives');

// ============================================================================
// 懒加载 server.js 中尚未抽取到子模块的函数 (避免循环依赖)
// ============================================================================
let _serverModule = null;
function _server() {
    if (_serverModule === null) {
        try { _serverModule = require('../server'); } catch (_) { _serverModule = {}; }
    }
    return _serverModule;
}

// ============================================================================
// DoRound - PowerShell 内存优化脚本（字符串常量，非 JS 函数）
// ============================================================================
const DoRound = `$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -MemberDefinition '[DllImport("psapi.dll")] public static extern int EmptyWorkingSet(IntPtr hwProc);' -Name "W32PSAPI" -Namespace "VP" -WarningAction SilentlyContinue -PassThru | Out-Null
Add-Type -MemberDefinition '[DllImport("kernel32.dll", SetLastError=true)] private static extern int SetSystemInformation(uint infoClass, IntPtr info, uint length);' -Name "W32SysInfo" -Namespace "VP" -WarningAction SilentlyContinue -PassThru | Out-Null
Add-Type -MemberDefinition '[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateFile(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);' -Name "W32File" -Namespace "VP" -WarningAction SilentlyContinue -PassThru | Out-Null
Add-Type -MemberDefinition '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FlushFileBuffers(IntPtr hFile);' -Name "W32Flush" -Namespace "VP" -WarningAction SilentlyContinue -PassThru | Out-Null
Add-Type -MemberDefinition '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr hObject);' -Name "W32Close" -Namespace "VP" -WarningAction SilentlyContinue -PassThru | Out-Null
function DoRound {
    try {
        $h = [VP.W32File]::CreateFile("\\\\.\\C:", 0x40000000, 0x00000003, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
        if ($h -ne [IntPtr]::Zero -and [long]$h -ne -1) {
            [void][VP.W32Flush]::FlushFileBuffers($h)
            [void][VP.W32Close]::CloseHandle($h)
        }
    } catch {}
    Start-Sleep -Milliseconds 1000
    Get-Process | ForEach-Object {
        try { [void][VP.W32PSAPI]::EmptyWorkingSet($_.Handle) } catch {}
    }
    try { [VP.W32SysInfo]::SetSystemInformation(80, [IntPtr]::Zero, 0) } catch {}
    try { [VP.W32SysInfo]::SetSystemInformation(81, [IntPtr]::Zero, 0) } catch {}
    try { [VP.W32SysInfo]::SetSystemInformation(82, [IntPtr]::Zero, 0) } catch {}
    try { [VP.W32SysInfo]::SetSystemInformation(39, [IntPtr]::Zero, 0) } catch {}
}
DoRound
Start-Sleep -Seconds 3
[GC]::Collect()
[GC]::WaitForPendingFinalizers()
DoRound
Start-Sleep -Seconds 3
[GC]::Collect()
[GC]::WaitForPendingFinalizers()
DoRound
Start-Sleep -Seconds 2
$after = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
Write-Output $after`;

// ============================================================================
// JVM 预热
// ============================================================================
async function preheatJvm(javaPath, maxMemMB) {
    if (ctx.jvm.preheatedJvm) return;
    try {
        const preheatArgs = [
            `-Xmx${Math.min(maxMemMB, 512)}M`,
            '-XX:+UseG1GC',
            '-XX:MaxGCPauseMillis=200',
            '-cp', '.',
            'java.lang.Object'
        ];
        const proc = spawn(javaPath, preheatArgs, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
        });
        proc.unref();
        ctx.jvm.preheatedJvm = { pid: proc.pid, javaPath, startTime: Date.now() };
        console.log(`[Preheat] JVM 预热进程已启动, PID: ${proc.pid}`);

        proc.on('exit', () => {
            ctx.jvm.preheatedJvm = null;
        });

        if (ctx.jvm.preheatTimer) clearTimeout(ctx.jvm.preheatTimer);
        ctx.jvm.preheatTimer = setTimeout(() => {
            if (ctx.jvm.preheatedJvm) {
                try { process.kill(ctx.jvm.preheatedJvm.pid); } catch(e) {}
                ctx.jvm.preheatedJvm = null;
                console.log('[Preheat] 预热进程已超时清理');
            }
        }, 300000);
    } catch(e) {
        console.log(`[Preheat] JVM 预热失败: ${e.message}`);
    }
}

// ============================================================================
// 性能优化
// ============================================================================
async function applyPerformanceOptimizations(pid) {
    if (!pid) return;

    let performanceBoost = true;
    try {
        const storePath = path.join(ctx.dirs.DATA_DIR, 'app-store.json');
        if (fs.existsSync(storePath)) {
            const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
            const launchStr = store['versepc_launch_settings'];
            if (launchStr) {
                const launchSettings = JSON.parse(launchStr);
                if (launchSettings.performanceBoost !== undefined) performanceBoost = launchSettings.performanceBoost;
            }
        }
    } catch (e) {}

    if (!performanceBoost) {
        try { os.setPriority(pid, os.constants.priority.PRIORITY_NORMAL); } catch(e) {}
        return;
    }

    try {
        os.setPriority(pid, os.constants.priority.PRIORITY_HIGH);
        console.log(`[Perf] 进程 ${pid} 优先级设为 HIGH`);
    } catch (e) {
        try {
            os.setPriority(pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
            console.log(`[Perf] 进程 ${pid} 优先级设为 ABOVE_NORMAL`);
        } catch (e2) {
            console.log(`[Perf] 设置进程优先级失败: ${e2.message}`);
        }
    }

    try {
        if (process.platform === 'win32') {
            const psScript = `
$proc = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($proc) {
    $cpu = Get-CimInstance Win32_Processor
    $coreCount = $cpu.NumberOfLogicalProcessors
    if ($coreCount -ge 8) {
        $pCores = [math]::Floor($coreCount * 0.75)
        $mask = [math]::Pow(2, $pCores) - 1
        $proc.ProcessorAffinity = $mask
    }
    try {
        $proc.PriorityClass = 'High'
    } catch {}
    try {
        $proc.IOPriority = [System.Diagnostics.ProcessPriorityClass]::High
    } catch {}
}
`.trim();
            const tmpScript = path.join(os.tmpdir(), `versepc_perf_${pid}.ps1`);
            fs.writeFileSync(tmpScript, psScript, 'utf8');
            exec(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpScript}"`, { timeout: 10000 }, (err) => {
                try { fs.unlinkSync(tmpScript); } catch (e) {}
                if (err) {
                    console.log(`[Perf] CPU亲和性设置失败: ${err.message}`);
                } else {
                    console.log(`[Perf] CPU亲和性和I/O优先级已优化 for PID ${pid}`);
                }
            });
        }
    } catch (e) {
        console.log(`[Perf] 性能优化脚本执行失败: ${e.message}`);
    }
}

// ============================================================================
// 退出码分析
// ============================================================================
function analyzeExitCode(code, versionId) {
    const analysis = { code, reason: '', suggestion: '', isCrash: false };

    if (code === 0) {
        analysis.reason = '正常退出';
        analysis.suggestion = '';
        return analysis;
    }

    if (code === 1) {
        analysis.isCrash = true;
        analysis.reason = '游戏异常退出（通用错误）';
        analysis.suggestion = '可能是模组冲突或Java参数问题，请查看崩溃日志';
    } else if (code === -1) {
        analysis.isCrash = true;
        analysis.reason = '游戏进程被强制终止';
        analysis.suggestion = '可能是内存不足或用户手动结束进程';
    } else if (code === 137) {
        analysis.isCrash = true;
        analysis.reason = '内存不足（OOM Killer）';
        analysis.suggestion = '请增加分配内存或减少模组数量';
    } else if (code === 134) {
        analysis.isCrash = true;
        analysis.reason = '程序异常终止（SIGABRT）';
        analysis.suggestion = '可能是JVM内部错误，尝试更新Java版本';
    } else if (code === 139) {
        analysis.isCrash = true;
        analysis.reason = '段错误（SIGSEGV）';
        analysis.suggestion = '可能是JVM崩溃或原生库问题，尝试更新显卡驱动和Java';
    } else if (code === -7 || code === -1073741819) {
        analysis.isCrash = true;
        analysis.reason = 'JVM 崩溃（访问违规）';
        analysis.suggestion = '可能是显卡驱动不兼容或内存损坏，请更新显卡驱动和Java版本，尝试减少分配内存';
    } else {
        analysis.isCrash = true;
        analysis.reason = `异常退出（退出码: ${code}）`;
        analysis.suggestion = '请查看崩溃日志获取更多信息';
    }

    const searchDirs = [];
    if (versionId && versions.resolveVersionIsolation(versionId)) {
        searchDirs.push(path.join(ctx.dirs.VERSIONS_DIR, versionId, 'crash-reports'));
    }
    const settings = versions.loadSettingsCached();
    searchDirs.push(path.join(settings.gameDir || ctx.dirs.DATA_DIR, 'crash-reports'));

    for (const dir of searchDirs) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt')).sort().reverse();
        if (files.length > 0) {
            try {
                const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');
                if (content.includes('java.lang.OutOfMemoryError')) {
                    analysis.reason = '内存不足（OutOfMemoryError）';
                    analysis.suggestion = '请在设置中增加最大内存分配';
                } else if (content.includes('UnsupportedClassVersionError') || content.includes('Unsupported major.minor version')) {
                    analysis.reason = 'Java版本不兼容';
                    analysis.suggestion = '游戏需要更高版本的Java，请在设置中更换Java版本';
                } else if (content.includes('java.lang.NoSuchMethodError') || content.includes('NoClassDefFoundError')) {
                    analysis.reason = '模组版本不兼容';
                    analysis.suggestion = '请检查模组是否与当前游戏版本和加载器版本匹配';
                } else if (content.includes('Unable to make protected final') || content.includes('does not export')) {
                    analysis.reason = 'Java版本过高导致模块访问限制';
                    analysis.suggestion = '请降级Java版本或使用Java 8/17启动';
                } else if (content.includes('ClassCastException') && content.includes('AppClassLoader') && content.includes('URLClassLoader')) {
                    analysis.reason = 'Java版本过高（旧版 launchwrapper 不兼容 Java 9+）';
                    analysis.suggestion = '该整合包需要 Java 8 才能运行。\n修复: 1)启动设置→Java→选择 JRE 8  2)启动器设置中关闭"自动选择高版本 Java"';
                } else if (content.includes('FMLCommonSetupEvent') || content.includes('fml')) {
                    analysis.reason = 'Forge/Fabric初始化失败';
                    analysis.suggestion = '请检查模组兼容性，尝试移除最近添加的模组';
                } else if (content.includes('ShaderCompilationException') || content.includes('shader')) {
                    analysis.reason = '着色器编译失败';
                    analysis.suggestion = '可能是光影模组问题，尝试移除光影模组';
                } else if (content.includes('Mixin') || content.includes('mixin')) {
                    analysis.reason = 'Mixin注入失败';
                    analysis.suggestion = '可能是模组与当前版本不兼容，检查Mixin相关模组';
                } else if (content.includes('OpenGL') || content.includes('GLFW')) {
                    analysis.reason = '图形驱动问题';
                    analysis.suggestion = '请更新显卡驱动或检查OpenGL支持';
                } else if (content.includes('Invalid paths argument') || content.includes('contained no existing paths')) {
                    analysis.reason = 'Forge核心库文件缺失（Invalid paths argument）';
                    analysis.suggestion = 'Forge安装不完整(fmlcore/javafmllanguage/mclanguage/lowcodelanguage缺失)。\n修复: 1)版本设置→文件修复 2)重新安装Forge 3)检查杀毒白名单';
                }
                analysis.crashLogFile = path.join(dir, files[0]);
                break;
            } catch (e) {}
        }
    }

    return analysis;
}

// ============================================================================
// 设置游戏语言
// ============================================================================
function setGameLanguage(gameDir, versionJson, settings) {
    if (!settings.autoSetChinese) {
        console.log('[Language] 自动设置中文已关闭，跳过语言设置');
        return;
    }

    let optionsPath = path.join(gameDir, 'options.txt');

    if (!fs.existsSync(optionsPath)) {
        const yosbrPath = path.join(gameDir, 'config', 'yosbr', 'options.txt');
        if (fs.existsSync(yosbrPath)) {
            console.log('[Language] 使用 Yosbr Mod 中的 options.txt');
            optionsPath = yosbrPath;
        } else {
            console.log('[Language] options.txt 不存在，将创建新文件');
        }
    }

    const releaseTime = versionJson.releaseTime || versionJson.time || '';
    let releaseDate = new Date(0);
    if (releaseTime) {
        try { releaseDate = new Date(releaseTime); } catch (e) {}
    }

    const mc1_1_date = new Date('2012-01-12');
    const mc1_11_date = new Date('2016-06-08');
    const mc1_13_date = new Date('2017-09-18');

    let requiredLang = 'zh_cn';

    if (releaseDate > new Date(0) && releaseDate <= mc1_1_date) {
        console.log('[Language] 1.0 及以下版本，无语言选项');
        return;
    } else if (releaseDate > mc1_1_date && releaseDate <= mc1_11_date) {
        requiredLang = 'zh_CN';
        console.log('[Language] 1.1~1.10 版本，使用 zh_CN 格式');
    } else if (releaseDate > mc1_11_date && releaseDate <= mc1_13_date) {
        requiredLang = 'zh_cn';
        console.log('[Language] 1.11~1.12 版本，使用 zh_cn 格式');
    } else {
        requiredLang = 'zh_cn';
        console.log('[Language] 1.13+ 版本，使用 zh_cn 格式');
    }

    let currentLang = 'none';
    let optionsContent = '';

    if (fs.existsSync(optionsPath)) {
        optionsContent = fs.readFileSync(optionsPath, 'utf-8');
        const langMatch = optionsContent.match(/^lang:(.+)$/m);
        if (langMatch) {
            currentLang = langMatch[1].trim();
        }
    }

    if (currentLang === requiredLang) {
        console.log(`[Language] 当前语言已为 ${requiredLang}，无需修改`);
    } else {
        const hasExistingSaves = fs.existsSync(path.join(gameDir, 'saves'));
        if (currentLang !== 'none' && hasExistingSaves) {
            console.log(`[Language] 已有存档且语言已设置 (${currentLang})，保留用户选择`);
        } else {
            if (optionsContent && currentLang !== 'none') {
                optionsContent = optionsContent.replace(/^lang:.+$/m, `lang:${requiredLang}`);
            } else if (optionsContent) {
                optionsContent += `\nlang:${requiredLang}`;
            } else {
                optionsContent = `lang:${requiredLang}\n`;
            }
            console.log(`[Language] 已将游戏语言设置为 ${requiredLang}`);
        }
    }

    const dir = path.dirname(optionsPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(optionsPath, optionsContent, 'utf-8');
}

// ============================================================================
// 应用窗口设置
// ============================================================================
function applyWindowSettings(gameDir, settings) {
    try {
        let optionsPath = path.join(gameDir, 'options.txt');
        const yosbrPath = path.join(gameDir, 'config', 'yosbr', 'options.txt');
        if (!fs.existsSync(optionsPath) && fs.existsSync(yosbrPath)) {
            optionsPath = yosbrPath;
        }

        let optionsContent = '';
        if (fs.existsSync(optionsPath)) {
            optionsContent = fs.readFileSync(optionsPath, 'utf-8');
        }

        if (!settings.fullscreen) {
            if (optionsContent.match(/^fullscreen:/m)) {
                optionsContent = optionsContent.replace(/^fullscreen:.+$/m, 'fullscreen:false');
            } else if (optionsContent) {
                optionsContent += '\nfullscreen:false';
            } else {
                optionsContent = 'fullscreen:false\n';
            }
            console.log('[Options] 已设置 fullscreen:false (窗口化模式)');
        } else {
            if (optionsContent.match(/^fullscreen:/m)) {
                optionsContent = optionsContent.replace(/^fullscreen:.+$/m, 'fullscreen:true');
            } else if (optionsContent) {
                optionsContent += '\nfullscreen:true';
            } else {
                optionsContent = 'fullscreen:true\n';
            }
            console.log('[Options] 已设置 fullscreen:true (全屏模式)');
        }

        const dir = path.dirname(optionsPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(optionsPath, optionsContent, 'utf-8');
    } catch (e) {
        console.error('[Options] 写入窗口设置失败:', e.message);
    }
}

// ============================================================================
// 构建启动参数
// ============================================================================
function buildLaunchArguments(versionJson, settings, account, versionId, customGameDir = null, externalVersionDir = null) {
    const actualVersionId = versionId || versionJson.id || 'unknown';
    const isExternal = !!externalVersionDir;
    let externalRoot = null;
    if (isExternal) {
        externalRoot = versions.findExternalRoot(externalVersionDir);
        if (!externalRoot) {
            externalRoot = path.dirname(path.dirname(externalVersionDir));
        }
    }

    const classpath = natives.buildClasspath(versionJson, actualVersionId, externalVersionDir);
    const nativesDir = natives.extractNatives(versionJson, actualVersionId, externalVersionDir);

    let gameDir;
    if (customGameDir) {
        gameDir = customGameDir;
    } else if (externalVersionDir) {
        gameDir = externalVersionDir;
    } else {
        if (versions.resolveVersionIsolation(actualVersionId)) {
            gameDir = path.join(ctx.dirs.VERSIONS_DIR, actualVersionId);
        } else {
            gameDir = settings.gameDir || ctx.dirs.DATA_DIR;
        }
    }
    if (!fs.existsSync(gameDir)) fs.mkdirSync(gameDir, { recursive: true });
    const subDirs = ['mods', 'resourcepacks', 'shaderpacks', 'saves', 'config', 'logs', 'crash-reports'];
    subDirs.forEach(d => {
        const p = path.join(gameDir, d);
        if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    });

    // === 复制 Forge log4j2.xml 到游戏目录 ===
    const forgeLog4jPath = path.join(ctx.dirs.VERSIONS_DIR, actualVersionId, 'log4j2.xml');
    if (fs.existsSync(forgeLog4jPath)) {
        const gameLog4jPath = path.join(gameDir, 'log4j2.xml');
        if (!fs.existsSync(gameLog4jPath)) {
            try {
                fs.copyFileSync(forgeLog4jPath, gameLog4jPath);
                console.log(`[Launch] log4j2.xml 已复制到游戏目录`);
            } catch (e) { console.error(`[Launch] log4j2.xml 复制失败: ${e.message}`); }
        }
    }

    let assetsRoot = isExternal && externalRoot ? path.join(externalRoot, 'assets') : ctx.dirs.ASSETS_DIR;
    const assetIndex = versionJson.assetIndex?.id || actualVersionId;
    if (versionJson.assetIndex?.virtual) {
        const virtualDir = path.join(assetsRoot, 'virtual', 'legacy');
        if (fs.existsSync(virtualDir)) {
            assetsRoot = virtualDir;
        }
    }
    const playerName = account?.username || 'Player';
    let uuid = account?.uuid;
    if (!uuid) {
        const md5 = crypto.createHash('md5').update('OfflinePlayer:' + playerName).digest();
        md5[6] = (md5[6] & 0x0f) | 0x30;
        md5[8] = (md5[8] & 0x3f) | 0x80;
        uuid = md5.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    }
    // 离线账户使用兼容格式的伪令牌，避免自定义 BootstrapLauncher 的 Base64 解析崩溃
    // 某些整合包（如 YUMC 系）的定制 BootstrapLauncher 会尝试 Base64 解码 accessToken
    const rawAccessToken = account?.accessToken || '';
    let accessToken;
    if (!rawAccessToken || rawAccessToken === '0') {
        // 生成一个合法的 Base64 编码字符串作为离线令牌
        // 格式: base64({"alg":"none","typ":"JWT"}.{"sub":"<uuid>","iss":"VersePC"}.offline)
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({
            sub: uuid,
            iss: 'VersePC',
            name: playerName,
            offline: true
        })).toString('base64url');
        accessToken = `${header}.${payload}.offline`;
    } else {
        accessToken = rawAccessToken;
    }
    const userType = account?.type === 'microsoft' ? 'msa' : (account?.type === 'legacy' ? 'legacy' : 'mojang');

    const mainJarPath = versions.findMainJar(versionJson, actualVersionId, externalVersionDir) || path.join(ctx.dirs.VERSIONS_DIR, actualVersionId, actualVersionId + '.jar');

    const variables = {
        auth_player_name: playerName,
        version_name: actualVersionId,
        game_directory: gameDir,
        assets_root: assetsRoot,
        assets_index_name: assetIndex,
        auth_uuid: uuid,
        auth_access_token: accessToken,
        user_type: userType,
        version_type: `VersePC - ${actualVersionId}`,
        resolution_width: settings.resolution?.split('x')[0] || '854',
        resolution_height: settings.resolution?.split('x')[1] || '480',
        library_directory: isExternal && externalRoot ? path.join(externalRoot, 'libraries') : ctx.dirs.LIBRARIES_DIR,
        classpath_separator: process.platform === 'win32' ? ';' : ':',
        natives_directory: nativesDir,
        launcher_name: 'VersePC',
        launcher_version: '1.0.0',
        classpath: classpath,
        clientid: uuid,
        auth_xuid: uuid,
        quickPlayPath: path.join(gameDir, 'quickPlay'),
        quickPlaySingleplayer: '',
        quickPlayMultiplayer: '',
        quickPlayRealms: ''
    };

    const jvmArgs = [];

    let maxMemMB = settings.maxMemory || 4096;
    try {
        const storePath = path.join(ctx.dirs.DATA_DIR, 'app-store.json');
        if (fs.existsSync(storePath)) {
            const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
            const launchStr = store['versepc_launch_settings'];
            if (launchStr) {
                const launchSettings = JSON.parse(launchStr);
                const memMode = launchSettings.memoryMode || 'auto';
                if (memMode === 'auto') {
                    const totalMB = Math.floor(os.totalmem() / 1024 / 1024);
                    const freeMB = Math.floor(os.freemem() / 1024 / 1024);
                    let autoMB;
                    if (totalMB <= 4096) autoMB = Math.min(1024, totalMB - 1024);
                    else if (totalMB <= 8192) autoMB = Math.floor(totalMB * 0.55);
                    else if (totalMB <= 16384) autoMB = Math.floor(totalMB * 0.6);
                    else autoMB = Math.floor(totalMB * 0.65);
                    if (freeMB < 1024 && totalMB > 4096) autoMB = Math.min(autoMB, freeMB + 512);
                    autoMB = Math.max(512, Math.min(autoMB, totalMB - 1536));
                    autoMB = Math.max(autoMB, 512);
                    autoMB = Math.min(autoMB, 32768);
                    autoMB = Math.floor(autoMB / 256) * 256;
                    maxMemMB = autoMB;
                } else if (memMode === 'custom') {
                    maxMemMB = parseInt(launchSettings.memoryValue, 10) || 4096;
                }
            }
        }
    } catch (e) {}
    const minMemMB = Math.min(1024, maxMemMB);
    jvmArgs.push(`-Xmn${Math.floor(maxMemMB * 0.15)}M`, `-Xmx${maxMemMB}M`, `-Xms${minMemMB}M`);
    jvmArgs.push('-Dlog4j2.formatMsgNoLookups=true');
    jvmArgs.push('-Djava.net.preferIPv4Stack=true');

    const hasUserGc = jvmArgs.some(a => /^-XX:\+?Use/.test(a) || /-XX:Use/.test(a));
    if (!hasUserGc) {
        let modCount = 0;
        try {
            const versionDir = path.join(ctx.dirs.VERSIONS_DIR, actualVersionId || versionId);
            const modsDir = path.join(versionDir, 'mods');
            if (fs.existsSync(modsDir)) {
                modCount = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar') && !f.endsWith('.jar.disabled')).length;
            }
        } catch(e) {}

        // Default to G1GC. ZGC/ShenandoahGC can cause stutter in Forge modpacks
        // because they behave poorly when mods allocate many short-lived objects.
        if (maxMemMB <= 1024) {
            jvmArgs.push('-XX:+UseSerialGC');
        } else {
            jvmArgs.push('-XX:+UseG1GC', '-XX:MaxGCPauseMillis=200');
            if (maxMemMB >= 4096) {
                jvmArgs.push('-XX:G1HeapRegionSize=' + (maxMemMB >= 8192 ? '32m' : '16m'));
            }
            if (modCount > 50) {
                jvmArgs.push('-XX:G1MixedGCCountTarget=16', '-XX:G1HeapWastePercent=5');
            }
        }
        jvmArgs.push('-XX:+DisableExplicitGC');
    }
    const hasUserMemOpt = jvmArgs.some(a => a.includes('StringDeduplication') || a.includes('CompressedClassSpaceSize') || a.includes('MetaspaceSize'));
    if (!hasUserMemOpt && maxMemMB >= 2048) {
        const usingG1 = jvmArgs.some(a => a.includes('UseG1GC'));
        if (usingG1) {
            jvmArgs.push('-XX:+UseStringDeduplication');
        }
        jvmArgs.push('-XX:CompressedClassSpaceSize=256m', '-XX:MaxMetaspaceSize=512m');
    }

    if (!jvmArgs.some(a => a.includes('preferIPv4Stack') || a.includes('preferIPv6Stack'))) {
        jvmArgs.push('-Djava.net.preferIPv4Stack=true');
        jvmArgs.push('-Djava.net.preferIPv4Addresses=true');
    }

    if (settings.javaArgs && settings.javaArgs.trim()) {
        const userArgs = settings.javaArgs.split(' ').filter(a => a);
        for (const arg of userArgs) {
            const baseArg = arg.split('=')[0];
            const hasConflict = jvmArgs.some(existing => existing.startsWith(baseArg));
            const gcPatterns = ['-XX:\\+Use', '-XX:-Use'];
            const isGcArg = gcPatterns.some(p => new RegExp(`^${p}`).test(arg));
            let hasGcConflict = false;
            if (isGcArg) {
                hasGcConflict = jvmArgs.some(existing =>
                    gcPatterns.some(p => new RegExp(`^${p}`).test(existing))
                );
                if (hasGcConflict) continue;
            }
            if (!hasConflict) jvmArgs.push(arg);
        }
    }

    const cdsDir = path.join(ctx.dirs.DATA_DIR, 'cds');
    const cdsArchive = path.join(cdsDir, `${actualVersionId || versionId}.jsa`);
    const cdsClassList = path.join(cdsDir, `${actualVersionId || versionId}.cls`);
    const selectedJavaPath = java.selectJavaForVersion(actualVersionId, settings, versionJson) || 'java';
    const javaMajorVer = java.getJavaMajorVersion(selectedJavaPath);
    const enableCds = settings.enableCds !== false && javaMajorVer >= 8;

    if (enableCds && fs.existsSync(cdsArchive)) {
        try {
            const stat = fs.statSync(cdsArchive);
            if (stat.size > 1024) {
                jvmArgs.push(`-Xshare:on`, `-XX:SharedArchiveFile=${cdsArchive}`);
                console.log(`[CDS] 使用共享归档: ${cdsArchive} (${Math.round(stat.size/1024)}KB)`);
            }
        } catch (e) {
            console.log(`[CDS] 归档文件不可用: ${e.message}`);
        }
    }

    const mainClass = versionJson.mainClass || 'net.minecraft.client.main.Main';
    const gameArgsForDetection = versionJson.arguments?.game || [];
    const hasForgeGameArg = gameArgsForDetection.some(a => typeof a === 'string' && a === 'forgeclient') ||
                             gameArgsForDetection.some(a => typeof a === 'string' && a === 'forge_server');
    const isForge = mainClass.includes('modlauncher') || mainClass.includes('fml') || mainClass.includes('forge') ||
                    mainClass.includes('bootstraplauncher') || mainClass.includes('BootstrapLauncher') ||
                    hasForgeGameArg;
    const isNeoForge = mainClass.includes('neoforged') || mainClass.includes('neoforge') ||
                       gameArgsForDetection.some(a => typeof a === 'string' && a === '--fml.neoForgeVersion') ||
                       (versionJson.libraries || []).some(l => l.name && l.name.startsWith('net.neoforged.fancymodloader:loader'));
    const isFabric = mainClass.includes('fabricmc') || mainClass.includes('knot');

    // 离线账户禁用 Realms/Microsoft API 认证，避免 "Failed to parse into SignedJWT" 错误
    const isOfflineAccount = !rawAccessToken || rawAccessToken === '0' || account?.type === 'offline';
    if (isOfflineAccount) {
        jvmArgs.push('-Dminecraft.api.auth=off', '-Dminecraft.api.env=local');
    }

    if (isForge || isNeoForge) {
        if (!jvmArgs.some(a => a.includes('minecraft.client.jar'))) {
            jvmArgs.push(`-Dminecraft.client.jar=${mainJarPath}`);
        }
        /*
        [CRITICAL] 禁用 Forge/NeoForge 早期加载窗口（Early Loading Screen）
        ====================================================================
        【问题原理】
          新版 Forge（26.x）和 NeoForge 引入了 "Early Loading Screen" 功能：
          游戏启动时，Forge 的 earlydisplay 模块会先创建一个红色/灰色的加载窗口，
          显示模组加载进度，然后等 Minecraft 主窗口创建后再切换过去。

          正常流程：
            1. JVM 启动 → earlydisplay 创建红色加载窗口
            2. Minecraft 初始化 → 创建主游戏窗口
            3. earlydisplay 检测到主窗口 → 自动关闭加载窗口
            4. 用户只看到一个游戏窗口

          异常流程（某些硬件/驱动/版本组合下）：
            1. JVM 启动 → earlydisplay 创建红色加载窗口
            2. Minecraft 初始化 → 创建主游戏窗口
            3. earlydisplay 未检测到主窗口 → 加载窗口不关闭
            4. 用户看到两个窗口：一个红色加载窗口 + 一个正常游戏窗口

          红色窗口没有 MOJANG logo，只有纯色背景，这是早期加载阶段的画面。
          它不会影响游戏功能，但用户体验很差。

        【修复原理】
          -Dfml.earlyLoadingWindow=false 是 Forge/NeoForge 支持的 JVM 参数，
          告诉 earlydisplay 模块不要创建早期加载窗口，直接等主窗口出现。
          这样从一开始就只有一个窗口。

        【注意】
          这个参数由 Forge/NeoForge 的 BootstrapLauncher 解析，
          不是 Minecraft 原生参数。它只在 Forge/NeoForge 环境下生效。

        [AI-AUTOGEN-WARNING] 请勿删除此 JVM 参数，否则 Forge/NeoForge 启动会出现双窗口。
        */
        if (!jvmArgs.some(a => a.includes('earlyLoadingWindow'))) {
            jvmArgs.push('-Dfml.earlyLoadingWindow=false');
        }
    }

    // JPMS module flags (--add-exports/--add-opens) only work on Java 9+
    // Java 8 will crash with "Unrecognized option: --add-exports"
    if ((isForge || isNeoForge) && javaMajorVer >= 9) {
        const jpmsFlags = [
            '--add-exports java.base/sun.security.util=ALL-UNNAMED',
            '--add-exports java.base/sun.security.x509=ALL-UNNAMED',
            '--add-opens java.base/java.lang=ALL-UNNAMED',
            '--add-opens java.base/java.lang.invoke=ALL-UNNAMED',
            '--add-opens java.base/java.lang.reflect=ALL-UNNAMED',
            '--add-opens java.base/java.io=ALL-UNNAMED',
            '--add-opens java.base/java.nio=ALL-UNNAMED',
            '--add-opens java.base/java.util=ALL-UNNAMED',
            '--add-opens java.base/java.util.concurrent=ALL-UNNAMED',
            '--add-opens java.base/java.util.concurrent.atomic=ALL-UNNAMED',
            '--add-opens java.base/java.util.concurrent.locks=ALL-UNNAMED',
            '--add-opens java.base/sun.nio.ch=ALL-UNNAMED',
            '--add-opens java.base/sun.nio.fs=ALL-UNNAMED',
            '--add-opens java.base/sun.security.action=ALL-UNNAMED',
            '--add-opens java.base/sun.security.provider=ALL-UNNAMED',
            '--add-opens java.base/jdk.internal.loader=ALL-UNNAMED',
            '--add-opens java.base/jdk.internal.ref=ALL-UNNAMED',
            '--add-opens java.base/jdk.internal.reflect=ALL-UNNAMED',
            '--add-opens java.base/jdk.internal.math=ALL-UNNAMED',
            '--add-opens java.base/jdk.internal.misc=ALL-UNNAMED',
            '--add-opens java.base/jdk.internal.util=ALL-UNNAMED',
            '--add-opens java.management/sun.management=ALL-UNNAMED',
            '--add-opens java.management/com.sun.jmx.mbeanserver=ALL-UNNAMED',
            '--add-opens jdk.management/com.sun.management.internal=ALL-UNNAMED',
            '--add-opens java.rmi/sun.rmi.registry=ALL-UNNAMED',
            '--add-opens java.rmi/sun.rmi.server=ALL-UNNAMED',
            '--add-opens java.desktop/java.awt=ALL-UNNAMED',
            '--add-opens java.desktop/java.awt.font=ALL-UNNAMED',
            '--add-opens java.desktop/java.awt.peer=ALL-UNNAMED',
            '--add-opens java.desktop/javax.swing=ALL-UNNAMED',
            '--add-opens java.desktop/sun.awt=ALL-UNNAMED',
            '--add-opens java.desktop/sun.java2d=ALL-UNNAMED',
            '--add-opens java.desktop/sun.font=ALL-UNNAMED',
            '--add-opens jdk.unsupported/sun.misc=ALL-UNNAMED'
        ];
        for (const combined of jpmsFlags) {
            const spaceIdx = combined.indexOf(' ');
            const flag = combined.substring(0, spaceIdx);
            const value = combined.substring(spaceIdx + 1);
            if (!jvmArgs.some((a, idx) => a === flag && jvmArgs[idx + 1] === value)) {
                jvmArgs.push(flag, value);
            }
        }
    }

    // Collect JVM args from standard `jvm` and Fabric/NeoForge non-standard groups (`default-user-jvm`, etc.)
    const jvmArgSources = [];
    if (versionJson.arguments?.jvm) jvmArgSources.push(...versionJson.arguments.jvm);
    // Fabric meta API v2 uses "default-user-jvm" group
    if (versionJson.arguments?.['default-user-jvm']) jvmArgSources.push(...versionJson.arguments['default-user-jvm']);
    if (jvmArgSources.length > 0) {
        for (let i = 0; i < jvmArgSources.length; i++) {
            const arg = jvmArgSources[i];
            if (typeof arg === 'string') {
                const replaced = utils.replaceVariables(arg, variables);
                // 跳过 -cp 和 classpath 字符串，始终使用我们自己的完整 classpath
                // Forge JSON 自带的 classpath 只有引导 JAR，不含所有库，会导致 ModuleLayer 启动失败
                if (replaced === '-cp') {
                    continue;
                }
                // 如果上一个被跳过的参数是 -cp，这个字符串就是 classpath 值，也跳过
                if (i > 0 && typeof jvmArgSources[i - 1] === 'string' && utils.replaceVariables(jvmArgSources[i - 1], variables) === '-cp') {
                    continue;
                }
                const isMultiValueFlag = replaced === '--add-opens' || replaced === '--add-exports' ||
                    replaced === '--add-reads' || replaced === '--add-modules' ||
                    replaced === '--patch-module' || replaced === '-javaagent';
                if (isMultiValueFlag) {
                    jvmArgs.push(replaced);
                    if (i + 1 < jvmArgSources.length && typeof jvmArgSources[i + 1] === 'string') {
                        const peeked = jvmArgSources[i + 1];
                        if (!peeked.startsWith('-')) {
                            i++;
                            jvmArgs.push(utils.replaceVariables(peeked, variables));
                        }
                    }
                } else {
                    const gcPatterns = ['-XX:\\+Use', '-XX:-Use'];
                    const isGcArg = gcPatterns.some(p => new RegExp(`^${p}`).test(replaced));
                    if (isGcArg && natives.hasGarbageCollectorArg(jvmArgs)) {
                        console.log(`[Launch] 跳过重复GC参数: ${replaced}`);
                        continue;
                    }
                    if (replaced.startsWith('-Xmx') || replaced.startsWith('-Xms')) {
                        if (!jvmArgs.some(e => e.startsWith(replaced.substring(0, 4)))) {
                            jvmArgs.push(replaced);
                        }
                    } else if (!jvmArgs.some(existing => existing === replaced)) {
                        jvmArgs.push(replaced);
                    }
                }
            } else if (arg && (arg.value !== undefined)) {
                const rulesMatch = !arg.rules || versions.evaluateRules(arg.rules, { hasCustomResolution: !!settings.resolution });
                if (rulesMatch) {
                    if (typeof arg.value === 'string') {
                        const replaced = utils.replaceVariables(arg.value, variables);
                        const isMultiValueFlag2 = replaced === '--add-opens' || replaced === '--add-exports' ||
                            replaced === '--add-reads' || replaced === '--add-modules' ||
                            replaced === '--patch-module' || replaced === '-javaagent';
                        if (isMultiValueFlag2) {
                            jvmArgs.push(replaced);
                        } else {
                            const gcPatterns = ['-XX:\\+Use', '-XX:-Use'];
                            const isGcArg = gcPatterns.some(p => new RegExp(`^${p}`).test(replaced));
                            if (isGcArg && natives.hasGarbageCollectorArg(jvmArgs)) continue;
                            if (!jvmArgs.some(existing => existing === replaced)) {
                                jvmArgs.push(replaced);
                            }
                        }
                    } else if (Array.isArray(arg.value)) {
                        for (const v of arg.value) {
                            const replaced = utils.replaceVariables(String(v), variables);
                            const isMultiValueFlag = replaced === '--add-opens' || replaced === '--add-exports' ||
                                replaced === '--add-reads' || replaced === '--add-modules' ||
                                replaced === '--patch-module' || replaced === '-javaagent';
                            if (isMultiValueFlag) {
                                jvmArgs.push(replaced);
                            } else {
                                const gcPatterns = ['-XX:\\+Use', '-XX:-Use'];
                                const isGcArg = gcPatterns.some(p => new RegExp(`^${p}`).test(replaced));
                                if (isGcArg && natives.hasGarbageCollectorArg(jvmArgs)) continue;
                                if (!jvmArgs.some(existing => existing === replaced)) {
                                    jvmArgs.push(replaced);
                                }
                            }
                        }
                    }
                }
            }
        }
    } else {
        if (!jvmArgs.some(a => a.includes('minecraft.launcher.brand'))) {
            jvmArgs.push('-Dminecraft.launcher.brand=VersePC');
            jvmArgs.push(`-Dminecraft.launcher.version=${ctx.pkgVersion}`);
        }
        if (!jvmArgs.some(a => a.includes('log4j2.formatMsgNoLookups'))) {
            jvmArgs.push('-Dlog4j2.formatMsgNoLookups=true');
        }
    }

    // 始终固定添加 java.library.path，不依赖 JSON 参数中的变量替换
    // 整合包的版本JSON可能缺少此参数或变量替换失败，导致 UnsatisfiedLinkError
    const hasJvmLibraryPath = jvmArgs.some(a => typeof a === 'string' && a.includes('java.library.path'));
    if (!hasJvmLibraryPath) {
        jvmArgs.push(`-Djava.library.path=${nativesDir}`);
        console.log(`[Launch] 补充 java.library.path=${nativesDir}`);
    } else {
        const existingIdx = jvmArgs.findIndex(a => typeof a === 'string' && a.includes('java.library.path'));
        if (existingIdx >= 0) {
            const val = jvmArgs[existingIdx];
            if (val.includes('${natives_directory}') || val.includes('$natives_directory')) {
                jvmArgs[existingIdx] = val.replace(/\$\{?natives_directory\}?/g, nativesDir);
                console.log(`[Launch] 修复未替换的 natives_directory 变量 -> ${nativesDir}`);
            }
        }
    }
    if (!jvmArgs.some(a => a.includes('minecraft.launcher.brand'))) {
        jvmArgs.push('-Dminecraft.launcher.brand=VersePC');
        jvmArgs.push(`-Dminecraft.launcher.version=${ctx.pkgVersion}`);
    }
    if (!jvmArgs.some(a => a.includes('log4j2.formatMsgNoLookups'))) {
        jvmArgs.push('-Dlog4j2.formatMsgNoLookups=true');
    }

    if (process.platform === 'darwin') {
        jvmArgs.unshift('-XstartOnFirstThread');
    }

    // 始终使用我们自己的完整 classpath（用系统分隔符 join），跳过 JSON 自带的残缺 classpath
    const cpSeparator = process.platform === 'win32' ? ';' : ':';
    const classpathStr = Array.isArray(classpath) ? classpath.join(cpSeparator) : classpath;
    jvmArgs.push('-cp', classpathStr);

    if (account?.type === 'thirdparty' && account?.serverUrl) {
        const aiDir3 = path.join(ctx.dirs.DATA_DIR, 'authlib-injector');
        const aiFiles2 = fs.existsSync(aiDir3) ? fs.readdirSync(aiDir3).filter(f => f.endsWith('.jar')).sort() : [];
        if (aiFiles2.length > 0) {
            const aiJarPath = path.join(aiDir3, aiFiles2[aiFiles2.length - 1]);
            let serverUrlArg = account.serverUrl;
            if (serverUrlArg.includes('@@@') || serverUrlArg.includes('@@')) {
                serverUrlArg = serverUrlArg.split('@@@')[0].split('@@')[0];
                console.log(`[Launch] Cleaned serverUrl: ${account.serverUrl} -> ${serverUrlArg}`);
            }
            const javaAgentIdx = jvmArgs.findIndex(a => a.startsWith('-javaagent:'));
            if (javaAgentIdx === -1) {
                jvmArgs.unshift(`-javaagent:${aiJarPath}=${serverUrlArg}`);
            }
            console.log(`[Launch] authlib-injector: ${aiJarPath} -> ${serverUrlArg}`);
        } else {
            console.log('[Launch] authlib-injector not found');
        }
    }

    if (versionJson.logging?.client?.argument && versionJson.logging?.client?.file?.id) {
        const logConfigPath = path.join(ctx.dirs.VERSIONS_DIR, actualVersionId, versionJson.logging.client.file.id);
        if (!fs.existsSync(logConfigPath)) {
            const logDir = path.join(ctx.dirs.VERSIONS_DIR, actualVersionId);
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
            if (versionJson.logging.client.file.url) {
                try {
                    http.downloadFileSync(versionJson.logging.client.file.url, logConfigPath);
                } catch (e) {
                    console.error('[Launch] log4j config download failed:', e.message);
                }
            }
        }
        if (fs.existsSync(logConfigPath)) {
            const logArg = versionJson.logging.client.argument
                .replace(/\$\{path\}/g, logConfigPath);
            if (!jvmArgs.some(a => a.includes('log4j2') || a.includes('Log4j') || a.includes('log4j.configurationFile'))) {
                jvmArgs.push(logArg);
            }
        }
    }

    jvmArgs.push(mainClass);

    const gameArgs = [];

    // Collect game args from standard `game` and Fabric/NeoForge non-standard groups (`default-user-game`, etc.)
    const gameArgSources = [];
    if (versionJson.arguments?.game) gameArgSources.push(...versionJson.arguments.game);
    // Fabric meta API v2 uses "default-user-game" group
    if (versionJson.arguments?.['default-user-game']) gameArgSources.push(...versionJson.arguments['default-user-game']);
    if (gameArgSources.length > 0) {
        for (const arg of gameArgSources) {
            if (typeof arg === 'string') {
                gameArgs.push(utils.replaceVariables(arg, variables));
            } else if (arg && (arg.value !== undefined)) {
                const rulesMatch = !arg.rules || versions.evaluateRules(arg.rules, { hasCustomResolution: !!settings.resolution });
                if (rulesMatch) {
                    if (typeof arg.value === 'string') {
                        gameArgs.push(utils.replaceVariables(arg.value, variables));
                    } else if (Array.isArray(arg.value)) {
                        gameArgs.push(...arg.value.map(v => utils.replaceVariables(String(v), variables)));
                    }
                }
            }
        }
    }

    if (versionJson.minecraftArguments) {
        const template = versionJson.minecraftArguments;
        gameArgs.push(...utils.replaceVariables(template, variables).split(' ').filter(a => a));
    }

    if (settings.fullscreen) {
        gameArgs.push('--fullscreen');
    } else {
        const resW = settings.resolution?.split('x')[0] || '854';
        const resH = settings.resolution?.split('x')[1] || '480';
        if (!gameArgs.some(a => a === '--width')) gameArgs.push('--width', resW);
        if (!gameArgs.some(a => a === '--height')) gameArgs.push('--height', resH);
    }

    let versionTypeIdx = gameArgs.indexOf('--versionType');
    if (versionTypeIdx === -1) {
        const ci = (settings.customInfo || '').trim();
        const wt = (settings.windowTitle || '').trim();
        gameArgs.push('--versionType', wt || ci || 'VersePC');
    }

    if (!gameArgs.some((a, i) => a === '--gameDir' && i + 1 < gameArgs.length)) {
        gameArgs.push('--gameDir', gameDir);
        console.log(`[Launch] 补充 --gameDir ${gameDir}`);
    } else {
        const gdi = gameArgs.indexOf('--gameDir');
        if (gdi !== -1 && gdi + 1 < gameArgs.length) {
            const existingGd = gameArgs[gdi + 1];
            if (existingGd.includes('${') || existingGd.includes('$game_directory')) {
                gameArgs[gdi + 1] = gameDir;
                console.log(`[Launch] 修复未替换的 gameDir 变量 -> ${gameDir}`);
            }
        }
    }

    const finalGameArgs = versions.deduplicateGameArgs(gameArgs);

    console.log(`[Launch] Args built: ${jvmArgs.length} JVM, ${finalGameArgs.length} game (${gameArgs.length - finalGameArgs.length} duplicates removed)`);
    console.log(`[Launch] mainClass: ${mainClass}`);
    console.log(`[Launch] classpath len: ${classpath.length}`);
    console.log(`[Launch] gameDir: ${gameDir}`);
    console.log(`[Launch] nativesDir: ${nativesDir}`);
    console.log(`[Launch] loader: ${isForge ? 'Forge' : isNeoForge ? 'NeoForge' : isFabric ? 'Fabric' : 'Vanilla'}`);
    return { args: [...jvmArgs, ...finalGameArgs], maxMemMB };
}

// ============================================================================
// 启动游戏（入口）
// ============================================================================
async function launchGame(versionId, settings, account, checkOnly = false) {
    try {
    let externalVersionDir = null;
    const cleanVersionId = versionId.replace(/ \[外部\d*\]/, '');

    const externalFolders = versions.loadExternalFolders();
    for (const folder of externalFolders) {
        if (!fs.existsSync(folder.path)) continue;
        const extVersions = versions.scanExternalFolder(folder.path);
        const extVer = extVersions.find(v => v.id === cleanVersionId || v.id === versionId ||
            path.basename(v.externalVersionDir || '') === cleanVersionId ||
            path.basename(v.externalVersionDir || '') === versionId);
        if (extVer) {
            externalVersionDir = extVer.externalVersionDir;
            break;
        }
    }

    console.log(`[LaunchGame] 版本: ${versionId}, 外部目录: ${externalVersionDir || '无'}`);

    const versionDirPath = externalVersionDir || path.join(ctx.dirs.VERSIONS_DIR, cleanVersionId);
    if (versionDirPath.includes('!') || versionDirPath.includes(';')) {
        return { success: false, error: '版本路径包含非法字符' };
    }

    if (cleanVersionId.includes('!') || cleanVersionId.includes(';')) {
        return { success: false, error: '版本路径包含非法字符（! 或 ;），可能导致启动失败，请修改版本名称后重试' };
    }

    let actualGameDir;
    if (externalVersionDir) {
        actualGameDir = externalVersionDir;
    } else {
        const settingsVersionId = cleanVersionId;
        const effectiveIsolation = versions.resolveVersionIsolation(settingsVersionId);
        if (effectiveIsolation) {
            actualGameDir = path.join(ctx.dirs.VERSIONS_DIR, cleanVersionId);
        } else {
            actualGameDir = settings.gameDir || ctx.dirs.DATA_DIR;
        }
    }
    const gameDirBasename = path.basename(actualGameDir);
    if (gameDirBasename.includes('!') || gameDirBasename.includes(';')) {
        return { success: false, error: `游戏路径中不可包含 ! 或 ;（${actualGameDir}）` };
    }
    const javaPathToCheck = settings.javaPath || '';
    if (javaPathToCheck) {
        const javaDir = path.dirname(javaPathToCheck);
        if (javaDir.includes('!') || javaDir.includes(';')) {
            return { success: false, error: `Java路径中不可包含 ! 或 ;（${javaPathToCheck}）` };
        }
    }

    const versionJson = versions.resolveVersionJson(cleanVersionId, externalVersionDir);
    if (!versionJson) {
        return { success: false, error: `找不到版本 ${versionId} 的JSON文件`, details: { versionId, externalVersionDir } };
    }

    if (externalVersionDir && !versionJson.inheritsFrom) {
        const m = cleanVersionId.match(/^(\d+\.\d+(?:\.\d+)?)/);
        if (m) {
            const parentVer = m[1];
            versionJson.inheritsFrom = parentVer;
            try {
                const jp = versions.findVersionJson(externalVersionDir);
                if (jp) {
                    const raw = JSON.parse(fs.readFileSync(jp, 'utf-8'));
                    if (!raw.inheritsFrom) {
                        raw.inheritsFrom = parentVer;
                        fs.writeFileSync(jp, JSON.stringify(raw, null, 2));
                        console.log(`[LaunchGame] 已修正 inheritsFrom: ${parentVer}`);
                    }
                }
            } catch (e) {
                console.warn(`[LaunchGame] 写回 inheritsFrom 失败: ${e.message}`);
            }
        }
    }

    console.log(`[LaunchGame] JSON已解析, mainClass: ${versionJson.mainClass}, inheritsFrom: ${versionJson.inheritsFrom}`);

    // 启动前验证Natives完整性，缺失时自动重新解压
    {
        const nativesDir = natives.getNativesFolder(cleanVersionId);
        const criticalNatives = ['lwjgl.dll', 'lwjgl_opengl.dll', 'lwjgl_glfw.dll', 'lwjgl_stb.dll', 'lwjgl_tinyfd.dll',
            'openal.dll', 'jinput-dx8.dll', 'jinput-raw.dll'];
        const missingNatives = criticalNatives.filter(n => {
            if (process.platform === 'win32') return !fs.existsSync(path.join(nativesDir, n));
            if (process.platform === 'darwin') return !fs.existsSync(path.join(nativesDir, n.replace('.dll', '.dylib')));
            return !fs.existsSync(path.join(nativesDir, n.replace('.dll', '.so')));
        });
        if (missingNatives.length > 0 && missingNatives.length < 6) {
            console.log(`[LaunchGame] 检测到 ${missingNatives.length} 个缺失Natives: ${missingNatives.join(', ')}，尝试重新解压...`);
            try {
                natives.extractNatives(versionJson, cleanVersionId, externalVersionDir);
                const recheckMissing = criticalNatives.filter(n => {
                    if (process.platform === 'win32') return !fs.existsSync(path.join(nativesDir, n));
                    if (process.platform === 'darwin') return !fs.existsSync(path.join(nativesDir, n.replace('.dll', '.dylib')));
                    return !fs.existsSync(path.join(nativesDir, n.replace('.dll', '.so')));
                });
                if (recheckMissing.length > 0) {
                    console.warn(`[LaunchGame] 重新解压后仍有 ${recheckMissing.length} 个Natives缺失: ${recheckMissing.join(', ')}`);
                } else {
                    console.log(`[LaunchGame] Natives重新解压成功`);
                }
            } catch (e) {
                console.error(`[LaunchGame] Natives重新解压失败: ${e.message}`);
            }
        } else if (missingNatives.length >= 6) {
            console.warn(`[LaunchGame] ⚠ 大量Natives缺失(${missingNatives.length}个)，可能影响游戏启动`);
        }
    }

    let depCheck = await dependencies.checkDependencies(cleanVersionId, settings, externalVersionDir);

    const scanLibsRecursive = (verId, visited = new Set()) => {
        if (visited.has(verId)) return [];
        visited.add(verId);
        let jsonPath = path.join(ctx.dirs.VERSIONS_DIR, verId, `${verId}.json`);
        if (!fs.existsSync(jsonPath) && externalVersionDir) {
            const extRoot = versions.findExternalRoot(externalVersionDir);
            if (extRoot) {
                const extJson = path.join(extRoot, 'versions', verId, `${verId}.json`);
                if (fs.existsSync(extJson)) jsonPath = extJson;
            }
            if (!fs.existsSync(jsonPath)) {
                const dirJson = path.join(path.dirname(externalVersionDir), verId, `${verId}.json`);
                if (fs.existsSync(dirJson)) jsonPath = dirJson;
            }
        }
        if (!fs.existsSync(jsonPath)) return [];
        let data;
        try { data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')); } catch (e) { return []; }
        const extLibBase = externalVersionDir ? versions.findExternalRoot(externalVersionDir) : null;
        const libs = (data.libraries || []).map(l => {
            if (l.rules && !versions.evaluateRules(l.rules)) return null;
            if (l.natives) return null;
            if (l.downloads?.artifact?.path) {
                const relPath = l.downloads.artifact.path;
                const localPath = path.join(ctx.dirs.LIBRARIES_DIR, relPath);
                if (fs.existsSync(localPath)) return { name: l.name, path: localPath, url: l.downloads.artifact.url, sha1: l.downloads.artifact.sha1, size: l.downloads.artifact.size, maven: null };
                if (extLibBase) {
                    const extPath = path.join(extLibBase, 'libraries', relPath);
                    if (fs.existsSync(extPath)) return { name: l.name, path: extPath, url: l.downloads.artifact.url, sha1: l.downloads.artifact.sha1, size: l.downloads.artifact.size, maven: null };
                }
                return { name: l.name, path: localPath, url: l.downloads.artifact.url, sha1: l.downloads.artifact.sha1, size: l.downloads.artifact.size, maven: null };
            }
            if (l.name) {
                const p = l.name.split(':');
                if (p.length >= 3) {
                    const gp = p[0].replace(/\./g, path.sep);
                    const cl = p.length >= 4 ? `-${p[3]}` : '';
                    const jn = `${p[1]}-${p[2]}${cl}.jar`;
                    const mavenRelPath = path.join(gp, p[1], p[2], jn);
                    const localMavenPath = path.join(ctx.dirs.LIBRARIES_DIR, mavenRelPath);
                    if (fs.existsSync(localMavenPath)) return { name: l.name, path: localMavenPath, url: l.url || '', sha1: '', size: 0, maven: { group: p[0], artifact: p[1], version: p[2], classifier: p[3] || '' } };
                    if (extLibBase) {
                        const extMavenPath = path.join(extLibBase, 'libraries', mavenRelPath);
                        if (fs.existsSync(extMavenPath)) return { name: l.name, path: extMavenPath, url: l.url || '', sha1: '', size: 0, maven: { group: p[0], artifact: p[1], version: p[2], classifier: p[3] || '' } };
                    }
                    return { name: l.name, path: localMavenPath, url: l.url || '', sha1: '', size: 0, maven: { group: p[0], artifact: p[1], version: p[2], classifier: p[3] || '' } };
                }
            }
            return null;
        }).filter(Boolean);

        const parentLibs = data.inheritsFrom ? scanLibsRecursive(data.inheritsFrom, visited) : [];
        return [...libs, ...parentLibs];
    };

    const allChainLibs = scanLibsRecursive(cleanVersionId);
    const extraMissing = [];
    for (const lib of allChainLibs) {
        if (!fs.existsSync(lib.path)) {
            let dlUrl = lib.url;
            if (!dlUrl && lib.maven) {
                const { group, artifact, version, classifier } = lib.maven;
                const mg = group.replace(/\./g, '/');
                const cl = classifier ? `-${classifier}` : '';
                const jn = `${artifact}-${version}${cl}.jar`;
                const base = group.includes('neoforged') ? 'https://maven.neoforged.net/'
                    : (group.includes('forge') ? 'https://maven.minecraftforge.net/' : 'https://libraries.minecraft.net/');
                dlUrl = `${base}${mg}/${artifact}/${version}/${jn}`;
            }
            if (dlUrl) {
                extraMissing.push({ type: 'library', url: dlUrl, path: lib.path, sha1: lib.sha1, size: lib.size, name: lib.name || path.basename(lib.path) });
            }
        }
    }

    if (extraMissing.length > 0) {
        console.log(`[Launch] 二次扫描发现 ${extraMissing.length} 个额外缺失库: ${extraMissing.map(f=>f.name).join(', ')}`);
        depCheck.missingFiles = [...depCheck.missingFiles.filter(f => f.type !== 'library'), ...extraMissing];
        depCheck.libraries.missing = extraMissing;
        depCheck.libraries.ok = false;
        depCheck.libraries.message = `二次扫描: ${extraMissing.length} 个库文件缺失`;
    }

    if (!depCheck.java.ok) {
        return { success: false, error: depCheck.java.message, needDownload: false, depCheck };
    }

    if (!depCheck.versionJson.ok) {
        return { success: false, error: depCheck.versionJson.message, needDownload: false, depCheck };
    }

    if (!depCheck.parentVersion.ok) {
        return { success: false, error: depCheck.parentVersion.message, needDownload: true, depCheck };
    }

    if (!depCheck.forgeCore.ok) {
        const forgeMissing = (depCheck.forgeCore.missing || [])
            .map(m => `  - ${m.desc}: ${path.basename(m.path)}`)
            .join('\n');
        console.warn(`[LaunchGame] Forge核心库缺失 (${depCheck.forgeCore.missing.length}个)，尝试自动修复...`);

        let forgeRepaired = false;

        {
            const neoMissing = (depCheck.forgeCore.missing || []).filter(m =>
                m.path && m.path.includes(path.join('net', 'neoforged', 'neoforge')) && path.basename(m.path).includes('universal'));
            for (const m of neoMissing) {
                const relPath = path.relative(ctx.dirs.LIBRARIES_DIR, m.path).replace(/\\/g, '/');
                const neoUrls = [
                    `https://maven.neoforged.net/releases/${relPath}`,
                    `https://bmclapi2.bangbang93.com/maven/${relPath}`
                ];
                console.log(`[LaunchGame] 尝试补下载NeoForge核心JAR: ${path.basename(m.path)}`);
                let neoOk = false;
                for (const url of neoUrls) {
                    try {
                        if (!fs.existsSync(path.dirname(m.path))) fs.mkdirSync(path.dirname(m.path), { recursive: true });
                        await http.downloadFile(url, m.path);
                        if (fs.existsSync(m.path) && utils.isJarIntact(m.path)) {
                            console.log(`[LaunchGame] NeoForge核心JAR补下载成功: ${path.basename(m.path)} (from ${url})`);
                            neoOk = true;
                            break;
                        }
                        console.warn(`[LaunchGame] 下载后JAR无效: ${url}`);
                        try { fs.unlinkSync(m.path); } catch (_) {}
                    } catch (e) {
                        console.warn(`[LaunchGame] NeoForge核心JAR下载失败: ${url} - ${e.message}`);
                    }
                }
                if (neoOk) {
                    forgeRepaired = true;
                }
            }
        }

        {
            let mvForgeVer = '';
            let mvMcVer = '';
            for (const chainId of [cleanVersionId, versionJson.inheritsFrom].filter(Boolean)) {
                if (chainId.toLowerCase().includes('forge')) {
                    const m = chainId.match(/^(.+)-neoforge-(.+)$/) || chainId.match(/^(.+)-forge-(.+)$/);
                    if (m) { mvMcVer = m[1]; mvForgeVer = m[2]; break; }
                }
            }
            if (!mvForgeVer) {
                const gArgs = versionJson.arguments?.game || [];
                const fvi = gArgs.findIndex(a => typeof a === 'string' && (a === '--fml.forgeVersion' || a === '--fml.neoForgeVersion'));
                const mvi = gArgs.findIndex(a => typeof a === 'string' && a === '--fml.mcVersion');
                if (fvi >= 0 && fvi + 1 < gArgs.length) mvForgeVer = gArgs[fvi + 1];
                if (mvi >= 0 && mvi + 1 < gArgs.length) mvMcVer = gArgs[mvi + 1];
            }
            if (mvForgeVer && mvMcVer) {
                console.log(`[LaunchGame] 尝试Maven直接下载Forge核心库 (${mvMcVer}-forge-${mvForgeVer})...`);
                const mvResult = await modloaders.downloadForgeCoreLibsFromMaven(`${mvMcVer}-${mvForgeVer}`);
                if (mvResult.failed === 0) {
                    const stillMissing = (depCheck.forgeCore.missing || []).filter(m => !fs.existsSync(m.path));
                    if (stillMissing.length === 0) {
                        console.log(`[LaunchGame] Maven直接下载修复成功!`);
                        forgeRepaired = true;
                    }
                } else {
                    console.warn(`[LaunchGame] Maven直接下载仍有${mvResult.failed}个缺失，继续尝试其他方式...`);
                }

                if (!forgeRepaired) {
                    console.log(`[LaunchGame] 补丁JAR不在Maven上，重装Forge以重新生成...`);
                    try {
                        const baseJar = path.join(ctx.dirs.VERSIONS_DIR, mvMcVer, `${mvMcVer}.jar`);
                        if (!fs.existsSync(baseJar)) {
                            console.log(`[LaunchGame] 原版JAR缺失，先下载 ${mvMcVer}.jar...`);
                            try { await modloaders.ensureBaseVersionInstalled(mvMcVer); } catch (e) { console.warn(`[LaunchGame] 下载原版JAR失败: ${e.message}`); }
                        }
                        const fiResult = await modloaders.installForge(mvMcVer, mvForgeVer, (p, msg) => {});
                        if (fiResult && fiResult.success) {
                            const stillMissing = (depCheck.forgeCore.missing || []).filter(m => !fs.existsSync(m.path));
                            if (stillMissing.length === 0) {
                                console.log(`[LaunchGame] Forge重装修复成功!`);
                                forgeRepaired = true;
                            } else {
                                console.warn(`[LaunchGame] Forge重装后仍有${stillMissing.length}个缺失文件`);
                            }
                        }
                    } catch (e) {
                        console.warn(`[LaunchGame] Forge重装失败: ${e.message}`);
                    }
                }
            }
        }

        for (const chainId of [cleanVersionId, versionJson.inheritsFrom].filter(Boolean)) {
            if (forgeRepaired) break;
            if (!chainId.toLowerCase().includes('forge')) continue;
            let forgeJsonPath = path.join(ctx.dirs.VERSIONS_DIR, chainId, `${chainId}.json`);
            if (!fs.existsSync(forgeJsonPath) && externalVersionDir) {
                const extRoot = versions.findExternalRoot(externalVersionDir);
                if (extRoot) {
                    const extJson = path.join(extRoot, 'versions', chainId, `${chainId}.json`);
                    if (fs.existsSync(extJson)) forgeJsonPath = extJson;
                }
            }
            if (!fs.existsSync(forgeJsonPath)) continue;
            try {
                const forgeJson = JSON.parse(fs.readFileSync(forgeJsonPath, 'utf-8'));
                const forgeMatch = chainId.match(/^(.+)-forge-(.+)$/);
                if (!forgeMatch) continue;
                const mcVer = forgeMatch[1];
                const forgeVer = forgeMatch[2];
                const baseJarPath = path.join(ctx.dirs.VERSIONS_DIR, mcVer, `${mcVer}.jar`);
                if (!fs.existsSync(baseJarPath)) {
                    console.log(`[LaunchGame] 原版JAR缺失 (${mcVer}.jar)，先下载再重装Forge...`);
                    try { await modloaders.ensureBaseVersionInstalled(mcVer); } catch (e) { console.warn(`[LaunchGame] 下载原版JAR失败: ${e.message}`); }
                }
                console.log(`[LaunchGame] 尝试重新安装Forge ${mcVer}-${forgeVer}来修复核心文件`);
                let repairResult = await modloaders.installForge(mcVer, forgeVer, (p, msg) => {
                    console.log(`[LaunchGame] 修复进度: ${Math.round(p * 100)}% - ${msg || ''}`);
                });
                if (!repairResult.success) {
                    console.log(`[LaunchGame] 主源修复失败，尝试BMCLAPI镜像...`);
                    repairResult = await modloaders.installForge(mcVer, forgeVer, (p, msg) => {
                        console.log(`[LaunchGame] BMCLAPI镜像修复进度: ${Math.round(p * 100)}% - ${msg || ''}`);
                    }, 'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge');
                }
                if (repairResult.success) {
                    const stillMissing = (depCheck.forgeCore.missing || []).filter(m => !fs.existsSync(m.path));
                    if (stillMissing.length === 0) {
                        console.log(`[LaunchGame] Forge核心文件自动修复成功!`);
                        forgeRepaired = true;
                    } else {
                        console.warn(`[LaunchGame] 修复后仍有 ${stillMissing.length} 个文件缺失`);
                    }
                } else {
                    console.warn(`[LaunchGame] Forge自动修复失败: ${repairResult.error}`);
                }
            } catch (repairErr) {
                console.warn(`[LaunchGame] Forge自动修复异常: ${repairErr.message}`);
            }
        }

        if (!forgeRepaired) {
            const altMinecraftDir = path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft');
            if (fs.existsSync(altMinecraftDir)) {
                let altCopied = 0;
                for (const m of (depCheck.forgeCore.missing || [])) {
                    if (fs.existsSync(m.path)) continue;
                    const relPath = path.relative(ctx.dirs.LIBRARIES_DIR, m.path).replace(/\\/g, '/');
                    const altLibPath = path.join(altMinecraftDir, 'libraries', relPath);
                    if (fs.existsSync(altLibPath)) {
                        try {
                            if (!fs.existsSync(path.dirname(m.path))) fs.mkdirSync(path.dirname(m.path), { recursive: true });
                            fs.copyFileSync(altLibPath, m.path);
                            if (fs.existsSync(m.path) && (!m.path.endsWith('.jar') || utils.isJarIntact(m.path))) {
                                altCopied++;
                            } else {
                                try { fs.unlinkSync(m.path); } catch (_) {}
                            }
                        } catch (_) {}
                    }
                }
                if (altCopied > 0) {
                    const stillMissing = (depCheck.forgeCore.missing || []).filter(m => !fs.existsSync(m.path));
                    if (stillMissing.length === 0) {
                        console.log(`[LaunchGame] 从.minecraft复制修复成功!`);
                        forgeRepaired = true;
                    }
                }
            }
        }

        if (!forgeRepaired) {
            const forgeSearchDirs = [];
            if (externalVersionDir) {
                const extRoot = versions.findExternalRoot(externalVersionDir);
                if (extRoot) forgeSearchDirs.push(path.join(extRoot, 'libraries'));
            }
            forgeSearchDirs.push(ctx.dirs.LIBRARIES_DIR);
            const homeLib = path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft', 'libraries');
            if (fs.existsSync(homeLib) && !forgeSearchDirs.includes(homeLib)) forgeSearchDirs.push(homeLib);
            // 扫描其他启动器的库目录
            const hmclLib = path.join(os.homedir(), 'AppData', 'Roaming', '.hmcl', 'libraries');
            if (fs.existsSync(hmclLib) && !forgeSearchDirs.includes(hmclLib)) forgeSearchDirs.push(hmclLib);
            const bakaLib = path.join(os.homedir(), 'AppData', 'Roaming', '.bakalx', 'libraries');
            if (fs.existsSync(bakaLib) && !forgeSearchDirs.includes(bakaLib)) forgeSearchDirs.push(bakaLib);
            // 也扫描常见的自定义游戏目录
            const customDirs = [path.join(os.homedir(), '.pcl'), path.join(os.homedir(), 'Documents', 'PCL'), path.join(os.homedir(), 'PCL')];
            for (const cd of customDirs) {
                if (!fs.existsSync(cd)) continue;
                try { const subs = fs.readdirSync(cd).filter(s => fs.statSync(path.join(cd, s)).isDirectory()); for (const s of subs) { const cl = path.join(cd, s, 'libraries'); if (fs.existsSync(cl) && !forgeSearchDirs.includes(cl)) forgeSearchDirs.push(cl); } } catch (_) {}
            }

            let deepCopied = 0;
            for (const m of (depCheck.forgeCore.missing || [])) {
                if (fs.existsSync(m.path)) continue;
                const basename = path.basename(m.path);
                const parentDir = path.dirname(m.path);
                const grandParent = path.dirname(parentDir);
                const verDirName = path.basename(parentDir);
                const libType = path.basename(grandParent);
                const libGroup = path.basename(path.dirname(grandParent));

                for (const searchDir of forgeSearchDirs) {
                    if (!fs.existsSync(searchDir)) continue;
                    try {
                        const typeDir = path.join(searchDir, libGroup, libType);
                        if (!fs.existsSync(typeDir)) continue;
                        const versionDirs = fs.readdirSync(typeDir).filter(d => {
                            try { return fs.statSync(path.join(typeDir, d)).isDirectory(); } catch (_) { return false; }
                        });
                        for (const vd of versionDirs) {
                            const candidatePath = path.join(typeDir, vd, basename);
                            if (fs.existsSync(candidatePath)) {
                                try {
                                    if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
                                    fs.copyFileSync(candidatePath, m.path);
                                    if (fs.existsSync(m.path) && (!m.path.endsWith('.jar') || utils.isJarIntact(m.path))) {
                                        deepCopied++;
                                        console.log(`[LaunchGame] 深度搜索修复: ${basename} (来源: ${candidatePath})`);
                                    } else {
                                        try { fs.unlinkSync(m.path); } catch (_) {}
                                    }
                                } catch (_) {}
                                break;
                            }
                        }
                        if (fs.existsSync(m.path)) break;
                    } catch (_) {}
                }
            }
            if (deepCopied > 0) {
                const stillMissing = (depCheck.forgeCore.missing || []).filter(m => !fs.existsSync(m.path));
                if (stillMissing.length === 0) {
                    console.log(`[LaunchGame] 深度搜索修复成功!`);
                    forgeRepaired = true;
                }
            }
        }

        if (!forgeRepaired) {
            const missingDetail = (depCheck.forgeCore.missing || [])
                .map(m => `  - ${m.desc || m.name}: ${path.basename(m.path)}`)
                .join('\n');
            const forgeErrorMsg = `Forge 核心库文件缺失 (${depCheck.forgeCore.missing.length}个)，无法启动游戏。\n` +
                `缺失文件:\n${missingDetail}\n\n` +
                `修复建议:\n` +
                `1) 前往"版本设置 → 文件修复"自动修复\n` +
                `2) 重新安装该Forge版本\n` +
                `3) 检查杀毒软件是否将Forge文件拦截并加入白名单`;
            console.error(`[LaunchGame] Forge核心库缺失，自动修复失败，拒绝启动`);
            console.error(`[LaunchGame] 修复建议: 1)文件修复 2)重新安装Forge 3)检查杀毒白名单`);
            return {
                success: false,
                error: forgeErrorMsg,
                needDownload: false,
                depCheck,
                repairHint: 'forge_core_missing'
            };
        }
    }

    // 兜底检查：直接扫描继承链中所有版本的libraries，确认Forge核心JAR存在
    const chainIds = [];
    {
        let current = cleanVersionId;
        const chainVisited = new Set();
        const chainSearchBases = [ctx.dirs.VERSIONS_DIR];
        if (externalVersionDir) {
            const extRoot = versions.findExternalRoot(externalVersionDir);
            if (extRoot) chainSearchBases.unshift(path.join(extRoot, 'versions'));
            chainSearchBases.unshift(path.join(path.dirname(externalVersionDir), current));
            const extFolders = versions.loadExternalFolders();
            for (const f of extFolders) {
                if (fs.existsSync(path.join(f.path, 'versions'))) chainSearchBases.push(path.join(f.path, 'versions'));
            }
        }
        while (current && !chainVisited.has(current)) {
            chainVisited.add(current);
            chainIds.push(current);
            let vjFound = false;
            for (const base of chainSearchBases) {
                const vjPath = path.join(base, current, `${current}.json`);
                if (fs.existsSync(vjPath)) {
                    try {
                        const vj = JSON.parse(fs.readFileSync(vjPath, 'utf-8'));
                        current = vj.inheritsFrom || null;
                        vjFound = true;
                        break;
                    } catch (_) { break; }
                }
            }
            if (!vjFound) break;
        }
    }
    const forgeSafeChain = chainIds.some(id => id.toLowerCase().includes('forge'));
    if (forgeSafeChain) {
        const forgeSafeMissing = [];
        let externalRootSafe = null;
        if (externalVersionDir) {
            externalRootSafe = versions.findExternalRoot(externalVersionDir);
            if (!externalRootSafe) externalRootSafe = path.dirname(path.dirname(externalVersionDir));
        }
        for (const lib of (versionJson.libraries || [])) {
            if (!lib.name) continue;
            const fp = lib.name.split(':');
            if (fp.length < 3) continue;
            const gp = fp[0].replace(/\./g, path.sep);
            const cl = fp.length >= 4 ? `-${fp[3]}` : '';
            const jn = `${fp[1]}-${fp[2]}${cl}.jar`;
            const isForgeCore = (fp[0] === 'net.minecraftforge' && fp[1] === 'forge' && cl) ||
                                (fp[0] === 'net.minecraft' && fp[1] === 'client' && (cl === '-srg' || cl === '-extra'));
            if (isForgeCore) {
                const localPath = path.join(ctx.dirs.LIBRARIES_DIR, gp, fp[1], fp[2], jn);
                if (externalRootSafe) {
                    const extPath = path.join(externalRootSafe, 'libraries', gp, fp[1], fp[2], jn);
                    if (fs.existsSync(extPath) && (!extPath.endsWith('.jar') || utils.isJarIntact(extPath))) continue;
                }
                if (!fs.existsSync(localPath) || !utils.isJarIntact(localPath)) {
                    forgeSafeMissing.push({ desc: jn, path: localPath });
                }
            }
        }
        if (forgeSafeMissing.length > 0) {
            const missingNames = forgeSafeMissing.map(f => f.desc).join(', ');
            console.warn(`[LaunchGame] 兜底检查发现Forge核心库缺失 (${forgeSafeMissing.length}个): ${missingNames}`);

            let safeRepaired = false;
            for (const chainId of chainIds) {
                if (safeRepaired) break;
                if (!chainId.toLowerCase().includes('forge')) continue;
                const forgeMatch = chainId.match(/^(.+)-forge-(.+)$/);
                if (!forgeMatch) continue;
                const mcVer = forgeMatch[1];
                const forgeVer = forgeMatch[2];
                console.log(`[LaunchGame] 兜底修复: 重新安装Forge ${mcVer}-${forgeVer}`);
                try {
                    let repairResult = await modloaders.installForge(mcVer, forgeVer, (p, msg) => {
                        console.log(`[LaunchGame] 兜底修复进度: ${Math.round(p * 100)}%`);
                    });
                    if (!repairResult.success) {
                        console.log(`[LaunchGame] 兜底修复主源失败，尝试BMCLAPI镜像...`);
                        repairResult = await modloaders.installForge(mcVer, forgeVer, (p, msg) => {
                            console.log(`[LaunchGame] 兜底BMCLAPI修复进度: ${Math.round(p * 100)}%`);
                        }, 'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge');
                    }
                    if (repairResult.success) {
                        const stillMissing = forgeSafeMissing.filter(f => !fs.existsSync(f.path) || !utils.isJarIntact(f.path));
                        if (stillMissing.length === 0) {
                            console.log(`[LaunchGame] 兜底修复成功!`);
                            safeRepaired = true;
                        }
                    }
                } catch (_) {}
            }

            if (!safeRepaired) {
                const altMinecraftDir = path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft');
                if (fs.existsSync(altMinecraftDir)) {
                    for (const f of forgeSafeMissing) {
                        if (fs.existsSync(f.path)) continue;
                        const relPath = path.relative(ctx.dirs.LIBRARIES_DIR, f.path).replace(/\\/g, '/');
                        const altLibPath = path.join(altMinecraftDir, 'libraries', relPath);
                        if (fs.existsSync(altLibPath)) {
                            try {
                                if (!fs.existsSync(path.dirname(f.path))) fs.mkdirSync(path.dirname(f.path), { recursive: true });
                                fs.copyFileSync(altLibPath, f.path);
                                if (fs.existsSync(f.path) && (!f.path.endsWith('.jar') || utils.isJarIntact(f.path))) {
                                    safeRepaired = true;
                                } else {
                                    try { fs.unlinkSync(f.path); } catch (_) {}
                                }
                            } catch (_) {}
                        }
                    }
                    if (safeRepaired) {
                        const stillMissing = forgeSafeMissing.filter(f => !fs.existsSync(f.path) || !utils.isJarIntact(f.path));
                        if (stillMissing.length > 0) safeRepaired = false;
                    }
                }
            }

            if (!safeRepaired) {
                return {
                    success: false,
                    error: `Forge 核心库文件缺失 (${forgeSafeMissing.length}个)，无法启动游戏。\n缺失文件: ${missingNames}\n请在版本设置中使用"文件修复"功能，或重新安装该版本。`,
                    needDownload: false,
                    depCheck,
                    repairHint: 'forge_core_missing'
                };
            }
        }
    }

    const nonForgeCoreMissing = depCheck.missingFiles.filter(f => f.type !== 'forge_core');
    if (nonForgeCoreMissing.length > 0) {
        const _LAUNCH_CORE_PREFIXES = ['net.minecraftforge', 'net.neoforged', 'cpw.mods', 'net.minecraft'];
        const criticalMissing = nonForgeCoreMissing.filter(f => f.type === 'main_jar' || f.type === 'parent_version' || f.type === 'native' || f.type === 'asset' || f.type === 'asset_index');
        const nonCoreLibMissing = nonForgeCoreMissing.filter(f => f.type === 'library' && f.name && !_LAUNCH_CORE_PREFIXES.some(p => f.name.split(':')[0].startsWith(p)));
        const coreLibMissing = nonForgeCoreMissing.filter(f => f.type === 'library' && f.name && _LAUNCH_CORE_PREFIXES.some(p => f.name.split(':')[0].startsWith(p)));

        if (criticalMissing.length === 0 && coreLibMissing.length === 0 && nonCoreLibMissing.length > 0) {
            console.log(`[LaunchGame] 跳过非核心库自动下载 (${nonCoreLibMissing.length}个)，直接尝试启动`);
            for (const f of nonCoreLibMissing) {
                console.log(`[LaunchGame] 非核心库缺失(不影响启动): ${f.name || f.path}`);
            }
        } else {
        const sessionId = `launch-${Date.now()}`;
        ctx.sessions.launchSessions.set(sessionId, {
            status: 'downloading',
            progress: 0,
            message: `正在下载 ${nonForgeCoreMissing.length} 个缺失文件..`,
            totalFiles: nonForgeCoreMissing.length,
            completedFiles: 0,
            currentFile: '',
            errors: [],
            versionId
        });

        console.log(`[LaunchGame] 缺失 ${nonForgeCoreMissing.length} 个文件，启动后台下载...`);
        const _bgDlVersionJson = versionJson;
        const _bgDlExternalDir = externalVersionDir;
        const _bgDlCleanId = cleanVersionId;
        (async () => {
            try {
                await dependencies.downloadMissingDependencies(nonForgeCoreMissing, (p) => {
                    if (!ctx.sessions.launchSessions.has(sessionId)) return;
                    const sess = ctx.sessions.launchSessions.get(sessionId);
                    if (p.progress !== undefined) sess.progress = p.progress;
                    if (p.file) sess.currentFile = p.file;
                    if (p.current !== undefined) sess.completedFiles = p.current;
                    if (p.total !== undefined) sess.totalFiles = p.total;
                    if (p.speed !== undefined) sess.speed = p.speed;
                    if (p.msg) sess.message = p.msg;
                    if (p.message) sess.message = p.message;
                    if (p.activeDownloads) sess.activeDownloads = p.activeDownloads;
                    if (p.failed !== undefined) sess.failed = p.failed;
                    if (p.status === 'completed' || p.status === 'completed_with_errors') sess.status = 'completed';
                    if (p.status === 'failed') {
                        sess.status = 'failed';
                        sess.message = p.message || p.msg || '下载失败';
                    }
                }, _bgDlVersionJson, null, _bgDlExternalDir);
                const sess = ctx.sessions.launchSessions.get(sessionId);
                if (sess) {
                    sess.status = 'completed';
                    sess.message = '缺失文件下载完成';
                }
                console.log(`[LaunchGame] 后台下载完成，缓存已失效`);
                java.invalidateDepCheckCache(_bgDlCleanId);
            } catch (dlErr) {
                console.error(`[LaunchGame] 后台下载失败: ${dlErr.message}`);
                const sess = ctx.sessions.launchSessions.get(sessionId);
                if (sess) {
                    sess.status = 'failed';
                    sess.message = '下载失败: ' + dlErr.message;
                }
            }
        })();

        return {
            success: true,
            needDownload: true,
            sessionId,
            totalFiles: nonForgeCoreMissing.length,
            message: `正在下载 ${nonForgeCoreMissing.length} 个缺失文件...`
        };
        }
    }

    if (checkOnly) {
        return { success: true, ready: true, message: '所有文件就绪，可以启动' };
    }

    return doLaunch(cleanVersionId, versionJson, settings, account, externalVersionDir, versionId);
    } catch (e) {
        console.error(`[LaunchGame] 异常: ${e.message}`);
        console.error(`[LaunchGame] 堆栈: ${e.stack}`);
        const errDetail = { versionId, error: e.message, stack: e.stack, timestamp: new Date().toISOString() };
        try {
            if (!fs.existsSync(ctx.dirs.LOGS_DIR)) fs.mkdirSync(ctx.dirs.LOGS_DIR, { recursive: true });
            fs.writeFileSync(path.join(ctx.dirs.LOGS_DIR, `launch-error-${Date.now()}.json`), JSON.stringify(errDetail, null, 2), 'utf-8');
        } catch (_) {}
        return {
            success: false,
            error: `启动流程异常: ${e.message}`,
            details: errDetail
        };
    }
}

// ============================================================================
// 启动游戏（实际启动进程）
// ============================================================================
async function doLaunch(versionId, versionJson, settings, account, externalVersionDir = null, fullVersionId = null) {
    console.log(`[Launch] ========== 开始启动流程 ==========`);
    console.log(`[Launch] 版本ID: ${versionId}`);
    console.log(`[Launch] 完整版本ID: ${fullVersionId || versionId}`);
    console.log(`[Launch] 外部版本目录: ${externalVersionDir || '无'}`);
    console.log(`[Launch] 主类: ${versionJson.mainClass || '未设置'}`);

    let launchVersionId = versionId;

    let javaPath = java.selectJavaForVersion(versionId, settings, versionJson);
    if (!javaPath) {
        const errorMsg = '未找到Java运行环境，请在设置中配置Java路径';
        console.error(`[Launch] 错误: ${errorMsg}`);
        return { success: false, error: errorMsg, details: { versionId, mainClass: versionJson.mainClass } };
    }
    console.log(`[Launch] Java路径: ${javaPath}`);

    let gameDir;
    if (externalVersionDir) {
        gameDir = externalVersionDir;
        console.log(`[Launch] 外部版本游戏目录(版本隔离): ${gameDir}`);
    } else {
        const settingsVersionId = fullVersionId || versionId;
        const effectiveIsolation = versions.resolveVersionIsolation(settingsVersionId);
        if (effectiveIsolation) {
            const sameVersionCount = [...ctx.sessions.gameInstances.values()].filter(g => g.versionId === versionId).length;
            if (sameVersionCount > 0) {
                gameDir = path.join(ctx.dirs.VERSIONS_DIR, versionId, `instance_${sameVersionCount + 1}`);
            } else {
                gameDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
            }
        } else {
            gameDir = settings.gameDir || ctx.dirs.DATA_DIR;
        }
        console.log(`[Launch] 游戏目录: ${gameDir}`);
        console.log(`[Launch] 版本隔离: ${effectiveIsolation ? '是' : '否'}`);
    }

    const nativesDir = natives.getNativesFolder(versionId);
    const launchResult = buildLaunchArguments(versionJson, settings, account, versionId, gameDir, externalVersionDir);
    const args = launchResult.args;
    const maxMemMB = launchResult.maxMemMB;
    console.log(`[Launch] 启动参数数量: ${args.length}`);

    {
        const debugLogPath = path.join(ctx.dirs.LOGS_DIR, `launch-debug-${Date.now()}.log`);
        try {
            const debugLines = [];
            debugLines.push(`=== VersePC 启动调试日志 ===`);
            debugLines.push(`时间: ${new Date().toISOString()}`);
            debugLines.push(`版本: ${versionId}`);
            debugLines.push(`外部版本: ${!!externalVersionDir}`);
            debugLines.push(`游戏目录: ${gameDir}`);
            debugLines.push(`JVM参数总数: ${args.length}`);
            debugLines.push(``);
            debugLines.push(`=== 完整JVM参数 ===`);
            args.forEach((a, i) => debugLines.push(`[${i}] ${a}`));

            const cpIdx2 = args.indexOf('-cp');
            if (cpIdx2 >= 0 && cpIdx2 + 1 < args.length) {
                const sep = process.platform === 'win32' ? ';' : ':';
                const entries = args[cpIdx2 + 1].split(sep);
                debugLines.push(``);
                debugLines.push(`=== Classpath (${entries.length}条目) ===`);
                entries.forEach(e => debugLines.push(`  ${e}`));
                const missing = entries.filter(e => !fs.existsSync(e));
                if (missing.length > 0) {
                    debugLines.push(``);
                    debugLines.push(`=== 缺失文件 (${missing.length}) ===`);
                    missing.forEach(m => debugLines.push(`  ${m}`));
                }
            }

            fs.writeFileSync(debugLogPath, debugLines.join('\n'), 'utf-8');
            console.log(`[Launch] 调试日志已保存: ${debugLogPath}`);
        } catch (e) {
            console.error(`[Launch] 调试日志写入失败: ${e.message}`);
        }
    }

    const cpIdx = args.indexOf('-cp');
    if (cpIdx !== -1 && cpIdx + 1 < args.length) {
        const classpathStr = args[cpIdx + 1];
        const separator = process.platform === 'win32' ? ';' : ':';
        const classpathEntries = classpathStr.split(separator);
        console.log(`[Launch] Classpath 条目数: ${classpathEntries.length}`);

        const mainClass = versionJson.mainClass || '';
        const isForgeLike = mainClass.includes('modlauncher') || mainClass.includes('fmlloader') ||
            mainClass.includes('forge') || mainClass.includes('neoforge');

        if (isForgeLike) {
            const criticalLibs = ['securejarhandler', 'forge', 'neoforge', 'fmlloader', 'modlauncher'];
            for (const crit of criticalLibs) {
                const found = classpathEntries.some(e => e.toLowerCase().includes(crit));
                console.log(`[Launch] 关键库 [${crit}]: ${found ? '✓ 找到' : '✗ 缺失!'}`);
            }
            const missingEntries = classpathEntries.filter(e => !fs.existsSync(e));
            if (missingEntries.length > 0) {
                console.error(`[Launch] ⚠ ${missingEntries.length} 个classpath条目文件不存在!`);
                missingEntries.slice(0, 5).forEach(m =>
                    console.error(`[Launch]   不存在: ${path.basename(m)}`)
                );
            }
        }

        if (mainClass.includes('fabric') || mainClass.includes('knot')) {
            const fabricLibs = classpathEntries.filter(e =>
                e.includes('fabric') || e.includes('fabricmc') || e.includes('intermediary')
            );
            console.log(`[Launch] Fabric库数量: ${fabricLibs.length}`);
            if (fabricLibs.length === 0) {
                console.error(`[Launch] 警告: Fabric版本但没有找到Fabric库!`);
            }
            fabricLibs.forEach((lib, i) => {
                const exists = fs.existsSync(lib);
                console.log(`[Launch] Fabric库[${i}]: ${path.basename(lib)} - ${exists ? '存在' : '缺失!'}`);
            });
        }
    }

    ctx.sessions.gameInstanceCounter++;
    const sessionId = `game_${ctx.sessions.gameInstanceCounter}_${Date.now()}`;

    try {

        try {
            setGameLanguage(gameDir, versionJson, settings);
        } catch (langErr) {
            console.error('[Language] 设置游戏语言失败:', langErr.message);
        }

        applyWindowSettings(gameDir, settings);

        const mainClass = versionJson.mainClass || 'net.minecraft.client.main.Main';

        console.log(`[Launch] 主类: ${mainClass}`);
        console.log(`[Launch] 参数总数: ${args.length}`);

        const cpIdx = args.indexOf('-cp');
        if (cpIdx !== -1 && cpIdx + 1 < args.length) {
            const cpStr = args[cpIdx + 1];
            const cpEntries = cpStr.split(';');
            const missingCp = cpEntries.filter(e => !fs.existsSync(e));
            console.log(`[Launch] Classpath: ${cpEntries.length}个条目, ${missingCp.length}个不存在`);
            if (missingCp.length > 0 && missingCp.length <= 10) {
                missingCp.forEach(m => console.log(`[Launch]   缺失: ${m}`));
            }

            const mainClassInCp = cpEntries.some(e => {
                const basename = path.basename(e).toLowerCase();
                if (mainClass.includes('knot') && basename.includes('fabric-loader')) return true;
                if (mainClass.includes('modlauncher') && basename.includes('securejarhandler')) return true;
                if (mainClass.includes('launchwrapper') && basename.includes('launchwrapper')) return true;
                return false;
            });
            console.log(`[Launch] 主类对应JAR在classpath中: ${mainClassInCp}`);
        }

        const spawnOptions = {
            cwd: gameDir,
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe']
        };

        if (process.platform === 'win32') {
            let shouldOptimizeMemory = false;
            try {
                const storePath = path.join(ctx.dirs.DATA_DIR, 'app-store.json');
                if (fs.existsSync(storePath)) {
                    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
                    const otherStr = store['versepc_other_settings'];
                    if (otherStr) {
                        const otherSettings = JSON.parse(otherStr);
                        if (otherSettings.autoMemoryOptimize !== false) shouldOptimizeMemory = true;
                    }
                }
            } catch (_) {}
            if (shouldOptimizeMemory) {
                try {
                    const verSettings = versions.loadVersionSettings(versionId);
                    if (verSettings.memOptimize === 'off') shouldOptimizeMemory = false;
                    else if (verSettings.memOptimize === 'on') shouldOptimizeMemory = true;
                } catch (_) {}
            }
            if (shouldOptimizeMemory) {
                const freeMB = Math.floor(os.freemem() / 1024 / 1024);
                const totalMB = Math.floor(os.totalmem() / 1024 / 1024);
                console.log(`[Launch] 启动前内存优化: 可用 ${freeMB}MB / 总计 ${totalMB}MB`);
                try {
                    const tmpScript = path.join(os.tmpdir(), 'versepc_memopt.ps1');
                    const psScript = DoRound;
                    fs.writeFileSync(tmpScript, psScript, 'utf8');
                    const { execFile } = require('child_process');
                    const afterMB = await new Promise((resolve) => {
                        execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpScript], { timeout: 90000, windowsHide: true }, (err, stdout) => {
                            try { fs.unlinkSync(tmpScript); } catch (_) {}
                            if (err) { resolve(null); return; }
                            resolve(parseInt(stdout.trim(), 10) || null);
                        });
                    });
                    if (afterMB) {
                        console.log(`[Launch] 内存优化完成: 可用 ${afterMB}MB (释放 ${afterMB - freeMB}MB)`);
                    } else {
                        console.log(`[Launch] 内存优化已执行`);
                    }
                } catch (e) {
                    console.log(`[Launch] 内存优化失败，继续启动: ${e.message}`);
                }
            }
        }

        if (process.platform === 'linux' && nativesDir) {
            const existingLdPath = spawnOptions.env.LD_LIBRARY_PATH || '';
            spawnOptions.env.LD_LIBRARY_PATH = [nativesDir, existingLdPath].filter(Boolean).join(':');
        }

        if (process.platform === 'darwin' && nativesDir) {
            const existingDyldPath = spawnOptions.env.DYLD_LIBRARY_PATH || '';
            spawnOptions.env.DYLD_LIBRARY_PATH = [nativesDir, existingDyldPath].filter(Boolean).join(':');
        }

        if (!spawnOptions.env.JAVA_HOME && javaPath) {
            try {
                const detectedHome = path.dirname(path.dirname(javaPath));
                spawnOptions.env.JAVA_HOME = detectedHome;
                console.log(`[Launch] 自动设置 JAVA_HOME: ${detectedHome}`);
            } catch (e) {}
        }

        try {
            const debugCmd = [javaPath, ...args].map(a => {
                if (a.includes(' ') || a.includes('"') || a.includes('=')) return `"${a}"`;
                return a;
            }).join(' ');
            const debugPath = path.join(ctx.dirs.DATA_DIR, 'launch-debug.txt');
            fs.writeFileSync(debugPath, utils.filterSensitiveInfo(debugCmd), 'utf-8');
            console.log(`[Launch] 调试命令行已写入: ${debugPath}`);
        } catch (e) {}

        const totalCmdLength = args.reduce((sum, a) => sum + a.length + 3, javaPath.length + 3);

        if (totalCmdLength > 30000 || (process.platform === 'win32' && totalCmdLength > 25000)) {
            console.log(`[Launch] 命令行过长(${totalCmdLength}字符)，使用@argfile方式启动`);
            const tmpDir = path.join(os.tmpdir(), 'versepc-launch');
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
            const argFilePath = path.join(tmpDir, `args-${Date.now()}.txt`);
            const argFileLines = [];
            for (const a of args) {
                if (process.platform === 'win32' && (a.includes(' ') || a.includes('(') || a.includes(')'))) {
                    argFileLines.push(`"${a}"`);
                } else {
                    argFileLines.push(a);
                }
            }
            fs.writeFileSync(argFilePath, argFileLines.join('\r\n'), 'utf-8');
            const newArgs = [`@${argFilePath}`];
            console.log(`[Launch] @argfile: ${argFilePath}, 参数数量: ${args.length}`);

            let skinBackups = [];
            try { skinBackups = natives.injectOfflineSkin(versionJson, account, ctx.dirs.ASSETS_DIR); } catch (e) {}

            const gameProcess = spawn(javaPath, newArgs, spawnOptions);

            gameProcess.on('exit', () => {
                try { clearInterval(_logSaveTimer); } catch (e) {}
                try { fs.unlinkSync(argFilePath); } catch (e) {}
                try { natives.restoreOfflineSkin(skinBackups); } catch (e) {}
            });

            console.log(`[Launch] 进程已启动(@argfile模式), PID: ${gameProcess.pid}`);

            applyPerformanceOptimizations(gameProcess.pid);

            const instanceInfo = {
                    sessionId,
                    process: gameProcess,
                    versionId,
                    pid: gameProcess.pid,
                    gameDir,
                    startTime: Date.now(),
                    logBuffer: [],
                    lanPort: null,
                    gameReady: false,
                    readyTime: null,
                    loadStage: 0,
                    launchInfo: {
                        versionId,
                        fullVersionId: fullVersionId || versionId,
                        externalVersionDir,
                        mainClass: versionJson.mainClass,
                        javaPath,
                        gameDir
                    }
                };

                ctx.sessions.gameInstances.set(sessionId, instanceInfo);
                console.log(`[Launch] 游戏进程已创建, PID: ${gameProcess.pid}, Session: ${sessionId}`);

                const _gameLogsDir = path.join(gameDir, 'logs');
                const _safeVersionId = versionId.replace(/[\\/:*?"<>|]/g, '_');
                const _crashLogPath = path.join(ctx.dirs.LOGS_DIR, `game-crash-${_safeVersionId}-${Date.now()}.log`);
                const _readGameLog = (name) => { try { return fs.readFileSync(path.join(_gameLogsDir, name), 'utf8'); } catch(e) { return ''; } };
                const _saveGameLog = (label) => {
                    let parts;
                    try {
                        parts = [`=== VersePC ${label || 'Game Log'} ===\nSession: ${sessionId}\nPID: ${gameProcess ? gameProcess.pid : 'N/A'}\nTime: ${new Date().toISOString()}\nVersion: ${versionId}\nGameDir: ${gameDir}\n`];
                        if (instanceInfo.logBuffer.length > 0) {
                            parts.push(`\n=== stdout/stderr (last 1000 lines) ===\n${instanceInfo.logBuffer.slice(-1000).join('\n')}\n`);
                        }
                        const latest = _readGameLog('latest.log');
                        if (latest) parts.push(`\n=== latest.log (last 500 lines) ===\n${latest.split('\n').slice(-500).join('\n')}\n`);
                        const debug = _readGameLog('debug.log');
                        if (debug) parts.push(`\n=== debug.log (last 500 lines) ===\n${debug.split('\n').slice(-500).join('\n')}\n`);
                        fs.writeFileSync(_crashLogPath, parts.join(''));
                    } catch (e) {
                        try {
                            const fbPath = path.join(ctx.dirs.DATA_DIR, `crash-${_safeVersionId}-${Date.now()}.log`);
                            fs.writeFileSync(fbPath, parts.join(''));
                        } catch (e2) {}
                    }
                };
                const _logSaveTimer = setInterval(() => _saveGameLog('periodic'), 2000);
                try { _saveGameLog('initial'); } catch(e) {}

                if (gameProcess.stdout) {
                    gameProcess.stdout.on('data', (data) => {
                        const lines = data.toString().split('\n').filter(l => l.trim()).map(utils.filterSensitiveInfo);
                        instanceInfo.logBuffer.push(...lines);
                        if (instanceInfo.logBuffer.length > 5000) instanceInfo.logBuffer = instanceInfo.logBuffer.slice(-3000);
                        ctx.sessions.gameLogBuffer.push(...lines);
                        if (ctx.sessions.gameLogBuffer.length > 5000) ctx.sessions.gameLogBuffer = ctx.sessions.gameLogBuffer.slice(-3000);
                        for (const line of lines) {
                            const lanMatch = line.match(/Local game hosted on.*?(\d{4,5})/i) ||
                                             line.match(/Started serving on.*?(\d{4,5})/i) ||
                                             line.match(/Opening LAN server.*?(\d{4,5})/i) ||
                                             line.match(/LAN server started.*?(\d{4,5})/i) ||
                                             line.match(/本地游戏已托管.*?(\d{4,5})/i);
                            if (lanMatch) {
                                instanceInfo.lanPort = parseInt(lanMatch[1], 10);
                                ctx.sessions.detectedLanPort = parseInt(lanMatch[1], 10);
                                console.log(`[LAN] Detected LAN port: ${instanceInfo.lanPort} (session: ${sessionId})`);
                            }
                            if (instanceInfo.loadStage < 1) { instanceInfo.loadStage = 1; }
                            if (instanceInfo.loadStage < 2 && line.includes('Setting user:')) { instanceInfo.loadStage = 2; console.log(`[Launch] 阶段 2/5: 用户已设置 (session: ${sessionId})`); }
                            if (instanceInfo.loadStage < 3 && /lwjgl version/i.test(line)) { instanceInfo.loadStage = 3; console.log(`[Launch] 阶段 3/5: LWJGL 已初始化 (session: ${sessionId})`); }
                            if (instanceInfo.loadStage < 4 && (line.includes('OpenAL initialized') || line.includes('Starting up SoundSystem'))) { instanceInfo.loadStage = 4; console.log(`[Launch] 阶段 4/5: 音频系统就绪 (session: ${sessionId})`); }
                            if (instanceInfo.loadStage < 5 && ((line.includes('Created') && line.includes('textures') && line.includes('-atlas')) || line.includes('Found animation info'))) {
                                instanceInfo.loadStage = 5;
                                if (!instanceInfo.gameReady) {
                                    instanceInfo.gameReady = true;
                                    instanceInfo.readyTime = Date.now();
                                    const launchDuration = instanceInfo.readyTime - instanceInfo.startTime;
                                    console.log(`[Launch] 阶段 5/5: 材质加载完成(Manifest模式), 耗时: ${(launchDuration / 1000).toFixed(1)}s`);
                                }
                            }
                        }
                    });
                }

                if (gameProcess.stderr) {
                    gameProcess.stderr.on('data', (data) => {
                        const lines = data.toString().split('\n').filter(l => l.trim()).map(utils.filterSensitiveInfo);
                        instanceInfo.logBuffer.push(...lines);
                        if (instanceInfo.logBuffer.length > 5000) instanceInfo.logBuffer = instanceInfo.logBuffer.slice(-3000);
                        ctx.sessions.gameLogBuffer.push(...lines);
                        if (ctx.sessions.gameLogBuffer.length > 5000) ctx.sessions.gameLogBuffer = ctx.sessions.gameLogBuffer.slice(-3000);
                    });
                }

                gameProcess.unref();

                gameProcess.on('close', (code) => {
                    try { clearInterval(_logSaveTimer); } catch (e) {}
                    const _sysInfo = utils.getSystemInfo();
                    const crashParts = [`=== VersePC Game Crash Log ===\nSession: ${sessionId}\nExit Code: ${code}\nTime: ${new Date().toISOString()}\nVersion: ${versionId}\nJava: ${javaPath}\nGameDir: ${gameDir}\nOS: ${_sysInfo.osType} ${_sysInfo.osRelease} (${_sysInfo.osArch})\nCPU: ${_sysInfo.cpuModel}\nGPU: ${_sysInfo.gpuInfo}\nMemory: ${_sysInfo.totalMemMB}MB total, ${_sysInfo.freeMemMB}MB free\n`];
                    try {
                        if (instanceInfo.logBuffer.length > 0) {
                            crashParts.push(`\n=== stdout/stderr (last 3000 lines) ===\n${instanceInfo.logBuffer.slice(-3000).join('\n')}\n`);
                        }
                        const latest = _readGameLog('latest.log');
                        if (latest) crashParts.push(`\n=== latest.log (last 500 lines) ===\n${latest.split('\n').slice(-500).join('\n')}\n`);
                        const debug = _readGameLog('debug.log');
                        if (debug) crashParts.push(`\n=== debug.log (last 500 lines) ===\n${debug.split('\n').slice(-500).join('\n')}\n`);
                        fs.writeFileSync(_crashLogPath, crashParts.join(''));
                    } catch (e) {
                        // 兜底：写入DATA_DIR根目录
                        try {
                            const fbPath = path.join(ctx.dirs.DATA_DIR, `crash-${_safeVersionId}-${Date.now()}.log`);
                            fs.writeFileSync(fbPath, crashParts.join(''));
                        } catch (e2) {}
                    }
                    const recentLogs = instanceInfo.logBuffer.slice(-100).join('\n');
                    let analysis = analyzeExitCode(code, launchVersionId || versionId);
                    // 补充：读取游戏日志文件进行更准确的分析
                    const gameLatestLog = _readGameLog('latest.log');
                    const gameDebugLog = _readGameLog('debug.log');
                    const gameAllLogs = (gameLatestLog + '\n' + gameDebugLog).toLowerCase();
                    if (gameAllLogs.includes('invalid paths argument') || gameAllLogs.includes('contained no existing paths')) {
                        analysis.reason = 'Forge核心库文件缺失（Invalid paths argument）';
                        analysis.suggestion = 'Forge安装不完整(fmlcore/javafmllanguage/mclanguage/lowcodelanguage缺失)。\n修复: 1)版本设置→文件修复 2)重新安装Forge 3)检查杀毒白名单';
                    }
                    instanceInfo.logBuffer.push(`[VersePC] 游戏进程退出(session:${sessionId}),代码:${code}`);
                    ctx.sessions.gameLogBuffer.push(`[VersePC] 游戏进程退出 (session: ${sessionId})，代码: ${code}`);
                    if (analysis.isCrash) {
                        instanceInfo.logBuffer.push(`[VersePC] 崩溃分析: ${analysis.reason}`);
                        instanceInfo.logBuffer.push(`[VersePC] 建议: ${analysis.suggestion}`);
                        ctx.sessions.gameLogBuffer.push(`[VersePC] 崩溃分析: ${analysis.reason}`);
                    } else {
                        instanceInfo.logBuffer.push(`[VersePC] ${analysis.reason}`);
                        ctx.sessions.gameLogBuffer.push(`[VersePC] ${analysis.reason}`);
                    }
                    ctx.sessions.lastGameExitAnalysis = {
                        ...analysis,
                        launchInfo: instanceInfo.launchInfo,
                        logBuffer: instanceInfo.logBuffer.slice(-50),
                        systemInfo: _sysInfo
                    };
                    try {
                        const crashLogs = [];
                        const _verDir2 = path.join(ctx.dirs.VERSIONS_DIR, launchVersionId || versionId);
                        if (fs.existsSync(_verDir2)) {
                            fs.readdirSync(_verDir2).filter(f => f.startsWith('hs_err_pid') && f.endsWith('.log')).forEach(f => crashLogs.push(path.join(_verDir2, f)));
                        }
                        if (fs.existsSync(gameDir)) {
                            fs.readdirSync(gameDir).filter(f => f.startsWith('hs_err_pid') && f.endsWith('.log')).forEach(f => crashLogs.push(path.join(gameDir, f)));
                        }
                        try {
                            const tmpDir = os.tmpdir();
                            if (fs.existsSync(tmpDir)) {
                                fs.readdirSync(tmpDir).filter(f => f.startsWith('hs_err_pid') && f.endsWith('.log')).forEach(f => crashLogs.push(path.join(tmpDir, f)));
                            }
                        } catch (_) {}
                        if (crashLogs.length > 0) {
                            crashLogs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
                            ctx.sessions.lastGameExitAnalysis.crashLog = crashLogs[0];
                            ctx.sessions.lastGameExitAnalysis.crashLogs = crashLogs;
                            ctx.sessions.lastGameExitAnalysis.reason = (ctx.sessions.lastGameExitAnalysis.reason || '') + `\nJVM 崩溃日志: ${crashLogs[0]}`;
                            instanceInfo.logBuffer.push(`[VersePC] JVM崩溃日志: ${crashLogs[0]}`);
                            ctx.sessions.gameLogBuffer.push(`[VersePC] JVM崩溃日志: ${crashLogs[0]}`);
                        }
                    } catch (_) {}
                    try {
                        const playTimePath = path.join(ctx.dirs.DATA_DIR, 'play-time.json');
                        if (fs.existsSync(playTimePath)) {
                            if (!global._playTimeWriteQueue) global._playTimeWriteQueue = Promise.resolve();
                            global._playTimeWriteQueue = global._playTimeWriteQueue.then(() => {
                                let ptData = JSON.parse(fs.readFileSync(playTimePath, 'utf8'));
                                const vData = ptData[launchVersionId || versionId];
                                if (vData && vData._launchTime) {
                                    const elapsed = (Date.now() - vData._launchTime) / 1000;
                                    vData.totalSeconds = (vData.totalSeconds || 0) + elapsed;
                                    delete vData._launchTime;
                                    fs.writeFileSync(playTimePath, JSON.stringify(ptData, null, 2), 'utf8');
                                }
                            });
                        }
                    } catch (e) {}
                    ctx.sessions.gameInstances.delete(sessionId);
                    if (ctx.sessions.gameInstances.size === 0) {
                        ctx.sessions.gameLogBuffer = [];
                    }
                });

                gameProcess.on('error', (err) => {
                    instanceInfo.logBuffer.push(`[VersePC] 启动错误: ${err.message}`);
                    ctx.sessions.gameLogBuffer.push(`[VersePC] 启动错误 (session: ${sessionId}): ${err.message}`);
                    ctx.sessions.lastGameExitAnalysis = {
                        code: -1,
                        reason: `启动错误: ${err.message}`,
                        suggestion: '请检查Java路径是否正确',
                        isCrash: true,
                        launchInfo: instanceInfo.launchInfo,
                        systemInfo: utils.getSystemInfo()
                    };
                    ctx.sessions.gameInstances.delete(sessionId);
                });

                return {
                    success: true,
                    sessionId,
                    pid: gameProcess.pid,
                    gameDir,
                    versionId
                };
        }

        let skinBackups = [];
        try { skinBackups = natives.injectOfflineSkin(versionJson, account, ctx.dirs.ASSETS_DIR); } catch (e) {}

        const gameProcess = spawn(javaPath, args, spawnOptions);

        console.log(`[Launch] 进程已启动, PID: ${gameProcess.pid}`);

        applyPerformanceOptimizations(gameProcess.pid);

        const instanceInfo = {
            sessionId,
            process: gameProcess,
            versionId,
            pid: gameProcess.pid,
            gameDir,
            startTime: Date.now(),
            logBuffer: [],
            lanPort: null,
            gameReady: false,
            readyTime: null,
            loadStage: 0,
            launchInfo: {
                versionId,
                fullVersionId: fullVersionId || versionId,
                externalVersionDir,
                mainClass: versionJson.mainClass,
                javaPath,
                gameDir
            }
        };

        ctx.sessions.gameInstances.set(sessionId, instanceInfo);
        console.log(`[Launch] 游戏进程已创建, PID: ${gameProcess.pid}, Session: ${sessionId}`);

        if (gameProcess.stdout) {
            gameProcess.stdout.on('data', (data) => {
                const lines = data.toString().split('\n').filter(l => l.trim()).map(utils.filterSensitiveInfo);
                instanceInfo.logBuffer.push(...lines);
                if (instanceInfo.logBuffer.length > 5000) instanceInfo.logBuffer = instanceInfo.logBuffer.slice(-3000);
                ctx.sessions.gameLogBuffer.push(...lines);
                if (ctx.sessions.gameLogBuffer.length > 5000) ctx.sessions.gameLogBuffer = ctx.sessions.gameLogBuffer.slice(-3000);
                for (const line of lines) {
                    const lanMatch = line.match(/Local game hosted on.*?(\d{4,5})/i) ||
                                     line.match(/Started serving on.*?(\d{4,5})/i) ||
                                     line.match(/Opening LAN server.*?(\d{4,5})/i) ||
                                     line.match(/LAN server started.*?(\d{4,5})/i) ||
                                     line.match(/本地游戏已托管.*?(\d{4,5})/i);
                    if (lanMatch) {
                        instanceInfo.lanPort = parseInt(lanMatch[1], 10);
                        ctx.sessions.detectedLanPort = parseInt(lanMatch[1], 10);
                        console.log(`[LAN] Detected LAN port: ${instanceInfo.lanPort} (session: ${sessionId})`);
                    }
                    if (instanceInfo.loadStage < 1) { instanceInfo.loadStage = 1; }
                    if (instanceInfo.loadStage < 2 && line.includes('Setting user:')) { instanceInfo.loadStage = 2; console.log(`[Launch] 阶段 2/5: 用户已设置 (session: ${sessionId})`); }
                    if (instanceInfo.loadStage < 3 && /lwjgl version/i.test(line)) { instanceInfo.loadStage = 3; console.log(`[Launch] 阶段 3/5: LWJGL 已初始化 (session: ${sessionId})`); }
                    if (instanceInfo.loadStage < 4 && (line.includes('OpenAL initialized') || line.includes('Starting up SoundSystem'))) { instanceInfo.loadStage = 4; console.log(`[Launch] 阶段 4/5: 音频系统就绪 (session: ${sessionId})`); }
                    if (instanceInfo.loadStage < 5 && ((line.includes('Created') && line.includes('textures') && line.includes('-atlas')) || line.includes('Found animation info'))) {
                        instanceInfo.loadStage = 5;
                        if (!instanceInfo.gameReady) {
                            instanceInfo.gameReady = true;
                            instanceInfo.readyTime = Date.now();
                            const launchDuration = instanceInfo.readyTime - instanceInfo.startTime;
                            console.log(`[Launch] 阶段 5/5: 材质加载完成, 耗时: ${(launchDuration / 1000).toFixed(1)}s`);
                        }
                    }
                }
            });
        }

        if (gameProcess.stderr) {
            gameProcess.stderr.on('data', (data) => {
                const lines = data.toString().split('\n').filter(l => l.trim()).map(utils.filterSensitiveInfo);
                instanceInfo.logBuffer.push(...lines);
                if (instanceInfo.logBuffer.length > 5000) instanceInfo.logBuffer = instanceInfo.logBuffer.slice(-3000);
                ctx.sessions.gameLogBuffer.push(...lines);
                if (ctx.sessions.gameLogBuffer.length > 5000) ctx.sessions.gameLogBuffer = ctx.sessions.gameLogBuffer.slice(-3000);
            });
        }

        gameProcess.unref();

        gameProcess.on('close', (code) => {
            try { natives.restoreOfflineSkin(skinBackups); } catch (e) {}
            const _sysInfo = utils.getSystemInfo();
            const recentLogs = instanceInfo.logBuffer.slice(-100).join('\n');
            let analysis = analyzeExitCode(code, launchVersionId);
            // 补充：读取游戏日志文件进行更准确的分析
            const gameLatestLog = (() => { try { return fs.readFileSync(path.join(gameDir, 'logs', 'latest.log'), 'utf8'); } catch(e) { return ''; } })();
            const gameDebugLog = (() => { try { return fs.readFileSync(path.join(gameDir, 'logs', 'debug.log'), 'utf8'); } catch(e) { return ''; } })();
            const gameAllLogs = (gameLatestLog + '\n' + gameDebugLog).toLowerCase();
            if (gameAllLogs.includes('invalid paths argument') || gameAllLogs.includes('contained no existing paths')) {
                analysis.reason = 'Forge核心库文件缺失（Invalid paths argument）';
                analysis.suggestion = 'Forge安装不完整(fmlcore/javafmllanguage/mclanguage/lowcodelanguage缺失)。\n修复: 1)版本设置→文件修复 2)重新安装Forge 3)检查杀毒白名单';
            }
            instanceInfo.logBuffer.push(`[VersePC] 游戏进程退出(session:${sessionId}),代码:${code}`);
            ctx.sessions.gameLogBuffer.push(`[VersePC] 游戏进程退出 (session: ${sessionId})，代码: ${code}`);
            if (analysis.isCrash) {
                instanceInfo.logBuffer.push(`[VersePC] 崩溃分析: ${analysis.reason}`);
                instanceInfo.logBuffer.push(`[VersePC] 建议: ${analysis.suggestion}`);
                ctx.sessions.gameLogBuffer.push(`[VersePC] 崩溃分析: ${analysis.reason}`);
            } else {
                instanceInfo.logBuffer.push(`[VersePC] ${analysis.reason}`);
                ctx.sessions.gameLogBuffer.push(`[VersePC] ${analysis.reason}`);
            }
            ctx.sessions.lastGameExitAnalysis = {
                ...analysis,
                launchInfo: instanceInfo.launchInfo,
                logBuffer: instanceInfo.logBuffer.slice(-50),
                systemInfo: _sysInfo
            };
            try {
                const crashLogs = [];
                const _verDir = path.join(ctx.dirs.VERSIONS_DIR, launchVersionId || versionId);
                if (fs.existsSync(_verDir)) {
                    fs.readdirSync(_verDir).filter(f => f.startsWith('hs_err_pid') && f.endsWith('.log')).forEach(f => crashLogs.push(path.join(_verDir, f)));
                }
                if (fs.existsSync(gameDir)) {
                    fs.readdirSync(gameDir).filter(f => f.startsWith('hs_err_pid') && f.endsWith('.log')).forEach(f => crashLogs.push(path.join(gameDir, f)));
                }
                try {
                    const tmpDir = os.tmpdir();
                    if (fs.existsSync(tmpDir)) {
                        fs.readdirSync(tmpDir).filter(f => f.startsWith('hs_err_pid') && f.endsWith('.log')).forEach(f => crashLogs.push(path.join(tmpDir, f)));
                    }
                } catch (_) {}
                if (crashLogs.length > 0) {
                    crashLogs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
                    ctx.sessions.lastGameExitAnalysis.crashLog = crashLogs[0];
                    ctx.sessions.lastGameExitAnalysis.crashLogs = crashLogs;
                    ctx.sessions.lastGameExitAnalysis.reason = (ctx.sessions.lastGameExitAnalysis.reason || '') + `\nJVM 崩溃日志: ${crashLogs[0]}`;
                    instanceInfo.logBuffer.push(`[VersePC] JVM崩溃日志: ${crashLogs[0]}`);
                    ctx.sessions.gameLogBuffer.push(`[VersePC] JVM崩溃日志: ${crashLogs[0]}`);
                }
            } catch (_) {}
            try {
                const playTimePath = path.join(ctx.dirs.DATA_DIR, 'play-time.json');
                if (fs.existsSync(playTimePath)) {
                    let ptData = JSON.parse(fs.readFileSync(playTimePath, 'utf8'));
                    const vData = ptData[launchVersionId];
                    if (vData && vData._launchTime) {
                        const elapsed = (Date.now() - vData._launchTime) / 1000;
                        vData.totalSeconds = (vData.totalSeconds || 0) + elapsed;
                        delete vData._launchTime;
                        fs.writeFileSync(playTimePath, JSON.stringify(ptData, null, 2), 'utf8');
                    }
                }
            } catch (e) {}
            ctx.sessions.gameInstances.delete(sessionId);
            if (ctx.sessions.gameInstances.size === 0) {
                ctx.sessions.gameLogBuffer = [];
            }
        });

        gameProcess.on('error', (err) => {
            instanceInfo.logBuffer.push(`[VersePC] 启动错误: ${err.message}`);
            ctx.sessions.gameLogBuffer.push(`[VersePC] 启动错误 (session: ${sessionId}): ${err.message}`);
            ctx.sessions.lastGameExitAnalysis = {
                code: -1,
                reason: `启动错误: ${err.message}`,
                suggestion: '请检查Java路径是否正确',
                isCrash: true,
                launchInfo: instanceInfo.launchInfo,
                systemInfo: utils.getSystemInfo()
            };
            ctx.sessions.gameInstances.delete(sessionId);
        });

        return { success: true, pid: gameProcess.pid, sessionId, launchInfo: instanceInfo.launchInfo };
    } catch (e) {
        console.error(`[Launch] 启动异常: ${e.message}`);
        console.error(`[Launch] 堆栈: ${e.stack}`);
        return {
            success: false,
            error: '启动失败: ' + e.message,
            details: {
                versionId,
                mainClass: versionJson.mainClass,
                externalVersionDir,
                error: e.message,
                stack: e.stack
            }
        };
    }
}

// ============================================================================
// 模块导出
// ============================================================================
module.exports = {
    preheatJvm,
    applyPerformanceOptimizations,
    analyzeExitCode,
    setGameLanguage,
    applyWindowSettings,
    buildLaunchArguments,
    launchGame,
    doLaunch
};
