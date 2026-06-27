/**
 * server/api/routes/lan.js - 局域网与 EasyTier 路由
 * ============================================================================
 * 从 server.js handleAPI switch 语句抽取的局域网联机与 EasyTier (Terracotta) 相关端点。
 * 包含 LAN 房间管理、UPnP 端口映射、EasyTier 虚拟局域网等功能。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

module.exports = {
    register(registerRoute, deps) {
        const { ctx, sendJSON, sendError, readBody } = deps;
        const { network, terracotta } = deps;

        const DATA_DIR = ctx.dirs.DATA_DIR;
        const TERRACOTTA_LOG_FILE = ctx.dirs.TERRACOTTA_LOG_FILE;
        const lanRooms = ctx.network.lanRooms;
        const upnpMappings = ctx.network.upnpMappings;

        // ====================================================================
        // /api/lan/create
        // ====================================================================
        registerRoute('POST', '/api/lan/create', async (req, res, parsedUrl) => {
            const data = await readBody(req);
            const roomName = data.name || '';
            const gamePort = data.port || 25565;
            const playerName = data.playerName || '主机';

            try {
                const result = network.createLANRoom(roomName, gamePort, playerName);
                sendJSON(res, { success: true, code: result.code, relayPort: result.relayPort, name: result.name });
            } catch (e) {
                sendError(res, '创建房间失败: ' + e.message);
            }
        });

        // ====================================================================
        // /api/lan/join
        // ====================================================================
        registerRoute('POST', '/api/lan/join', async (req, res, parsedUrl) => {
            const data = await readBody(req);
            const code = (data.code || '').toUpperCase().trim();
            const playerName = data.playerName || '玩家';

            if (!code) { sendError(res, '请输入房间号', 400); return; }

            const room = lanRooms.get(code);
            if (!room) { sendError(res, '房间不存在', 404); return; }
            if (room.status !== 'active') { sendError(res, '房间未就绪', 400); return; }

            const peerId = crypto.randomUUID();
            room.peers.set(peerId, { id: peerId, name: playerName, connectedAt: Date.now() });

            sendJSON(res, {
                success: true,
                code: room.code,
                name: room.name,
                hostPlayer: room.hostPlayer,
                relayPort: room.relayPort,
                gamePort: room.gamePort,
                peerId
            });
        });

        // ====================================================================
        // /api/lan/info
        // ====================================================================
        registerRoute('GET', '/api/lan/info', async (req, res, parsedUrl) => {
            const code = (parsedUrl.query.code || '').toUpperCase().trim();
            if (!code) { sendError(res, 'Missing code', 400); return; }

            const info = network.getLANRoomInfo(code);
            if (!info) { sendError(res, '房间不存在', 404); return; }

            sendJSON(res, { success: true, room: info });
        });

        // ====================================================================
        // /api/lan/leave
        // ====================================================================
        registerRoute('POST', '/api/lan/leave', async (req, res, parsedUrl) => {
            const data = await readBody(req);
            const code = (data.code || '').toUpperCase().trim();
            const peerId = data.peerId || '';

            const room = lanRooms.get(code);
            if (!room) { sendJSON(res, { success: true }); return; }

            if (peerId) {
                const conn = room.connections.get(peerId);
                if (conn) {
                    if (conn.client) conn.client.destroy();
                    if (conn.server) conn.server.destroy();
                    room.connections.delete(peerId);
                }
                room.peers.delete(peerId);
            }

            sendJSON(res, { success: true });
        });

        // ====================================================================
        // /api/lan/destroy
        // ====================================================================
        registerRoute('POST', '/api/lan/destroy', async (req, res, parsedUrl) => {
            const data = await readBody(req);
            const code = (data.code || '').toUpperCase().trim();
            network.destroyLANRoom(code);
            sendJSON(res, { success: true });
        });

        // ====================================================================
        // /api/lan/my-ip
        // ====================================================================
        registerRoute('GET', '/api/lan/my-ip', async (req, res, parsedUrl) => {
            const nets = os.networkInterfaces();
            const ips = [];
            for (const name of Object.keys(nets)) {
                for (const net of nets[name]) {
                    if (net.family === 'IPv4' && !net.internal) {
                        ips.push({ interface: name, address: net.address });
                    }
                }
            }
            const publicIP = await network.getPublicIP();
            sendJSON(res, { success: true, ips, publicIP });
        });

        // ====================================================================
        // /api/lan/upnp-map
        // ====================================================================
        registerRoute('POST', '/api/lan/upnp-map', async (req, res, parsedUrl) => {
            const upnpData = await readBody(req);
            const internalPort = parseInt(upnpData.internalPort, 10) || 25565;
            const externalPort = parseInt(upnpData.externalPort, 10) || internalPort;
            const desc = upnpData.description || 'VersePC Minecraft';

            const result = await network.upnpAddPortMapping(internalPort, externalPort, desc);
            sendJSON(res, result);
        });

        // ====================================================================
        // /api/lan/upnp-unmap
        // ====================================================================
        registerRoute('POST', '/api/lan/upnp-unmap', async (req, res, parsedUrl) => {
            const unmapData = await readBody(req);
            const extPort = parseInt(unmapData.externalPort, 10);
            if (!extPort) { sendError(res, 'Missing externalPort', 400); return; }

            const result = await network.upnpDeletePortMapping(extPort);
            sendJSON(res, result);
        });

        // ====================================================================
        // /api/lan/upnp-status
        // ====================================================================
        registerRoute('GET', '/api/lan/upnp-status', async (req, res, parsedUrl) => {
            sendJSON(res, {
                success: true,
                mappings: Array.from(upnpMappings.entries()).map(([ext, int]) => ({
                    externalPort: ext, internalPort: int.internalPort, description: int.description, localIP: int.localIP
                }))
            });
        });

        // ====================================================================
        // /api/lan/upnp-diagnose
        // ====================================================================
        registerRoute('GET', '/api/lan/upnp-diagnose', async (req, res, parsedUrl) => {
            const diag = { platform: os.platform(), checks: [], canUseUPnP: false, recommendations: [] };

            diag.checks.push({ name: 'Platform', result: os.platform(), status: 'info' });

            const netIfs = os.networkInterfaces();
            const localIPs = [];
            for (const name of Object.keys(netIfs)) {
                for (const net of netIfs[name]) {
                    if (net.family === 'IPv4' && !net.internal) {
                        localIPs.push({ address: net.address, interface: name });
                    }
                }
            }
            diag.checks.push({ name: 'Local IPs', result: localIPs, status: localIPs.length > 0 ? 'ok' : 'warn' });

            if (localIPs.length === 0) {
                diag.recommendations.push('No non-internal IPv4 addresses found. Check network connection.');
            } else {
                const hasPrivateIP = localIPs.some(ip => {
                    const p = ip.address.split('.').map(Number);
                    return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
                });
                if (hasPrivateIP) {
                    diag.checks.push({ name: 'NAT Detection', result: 'Behind NAT (private IP)', status: 'info' });
                    diag.recommendations.push('You are behind NAT. UPnP port mapping is needed for remote connections.');
                } else {
                    diag.checks.push({ name: 'NAT Detection', result: 'Public IP detected', status: 'ok' });
                }
            }

            if (os.platform() === 'win32') {
                try {
                    const ssdpSvc = execSync('sc query SSDPSRV', { encoding: 'utf8', timeout: 5000 });
                    const isRunning = ssdpSvc.includes('RUNNING');
                    diag.checks.push({ name: 'Windows SSDP Discovery Service', result: isRunning ? 'Running (may conflict)' : 'Not running', status: isRunning ? 'warn' : 'ok' });
                    if (isRunning) {
                        diag.recommendations.push('Windows SSDP Discovery service is running and may intercept UPnP responses. You can stop it with: sc stop SSDPSRV (requires admin)');
                    }
                } catch (e) {
                    diag.checks.push({ name: 'Windows SSDP Discovery Service', result: 'Could not check', status: 'warn' });
                }
            }

            try {
                const gateway = await network.discoverUPnPGateway();
                diag.checks.push({ name: 'UPnP Gateway Discovery', result: `Found: ${gateway.address}`, status: 'ok' });

                try {
                    const ctrlInfo = await network.getUPnPControlURL(gateway.location);
                    diag.checks.push({ name: 'WANIPConnection Service', result: ctrlInfo.serviceType || 'Found', status: 'ok' });
                    diag.canUseUPnP = true;
                } catch (e) {
                    diag.checks.push({ name: 'WANIPConnection Service', result: e.message, status: 'fail' });
                    diag.recommendations.push('Gateway found but WANIPConnection service not available. Your router may not support UPnP port mapping.');
                }
            } catch (e) {
                diag.checks.push({ name: 'UPnP Gateway Discovery', result: e.message, status: 'fail' });
                diag.recommendations.push('UPnP gateway not found. Please check:');
                diag.recommendations.push('1. Router UPnP feature is enabled in router admin panel');
                diag.recommendations.push('2. Windows Firewall allows UDP port 1900 (SSDP)');
                diag.recommendations.push('3. Network type is set to "Private" not "Public"');
                diag.recommendations.push('4. No other security software blocking multicast traffic');
            }

            try {
                const publicIP = await network.getPublicIP();
                diag.checks.push({ name: 'Public IP', result: publicIP, status: 'ok' });
            } catch (e) {
                diag.checks.push({ name: 'Public IP', result: 'Could not detect', status: 'warn' });
            }

            if (diag.recommendations.length === 0 && diag.canUseUPnP) {
                diag.recommendations.push('UPnP appears to be working correctly.');
            }

            sendJSON(res, { success: true, diagnosis: diag });
        });

        // ====================================================================
        // /api/lan/remote-create
        // ====================================================================
        registerRoute('POST', '/api/lan/remote-create', async (req, res, parsedUrl) => {
            const rData = await readBody(req);
            const roomName = rData.name || '';
            const gamePort = parseInt(rData.port, 10) || 25565;
            const playerName = rData.playerName || '主机';
            const useUPnP = rData.useUPnP !== false;

            try {
                let wsPort = 31000 + Math.floor(Math.random() * 100);
                let wsResult = null;

                for (let attempt = 0; attempt < 5; attempt++) {
                    try {
                        wsResult = network.startWSRelayServer(wsPort);
                        if (wsResult.success) break;
                    } catch (e) {
                        console.log('[LAN-Remote] WS port', wsPort, 'failed:', e.message);
                    }
                    wsPort = 31000 + Math.floor(Math.random() * 1000);
                }

                if (!wsResult || !wsResult.success) {
                    sendError(res, 'WebSocket中继启动失败');
                    return;
                }

                let upnpResult = null;
                let publicIP = null;

                if (useUPnP) {
                    try {
                        upnpResult = await network.upnpAddPortMapping(gamePort, gamePort, 'VersePC Minecraft');
                    } catch (e) {
                        console.log('[LAN-Remote] UPnP failed:', e.message);
                        upnpResult = { success: false, error: e.message };
                    }
                }

                try {
                    publicIP = await network.getPublicIP();
                } catch (e) {
                    console.log('[LAN-Remote] Public IP detection failed:', e.message);
                }

                const localIPs = [];
                try {
                    const netIfs = os.networkInterfaces();
                    for (const name of Object.keys(netIfs)) {
                        for (const net of netIfs[name]) {
                            if (net.family === 'IPv4' && !net.internal) {
                                localIPs.push(net.address);
                            }
                        }
                    }
                } catch (e) {}

                sendJSON(res, {
                    success: true,
                    wsPort: wsResult.port,
                    gamePort,
                    upnp: upnpResult,
                    publicIP,
                    localIPs,
                    connectInfo: publicIP ? `${publicIP}:${gamePort}` : (localIPs[0] ? `${localIPs[0]}:${gamePort}` : 'unknown')
                });
            } catch (e) {
                console.error('[LAN-Remote] Error:', e);
                sendError(res, '创建远程房间失败: ' + e.message);
            }
        });

        // ====================================================================
        // /api/lan/public-ip
        // ====================================================================
        registerRoute('GET', '/api/lan/public-ip', async (req, res, parsedUrl) => {
            const pubIP = await network.getPublicIP();
            sendJSON(res, { success: true, publicIP: pubIP });
        });

        // ====================================================================
        // /api/lan/port
        // ====================================================================
        registerRoute('GET', '/api/lan/port', async (req, res, parsedUrl) => {
            sendJSON(res, { success: true, port: ctx.sessions.detectedLanPort });
        });

        // ====================================================================
        // /api/easytier/status
        // ====================================================================
        registerRoute('GET', '/api/easytier/status', async (req, res, parsedUrl) => {
            console.log('[Terracotta] API: 查询状态');
            const terracottaState = await terracotta.getTerracottaState();
            const terracottaStatus = ctx.network.terracottaStatus;
            sendJSON(res, {
                success: true,
                installed: terracotta.isTerracottaInstalled(),
                running: terracottaStatus.running,
                mode: terracottaStatus.mode,
                roomCode: terracottaStatus.roomCode,
                virtualIP: terracottaStatus.virtualIP,
                gamePort: terracottaStatus.gamePort,
                state: terracottaState,
                profiles: terracottaStatus.profiles || [],
                difficulty: terracottaStatus.difficulty || null,
                errorType: terracottaStatus.errorType || null,
                errorMessage: terracottaStatus.errorMessage || null
            });
        });

        // ====================================================================
        // /api/easytier/host
        // ====================================================================
        registerRoute('POST', '/api/easytier/host', async (req, res, parsedUrl) => {
            const etHostData = await readBody(req);
            const etGamePort = etHostData.gamePort || 25565;
            console.log(`[Terracotta] API: 创建主机 | 端口: ${etGamePort} | 玩家: ${etHostData.playerName || '未知'}`);

            try {
                const result = await terracotta.terracottaStartHost(etGamePort, etHostData.playerName);
                sendJSON(res, { success: true, ...result });
            } catch (e) {
                console.error(`[Terracotta] API: 创建主机失败: ${e.message}`);
                sendError(res, '创建联机失败: ' + e.message);
            }
        });

        // ====================================================================
        // /api/easytier/guest
        // ====================================================================
        registerRoute('POST', '/api/easytier/guest', async (req, res, parsedUrl) => {
            const etGuestData = await readBody(req);
            const etGuestRoomCode = etGuestData.roomCode || etGuestData.invitationCode;
            console.log(`[Terracotta] API: 加入房间 | 房间码: ${etGuestRoomCode || '空'} | 玩家: ${etGuestData.playerName || '未知'}`);

            if (!etGuestRoomCode) {
                sendError(res, '缺少房间码', 400);
                return;
            }

            try {
                const result = await terracotta.terracottaStartGuest(etGuestRoomCode, etGuestData.playerName);
                sendJSON(res, { success: true, ...result });
            } catch (e) {
                console.error(`[Terracotta] API: 加入房间失败: ${e.message}`);
                sendError(res, '加入联机失败: ' + e.message);
            }
        });

        // ====================================================================
        // /api/easytier/stop
        // ====================================================================
        registerRoute('POST', '/api/easytier/stop', async (req, res, parsedUrl) => {
            terracotta.stopTerracotta();
            sendJSON(res, { success: true });
        });

        // ====================================================================
        // /api/easytier/diagnose
        // ====================================================================
        registerRoute('GET', '/api/easytier/diagnose', async (req, res, parsedUrl) => {
            const diagResults = [];
            const nodes = await terracotta.fetchTerracottaPublicNodes(true);
            console.log(`[Terracotta] 诊断: 测试 ${nodes.length} 个公共节点...`);
            for (const node of nodes) {
                const start = Date.now();
                let status = 'unknown';
                let latency = -1;
                try {
                    if (node.startsWith('http')) {
                        const ctrl = new AbortController();
                        const t = setTimeout(() => ctrl.abort(), 5000);
                        const r = await fetch(node, { method: 'HEAD', signal: ctrl.signal });
                        clearTimeout(t);
                        status = r.ok ? 'ok' : `http_${r.status}`;
                        latency = Date.now() - start;
                    } else {
                        const proto = node.split('://')[0];
                        const hostPort = node.split('://')[1];
                        const host = hostPort.split(':')[0];
                        const port = parseInt(hostPort.split(':')[1], 10) || 11010;
                        const net = require('net');
                        await new Promise((resolve, reject) => {
                            const sock = net.createConnection({ host, port, timeout: 5000 }, () => {
                                status = 'ok';
                                latency = Date.now() - start;
                                sock.destroy();
                                resolve();
                            });
                            sock.on('error', (e) => { status = `err_${e.code}`; reject(e); });
                            sock.on('timeout', () => { status = 'timeout'; sock.destroy(); reject(new Error('timeout')); });
                        });
                    }
                } catch (e) {
                    if (status === 'unknown') status = `err_${e.code || e.message}`;
                }
                diagResults.push({ node, status, latency });
                console.log(`[Terracotta] 诊断: ${node} -> ${status} (${latency}ms)`);
            }
            sendJSON(res, { nodes: diagResults });
        });

        // ====================================================================
        // /api/easytier/peers
        // ====================================================================
        registerRoute('GET', '/api/easytier/peers', async (req, res, parsedUrl) => {
            const terracottaState = await terracotta.getTerracottaState();
            sendJSON(res, { success: true, state: terracottaState, status: ctx.network.terracottaStatus });
        });

        // ====================================================================
        // /api/easytier/log
        // ====================================================================
        registerRoute('GET', '/api/easytier/log', async (req, res, parsedUrl) => {
            if (!ctx.network.terracottaHttpPort) { sendJSON(res, { log: '' }); return; }
            try {
                const logData = await terracotta.terracottaHttpGet('/log?fetch=true');
                sendJSON(res, { log: typeof logData === 'string' ? logData : JSON.stringify(logData) });
            } catch (e) {
                sendJSON(res, { log: '', error: e.message });
            }
        });

        // ====================================================================
        // /api/easytier/filelog
        // ====================================================================
        registerRoute('GET', '/api/easytier/filelog', async (req, res, parsedUrl) => {
            try {
                if (fs.existsSync(TERRACOTTA_LOG_FILE)) {
                    const logContent = fs.readFileSync(TERRACOTTA_LOG_FILE, 'utf8');
                    sendJSON(res, { success: true, log: logContent });
                } else {
                    sendJSON(res, { success: true, log: '' });
                }
            } catch (e) {
                sendJSON(res, { success: false, error: e.message });
            }
        });

        // ====================================================================
        // /api/easytier/download
        // ====================================================================
        registerRoute('POST', '/api/easytier/download', async (req, res, parsedUrl) => {
            try {
                const etDir = path.join(DATA_DIR, 'easytier');
                if (!fs.existsSync(etDir)) fs.mkdirSync(etDir, { recursive: true });
                const etBin = path.join(etDir, 'easytier.exe');
                if (fs.existsSync(etBin)) { sendJSON(res, { success: true, message: 'already installed' }); return; }
                const etUrl = 'https://github.com/EasyTier/EasyTier/releases/latest/download/easytier-windows-x86_64.zip';
                const etZip = path.join(etDir, 'easytier.zip');
                const dlRes = await fetch(etUrl, { redirect: 'follow' });
                if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);
                const buffer = Buffer.from(await dlRes.arrayBuffer());
                fs.writeFileSync(etZip, buffer);
                const AdmZip = require('adm-zip');
                const zip = new AdmZip(etZip);
                zip.extractAllTo(etDir, true);
                fs.unlinkSync(etZip);
                const extracted = fs.readdirSync(etDir).find(f => f.endsWith('.exe'));
                if (extracted && extracted !== 'easytier.exe') {
                    fs.renameSync(path.join(etDir, extracted), etBin);
                }
                sendJSON(res, { success: true });
            } catch (e) {
                sendJSON(res, { error: e.message });
            }
        });

        // ====================================================================
        // /api/easytier/download-status
        // ====================================================================
        registerRoute('GET', '/api/easytier/download-status', async (req, res, parsedUrl) => {
            sendJSON(res, { status: 'completed', progress: 100 });
        });
    }
};
