'use strict';

// The only bridge between the page and Electron. The page feature-detects
// window.walkieNative, so the same walkie.html still works in a plain browser.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('walkieNative', {
  platform: process.platform,
  // Global hold-to-talk key: cb(true) on press, cb(false) on release.
  onPtt: (cb) => ipcRenderer.on('ptt', (_event, down) => cb(Boolean(down))),
  getPttKey: () => ipcRenderer.invoke('ptt-key:get'),
  // Resolves with the new binding after the user presses a key or mouse side button (Esc cancels).
  capturePttKey: () => ipcRenderer.invoke('ptt-key:capture'),
  setStatus: (text) => ipcRenderer.send('status', String(text)),
  // Desktop-only settings: { closeToTray, openAtLogin }.
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setTheme: (theme) => ipcRenderer.send('theme', theme === 'light' ? 'light' : 'dark'),
});
