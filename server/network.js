/**
 * server/network.js - UPnP/网络/mcPing 功能模块
 * ============================================================================
 * 从 server.js 抽取的 LAN 房间、UPnP 端口映射、WS 中继、MC Ping 等网络功能。
 * 通过 ctx (./context) 访问共享状态，通过 utils (./utils) 访问工具函数，
 * 通过 httpClient (./http-client) 访问 HTTP 客户端功能。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const dgram = require('dgram');
const url = require('url');
const crypto = require('crypto');
const os = require('os');

const WebSocket = require('ws');

const ctx = require('./context');
const utils = require('./utils');
const httpClient = require('./http-client');

// ============================================================================
// 辅助函数
// ============================================================================
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(6);
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[bytes[i] % chars.length];
    return code;
}

// ============================================================================
// LAN 房间
// ============================================================================
function createLANRoom(roomName, gamePort, playerName) {
    const code = generateRoomCode();
    while (ctx.network.lanRooms.has(code)) { code = generateRoomCode(); }

    const net = require('net');
    const dgram = require('dgram');

    const relayPort = 30000 + Math.floor(Math.random() * 1000);

    const room = {
        code,
        name: roomName || `房间 ${code}`,
        hostPlayer: playerName || '主机',
        gamePort: parseInt(gamePort, 10) || 25565,
        relayPort,
        peers: new Map(),
        connections: new Map(),
        createdAt: Date.now(),
        status: 'waiting'
    };

    const relayServer = net.createServer((clientSocket) => {
        const peerId = crypto.randomUUID();
        clientSocket.peerId = peerId;

        const mcServer = net.createConnection({ host: '127.0.0.1', port: room.gamePort }, () => {
            room.connections.set(peerId, { client: clientSocket, server: mcServer, connected: true });
            room.peers.set(peerId, { id: peerId, name: `玩家${room.peers.size + 1}`, connectedAt: Date.now() });
            console.log(`[LAN] Peer ${peerId} connected, forwarding to MC server :${room.gamePort}`);
        });

        clientSocket.on('data', (data) => {
            if (mcServer.writable) mcServer.write(data);
        });

        mcServer.on('data', (data) => {
            if (clientSocket.writable) clientSocket.write(data);
        });

        clientSocket.on('close', () => {
            mcServer.destroy();
            room.connections.delete(peerId);
            room.peers.delete(peerId);
            console.log(`[LAN] Peer ${peerId} disconnected`);
        });

        mcServer.on('close', () => {
            clientSocket.destroy();
            room.connections.delete(peerId);
        });

        clientSocket.on('error', () => { mcServer.destroy(); });
        mcServer.on('error', () => { clientSocket.destroy(); });
    });

    relayServer.listen(relayPort, '0.0.0.0', () => {
        console.log(`[LAN] Room ${code} relay listening on port ${relayPort}`);
        room.status = 'active';
    });

    relayServer.on('error', (e) => {
        console.error(`[LAN] Relay server error:`, e.message);
        room.status = 'error';
    });

    room.relayServer = relayServer;
    ctx.network.lanRooms.set(code, room);
    ctx.network.lanRelayServers.set(code, relayServer);

    return { code, relayPort, name: room.name };
}

function destroyLANRoom(code) {
    const room = ctx.network.lanRooms.get(code);
    if (!room) return;

    room.connections.forEach((conn) => {
        if (conn.client) conn.client.destroy();
        if (conn.server) conn.server.destroy();
    });
    room.peers.clear();
    room.connections.clear();

    const relay = ctx.network.lanRelayServers.get(code);
    if (relay) {
        relay.close();
        ctx.network.lanRelayServers.delete(code);
    }

    ctx.network.lanRooms.delete(code);
    console.log(`[LAN] Room ${code} destroyed`);
}

function getLANRoomInfo(code) {
    const room = ctx.network.lanRooms.get(code);
    if (!room) return null;

    return {
        code: room.code,
        name: room.name,
        hostPlayer: room.hostPlayer,
        gamePort: room.gamePort,
        relayPort: room.relayPort,
        status: room.status,
        peerCount: room.peers.size,
        peers: Array.from(room.peers.values()).map(p => ({
            id: p.id,
            name: p.name,
            connectedAt: p.connectedAt
        }))
    };
}

// ============================================================================
// UPnP
// ============================================================================
function getLocalIPForGateway(gatewayAddress) {
    const netIfs = os.networkInterfaces();
    for (const name of Object.keys(netIfs)) {
        for (const net of netIfs[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                const parts = net.address.split('.').map(Number);
                const gwParts = gatewayAddress.split('.').map(Number);
                if (parts[0] === gwParts[0] && parts[1] === gwParts[1] && parts[2] === gwParts[2]) {
                    return net.address;
                }
            }
        }
    }
    for (const name of Object.keys(netIfs)) {
        for (const net of netIfs[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return '127.0.0.1';
}

async function discoverUPnPGateway() {
    if (ctx.network.upnpGatewayCache) {
        return ctx.network.upnpGatewayCache;
    }

    const searchTypes = [
        'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
        'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
        'upnp:rootdevice'
    ];

    for (const st of searchTypes) {
        try {
            const result = await _ssdpSearch(st, 3);
            if (result) {
                ctx.network.upnpGatewayCache = result;
                return result;
            }
        } catch (e) {
            console.log(`[UPnP] SSDP search for ${st} failed:`, e.message);
        }
    }

    throw new Error('未检测到UPnP网关。请检查: 1) 路由器已开启UPnP功能 2) Windows SSDP发现服务未被禁用 3) 防火墙允许UDP 1900端口');
}

function _ssdpSearch(searchType, maxRetries) {
    return new Promise((resolve, reject) => {
        const dgram = require('dgram');
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        const ssdpMsg = [
            'M-SEARCH * HTTP/1.1',
            'HOST: 239.255.255.250:1900',
            'MAN: "ssdp:discover"',
            'MX: 5',
            `ST: ${searchType}`,
            '', ''
        ].join('\r\n');

        let found = false;
        let retryCount = 0;
        let retryTimer = null;
        const timeout = 8000;

        const timer = setTimeout(() => {
            if (!found) {
                clearTimeout(retryTimer);
                socket.close();
                reject(new Error(`SSDP search timeout for ${searchType}`));
            }
        }, timeout);

        socket.on('message', (msg, rinfo) => {
            const str = msg.toString();
            if (str.includes('InternetGatewayDevice') || str.includes('WANIPConnection') || str.includes('WANPPPConnection')) {
                const locationMatch = str.match(/LOCATION:\s*(.+)/i);
                if (locationMatch) {
                    found = true;
                    clearTimeout(timer);
                    clearTimeout(retryTimer);
                    socket.close();
                    const result = { location: locationMatch[1].trim(), address: rinfo.address };
                    resolve(result);
                }
            }
        });

        socket.on('error', (e) => {
            clearTimeout(timer);
            clearTimeout(retryTimer);
            socket.close();
            reject(e);
        });

        socket.bind(() => {
            try {
                socket.addMembership('239.255.255.250');
            } catch (e) {
                console.log('[UPnP] addMembership failed (non-fatal):', e.message);
            }
            socket.setBroadcast(true);
            socket.setMulticastTTL(4);

            const sendSearch = () => {
                if (found || retryCount >= maxRetries) return;
                retryCount++;
                socket.send(ssdpMsg, 1900, '239.255.255.250', (err) => {
                    if (err) {
                        clearTimeout(timer);
                        clearTimeout(retryTimer);
                        socket.close();
                        reject(err);
                    }
                });
                if (retryCount < maxRetries) {
                    retryTimer = setTimeout(sendSearch, 2000);
                }
            };
            sendSearch();
        });
    });
}

async function getUPnPControlURL(gatewayLocation) {
    return new Promise((resolve, reject) => {
        let parsedUrl;
        try { parsedUrl = new URL(gatewayLocation); } catch (e) { return reject(new Error('Invalid gateway URL')); }

        const req = http.request({
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 80,
            path: parsedUrl.pathname + (parsedUrl.search || ''),
            method: 'GET',
            timeout: 10000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const match = data.match(/<URLBase>(.*?)<\/URLBase>/);
                const baseUrl = match ? match[1] : `${parsedUrl.protocol}//${parsedUrl.host}`;

                const serviceTypes = [
                    'urn:schemas-upnp-org:service:WANIPConnection:1',
                    'urn:schemas-upnp-org:service:WANIPConnection:2',
                    'urn:schemas-upnp-org:service:WANPPPConnection:1'
                ];

                for (const svcType of serviceTypes) {
                    const escapedType = svcType.replace(/([.:])/g, '\\$1');
                    const svcRegex = new RegExp(
                        `<service>[\\s\\S]*?<serviceType>${escapedType}<\\/serviceType>[\\s\\S]*?<controlURL>(.*?)<\\/controlURL>[\\s\\S]*?<\\/service>`, 'i'
                    );
                    const svcMatch = data.match(svcRegex);
                    if (svcMatch) {
                        resolve({ baseUrl, controlUrl: svcMatch[1], serviceType: svcType });
                        return;
                    }
                }

                const anyWanMatch = data.match(/<service>[\s\S]*?<serviceType>(urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:\d+)<\/serviceType>[\s\S]*?<controlURL>(.*?)<\/controlURL>[\s\S]*?<\/service>/i);
                if (anyWanMatch) {
                    resolve({ baseUrl, controlUrl: anyWanMatch[2], serviceType: anyWanMatch[1] });
                    return;
                }

                reject(new Error('WANIPConnection service not found in gateway description'));
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout fetching gateway description')); });
        req.end();
    });
}

async function upnpAddPortMapping(internalPort, externalPort, description) {
    try {
        const gateway = await discoverUPnPGateway();
        const { baseUrl, controlUrl, serviceType } = await getUPnPControlURL(gateway.location);
        const svcType = serviceType || 'urn:schemas-upnp-org:service:WANIPConnection:1';
        const localIP = getLocalIPForGateway(gateway.address);

        let parsedBase;
        try { parsedBase = new URL(baseUrl); } catch (e) { return { success: false, error: 'Invalid base URL' }; }
        const soapBody = [
            '<?xml version="1.0"?>',
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
            '<s:Body>',
            `<u:AddPortMapping xmlns:u="${svcType}">`,
            '<NewRemoteHost></NewRemoteHost>',
            `<NewExternalPort>${externalPort}</NewExternalPort>`,
            '<NewProtocol>TCP</NewProtocol>',
            `<NewInternalClient>${localIP}</NewInternalClient>`,
            `<NewInternalPort>${internalPort}</NewInternalPort>`,
            '<NewEnabled>1</NewEnabled>',
            `<NewPortMappingDescription>${description || 'VersePC'}</NewPortMappingDescription>`,
            '<NewLeaseDuration>0</NewLeaseDuration>',
            '</u:AddPortMapping>',
            '</s:Body>',
            '</s:Envelope>'
        ].join('');

        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: parsedBase.hostname,
                port: parsedBase.port || 80,
                path: controlUrl,
                method: 'POST',
                headers: {
                    'Content-Type': 'text/xml; charset=utf-8',
                    'SOAPAction': `"${svcType}#AddPortMapping"`,
                    'Content-Length': Buffer.byteLength(soapBody)
                },
                timeout: 10000
            }, (res) => {
                if (res.statusCode === 200 || res.statusCode === 204) {
                    ctx.network.upnpMappings.set(externalPort, { internalPort, description, localIP });
                    resolve({ success: true, externalPort, internalPort, localIP });
                } else {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        const errorCodeMatch = data.match(/<errorCode>(\d+)<\/errorCode>/);
                        const errorDescMatch = data.match(/<errorDescription>(.*?)<\/errorDescription>/);
                        const errorCode = errorCodeMatch ? errorCodeMatch[1] : res.statusCode;
                        const errorDesc = errorDescMatch ? errorDescMatch[1] : data.substring(0, 200);

                        if (errorCode === '725') {
                            reject(new Error('Router does not allow permanent port mapping (error 725). Try with a lease duration.'));
                        } else if (errorCode === '718') {
                            reject(new Error('Port mapping conflict: another mapping already exists for this port (error 718).'));
                        } else if (errorCode === '606') {
                            reject(new Error('Router rejected the mapping (error 606). Try a different external port.'));
                        } else {
                            reject(new Error(`UPnP AddPortMapping failed: ${errorCode} ${errorDesc}`));
                        }
                    });
                }
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            req.write(soapBody);
            req.end();
        });
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function upnpDeletePortMapping(externalPort) {
    try {
        const gateway = await discoverUPnPGateway();
        const { baseUrl, controlUrl, serviceType } = await getUPnPControlURL(gateway.location);
        const svcType = serviceType || 'urn:schemas-upnp-org:service:WANIPConnection:1';

        let parsedBase;
        try { parsedBase = new URL(baseUrl); } catch (e) { return { success: false, error: 'Invalid base URL' }; }
        const soapBody = [
            '<?xml version="1.0"?>',
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
            '<s:Body>',
            `<u:DeletePortMapping xmlns:u="${svcType}">`,
            '<NewRemoteHost></NewRemoteHost>',
            `<NewExternalPort>${externalPort}</NewExternalPort>`,
            '<NewProtocol>TCP</NewProtocol>',
            '</u:DeletePortMapping>',
            '</s:Body>',
            '</s:Envelope>'
        ].join('');

        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: parsedBase.hostname,
                port: parsedBase.port || 80,
                path: controlUrl,
                method: 'POST',
                headers: {
                    'Content-Type': 'text/xml; charset=utf-8',
                    'SOAPAction': `"${svcType}#DeletePortMapping"`,
                    'Content-Length': Buffer.byteLength(soapBody)
                },
                timeout: 10000
            }, (res) => {
                if (res.statusCode === 200 || res.statusCode === 204) {
                    ctx.network.upnpMappings.delete(externalPort);
                    ctx.network.upnpGatewayCache = null;
                    resolve({ success: true });
                } else {
                    reject(new Error(`UPnP DeletePortMapping failed: ${res.statusCode}`));
                }
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            req.write(soapBody);
            req.end();
        });
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function getPublicIP() {
    const services = [
        'https://api.ipify.org?format=json',
        'https://api64.ipify.org?format=json',
        'https://ifconfig.me/ip'
    ];

    for (const service of services) {
        try {
            const result = await new Promise((resolve, reject) => {
                const client = service.startsWith('https') ? https : http;
                const req = client.get(service, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(data);
                            resolve(json.ip);
                        } catch {
                            resolve(data.trim());
                        }
                    });
                });
                req.on('error', reject);
                req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
            });
            if (result && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(result)) {
                return result;
            }
        } catch (e) { continue; }
    }
    return null;
}

// ============================================================================
// WebSocket 中继
// ============================================================================
function startWSRelayServer(port) {
    if (ctx.network.wsRelayServer) return { success: true, port: ctx.network.wsRelayServer.port };

    try {
        ctx.network.wsRelayServer = new WebSocket.Server({ port, maxPayload: 10 * 1024 * 1024 });
        ctx.network.wsRelayServer.port = port;

        ctx.network.wsRelayServer.on('connection', (ws, req) => {
            ws.isAlive = true;
            ws.on('pong', () => { ws.isAlive = true; });

            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    handleWSMessage(ws, msg);
                } catch (e) {}
            });

            ws.on('close', () => {
                if (ws.roomCode) {
                    const room = ctx.network.wsRelayRooms.get(ws.roomCode);
                    if (room) {
                        if (ws.role === 'host') {
                            room.host = null;
                            room.clients.forEach(c => { try { c.close(); } catch(e){} });
                            ctx.network.wsRelayRooms.delete(ws.roomCode);
                        } else {
                            room.clients.delete(ws);
                            if (room.host) {
                                try { room.host.send(JSON.stringify({ type: 'peer-left', peerId: ws.peerId })); } catch(e){}
                            }
                        }
                    }
                }
            });
        });

        const interval = setInterval(() => {
            ctx.network.wsRelayServer.clients.forEach(ws => {
                if (!ws.isAlive) return ws.terminate();
                ws.isAlive = false;
                ws.ping();
            });
        }, 30000);

        ctx.network.wsRelayServer.on('close', () => clearInterval(interval));

        console.log(`[WS-Relay] Server started on port ${port}`);
        return { success: true, port };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function handleWSMessage(ws, msg) {
    switch (msg.type) {
        case 'create-room': {
            const code = msg.code || generateRoomCode();
            while (ctx.network.wsRelayRooms.has(code)) { code = generateRoomCode(); }

            ws.roomCode = code;
            ws.role = 'host';

            const room = {
                code,
                host: ws,
                clients: new Set(),
                gamePort: msg.gamePort || 25565,
                roomName: msg.roomName || `房间 ${code}`,
                hostPlayer: msg.hostPlayer || '主机',
                createdAt: Date.now()
            };
            ctx.network.wsRelayRooms.set(code, room);

            ws.send(JSON.stringify({ type: 'room-created', code, gamePort: room.gamePort }));
            break;
        }
        case 'join-room': {
            const code = (msg.code || '').toUpperCase().trim();
            const room = ctx.network.wsRelayRooms.get(code);

            if (!room || !room.host) {
                ws.send(JSON.stringify({ type: 'join-failed', error: '房间不存在' }));
                return;
            }

            ws.roomCode = code;
            ws.role = 'client';
            ws.peerId = crypto.randomUUID();
            ws.playerName = msg.playerName || '玩家';

            room.clients.add(ws);

            ws.send(JSON.stringify({
                type: 'join-success',
                code,
                peerId: ws.peerId,
                roomName: room.roomName,
                hostPlayer: room.hostPlayer
            }));

            try {
                room.host.send(JSON.stringify({
                    type: 'peer-joined',
                    peerId: ws.peerId,
                    playerName: ws.playerName
                }));
            } catch(e){}
            break;
        }
        case 'mc-data': {
            if (ws.role === 'client' && ws.roomCode) {
                const room = ctx.network.wsRelayRooms.get(ws.roomCode);
                if (room && room.host) {
                    try { room.host.send(JSON.stringify({ type: 'mc-data', data: msg.data, peerId: ws.peerId })); } catch(e){}
                }
            } else if (ws.role === 'host' && ws.roomCode) {
                const room = ctx.network.wsRelayRooms.get(ws.roomCode);
                if (room && msg.peerId) {
                    room.clients.forEach(client => {
                        if (client.peerId === msg.peerId) {
                            try { client.send(JSON.stringify({ type: 'mc-data', data: msg.data })); } catch(e){}
                        }
                    });
                }
            }
            break;
        }
        case 'mc-connect': {
            if (ws.role === 'client' && ws.roomCode) {
                const room = ctx.network.wsRelayRooms.get(ws.roomCode);
                if (room && room.host) {
                    try { room.host.send(JSON.stringify({ type: 'mc-connect', peerId: ws.peerId, playerName: ws.playerName })); } catch(e){}
                }
            }
            break;
        }
        case 'mc-disconnect': {
            if (ws.role === 'client' && ws.roomCode) {
                const room = ctx.network.wsRelayRooms.get(ws.roomCode);
                if (room && room.host) {
                    try { room.host.send(JSON.stringify({ type: 'mc-disconnect', peerId: ws.peerId })); } catch(e){}
                }
            }
            break;
        }
        case 'list-rooms': {
            const rooms = [];
            ctx.network.wsRelayRooms.forEach((room, code) => {
                if (room.host) {
                    rooms.push({ code, name: room.roomName, hostPlayer: room.hostPlayer, peers: room.clients.size });
                }
            });
            ws.send(JSON.stringify({ type: 'room-list', rooms }));
            break;
        }
    }
}

// ============================================================================
// Minecraft 协议 VarInt 编解码
// ============================================================================
function encodeVarInt(value) {
    const bytes = [];
    do {
        let temp = value & 0x7F;
        value >>>= 7;
        if (value !== 0) temp |= 0x80;
        bytes.push(temp);
    } while (value !== 0);
    return Buffer.from(bytes);
}

function decodeVarInt(buffer, offset) {
    let result = 0;
    let shift = 0;
    let bytesRead = 0;
    while (true) {
        const b = buffer[offset + bytesRead];
        result |= (b & 0x7F) << shift;
        bytesRead++;
        if ((b & 0x80) === 0) break;
        shift += 7;
    }
    return { value: result, bytesRead };
}

async function mcPing(host, port = 25565, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        socket.setTimeout(timeout);

        let resolved = false;
        const finish = (result) => {
            if (resolved) return;
            resolved = true;
            socket.destroy();
            resolve(result);
        };

        socket.on('timeout', () => finish({ online: false, error: 'timeout' }));
        socket.on('error', (err) => finish({ online: false, error: err.message }));

        socket.connect(port, host, () => {
            const pingStart = Date.now();

            const handshakeData = [
                encodeVarInt(0),
                encodeVarInt(772),
                encodeVarInt(host.length),
                Buffer.from(host, 'utf8'),
                Buffer.from([(port >> 8) & 0xFF, port & 0xFF]),
                encodeVarInt(1)
            ];
            const handshakeBody = Buffer.concat(handshakeData);
            const handshakePacket = Buffer.concat([encodeVarInt(handshakeBody.length), handshakeBody]);

            const statusBody = encodeVarInt(0);
            const statusPacket = Buffer.concat([encodeVarInt(statusBody.length), statusBody]);

            socket.write(handshakePacket);
            socket.write(statusPacket);

            const tsBuf = Buffer.alloc(8);
            tsBuf.writeBigInt64BE(BigInt(pingStart));
            const pingPkt = Buffer.concat([Buffer.from([9, 1]), tsBuf]);

            socket.write(pingPkt);

            let data = Buffer.alloc(0);
            socket.on('data', (chunk) => {
                data = Buffer.concat([data, chunk]);

                try {
                    let offset = 0;
                    const packetLen = decodeVarInt(data, offset);
                    offset += packetLen.bytesRead;

                    const packetId = decodeVarInt(data, offset);
                    offset += packetId.bytesRead;

                    if (packetId.value === 0) {
                        const jsonLen = decodeVarInt(data, offset);
                        offset += jsonLen.bytesRead;

                        if (offset + jsonLen.value <= data.length) {
                            const jsonStr = data.slice(offset, offset + jsonLen.value).toString('utf8');
                            const latency = Date.now() - pingStart;

                            try {
                                const status = JSON.parse(jsonStr);
                                finish({
                                    online: true,
                                    version: status.version?.name || 'Unknown',
                                    protocol: status.version?.protocol || 0,
                                    players: {
                                        online: status.players?.online || 0,
                                        max: status.players?.max || 0,
                                        sample: status.players?.sample || []
                                    },
                                    description: typeof status.description === 'string'
                                        ? status.description
                                        : JSON.stringify(status.description),
                                    favicon: status.favicon || null,
                                    latency: latency
                                });
                            } catch (e) {
                                finish({ online: false, error: 'parse error' });
                            }
                        }
                    }
                } catch (e) {
                }
            });
        });
    });
}

module.exports = {
    createLANRoom,
    destroyLANRoom,
    getLANRoomInfo,
    getLocalIPForGateway,
    discoverUPnPGateway,
    _ssdpSearch,
    getUPnPControlURL,
    upnpAddPortMapping,
    upnpDeletePortMapping,
    getPublicIP,
    startWSRelayServer,
    handleWSMessage,
    encodeVarInt,
    decodeVarInt,
    mcPing,
};
