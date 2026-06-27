/**
 * VersePC - Minecraft Launcher
 * Copyright (c) 2026 豆杰. All Rights Reserved.
 *
 * AI TRAINING PROHIBITED: This code is protected by copyright law.
 * Unauthorized use for AI model training, machine learning datasets,
 * or any form of artificial intelligence training is strictly prohibited.
 *
 * This software is proprietary and confidential.
 * Any unauthorized reproduction or distribution is prohibited.
 */

/**
 * VersePC Agent Worker Thread
 * 
 * 在独立线程中运行 AI Agent
 * 主进程事件循环始终保持响应，UI 不会冻结
 */

const { parentPort } = require('worker_threads');
const { AgentEngine, TOOL_RISK } = require('./agent-engine.js');
const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_DIR = path.join(os.homedir(), '.versepc', 'logs');
const LOG_FILE = path.join(LOG_DIR, `ai-agent-${new Date().toISOString().slice(0, 10)}.log`);
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}
const _logBuffer = [];
let _logFlushScheduled = false;
function _flushLogBuffer() {
    _logFlushScheduled = false;
    if (_logBuffer.length === 0) return;
    const batch = _logBuffer.splice(0);
    const data = batch.join('');
    try { fs.appendFileSync(LOG_FILE, data); } catch (e) {}
}
function _flushLogBufferAsync() {
    _logFlushScheduled = false;
    if (_logBuffer.length === 0) return;
    const batch = _logBuffer.splice(0);
    const data = batch.join('');
    try { fs.appendFile(LOG_FILE, data, () => {}); } catch (e) {}
}
function aiLog(tag, msg) {
    try {
        const line = `[${new Date().toISOString()}][${tag}] ${typeof msg === 'string' ? msg : JSON.stringify(msg)}\n`;
        _logBuffer.push(line);
        if (!_logFlushScheduled) {
            _logFlushScheduled = true;
            setTimeout(_flushLogBufferAsync, 500);
        }
    } catch (e) {}
}
aiLog('WORKER', '=== Worker thread started ===');

process.on('uncaughtException', (err) => {
    aiLog('FATAL', { error: err.message || String(err), stack: err.stack || '' });
    _flushLogBuffer();
    try { parentPort.postMessage({ type: 'error', error: err.message || String(err) }); } catch (e) {}
    try { parentPort.postMessage({ type: 'done' }); } catch (e) {}
});
process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    aiLog('REJECT', { error: msg });
    _flushLogBuffer();
    try { parentPort.postMessage({ type: 'error', error: msg }); } catch (e) {}
    try { parentPort.postMessage({ type: 'done' }); } catch (e) {}
});

let engine = null;
let aborted = false;

const pendingApprovals = new Map();
const pendingExecs = new Map();
let execCounter = 0;
let approvalCounter = 0;

function sendChunk(chunk) {
    if (!chunk) return;
    try { parentPort.postMessage({ type: 'chunk', chunk }); } catch (e) {}
}

function execToolViaMain(name, argsStr) {
    return new Promise((resolve) => {
        const execId = String(++execCounter);
        const timer = setTimeout(() => {
            pendingExecs.delete(execId);
            resolve(JSON.stringify({ status: 'error', error: '工具执行超时(130s)', type: 'timeout' }));
        }, 130000);
        pendingExecs.set(execId, { resolve, timer });
        parentPort.postMessage({ type: 'exec_tool', execId, name, args: argsStr });
    });
}

function requestApprovalViaMain(toolName, argsStr, escalatedRisk, dangerousInfo) {
    return new Promise((resolve) => {
        const aid = `apv_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 6)}`;
        const risk = escalatedRisk || TOOL_RISK[toolName] || 'moderate';
        const timer = setTimeout(() => {
            pendingApprovals.delete(aid);
            resolve({ approved: false, toolName, timeout: true });
        }, 60000);
        pendingApprovals.set(aid, { resolve, timer, toolName });
        parentPort.postMessage({ type: 'approval_request', approvalId: aid, toolName, risk, args: argsStr, dangerous: dangerousInfo || null });
    });
}

function askUserViaMain(question, options, context) {
    return new Promise((resolve) => {
        const askId = `ask_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 6)}`;
        const timer = setTimeout(() => {
            pendingAsks.delete(askId);
            resolve('(用户未在规定时间内回答)');
        }, 120000);
        pendingAsks.set(askId, { resolve, timer });
        parentPort.postMessage({ type: 'ask_user_request', askId, question, options, context });
    });
}
const pendingAsks = new Map();

let reasoningState = { started: false, fullText: '' };

function translateChunk(processed) {
    if (!processed) return null;

    const { type, say, text, partial, delta, trailing } = processed;

    if (type === 'say') {
        switch (say) {
            case 'text': {
                if (delta) return { content: text };
                if (trailing) return { content: text };
                if (partial) return { content: text };
                return null;
            }
            case 'reasoning': {
                if (!partial) {
                    const hadContent = reasoningState.started || reasoningState.fullText.length > 0;
                    reasoningState = { started: false, fullText: '' };
                    if (hadContent || text) return { type: 'reasoning_end' };
                    return null;
                }
                if (text) {
                    const prevLen = reasoningState.fullText.length;
                    reasoningState.fullText += text;
                    if (!reasoningState.started) {
                        reasoningState.started = true;
                        return { type: 'reasoning_start', content: reasoningState.fullText };
                    }
                    return { type: 'reasoning_content', content: reasoningState.fullText };
                }
                if (!reasoningState.started) {
                    reasoningState.started = true;
                    return { type: 'reasoning_start', content: null };
                }
                return null;
            }
            case 'tool_start': {
                try {
                    const calls = JSON.parse(text);
                    const mapped = calls.map(c => ({
                        id: c.id,
                        name: c.name,
                        displayName: c.displayName || c.name,
                        arguments: c.args || '',
                        snapshot: !!c.snapshot
                    }));
                    return { type: 'tool_calls_start', calls: mapped };
                } catch (e) {
                    return null;
                }
            }
            case 'tool_result': {
                try {
                    const parsed = JSON.parse(text);
                    if (parsed.error) {
                        return { type: 'tool_call_result', id: parsed.id, name: parsed.name, error: true, result: parsed.error, snapshot: !!parsed.snapshot };
                    }
                    return {
                        type: 'tool_call_result',
                        id: parsed.id,
                        name: parsed.name,
                        displayName: parsed.displayName || parsed.name,
                        result: parsed.result,
                        elapsed: parsed.elapsed,
                        snapshot: !!parsed.snapshot
                    };
                } catch (e) {
                    return { type: 'tool_call_result', id: '', name: '', result: text };
                }
            }
            case 'tool_end': {
                return { type: 'tool_calls_end' };
            }
            case 'heartbeat': {
                return { type: 'heartbeat', text };
            }
            case 'error': {
                return { type: 'say', say: 'error', text };
            }
            case 'completion': {
                return { done: true };
            }
            case 'api_req_started': {
                return null;
            }
            case 'plan_created': {
                try {
                    const parsed = JSON.parse(text);
                    if (parsed.status === 'generating') return { type: 'planning' };
                    return { type: 'plan_created', plan: parsed };
                } catch (e) { return null; }
            }
            case 'plan_step_update': {
                try {
                    const parsed = JSON.parse(text);
                    return { type: 'plan_step_update', step: parsed.step, status: parsed.status };
                } catch (e) { return null; }
            }
            case 'plan_done': {
                try {
                    const parsed = JSON.parse(text);
                    return { type: 'plan_completed', steps: parsed.steps };
                } catch (e) { return { type: 'plan_completed', steps: 0 }; }
            }
            case 'thinking_step': {
                try {
                    const parsed = JSON.parse(text);
                    return { type: 'thinking_step', step: parsed };
                } catch (e) { return null; }
            }
            case 'reflection': {
                try {
                    const parsed = JSON.parse(text);
                    return { type: 'reflection', reflection: parsed };
                } catch (e) { return null; }
            }
            case 'progress': {
                try {
                    const parsed = JSON.parse(text);
                    return { type: 'install_progress', ...parsed };
                } catch (e) { return { type: 'install_progress', progress: 0 }; }
            }
        }
    }

    return null;
}

engine = new AgentEngine({
    onChunk(processed) {
        if (processed.type && processed.type !== 'say') {
            aiLog('DIRECT', { type: processed.type });
            sendChunk(processed);
            return;
        }
        aiLog('ENGINE', { say: processed.say, partial: processed.partial, delta: processed.delta, textLen: (processed.text || '').length });
        const chunk = translateChunk(processed);
        if (chunk) sendChunk(chunk);
    },
    onRequestApproval(toolName, argsStr, escalatedRisk, dangerousInfo) {
        aiLog('APPROVAL', { toolName, escalatedRisk, dangerous: !!dangerousInfo });
        return requestApprovalViaMain(toolName, argsStr, escalatedRisk, dangerousInfo);
    },
    onAskUser(question, options, context) {
        return askUserViaMain(question, options, context);
    },
    executeTool(name, argsStr) {
        aiLog('EXEC_TOOL', { name, argsLen: (argsStr || '').length });
        return execToolViaMain(name, argsStr);
    }
});

if (parentPort) {
parentPort.on('message', (msg) => {
    aiLog('MSG', { type: msg.type });
    try {
        switch (msg.type) {
            case 'start':
                aborted = false;
                if (msg.params && msg.params.currentMode) {
                    engine._currentMode = msg.params.currentMode;
                }
                aiLog('START', { model: msg.params?.model, tools: msg.params?.tools?.length || 0, msgs: msg.params?.messages?.length || 0, mode: engine._currentMode });
                engine.processChat(msg.params).then(() => {
                    aiLog('DONE', 'processChat completed');
                    parentPort.postMessage({ type: 'done' });
                }).catch(e => {
                    aiLog('ERROR', e.message);
                    sendChunk({ error: e.message });
                    parentPort.postMessage({ type: 'done' });
                });
                break;
            case 'abort':
                aborted = true;
                engine.abort();
                for (const [, pending] of pendingApprovals) {
                    clearTimeout(pending.timer);
                    pending.resolve({ approved: false });
                }
                pendingApprovals.clear();
                for (const [, pending] of pendingExecs) {
                    clearTimeout(pending.timer);
                    pending.resolve(JSON.stringify({ status: 'aborted' }));
                }
                pendingExecs.clear();
                for (const [, pending] of pendingAsks) {
                    clearTimeout(pending.timer);
                    pending.resolve('(已中断)');
                }
                pendingAsks.clear();
                parentPort.postMessage({ type: 'done' });
                break;
            case 'approval_response':
                {
                    const pending = pendingApprovals.get(msg.approvalId);
                    if (pending) {
                        clearTimeout(pending.timer);
                        pendingApprovals.delete(msg.approvalId);
                        pending.resolve({ approved: msg.approved });
                    }
                }
                break;
            case 'exec_tool_result':
                {
                    const pending = pendingExecs.get(msg.execId);
                    if (pending) {
                        clearTimeout(pending.timer);
                        pendingExecs.delete(msg.execId);
                        pending.resolve(msg.result);
                    }
                }
                break;
        }
        if (msg.type === 'ask_user_response') {
            const pending = pendingAsks.get(msg.askId);
            if (pending) {
                clearTimeout(pending.timer);
                pendingAsks.delete(msg.askId);
                pending.resolve(msg.answer);
            }
        }
    } catch (e) {
        try {
            parentPort.postMessage({ type: 'error', error: e.message });
        } catch (e2) {}
    }
});
} else {
    console.error('[AgentWorker] parentPort is null - not running in Worker thread');
}