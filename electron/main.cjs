const { app, BrowserWindow, ipcMain, shell, Menu, nativeImage } = require('electron');
const path = require('path');
const { checkReadiness } = require('./server-health.cjs');
const { createDragFiles } = require('./drag-files.cjs');
const { spawn } = require('child_process');
const { existsSync, mkdirSync } = require('fs');
const { readFile, writeFile, mkdir } = require('fs').promises;
const {
  findPython,
  downloadPython,
  installPython,
  createVenv,
  installRembg,
  isRembgInstalled,
  getRembgExe,
} = require('./setup-helpers.cjs');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const isDev = !app.isPackaged;
const SERVER_PORT = 7777;

function getUserDataPath(...parts) {
  return path.join(app.getPath('userData'), ...parts);
}

const CONFIG_PATH = () => getUserDataPath('config.json');
const VENV_PATH = () => getUserDataPath('venv');
const MODELS_PATH = () => getUserDataPath('models');

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_PATH(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return { setupComplete: false };
  }
}

async function saveConfig(patch) {
  let current = {};
  try { current = JSON.parse(await readFile(CONFIG_PATH(), 'utf8')); } catch {}
  const next = { ...current, ...patch };
  mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
  await writeFile(CONFIG_PATH(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ---------------------------------------------------------------------------
// rembg server lifecycle
// ---------------------------------------------------------------------------

let rembgProcess = null;
let mainWindow = null;

let serverState = { running: false, ready: false, starting: false, port: SERVER_PORT, revision: 0 };
let startupController;
let serverOperation = Promise.resolve();

function publishServer(patch) {
  serverState = { ...serverState, ...patch, revision: serverState.revision + 1 };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('server:state', serverState);
}

function startServer(config) {
  // Serialize restarts so an old child cannot steal the new child's port/state.
  serverOperation = serverOperation.then(async () => {
    await stopServer();
    const rembgExe = getRembgExe(config.venvPath || VENV_PATH());
    if (!existsSync(rembgExe)) {
      publishServer({ starting: false, error: 'rembg executable not found. Please re-run setup.' });
      return;
    }
    mkdirSync(MODELS_PATH(), { recursive: true });
    const pythonExe = path.join(path.dirname(rembgExe), 'python.exe');
    // Python cannot read Electron's virtual app.asar filesystem.
    const launcher = isDev ? path.join(__dirname, 'rembg-server.py')
      : path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'rembg-server.py');
    const child = spawn(pythonExe, ['-u', launcher, 's', '--host', '127.0.0.1', '--port', String(SERVER_PORT), '--no-ui'], {
      windowsHide: true,
      env: { ...process.env, U2NET_HOME: MODELS_PATH(), BROWSER: 'nul' },
    });
    rembgProcess = child;
    const controller = new AbortController();
    startupController = controller;
    publishServer({ running: true, starting: true, ready: false, error: null });
    child.stdout.on('data', d => console.log('[rembg]', d.toString().trim()));
    child.stderr.on('data', d => console.error('[rembg]', d.toString().trim()));
    const failed = msg => {
      if (rembgProcess !== child) return;
      rembgProcess = null;
      controller.abort();
      publishServer({ running: false, ready: false, starting: false, error: msg });
    };
    child.on('error', err => failed(err.message));
    child.on('exit', code => failed('rembg server exited (code ' + code + ')'));
    // Probe only during startup; process events own subsequent lifecycle state.
    (async () => {
      const deadline = Date.now() + 60000;
      let error;
      while (!controller.signal.aborted && Date.now() < deadline) {
        try {
          await checkReadiness('http://127.0.0.1:' + SERVER_PORT, controller.signal);
          if (rembgProcess === child && !controller.signal.aborted) publishServer({ ready: true, starting: false, error: null });
          return;
        } catch (err) { error = err.message; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (rembgProcess === child && !controller.signal.aborted) {
        publishServer({ ready: false, starting: false, error: 'rembg did not become ready: ' + error });
      }
    })();
  }).catch(err => publishServer({ ready: false, starting: false, error: err.message }));
  return serverOperation;
}

async function stopServer() {
  startupController?.abort();
  const child = rembgProcess;
  rembgProcess = null;
  publishServer({ running: false, ready: false, starting: false });
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Previous rembg process did not stop.')), 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.once('error', () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 360,
    minHeight: 460,
    title: 'DeBG',
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false, // allows fetch() to localhost rembg server from file://
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  if (!isDev) Menu.setApplicationMenu(null);

  if (isDev) {
    mainWindow.loadURL('http://localhost:5180');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------------------------------------------------------------------------
// IPC: Setup
// ---------------------------------------------------------------------------

ipcMain.handle('setup:check', async () => {
  const config = await loadConfig();
  const venvPath = config.venvPath || VENV_PATH();
  // Run Python detection now so the wizard can show accurate status immediately
  const pythonInfo = findPython();
  return {
    complete: config.setupComplete === true && isRembgInstalled(venvPath),
    config,
    pythonInfo, // { path, version } or null
  };
});

ipcMain.handle('setup:run', async (event, backend) => {
  const send = (data) => {
    if (!event.sender.isDestroyed()) event.sender.send('setup:progress', data);
  };

  try {
    // Step 1 - Python
    send({ step: 1, type: 'status', msg: 'Checking for Python 3.11-3.13...' });
    let pythonInfo = findPython();

    if (!pythonInfo) {
      const installerPath = await downloadPython((p) => send({ step: 1, ...p }));
      const pyExe = await installPython(installerPath, (p) => send({ step: 1, ...p }));
      pythonInfo = { path: pyExe, version: '3.12' };
    } else {
      send({ step: 1, type: 'status', msg: `Found Python ${pythonInfo.version} at ${pythonInfo.path}` });
    }

    await saveConfig({ pythonPath: pythonInfo.path });

    // Step 2 - Venv
    const venvPath = VENV_PATH();
    send({ step: 2, type: 'status', msg: 'Setting up virtual environment…' });
    await createVenv(pythonInfo.path, venvPath, (p) => send({ step: 2, ...p }));
    await saveConfig({ venvPath });

    // Step 3 - rembg
    send({ step: 3, type: 'status', msg: `Installing rembg[${backend},cli]…` });
    await installRembg(venvPath, backend, (p) => send({ step: 3, ...p }));
    await saveConfig({ setupComplete: true, backend });

    return { success: true };
  } catch (err) {
    console.error('Setup error:', err);
    return { success: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// IPC: Config
// ---------------------------------------------------------------------------

ipcMain.handle('config:get', async () => loadConfig());
ipcMain.handle('config:save', async (_, patch) => saveConfig(patch));

// ---------------------------------------------------------------------------
// IPC: Model cache check
// ---------------------------------------------------------------------------

const { isModelCached } = require('./model-cache.cjs');
ipcMain.handle('model:check', (_, modelId) => isModelCached(MODELS_PATH(), modelId));

// ---------------------------------------------------------------------------
// IPC: Server
// ---------------------------------------------------------------------------

ipcMain.handle('window:set-always-on-top', (event, value) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || typeof value !== 'boolean') throw new Error('Invalid window request');
  mainWindow.setAlwaysOnTop(value);
  return mainWindow.isAlwaysOnTop();
});

ipcMain.handle('server:status', () => serverState);

ipcMain.handle('server:restart', async () => {
  const config = await loadConfig();
  await startServer(config);
  return { ok: true };
});

ipcMain.handle('server:switch-backend', async (event, backend) => {
  const send = (data) => {
    if (!event.sender.isDestroyed()) event.sender.send('switch:progress', data);
  };

  try {
    await stopServer();
    const config = await loadConfig();
    const venvPath = config.venvPath || VENV_PATH();

    send({ type: 'status', msg: `Reinstalling rembg[${backend},cli]…` });
    await installRembg(venvPath, backend, (p) => send(p));
    await saveConfig({ backend });

    await startServer({ ...config, venvPath });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Prepared PNG capabilities are scoped to the main window's top-level frame.
let dragFiles;
const dragPreparations = new Set();
function trustedDragSender(event) {
  return mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents
    && event.senderFrame === mainWindow.webContents.mainFrame;
}
ipcMain.handle('result:prepare-drag', async (event, { name, buffer }) => {
  if (!trustedDragSender(event)) throw new Error('Untrusted drag sender.');
  const preparation = dragFiles.prepare(event.sender.id, name, buffer);
  dragPreparations.add(preparation);
  try { return await preparation; }
  finally { dragPreparations.delete(preparation); }
});
ipcMain.on('result:start-drag', (event, token) => {
  if (!trustedDragSender(event)) return;
  try { dragFiles.start(event.sender.id, token, event.sender); }
  catch (err) { console.error('Native drag failed:', err); }
});
ipcMain.on('result:release-drag', (event, token) => {
  if (trustedDragSender(event)) dragFiles.release(event.sender.id, token);
});

// ---------------------------------------------------------------------------
// IPC: Output folder / auto-save
// ---------------------------------------------------------------------------

ipcMain.handle('output:get-default', () =>
  path.join(app.getPath('pictures'), 'bg-removed')
);

ipcMain.handle('output:pick-folder', async () => {
  const result = await require('electron').dialog.showOpenDialog(mainWindow, {
    title: 'Choose output folder for saved images',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('output:save-file', async (_, { folder, filename, buffer }) => {
  await mkdir(folder, { recursive: true });
  // Avoid overwriting - append numeric suffix if the file already exists
  let dest = path.join(folder, filename);
  if (existsSync(dest)) {
    const ext  = path.extname(filename);
    const base = filename.slice(0, filename.length - ext.length);
    let n = 2;
    do { dest = path.join(folder, `${base}-${n}${ext}`); n++; } while (existsSync(dest));
  }
  await writeFile(dest, Buffer.from(buffer));
  return dest;
});

ipcMain.handle('output:open-folder', (_, folder) => {
  shell.openPath(folder);
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  dragFiles = createDragFiles(app.getPath('temp'), nativeImage);
  createWindow();
  const config = await loadConfig();
  if (config.setupComplete && isRembgInstalled(config.venvPath || VENV_PATH())) {
    startServer(config);
  }
});

app.on('window-all-closed', () => {
  stopServer().catch(console.error);
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

let quitting = false;
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  Promise.allSettled([stopServer(), ...dragPreparations])
    .then(() => dragFiles?.cleanup())
    .catch(console.error)
    .finally(() => app.quit());
});
