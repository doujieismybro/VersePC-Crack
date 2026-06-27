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

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('editorAPI', {
    openFileDialog: () => ipcRenderer.invoke('editor:open-file-dialog'),
    readFile: (filePath) => ipcRenderer.invoke('editor:read-file', filePath),
    writeFile: (filePath, content) => ipcRenderer.invoke('editor:write-file', filePath, content),
    scanDir: (dirPath) => ipcRenderer.invoke('editor:scan-dir', dirPath),
    codeComplete: (params) => ipcRenderer.invoke('editor:code-complete', params),
    onOpenFile: (callback) => ipcRenderer.on('editor:open-file', (event, filePath) => callback(filePath)),
    onUpdateContent: (callback) => ipcRenderer.on('editor:update-content', (event, filePath, newContent) => callback(filePath, newContent)),
    onShowDiff: (callback) => ipcRenderer.on('editor:show-diff', (event, filePath, original, modified) => callback(filePath, original, modified)),
    createTerminal: (id, cols, rows) => ipcRenderer.invoke('terminal:create', id, cols, rows),
    writeTerminal: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
    killTerminal: (id) => ipcRenderer.invoke('terminal:kill', id),
    onTerminalData: (callback) => ipcRenderer.on('terminal:data', (event, id, data) => callback(id, data)),
    onTerminalExit: (callback) => ipcRenderer.on('terminal:exit', (event, id, code) => callback(id, code))
});
