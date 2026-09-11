'use strict';

// Electron shell for the serverless walkie-talkie. The app itself is
// renderer/walkie.html (copied from ../serverless by `npm run sync`); this
// process adds what a web page can't do:
//   - a system-wide hold-to-talk key (works while other apps are focused)
//   - running in the tray so you keep hearing the channel
//   - native microphone permission handling

const {
  app, BrowserWindow, Tray, Menu, ipcMain, session, systemPreferences, nativeImage, shell,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { makePng } = require('./icon');

let uIOhook = null;
let UiohookKey = {};
let hookError = null;
try {
  ({ uIOhook, UiohookKey } = require('uiohook-napi'));
} catch (err) {
  hookError = err.message;
}

// Testing aids: fake mic, remote debugging, several instances on one machine.
if (process.env.WALKIE_FAKE_MEDIA) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}
if (process.env.WALKIE_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.WALKIE_DEBUG_PORT);
}
const multiInstance = Boolean(process.env.WALKIE_MULTI_INSTANCE);
if (multiInstance) {
  app.setPath('userData', path.join(app.getPath('userData'), `instance-${process.pid}`));
}

// ---------------------------------------------------------------------------
// Settings

// pttKey: uiohook keycode; pttMouse: mouse button number (3 = middle, 4/5 = side buttons)
// and, when set, it's used instead of the key.
const DEFAULT_SETTINGS = { pttKey: 66 /* F8 */, pttMouse: null, closeToTray: true, trayHintShown: false };
let settings = { ...DEFAULT_SETTINGS };

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch { /* first run */ }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Could not save settings:', err.message);
  }
}

const KEY_NAMES = Object.fromEntries(Object.entries(UiohookKey).map(([name, code]) => [code, name]));
const keyName = (code) => KEY_NAMES[code] || `Key ${code}`;

const MOUSE_NAMES = { 3: 'Middle mouse', 4: 'Mouse 4', 5: 'Mouse 5' };
const bindingName = () => (settings.pttMouse
  ? MOUSE_NAMES[settings.pttMouse] || `Mouse ${settings.pttMouse}`
  : keyName(settings.pttKey));

function pttKeyInfo() {
  return { available: Boolean(uIOhook), error: hookError, name: bindingName() };
}

// ---------------------------------------------------------------------------
// Global hold-to-talk

let win = null;
let tray = null;
let quitting = false;
let keyHeld = false;
let captureResolve = null;

function sendPtt(down) {
  if (win && !win.isDestroyed()) win.webContents.send('ptt', down);
}

function startHook() {
  if (!uIOhook) return;

  const capture = (binding) => {
    const done = captureResolve;
    captureResolve = null;
    done(binding);
  };

  uIOhook.on('keydown', (e) => {
    if (captureResolve) return capture({ key: e.keycode });
    // The OS repeats keydown while a key is held; only the first one counts.
    if (!settings.pttMouse && e.keycode === settings.pttKey && !keyHeld) {
      keyHeld = true;
      sendPtt(true);
    }
  });
  uIOhook.on('keyup', (e) => {
    if (!settings.pttMouse && e.keycode === settings.pttKey && keyHeld) {
      keyHeld = false;
      sendPtt(false);
    }
  });

  // Mouse buttons 3+ (middle, side buttons) can be talk buttons; left/right clicks never.
  uIOhook.on('mousedown', (e) => {
    if (captureResolve && e.button >= 3) return capture({ mouse: e.button });
    if (settings.pttMouse && e.button === settings.pttMouse && !keyHeld) {
      keyHeld = true;
      sendPtt(true);
    }
  });
  uIOhook.on('mouseup', (e) => {
    if (settings.pttMouse && e.button === settings.pttMouse && keyHeld) {
      keyHeld = false;
      sendPtt(false);
    }
  });

  try {
    uIOhook.start();
  } catch (err) {
    hookError = err.message;
    uIOhook = null;
  }
}

function registerIpc() {
  ipcMain.handle('ptt-key:get', () => pttKeyInfo());

  ipcMain.handle('ptt-key:capture', () => new Promise((resolve) => {
    if (!uIOhook) {
      resolve(pttKeyInfo());
      return;
    }
    if (keyHeld) {
      keyHeld = false;
      sendPtt(false);
    }
    const timer = setTimeout(() => {
      captureResolve = null;
      resolve(pttKeyInfo());
    }, 15_000);
    captureResolve = (binding) => {
      clearTimeout(timer);
      if (binding.mouse) {
        settings.pttMouse = binding.mouse;
      } else if (binding.key !== UiohookKey.Escape) {
        settings.pttKey = binding.key;
        settings.pttMouse = null;
      }
      saveSettings();
      updateTrayMenu();
      resolve(pttKeyInfo());
    };
  }));

  ipcMain.on('status', (_event, text) => {
    if (tray) tray.setToolTip(`Walkie: ${String(text).slice(0, 100)}`);
  });

  ipcMain.handle('settings:get', () => ({
    closeToTray: settings.closeToTray,
    openAtLogin: app.getLoginItemSettings().openAtLogin,
  }));

  ipcMain.handle('settings:set', (_event, patch) => {
    if (patch && typeof patch.closeToTray === 'boolean') {
      settings.closeToTray = patch.closeToTray;
      saveSettings();
      updateTrayMenu();
    }
    if (patch && typeof patch.openAtLogin === 'boolean') {
      app.setLoginItemSettings({ openAtLogin: patch.openAtLogin });
    }
  });

  // Keep the native window buttons in step with the page's light/dark theme.
  ipcMain.on('theme', (_event, theme) => {
    if (!win || win.isDestroyed() || process.platform === 'darwin') return;
    const light = theme === 'light';
    try {
      win.setTitleBarOverlay({ color: light ? '#e8e9ec' : '#17181b', symbolColor: light ? '#1f2328' : '#e8eaed' });
      win.setBackgroundColor(light ? '#f3f3f4' : '#1e1f22');
    } catch { /* overlay not supported */ }
  });
}

// ---------------------------------------------------------------------------
// Window & tray

function appIcon(sizes) {
  const img = nativeImage.createEmpty();
  sizes.forEach((size, i) => img.addRepresentation({ scaleFactor: i + 1, buffer: makePng(size) }));
  return img;
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 360,
    minHeight: 560,
    title: 'Walkie',
    backgroundColor: '#1e1f22',
    icon: appIcon([64, 128]),
    autoHideMenuBar: true,
    // The page's top bar is the title bar; the OS draws the window buttons over its right end.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 14 } }
      : { titleBarOverlay: { color: '#17181b', symbolColor: '#e8eaed', height: 44 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      // Keep audio, timers and connections at full speed while hidden in the tray.
      backgroundThrottling: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.on('close', (e) => {
    if (quitting || !settings.closeToTray || !tray) return;
    e.preventDefault();
    win.hide();
    if (!settings.trayHintShown && process.platform === 'win32') {
      tray.displayBalloon({
        title: 'Walkie is still running',
        content: `You'll keep hearing your channel. Hold ${bindingName()} to talk. Right-click the tray icon to quit.`,
      });
      settings.trayHintShown = true;
      saveSettings();
    }
  });
  win.on('closed', () => { win = null; });

  win.loadFile(path.join(__dirname, 'renderer', 'walkie.html'));
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Walkie', click: showWindow },
    {
      label: uIOhook ? `Talk key: ${bindingName()}` : 'Global talk key unavailable',
      enabled: false,
    },
    {
      label: 'Keep running when window is closed',
      type: 'checkbox',
      checked: settings.closeToTray,
      click: (item) => {
        settings.closeToTray = item.checked;
        saveSettings();
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  tray = new Tray(appIcon([16, 32]));
  tray.setToolTip('Walkie');
  tray.on('click', showWindow);
  updateTrayMenu();
}

// Allow the microphone (audio only), location (map sharing, opt-in in the page),
// notifications (opt-in in Settings) and clipboard writes for the Invite button;
// deny everything else.
function setupPermissions() {
  const allowed = new Set(['media', 'geolocation', 'notifications', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'media') {
      const types = (details && details.mediaTypes) || [];
      callback(types.every((t) => t === 'audio'));
      return;
    }
    callback(allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

// ---------------------------------------------------------------------------
// App lifecycle

if (!multiInstance && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    loadSettings();
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    setupPermissions();
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      await systemPreferences.askForMediaAccess('microphone');
    }
    registerIpc();
    createTray();
    createWindow();
    startHook();
  });

  app.on('activate', showWindow);
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => {
    if (uIOhook) {
      try { uIOhook.stop(); } catch { /* already stopped */ }
    }
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
