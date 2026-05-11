/**
 * Workspace Client - Electron Main Process
 * Gère la fenêtre d'application et la connexion au serveur distant
 */
const { app, BrowserWindow, ipcMain, shell, Notification, nativeImage, Menu, globalShortcut, crashReporter, net } = require('electron');
const path = require('path');
const url = require('url');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { exec, execSync, execFile, spawn } = require('child_process');
const PDFDocument = require('pdfkit');

/** Activer les envois de logs debug vers l'endpoint ingest (débug session). Définir WORKSPACE_DEBUG=1 pour activer. */
const DEBUG_INGEST = process.env.WORKSPACE_DEBUG === '1';

// Crash reporting : dumps locaux par défaut ; pour envoi à Sentry/Bugsnag, définir CRASH_REPORT_URL (ex. https://sentry.io/...)
try {
    if (process.type !== 'renderer' && crashReporter && typeof crashReporter.start === 'function') {
        const submitURL = process.env.CRASH_REPORT_URL || '';
        crashReporter.start({
            submitURL: submitURL || 'https://localhost/crash', // requis par l'API ; ignoré si uploadToServer: false
            uploadToServer: !!submitURL,
            compress: true,
            globalExtra: { appVersion: (typeof app.getVersion === 'function' ? app.getVersion() : null) || process.env.npm_package_version || '0.0.0' }
        });
    }
} catch (e) {
    console.warn('[CrashReporter] init skipped:', e?.message);
}

// #region agent log (bootstrap debug log pour AppImage sur autres machines)
function getAppImageDebugLogPath() {
    try {
        if (app.isPackaged) {
            return path.join(app.getPath('userData'), 'debug.log');
        }
        return path.join(__dirname, '..', '..', '.cursor', 'debug.log');
    } catch (_) {
        return path.join(os.homedir(), '.config', 'workspace-client-debug.log');
    }
}
function writeAppImageDebugLog(payload) {
    try {
        const logPath = getAppImageDebugLogPath();
        const dir = path.dirname(logPath);
        if (!fs.existsSync(dir)) {
            try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { }
        }
        fs.appendFileSync(logPath, JSON.stringify({ ...payload, timestamp: Date.now() }) + '\n');
    } catch (_) { }
}
try {
    writeAppImageDebugLog({
        hypothesisId: 'H4-H5',
        location: 'main.js:bootstrap',
        message: 'main_started',
        data: {
            platform: process.platform,
            arch: process.arch,
            nodeVersion: process.version,
            packaged: app.isPackaged,
            execPath: process.execPath ? path.basename(process.execPath) : ''
        }
    });
} catch (_) { }
process.on('uncaughtException', (err) => {
    writeAppImageDebugLog({ hypothesisId: 'H4', location: 'uncaughtException', message: String(err && err.message), data: { stack: err && err.stack } });
});
process.on('unhandledRejection', (reason) => {
    writeAppImageDebugLog({ hypothesisId: 'H4', location: 'unhandledRejection', message: String(reason) });
});
// #endregion

// #region agent log (session debug - écran redémarrage MAJ)
const DEBUG_SESSION_LOG = path.join(__dirname, '..', '..', '.cursor', 'debug-3375e0.log');
const FALLBACK_SESSION_LOG = process.platform === 'linux' && process.env.HOME
    ? path.join(process.env.HOME, '.config', 'workspace-client', 'debug-3375e0.log')
    : null;
function sessionLog(payload) {
    const line = JSON.stringify({ sessionId: '3375e0', ...payload, timestamp: Date.now() }) + '\n';
    try {
        fs.appendFileSync(DEBUG_SESSION_LOG, line);
    } catch (_) {
        if (FALLBACK_SESSION_LOG) {
            try {
                const d = path.dirname(FALLBACK_SESSION_LOG);
                if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
                fs.appendFileSync(FALLBACK_SESSION_LOG, line);
            } catch (_2) { }
        }
    }
}
// #endregion

// Import ClientDiscovery et module de mise à jour (désactivé au démarrage : MAJ manuelle)
const ClientDiscovery = require('./lib/ClientDiscovery.js');
const { runAutoUpdate } = require('./lib/update.js');

// Détection environnement (production vs développement)
const isProduction = process.env.NODE_ENV === 'production' || app.isPackaged;

/**
 * Obtenir toutes les IPs locales du réseau
 */
function getLocalNetworkIPs() {
    const interfaces = os.networkInterfaces();
    const ips = [];

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // IPv4, non-interne
            if (iface.family === 'IPv4' && !iface.internal) {
                const parts = iface.address.split('.');
                const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`;
                ips.push({ subnet, myIp: iface.address });
            }
        }
    }
    return ips;
}

/**
 * Tester la connexion à une IP:PORT spécifique
 */
function testServerConnection(ip, port = 8060, timeout = 1000) {
    return new Promise((resolve) => {
        const req = http.get(`http://${ip}:${port}/api/health`, { timeout }, (res) => {
            if (res.statusCode === 200) {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const health = JSON.parse(data);
                        if (health.status === 'ok') {
                            resolve({ found: true, url: `http://${ip}:${port}` });
                        } else {
                            resolve({ found: false });
                        }
                    } catch (e) {
                        resolve({ found: false });
                    }
                });
            } else {
                resolve({ found: false });
            }
        });

        req.on('error', () => resolve({ found: false }));
        req.on('timeout', () => {
            req.destroy();
            resolve({ found: false });
        });
    });
}

/**
 * Scanner le réseau local pour trouver le serveur
 */
async function discoverServer(port = 8060) {
    console.log('🔍 Recherche du serveur via beacons UDP...');

    // D'abord, essayer la découverte via beacons UDP
    const discovery = new ClientDiscovery();

    try {
        const server = await discovery.findServer(5000);  // Timeout de 5 secondes
        if (server) {
            return server;
        }
    } catch (err) {
        console.warn('⚠️  Erreur lors de la découverte UDP:', err.message);
    }

    console.log('🔍 Fallback: Recherche manuelle du serveur sur le réseau...');

    const networks = getLocalNetworkIPs();
    if (networks.length === 0) {
        console.warn('⚠️  Aucune interface réseau détectée');
        return null;
    }

    // Tester d'abord localhost
    console.log('🔍 Test localhost...');
    const localhostTest = await testServerConnection('localhost', port, 500);
    if (localhostTest.found) {
        console.log('✅ Serveur trouvé sur localhost');
        return { url: localhostTest.url, ws: `ws://localhost:${port}` };
    }

    // Ensuite tester notre propre IP
    for (const network of networks) {
        console.log(`🔍 Test ${network.myIp}...`);
        const selfTest = await testServerConnection(network.myIp, port, 500);
        if (selfTest.found) {
            console.log(`✅ Serveur trouvé sur ${network.myIp}`);
            return { url: selfTest.url, ws: `ws://${network.myIp}:${port}` };
        }
    }

    // Scanner le sous-réseau (en parallèle pour plus de rapidité)
    for (const network of networks) {
        console.log(`🔍 Scan du réseau ${network.subnet}.0/24...`);
        const promises = [];

        for (let i = 1; i <= 254; i++) {
            const ip = `${network.subnet}.${i}`;
            if (ip !== network.myIp) {  // Skip notre propre IP déjà testée
                promises.push(testServerConnection(ip, port, 800));
            }
        }

        const results = await Promise.all(promises);
        for (let i = 0; i < results.length; i++) {
            if (results[i].found) {
                const foundIp = results[i].url.replace('http://', '').replace(`:${port}`, '');
                console.log(`✅ Serveur trouvé sur ${foundIp}`);
                return { url: results[i].url, ws: `ws://${foundIp}:${port}` };
            }
        }
    }

    console.warn('⚠️  Aucun serveur trouvé sur le réseau');
    return null;
}

// Charger la configuration serveur centralisée
let serverConfig = {};
try {
    const configPath = path.join(__dirname, 'config', 'connection.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    serverConfig = JSON.parse(configData);
    console.log('✅ Configuration serveur chargée:', serverConfig.mode);
} catch (error) {
    console.error('❌ Erreur chargement config serveur:', error.message);
    // Fallback to default local config
    serverConfig = {
        mode: 'local',
        environments: {
            local: {
                url: 'http://localhost:8060',
                ws: 'ws://localhost:8060'
            }
        },
        endpoints: {
            health: '/api/health'
        }
    };
}

// Configuration initiale (fallback) - La vraie config vient du client web via ConnectionConfig.js
const MODE = process.env.SERVER_MODE || serverConfig.mode || 'local';
const environments = serverConfig.environments || {};
let currentConfig = environments[MODE] || environments.local;

// Utiliser la config locale par défaut
if (!currentConfig || !currentConfig.url) {
    currentConfig = { url: 'http://localhost:8060', ws: 'ws://localhost:8060' };
}

let SERVER_URL = currentConfig.url;
let SERVER_WS_URL = currentConfig.ws;
const healthEndpoint = serverConfig.endpoints?.health || '/api/health';
let SERVER_HEALTH_ENDPOINT = `${SERVER_URL}${healthEndpoint}`;
const MAX_RETRY_ATTEMPTS = 10;
const RETRY_INTERVAL = 500;

let mainWindow;
let splashWindow = null;
/** true pendant quitAndInstall pour ne pas retarder la sortie (before-quit) */
let quittingForUpdate = false;
/** Début du démarrage (app.ready) pour mesure de performance */
let startupBegin = 0;

/**
 * Instance unique: empêcher le double lancement et remettre la fenêtre existante au premier plan.
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        const targetWindow = (mainWindow && !mainWindow.isDestroyed())
            ? mainWindow
            : ((splashWindow && !splashWindow.isDestroyed()) ? splashWindow : null);

        if (!targetWindow) return;
        if (targetWindow.isMinimized && targetWindow.isMinimized()) {
            targetWindow.restore();
        }
        targetWindow.show();
        targetWindow.focus();
    });
}

/**
 * Sous Linux AppImage : crée une copie .bak de l'AppImage actuelle (à appeler dès qu'une MAJ est disponible).
 */
function linuxAppImageBackup(currentAppPath) {
    if (process.platform !== 'linux' || !currentAppPath) return;
    try {
        const bakPath = currentAppPath + '.bak';
        if (!fs.existsSync(bakPath)) {
            fs.copyFileSync(currentAppPath, bakPath);
            console.log('[Update] Sauvegarde créée:', bakPath);
        }
    } catch (e) {
        console.warn('[Update] Backup .bak failed:', e?.message);
    }
}

/**
 * Sous Linux AppImage : la nouvelle AppImage a déjà été téléchargée dans un dossier temporaire
 * (ex. app.getPath('temp')/workspace-update/). Un script attend la fermeture de l'app,
 * supprime l'ancienne AppImage, déplace celle du temporaire vers le dossier racine et relance.
 */
function tryLinuxAppImageUpdateHelper(currentAppPath, newAppPath) {
    if (process.platform !== 'linux' || !currentAppPath || !newAppPath) return false;
    if (!fs.existsSync(newAppPath)) return false;
    try {
        const dir = path.dirname(currentAppPath);
        const finalPath = currentAppPath;
        // Chemins via l’environnement : évite les ambiguïtés $0/$1 avec `sh -c` selon les shells,
        // et les chemins avec espaces / caractères spéciaux (pas d’interpolation dans le corps du script).
        const env = {
            ...process.env,
            WS_APPIMAGE_NEW: newAppPath,
            WS_APPIMAGE_DEST: finalPath,
            WS_APPIMAGE_PID: String(process.pid)
        };
        const script = [
            'while kill -0 "$WS_APPIMAGE_PID" 2>/dev/null; do sleep 0.3; done',
            'test -f "$WS_APPIMAGE_NEW" || exit 1',
            'rm -f "${WS_APPIMAGE_DEST}.bak"',
            'mv -f "$WS_APPIMAGE_DEST" "${WS_APPIMAGE_DEST}.bak" || exit 1',
            'mv -f "$WS_APPIMAGE_NEW" "$WS_APPIMAGE_DEST" || exit 1',
            'chmod +x "$WS_APPIMAGE_DEST" 2>/dev/null || true',
            'export APPIMAGE_SILENT_INSTALL=true',
            'exec "$WS_APPIMAGE_DEST"'
        ].join('; ');
        const shells = ['/bin/sh', '/usr/bin/sh', '/bin/bash', '/usr/bin/bash'];
        for (const shellPath of shells) {
            try {
                if (!fs.existsSync(shellPath)) continue;
                const child = spawn(shellPath, ['-c', script], {
                    detached: true,
                    stdio: 'ignore',
                    cwd: dir,
                    env
                });
                if (child && typeof child.pid === 'number' && child.pid > 0) {
                    child.once('error', (err) => {
                        console.warn('[Update] helper spawn error:', shellPath, err?.message || err);
                    });
                    child.unref();
                    return true;
                }
            } catch (inner) {
                console.warn('[Update] helper spawn try failed:', shellPath, inner?.message || inner);
            }
        }
        console.warn('[Update] Aucun shell utilisable pour le helper AppImage');
        return false;
    } catch (e) {
        console.warn('[Update] Helper script failed:', e?.message);
        return false;
    }
}

function tryLinuxAppImageUpdateHelperDetailed(currentAppPath, newAppPath) {
    try {
        if (process.platform !== 'linux') return { ok: false, error: 'Plateforme non supportée' };
        if (!currentAppPath) return { ok: false, error: 'APPIMAGE vide' };
        if (!fs.existsSync(currentAppPath)) return { ok: false, error: `APPIMAGE introuvable: ${currentAppPath}` };
        if (!newAppPath) return { ok: false, error: 'Chemin de téléchargement vide' };
        if (!fs.existsSync(newAppPath)) return { ok: false, error: `Fichier téléchargé introuvable: ${newAppPath}` };
        try {
            fs.accessSync(path.dirname(currentAppPath), fs.constants.W_OK);
        } catch (_) {
            return {
                ok: false,
                error: `Dossier non accessible en écriture: ${path.dirname(currentAppPath)}`
            };
        }
        const ok = tryLinuxAppImageUpdateHelper(currentAppPath, newAppPath);
        return ok ? { ok: true } : { ok: false, error: 'spawn helper échoué (voir logs)' };
    } catch (e) {
        return { ok: false, error: e?.message || String(e) };
    }
}

// --- Mise à jour manuelle (AppImage) ---
const GITHUB_OWNER = 'SandersonnDev';
const GITHUB_REPO = 'workspace';

function normalizeSemver(v) {
    const s = String(v || '').trim().replace(/^v/i, '');
    return s;
}

function compareSemver(a, b) {
    const pa = normalizeSemver(a).split('.').map(x => parseInt(x, 10) || 0);
    const pb = normalizeSemver(b).split('.').map(x => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const da = pa[i] || 0;
        const db = pb[i] || 0;
        if (da > db) return 1;
        if (da < db) return -1;
    }
    return 0;
}

async function fetchLatestGithubRelease() {
    const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
    const res = await fetch(apiUrl, {
        headers: {
            'Accept': 'application/vnd.github+json',
            'User-Agent': `WorkspaceClient/${app.getVersion?.() || '0.0.0'}`
        }
    });
    if (!res.ok) {
        throw new Error(`GitHub API HTTP ${res.status}`);
    }
    return await res.json();
}

function pickAppImageAsset(releaseJson) {
    const assets = Array.isArray(releaseJson?.assets) ? releaseJson.assets : [];
    // Priorité au nom demandé par toi, puis variantes usuelles.
    const preferred = assets.find(a => String(a?.name || '').toLowerCase() === 'workspace.appimage')
        || assets.find(a => /workspace.*\.appimage$/i.test(String(a?.name || '')))
        || assets.find(a => /\.appimage$/i.test(String(a?.name || '')));
    return preferred || null;
}

async function downloadToFile(downloadUrl, destPath, onProgress) {
    const res = await fetch(downloadUrl, {
        redirect: 'follow',
        headers: { 'User-Agent': `WorkspaceClient/${app.getVersion?.() || '0.0.0'}` }
    });
    if (!res.ok) throw new Error(`Téléchargement HTTP ${res.status}`);

    const total = Number(res.headers.get('content-length') || 0) || null;
    const body = res.body;
    if (!body || typeof body.getReader !== 'function') {
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(destPath, buf);
        try { fs.chmodSync(destPath, 0o755); } catch (_) { }
        if (typeof onProgress === 'function') onProgress({ received: buf.length, total, percent: 100 });
        return { bytes: buf.length };
    }

    const reader = body.getReader();
    const out = fs.createWriteStream(destPath, { flags: 'w', mode: 0o755 });
    let received = 0;
    let lastEmit = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
                const buf = Buffer.from(value);
                out.write(buf);
                received += buf.length;
                const now = Date.now();
                if (typeof onProgress === 'function' && (now - lastEmit > 120)) {
                    const percent = total ? Math.max(0, Math.min(100, Math.round((received / total) * 100))) : null;
                    onProgress({ received, total, percent });
                    lastEmit = now;
                }
            }
        }
        await new Promise((resolve, reject) => {
            out.end(() => resolve());
            out.on('error', reject);
        });
        try { fs.chmodSync(destPath, 0o755); } catch (_) { }
        if (typeof onProgress === 'function') onProgress({ received, total, percent: 100 });
        return { bytes: received };
    } finally {
        // close() est implicite après end(); éviter de fermer trop tôt.
        try { reader.releaseLock(); } catch (_) { }
    }
}

ipcMain.handle('check-app-update', async () => {
    try {
        const current = normalizeSemver(app.getVersion());
        const release = await fetchLatestGithubRelease();
        const latest = normalizeSemver(release?.tag_name || release?.name || '');
        const asset = pickAppImageAsset(release);
        const downloadUrl = asset?.browser_download_url || null;
        const available = !!latest && compareSemver(latest, current) > 0;
        return {
            success: true,
            available,
            currentVersion: current,
            latestVersion: latest || null,
            downloadUrl,
            releaseName: release?.name || null
        };
    } catch (e) {
        return { success: false, error: e?.message || String(e) };
    }
});

ipcMain.handle('download-app-update', async () => {
    try {
        if (process.platform !== 'linux') {
            return { success: false, error: 'Mise à jour manuelle supportée uniquement sous Linux AppImage' };
        }
        const currentApp = process.env.APPIMAGE;
        if (!currentApp || !fs.existsSync(currentApp)) {
            return { success: false, error: 'APPIMAGE introuvable (lance l’app via AppImage)' };
        }

        const release = await fetchLatestGithubRelease();
        const asset = pickAppImageAsset(release);
        if (!asset?.browser_download_url) {
            return { success: false, error: 'Aucun asset AppImage trouvé sur la release' };
        }
        const latest = normalizeSemver(release?.tag_name || release?.name || '');
        const tempDir = path.join(app.getPath('temp'), 'workspace-manual-update');
        try { fs.mkdirSync(tempDir, { recursive: true }); } catch (_) { }
        const downloadedPath = path.join(tempDir, 'workspace.appimage');

        const dl = await downloadToFile(asset.browser_download_url, downloadedPath, ({ received, total, percent }) => {
            try {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('app-update-download-progress', { received, total, percent });
                }
            } catch (_) { }
        });
        linuxAppImageBackup(currentApp);

        const helper = tryLinuxAppImageUpdateHelperDetailed(currentApp, downloadedPath);
        if (!helper.ok) {
            const detail = helper.error || null;
            return {
                success: false,
                error: detail
                    ? `Impossible de préparer le remplacement : ${detail}`
                    : 'Impossible de préparer le remplacement (helper non lancé)',
                detail,
                debug: {
                    currentApp,
                    downloadedPath,
                    downloadedExists: fs.existsSync(downloadedPath),
                    destDir: path.dirname(currentApp)
                }
            };
        }
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('app-update-download-done', { success: true, latestVersion: latest || null });
            }
        } catch (_) { }
        return {
            success: true,
            latestVersion: latest || null,
            bytes: dl.bytes,
            message: 'Mise à jour téléchargée. Redémarre l’application pour l’appliquer.'
        };
    } catch (e) {
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('app-update-download-done', { success: false, error: e?.message || String(e) });
            }
        } catch (_) { }
        return { success: false, error: e?.message || String(e) };
    }
});

let pdfWindows = new Map();
let serverConnected = false;
let discoveredServer = null;
let lastOpenTime = 0;
const MIN_OPEN_INTERVAL = 1500; // 1.5s minimum entre chaque ouverture

function isBlacklisted(name, blacklist = [], ignoreSuffixes = [], ignoreExtensions = []) {
    if (!name) return true;
    if (blacklist.includes(name)) return true;
    if (name.startsWith('~$')) return true;
    if (name.startsWith('.') && name !== '.' && name !== '..') return true;
    for (const suffix of ignoreSuffixes) {
        if (name.endsWith(suffix)) return true;
    }
    for (const ext of ignoreExtensions) {
        if (name.endsWith(ext)) return true;
    }
    return false;
}

/**
 * Vérifier la connexion au serveur distant (non-bloquant)
 */
function checkServerConnection(retries = 0) {
    return new Promise((resolve) => {
        const req = http.get(SERVER_HEALTH_ENDPOINT, { timeout: 3000 }, (res) => {
            if (res.statusCode === 200) {
                if (!serverConnected) console.log(`✅ Connecté au serveur: ${SERVER_URL}`);
                serverConnected = true;
                resolve(true);
            } else if (retries < MAX_RETRY_ATTEMPTS) {
                setTimeout(() => {
                    checkServerConnection(retries + 1).then(resolve);
                }, RETRY_INTERVAL);
            } else {
                console.warn(`⚠️  Serveur indisponible après ${MAX_RETRY_ATTEMPTS} tentatives`);
                serverConnected = false;
                resolve(false);
            }
        });

        req.on('error', () => {
            if (retries < MAX_RETRY_ATTEMPTS) {
                setTimeout(() => {
                    checkServerConnection(retries + 1).then(resolve);
                }, RETRY_INTERVAL);
            } else {
                console.warn(`⚠️  Impossible de se connecter au serveur: ${SERVER_URL}`);
                serverConnected = false;
                resolve(false);
            }
        });

        req.on('timeout', () => {
            req.destroy();
            if (retries < MAX_RETRY_ATTEMPTS) {
                setTimeout(() => {
                    checkServerConnection(retries + 1).then(resolve);
                }, RETRY_INTERVAL);
            } else {
                console.warn('⚠️  Timeout lors de la connexion au serveur');
                serverConnected = false;
                resolve(false);
            }
        });
    });
}

/**
 * Écran de démarrage (splash) affiché pendant le chargement
 */
function createSplashWindow() {
    const splashHtml = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: linear-gradient(145deg, #1a237e 0%, #0d47a1 100%);
    color: #fff;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem;
  }
  .logo { font-size: 2rem; font-weight: 700; margin-bottom: 0.5rem; letter-spacing: 0.02em; }
  .tagline { font-size: 0.9rem; opacity: 0.85; margin-bottom: 2rem; }
  .spinner {
    width: 40px; height: 40px;
    border: 3px solid rgba(255,255,255,0.25);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .message { margin-top: 1.25rem; font-size: 0.85rem; opacity: 0.9; }
  .progress-wrap { margin-top: 1rem; width: 100%; max-width: 260px; display: none; }
  .progress-wrap.visible { display: block; }
  .progress-bar { height: 8px; background: rgba(255,255,255,0.25); border-radius: 4px; overflow: hidden; }
  .progress-fill { height: 100%; width: 0%; background: rgba(255,255,255,0.9); border-radius: 4px; transition: width 0.2s ease; }
</style></head><body>
  <div class="logo">Workspace</div>
  <div class="tagline">By Sandersonn</div>
  <div class="spinner"></div>
  <p class="message">Chargement en cours…</p>
  <div class="progress-wrap" id="splash-progress">
    <div class="progress-bar"><div class="progress-fill" id="splash-progress-fill"></div></div>
  </div>
</body></html>`;
    const win = new BrowserWindow({
        width: 380,
        height: 280,
        frame: true,
        transparent: false,
        resizable: false,
        show: false,
        alwaysOnTop: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
        icon: (() => {
            const base = app.isPackaged ? app.getAppPath() : __dirname;
            const p = path.join(base, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
            return fs.existsSync(p) ? p : undefined;
        })(),
    });
    win.setMenuBarVisibility(false);
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml));
    win.once('ready-to-show', () => win.show());
    splashWindow = win;
    win.on('closed', () => { splashWindow = null; });
    return win;
}

/**
 * Mettre à jour le message affiché sur l'écran de démarrage (splash)
 */
function setSplashMessage(text) {
    if (splashWindow && !splashWindow.isDestroyed() && splashWindow.webContents) {
        splashWindow.webContents.executeJavaScript(
            `(function(){ var el = document.querySelector('.message'); if (el) el.textContent = ${JSON.stringify(text)}; })();`
        ).catch(() => { });
    }
}

/**
 * Afficher ou masquer la barre de progression (percent: 0-100, ou null pour masquer)
 */
function setSplashProgress(percent) {
    if (!splashWindow || splashWindow.isDestroyed() || !splashWindow.webContents) return;
    const show = typeof percent === 'number';
    const value = Math.min(100, Math.max(0, percent));
    splashWindow.webContents.executeJavaScript(
        `(function(){
            var wrap = document.getElementById('splash-progress');
            var fill = document.getElementById('splash-progress-fill');
            if (wrap) wrap.classList.toggle('visible', ${show});
            if (fill) fill.style.width = ${JSON.stringify(value)} + '%';
        })();`
    ).catch(() => { });
}

/**
 * Afficher l'état succès sur le splash (icône check, pas de spinner) et masquer la barre de progression
 */
function setSplashUpdateSuccess(text) {
    if (splashWindow && !splashWindow.isDestroyed() && splashWindow.webContents) {
        splashWindow.webContents.executeJavaScript(
            `(function(){
                var spinner = document.querySelector('.spinner');
                var msg = document.querySelector('.message');
                var progressWrap = document.getElementById('splash-progress');
                if (spinner) { spinner.style.display = 'none'; }
                if (progressWrap) { progressWrap.classList.remove('visible'); }
                var wrap = document.querySelector('.message-wrap');
                if (!wrap && msg) {
                    wrap = document.createElement('div');
                    wrap.className = 'message-wrap';
                    msg.parentNode.insertBefore(wrap, msg);
                    wrap.appendChild(msg);
                }
                if (wrap) wrap.innerHTML = '<div class="splash-success"><span class="splash-check">✓</span></div><p class="message">' + ${JSON.stringify(text)} + '</p>';
                var style = document.createElement('style');
                style.textContent = '.splash-success { margin-top: 1rem; }.splash-check { display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; background: rgba(76, 175, 80, 0.9); color: #fff; border-radius: 50%; font-size: 1.5rem; font-weight: bold; }.message-wrap .message { margin-top: 0.75rem; }';
                if (!document.querySelector('#splash-success-style')) { style.id = 'splash-success-style'; document.head.appendChild(style); }
            })();`
        ).catch(() => { });
    }
}

/**
 * Fermer l'écran de démarrage (splash)
 */
function closeSplashWindow() {
    if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
        splashWindow = null;
    }
}

/**
 * Résout le chemin de l'icône de l'app (barre des tâches / dock).
 * Essaie plusieurs bases (__dirname, process.cwd(), getAppPath) pour dev et packagé.
 */
function getAppIconPath() {
    const iconName = process.platform === 'win32' ? 'icon.ico' : process.platform === 'darwin' ? 'icon.icns' : 'icon.png';
    const bases = [__dirname, process.cwd(), app.getAppPath()].filter(Boolean);
    const tried = [];
    for (const base of bases) {
        const inAssets = path.join(base, 'assets', iconName);
        const pngFallback = path.join(base, 'assets', 'icon.png');
        if (fs.existsSync(inAssets)) return inAssets;
        tried.push(inAssets);
        if (iconName !== 'icon.png' && fs.existsSync(pngFallback)) return pngFallback;
        if (iconName !== 'icon.png') tried.push(pngFallback);
    }
    return null;
}

/**
 * Créer la fenêtre principale (une seule instance)
 */
function createWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
        return;
    }
    const appIconPath = getAppIconPath();
    if (!app.isPackaged && appIconPath) {
        console.log('🖼️ Icône app (barre des tâches):', appIconPath);
    }
    let windowIcon = undefined;
    if (appIconPath) {
        let img = nativeImage.createFromPath(appIconPath);
        if (img.isEmpty()) {
            try {
                const buf = fs.readFileSync(appIconPath);
                img = nativeImage.createFromBuffer(buf);
            } catch (_) { }
        }
        windowIcon = (img && !img.isEmpty()) ? img : appIconPath;
    }
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false,
        autoHideMenuBar: true,
        icon: windowIcon,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            enableRemoteModule: false,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    // Désactiver complètement le menu (Alt n'affiche plus File / Edit / View…)
    Menu.setApplicationMenu(null);

    // Raccourcis clavier (dev uniquement pour DevTools)
    const toggleDevTools = () => {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
            mainWindow.webContents.toggleDevTools();
        }
    };
    const reloadApp = () => {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
            mainWindow.webContents.reload();
        }
    };
    const toggleFullscreen = () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setFullScreen(!mainWindow.isFullScreen());
        }
    };
    try {
        if (!isProduction) {
            globalShortcut.register('F12', toggleDevTools);
            globalShortcut.register('CommandOrControl+Shift+I', toggleDevTools);
        }
        globalShortcut.register('CommandOrControl+R', reloadApp);
        globalShortcut.register('F11', toggleFullscreen);
    } catch (e) {
        console.warn('Raccourcis globaux non enregistrés:', e?.message);
    }

    if (appIconPath && process.platform === 'linux' && windowIcon) {
        const iconToSet = typeof windowIcon === 'string' ? nativeImage.createFromPath(windowIcon) : windowIcon;
        const applyIcon = () => {
            if (mainWindow && !mainWindow.isDestroyed() && iconToSet && !iconToSet.isEmpty()) {
                mainWindow.setIcon(iconToSet);
            }
        };
        mainWindow.once('ready-to-show', applyIcon);
        mainWindow.once('did-finish-load', () => setTimeout(applyIcon, 100));
    }

    // Charger l'index.html ; afficher la fenêtre et fermer le splash une fois prêt
    mainWindow.loadURL(`file://${path.join(__dirname, 'public', 'index.html')}`);
    let showMainCalled = false;
    let showMainFallbackId;
    const showMainAndCloseSplash = () => {
        if (showMainCalled) return;
        showMainCalled = true;
        if (showMainFallbackId) clearTimeout(showMainFallbackId);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
        const startupMs = startupBegin ? Math.round(Date.now() - startupBegin) : 0;
        if (startupMs > 0) {
            console.log(`⏱️ Démarrage (ready → fenêtre affichée): ${startupMs} ms`);
            try {
                const metricsPath = path.join(app.getPath('userData'), 'startup-metrics.json');
                fs.writeFileSync(metricsPath, JSON.stringify({ lastStartupMs: startupMs, timestamp: new Date().toISOString() }, null, 2), 'utf8');
            } catch (_) { /* ignore */ }
        }
        closeSplashWindow();
        const flagPath = path.join(app.getPath('userData'), 'workspace-update-installed.flag');
        if (fs.existsSync(flagPath)) {
            // #region agent log
            sessionLog({ hypothesisId: 'H4', location: 'main.js:showMainAndCloseSplash', message: 'flag found post-restart', data: {} });
            // #endregion
            try {
                fs.unlinkSync(flagPath);
            } catch (_) { }
            setTimeout(() => {
                if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
                    mainWindow.webContents.send('update-was-installed');
                }
            }, 800);
        }
    };
    mainWindow.webContents.once('did-finish-load', showMainAndCloseSplash);
    showMainFallbackId = setTimeout(showMainAndCloseSplash, 15000);

    // Ouvrir les liens externes (target="_blank" ou window.open) dans le navigateur système au lieu d'une nouvelle fenêtre Electron
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        try {
            const u = new URL(url);
            if (['http:', 'https:'].includes(u.protocol)) {
                shell.openExternal(url);
            }
        } catch (e) {
            console.warn('setWindowOpenHandler url:', e.message);
        }
        return { action: 'deny' };
    });

    // Empêcher la navigation vers des URL externes dans la fenêtre principale (sécurité : garder file:// uniquement)
    mainWindow.webContents.on('will-navigate', (event, url) => {
        try {
            const u = new URL(url);
            if (u.protocol !== 'file:') {
                event.preventDefault();
                if (['http:', 'https:'].includes(u.protocol)) {
                    shell.openExternal(url);
                }
            }
        } catch (_) { /* ignore */ }
    });

    // DevTools uniquement en développement
    if (!isProduction) {
        mainWindow.webContents.openDevTools();
    }

    // Logs console Electron (filtrer le bruit). Nouvelle API : (event) avec event.message ; ancienne : (event, level, message)
    mainWindow.webContents.on('console-message', (...args) => {
        const payload = args[0];
        const message = (payload && typeof payload === 'object' && payload.message != null)
            ? payload.message
            : (args[2] != null ? String(args[2]) : '');
        if (typeof message !== 'string' || !message) return;
        if (message.includes('Autofill') || message.includes('atom_cache') || message.includes('privileged')) return;
        console.log(`[Renderer] ${message}`);
    });

    mainWindow.webContents.on('destroyed', () => {
        mainWindow = null;
    });

    mainWindow.on('closed', () => {
        try {
            globalShortcut.unregister('F12');
            globalShortcut.unregister('CommandOrControl+Shift+I');
            globalShortcut.unregister('CommandOrControl+R');
            globalShortcut.unregister('F11');
        } catch (_) { /* ignore */ }
        mainWindow = null;
    });

    // Arrêter le clignotement de la barre des tâches quand l'utilisateur revient sur la fenêtre
    mainWindow.on('focus', () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(false);
    });
}

/**
 * Notifications chat : clignotement barre des tâches + notification OS (nouveau message non vu)
 */
function setupChatNotifications() {
    ipcMain.on('chat-new-message', (_event, payload) => {
        const pseudo = (payload && payload.pseudo) ? String(payload.pseudo) : 'Quelqu\'un';
        const win = mainWindow;
        if (!win || win.isDestroyed()) return;
        // Ne pas notifier si la fenêtre a le focus (utilisateur déjà sur l'app)
        if (win.isFocused()) return;
        // Faire clignoter l'icône dans la barre des tâches (Linux/Windows) ou bounce dock (macOS)
        try {
            if (process.platform === 'darwin' && app.dock) {
                app.dock.bounce('informational');
            } else {
                win.flashFrame(true);
            }
        } catch (_) { }
        // Notification système (popup à droite sur la plupart des OS)
        if (Notification.isSupported()) {
            const iconPath = path.join(__dirname, 'build', 'icon.png');
            const opts = { body: `${pseudo} a envoyé un message` };
            if (fs.existsSync(iconPath)) opts.icon = iconPath;
            const n = new Notification('Workspace - Chat', opts);
            n.on('click', () => {
                if (win && !win.isDestroyed()) {
                    win.show();
                    win.focus();
                    win.flashFrame(false);
                }
            });
            n.show();
        }
    });
}

/** Garde pour éviter le double lancement (ex. checkForUpdates rejette après update-not-available) */
let appLaunched = false;

/**
 * Lancer l'application (fenêtre principale après éventuelle mise à jour).
 * La fenêtre est créée immédiatement pour un affichage plus rapide ; la vérification
 * du serveur s'exécute en parallèle (le client gère le mode hors-ligne).
 */
function launchApp() {
    // #region agent log
    sessionLog({ hypothesisId: 'H4', location: 'main.js:launchApp', message: 'launchApp called', data: { appLaunched } });
    // #endregion
    if (appLaunched) return;
    appLaunched = true;
    setSplashMessage('Chargement en cours…');
    createWindow();
    checkServerConnection().then(() => {
        if (!serverConnected) console.log('🔌 Mode hors-ligne: Le client démarre sans connexion serveur');
    });
    console.log('✅ Interface graphique lancée');
    console.log('✨ Application prête');
}

/**
 * Événement de démarrage Electron
 */
app.on('ready', async () => {
    startupBegin = Date.now();
    app.setName('Workspace Client');
    console.log('🚀 Démarrage Workspace Client...');
    console.log(`📍 Configuration depuis: ${MODE} (connexion-config.json)`);
    console.log(`🔗 Serveur par défaut: ${SERVER_URL}`);
    console.log(`🌍 Environnement: ${isProduction ? 'PRODUCTION' : 'DÉVELOPPEMENT'}`);
    console.log('ℹ️  La config réelle sera chargée par le client web');
    
    setupChatNotifications();
    // Démarrage optimisé : plus de vérification MAJ au lancement.
    await launchApp();
});

// IPC: lister les dossiers d'un chemin (restriction aux répertoires autorisés)
ipcMain.handle('list-folders', async (_event, payload) => {
    const { path: basePath, blacklist = [], ignoreSuffixes = [], ignoreExtensions = [] } = payload || {};
    if (!basePath) throw new Error('path is required');

    const resolvedPath = path.resolve(basePath);
    if (!isPathAllowed(resolvedPath)) {
        console.error('❌ list-folders: chemin non autorisé:', resolvedPath);
        throw new Error('Chemin non autorisé');
    }
    try {
        const entries = await fs.promises.readdir(resolvedPath, { withFileTypes: true });
        const folders = entries
            .filter((ent) => ent.isDirectory() && !isBlacklisted(ent.name, blacklist, ignoreSuffixes, ignoreExtensions))
            .map((ent) => ent.name);
        return { folders, path: resolvedPath };
    } catch (error) {
        console.error('❌ Erreur list-folders:', error);
        throw error;
    }
});

/**
 * Télécharge le PDF côté main : préfère net.fetch (pile Chromium) pour coller au navigateur
 * (certificats, proxy, AppImage) ; repli sur fetch Node si besoin.
 */
async function fetchPdfBufferForOpen(pdfUrl, token) {
    const headers = { Authorization: `Bearer ${token || ''}` };
    if (net && typeof net.fetch === 'function') {
        try {
            const res = await net.fetch(pdfUrl, { headers });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return Buffer.from(await res.arrayBuffer());
        } catch (e) {
            console.warn('[open-pdf] net.fetch, repli fetch Node:', e?.message || e);
        }
    }
    const res = await fetch(pdfUrl, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

/** Linux : ouvrir un fichier PDF via le bureau (xdg-open / gio) si shell.openPath échoue (souvent sous AppImage). */
function tryLinuxSpawnOpenFile(filePath) {
    if (process.platform !== 'linux') return false;
    const candidates = [
        ['/usr/bin/xdg-open', [filePath]],
        ['/bin/xdg-open', [filePath]],
        ['xdg-open', [filePath]],
        ['/usr/bin/gio', ['open', filePath]],
        ['/bin/gio', ['open', filePath]],
        ['gio', ['open', filePath]],
        ['/usr/bin/kde-open', [filePath]],
        ['/usr/bin/kde-open5', [filePath]]
    ];
    for (const [cmd, args] of candidates) {
        if (cmd.includes('/') && !fs.existsSync(cmd)) continue;
        try {
            const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env: process.env });
            if (child && typeof child.pid === 'number' && child.pid > 0) {
                child.once('error', () => {});
                child.unref();
                return true;
            }
        } catch (_) { /* essai suivant */ }
    }
    return false;
}

async function openPdfFileWithDesktopDefault(filePath) {
    const OPEN_PATH_TIMEOUT_MS = 15000;
    try {
        const err = await Promise.race([
            shell.openPath(filePath),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Ouverture expirée')), OPEN_PATH_TIMEOUT_MS))
        ]);
        if (!err) return { ok: true };
        if (tryLinuxSpawnOpenFile(filePath)) return { ok: true };
        return { ok: false, error: typeof err === 'string' ? err : String(err) };
    } catch (e) {
        if (tryLinuxSpawnOpenFile(filePath)) return { ok: true };
        return { ok: false, error: e?.message || String(e) };
    }
}

// IPC: télécharger un PDF depuis une URL et l'ouvrir avec l'application système (traçabilité)
ipcMain.handle('open-pdf-with-system-app', async (_event, payload) => {
    const { url: pdfUrl, token, suggestedFilename, localFilePath } = payload || {};
    // #region agent log
    if (DEBUG_INGEST) { fetch('http://127.0.0.1:7769/ingest/5680a22c-9f00-42fe-8dff-e51f17df8a04',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'da2875'},body:JSON.stringify({sessionId:'da2875',location:'main.js:open-pdf-with-system-app',message:'handler entry',data:{urlStart:(pdfUrl||'').slice(0,100),hasToken:!!(token&&String(token).trim())},hypothesisId:'H3',timestamp:Date.now()})}).catch(()=>{}); }
    // #endregion
    if (!pdfUrl || typeof pdfUrl !== 'string') {
        return { success: false, error: 'URL requise' };
    }
    if (localFilePath && typeof localFilePath === 'string') {
        try {
            const resolvedLocal = path.resolve(localFilePath.trim());
            if (isPathAllowed(resolvedLocal) && fs.existsSync(resolvedLocal) && fs.statSync(resolvedLocal).isFile()) {
                const opened = await openPdfFileWithDesktopDefault(resolvedLocal);
                if (opened.ok) return { success: true, path: resolvedLocal, source: 'local' };
            }
        } catch (e) {
            console.warn('open-pdf-with-system-app: ouverture locale ignorée, fallback URL', e?.message || e);
        }
    }
    let safeName = (suggestedFilename && String(suggestedFilename).replace(/[\\/:*?"<>|]/g, '_')) || 'tracabilite.pdf';
    if (!safeName.toLowerCase().endsWith('.pdf')) safeName += '.pdf';
    const tempPath = path.join(os.tmpdir(), `workspace-pdf-${Date.now()}-${safeName}`);
    try {
        const buf = await fetchPdfBufferForOpen(pdfUrl.trim(), token);
        // #region agent log
        if (DEBUG_INGEST) { fetch('http://127.0.0.1:7769/ingest/5680a22c-9f00-42fe-8dff-e51f17df8a04',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'da2875'},body:JSON.stringify({sessionId:'da2875',location:'main.js:open-pdf-with-system-app',message:'after fetch',data:{bytes:buf?.length},hypothesisId:'H4',timestamp:Date.now()})}).catch(()=>{}); }
        // #endregion
        fs.writeFileSync(tempPath, buf);
        const opened = await openPdfFileWithDesktopDefault(tempPath);
        if (!opened.ok) {
            try { fs.unlinkSync(tempPath); } catch (_) {}
            return { success: false, error: opened.error || 'Ouverture impossible' };
        }
        return { success: true, path: tempPath };
    } catch (e) {
        // #region agent log
        if (DEBUG_INGEST) { fetch('http://127.0.0.1:7769/ingest/5680a22c-9f00-42fe-8dff-e51f17df8a04',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'da2875'},body:JSON.stringify({sessionId:'da2875',location:'main.js:open-pdf-with-system-app',message:'handler catch',data:{message:e?.message,name:e?.constructor?.name},hypothesisId:'H5',timestamp:Date.now()})}).catch(()=>{}); }
        // #endregion
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
        console.error('❌ open-pdf-with-system-app:', e.message);
        return { success: false, error: e.message };
    }
});

// IPC: ouvrir un chemin local (fichier ou dossier) avec l'app par défaut (restriction aux répertoires autorisés)
ipcMain.handle('open-path', async (_event, payload) => {
    const targetPath = typeof payload === 'string' ? payload : payload?.path;
    if (!targetPath) throw new Error('path is required');

    try {
        const resolved = path.resolve(targetPath);
        if (!isPathAllowed(resolved)) {
            console.error('❌ open-path: chemin non autorisé:', resolved);
            return { success: false, error: 'Chemin non autorisé' };
        }

        if (!fs.existsSync(resolved)) {
            return { success: false, error: 'Path does not exist' };
        }

        const now = Date.now();
        const elapsed = now - lastOpenTime;
        if (elapsed < MIN_OPEN_INTERVAL) {
            await new Promise(resolve => setTimeout(resolve, MIN_OPEN_INTERVAL - elapsed));
        }
        lastOpenTime = Date.now();

        const stat = fs.statSync(resolved);
        if (stat.isFile()) {
            const err = await shell.openPath(resolved);
            if (err) {
                console.error('❌ open-path (fichier):', err);
                return { success: false, error: err };
            }
            return { success: true, path: resolved };
        }

        const platform = process.platform;
        let cmd;
        if (platform === 'win32') {
            cmd = `explorer "${resolved}"`;
        } else if (platform === 'darwin') {
            cmd = `open "${resolved}"`;
        } else {
            cmd = `xdg-open "${resolved}" || nautilus "${resolved}" || dolphin "${resolved}"`;
        }
        exec(cmd, (error) => {
            if (error) console.error('❌ Erreur ouverture dossier:', error.message);
        });
        return { success: true, path: resolved };
    } catch (error) {
        console.error('❌ Erreur open-path:', error);
        return { success: false, error: error.message };
    }
});

// IPC: récupérer l'icône d'une application
ipcMain.handle('get-app-icon', async (_event, payload) => {
    const { command, appName } = payload || {};
    if (!command) return { success: false, icon: null };

    try {
        // Extraire la commande de base (avant les flags)
        const baseCommand = command.split(' ')[0];

        // D'abord chercher dans /usr/share/applications avec la commande
        let desktopFiles = [
            `/usr/share/applications/${command}.desktop`,
            `/usr/share/applications/${baseCommand}.desktop`,
            `/usr/local/share/applications/${command}.desktop`,
            `/usr/local/share/applications/${baseCommand}.desktop`,
            `${os.homedir()}/.local/share/applications/${command}.desktop`,
            `${os.homedir()}/.local/share/applications/${baseCommand}.desktop`
        ];

        // Pour LibreOffice, détecter le type spécifique depuis la commande
        if (baseCommand === 'libreoffice' && command.includes('--')) {
            const flag = command.match(/--(\w+)/)?.[1];
            if (flag) {
                desktopFiles.unshift(`/usr/share/applications/libreoffice-${flag}.desktop`);
            }
        }

        // Ajouter des variantes courantes basées sur le nom de l'app
        if (appName) {
            const nameLower = appName.toLowerCase().replace(/\s+/g, '');
            desktopFiles.push(
                `/usr/share/applications/${nameLower}.desktop`,
                `/usr/share/applications/${baseCommand}-${nameLower}.desktop`,
                `/usr/share/applications/org.${nameLower}.${appName}.desktop`,
                `/usr/share/applications/org.gnome.${appName}.desktop`,  // GNOME apps (majuscule)
                `/usr/share/applications/org.gnome.${nameLower}.desktop`  // GNOME apps (minuscule)
            );
            // Ajouter aussi la variante complète (org.gnome.GNOME)
            desktopFiles.push(
                `/usr/share/applications/org.${nameLower}.${nameLower}.desktop`
            );
        }

        // Chercher aussi les .desktop contenant la commande (grep)
        try {
            const result = execSync(`grep -l "Exec=.*${baseCommand}" /usr/share/applications/*.desktop 2>/dev/null | head -5`, {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'ignore']
            }).trim().split('\n').filter(Boolean);
            if (result[0]) desktopFiles.push(...result);
        } catch (e) {
            // Pas d'erreur si rien trouvé
        }

        // Pour les apps Flatpak, extraire l'ID
        let flatpakId = null;
        if (command.startsWith('flatpak') || command.includes('com.') || command.includes('io.')) {
            const parts = command.split(' ');
            flatpakId = parts[parts.length - 1];
            desktopFiles.push(
                `/var/lib/flatpak/app/${flatpakId}/current/active/files/share/applications/${flatpakId}.desktop`,
                `${os.homedir()}/.local/share/flatpak/app/${flatpakId}/current/active/files/share/applications/${flatpakId}.desktop`
            );
        }

        // Déduplicatif et filtre
        desktopFiles = [...new Set(desktopFiles)].filter(f => f && f.includes('.desktop'));

        for (const desktopFile of desktopFiles) {
            if (fs.existsSync(desktopFile)) {
                try {
                    const content = fs.readFileSync(desktopFile, 'utf8');
                    const iconMatch = content.match(/Icon=(.+)/);

                    if (iconMatch) {
                        const iconName = iconMatch[1].trim();

                        // Chercher l'icône - augmenter la couverture de recherche
                        const iconPaths = [
                            // Hicolor (standard)
                            `/usr/share/icons/hicolor/256x256/apps/${iconName}.png`,
                            `/usr/share/icons/hicolor/256x256/apps/${iconName}.svg`,
                            `/usr/share/icons/hicolor/128x128/apps/${iconName}.png`,
                            `/usr/share/icons/hicolor/128x128/apps/${iconName}.svg`,
                            `/usr/share/icons/hicolor/48x48/apps/${iconName}.png`,
                            `/usr/share/icons/hicolor/48x48/apps/${iconName}.svg`,
                            `/usr/share/icons/hicolor/scalable/apps/${iconName}.svg`,
                            // Pixmaps
                            `/usr/share/pixmaps/${iconName}.png`,
                            `/usr/share/pixmaps/${iconName}.svg`,
                            `/usr/share/pixmaps/${iconName}`,
                            // Adwaita (GNOME)
                            `/usr/share/icons/Adwaita/256x256/apps/${iconName}.png`,
                            `/usr/share/icons/Adwaita/256x256/apps/${iconName}.svg`,
                            `/usr/share/icons/Adwaita/scalable/apps/${iconName}.svg`,
                            // HighContrast
                            `/usr/share/icons/HighContrast/256x256/apps/${iconName}.png`,
                            `/usr/share/icons/HighContrast/256x256/apps/${iconName}.svg`,
                            // Mint-Y (popular Linux theme)
                            `/usr/share/icons/Mint-Y/apps/256/${iconName}.png`,
                            `/usr/share/icons/Mint-Y/apps/48/${iconName}.png`,
                            `/usr/share/icons/Mint-L/apps/256/${iconName}.png`,
                            `/usr/share/icons/Mint-L/apps/48/${iconName}.png`,
                            // Papirus (SVG icons)
                            `/usr/share/icons/Papirus/64x64/apps/${iconName}.svg`,
                            `/usr/share/icons/Papirus/48x48/apps/${iconName}.svg`,
                            `/usr/share/icons/Papirus/32x32/apps/${iconName}.svg`,
                            // Humanity
                            `/usr/share/icons/Humanity/apps/128/${iconName}.svg`,
                            `/usr/share/icons/Humanity/apps/64/${iconName}.svg`,
                            // Yaru
                            `/usr/share/icons/Yaru/256x256/apps/${iconName}.png`,
                            `/usr/share/icons/Yaru/48x48/apps/${iconName}.png`,
                            // GNOME
                            `/usr/share/icons/gnome/256x256/apps/${iconName}.png`,
                            `/usr/share/icons/gnome/48x48/apps/${iconName}.png`,
                            // Variantes avec traits d'union/underscore
                            `/usr/share/icons/hicolor/256x256/apps/${iconName.replace(/_/g, '-')}.png`,
                            `/usr/share/icons/hicolor/256x256/apps/${iconName.replace(/_/g, '-')}.svg`,
                            `/usr/share/icons/Adwaita/256x256/apps/${iconName.replace(/_/g, '-')}.png`,
                            `/usr/share/icons/Adwaita/256x256/apps/${iconName.replace(/_/g, '-')}.svg`,
                            `/usr/share/icons/Mint-Y/apps/256/${iconName.replace(/_/g, '-')}.png`
                        ];

                        // Pour Flatpak
                        if (flatpakId) {
                            iconPaths.push(
                                `/var/lib/flatpak/app/${flatpakId}/current/active/files/share/icons/hicolor/256x256/apps/${iconName}.png`,
                                `/var/lib/flatpak/app/${flatpakId}/current/active/files/share/pixmaps/${iconName}.png`,
                                `${os.homedir()}/.local/share/flatpak/app/${flatpakId}/current/active/files/share/icons/hicolor/256x256/apps/${iconName}.png`
                            );
                        }

                        for (const iconPath of iconPaths) {
                            if (fs.existsSync(iconPath)) {
                                console.log('✅ Icône trouvée:', iconPath);
                                return { success: true, icon: iconPath };
                            }
                        }
                    }
                } catch (err) {
                    console.warn('⚠️ Erreur lecture .desktop:', desktopFile, err.message);
                }
            }
        }

        console.warn('⚠️ Icône non trouvée pour:', command, 'avec appName:', appName);
        return { success: false, icon: null };
    } catch (error) {
        console.error('❌ Erreur get-app-icon:', error);
        return { success: false, icon: null };
    }
});

// IPC: lancer une application (sécurisé : whitelist + execFile, pas de shell)
const LAUNCH_APP_SAFE_PATTERN = /^[a-zA-Z0-9_.-]+$/;
const LAUNCH_PATH_SAFE_PATTERN = /^[a-zA-Z0-9_./#+\- ]+$/;
const LAUNCH_APP_MAX_LEN = 128;

ipcMain.handle('launch-app', async (_event, payload) => {
    const { command, args = [] } = payload || {};
    if (!command || typeof command !== 'string') throw new Error('command is required');

    const cmd = command.trim();
    const isSimpleCommand = LAUNCH_APP_SAFE_PATTERN.test(cmd);
    const isPathLikeCommand = (cmd.includes('/') || cmd.startsWith('.')) && LAUNCH_PATH_SAFE_PATTERN.test(cmd);
    if (cmd.length > LAUNCH_APP_MAX_LEN || (!isSimpleCommand && !isPathLikeCommand)) {
        console.error('❌ launch-app: commande refusée (caractères ou longueur non autorisés)');
        return { success: false, error: 'Commande non autorisée' };
    }
    const safeArgs = Array.isArray(args) ? args.map(a => (typeof a === 'string' ? a : String(a))) : [];

    try {
        execFile(cmd, safeArgs, { shell: false }, (error, stdout, stderr) => {
            if (error) {
                console.error('❌ Erreur lancement app:', error.message);
                return;
            }
            if (stderr) console.warn('⚠️ App stderr:', stderr);
            console.log('✅ Application lancée:', cmd);
        });
        return { success: true, command: cmd };
    } catch (error) {
        console.error('❌ Erreur launch-app:', error);
        return { success: false, error: error.message };
    }
});

/**
 * Fermeture de toutes les fenêtres
 */
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

/**
 * Activation (macOS)
 */
app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});

/**
 * Avant la fermeture de l'application
 */
app.on('before-quit', () => {
    if (quittingForUpdate) {
        return;
    }
    console.log('⏹️  Arrêt de Workspace Client');
    pdfWindows.forEach((win) => {
        if (win && !win.isDestroyed()) {
            win.close();
        }
    });
    pdfWindows.clear();
});


/**
 * IPC Handlers - API exposée au renderer
 */

/**
 * Ouvrir une URL externe
 */
ipcMain.handle('open-external', async (event, url) => {
    try {
        // Valider l'URL
        const urlObj = new URL(url);
        if (!['http:', 'https:', 'mailto:', 'ftp:'].includes(urlObj.protocol)) {
            throw new Error('Protocole non autorisé');
        }
        await shell.openExternal(url);
        return { success: true };
    } catch (error) {
        console.error('❌ Erreur ouverture URL:', error.message);
        return { success: false, error: error.message };
    }
});

/**
 * Ouvrir un fichier PDF
 */
ipcMain.handle('open-pdf-window', async (event, data) => {
    try {
        const { pdfFile, title } = data;

        // Validation
        if (!pdfFile || typeof pdfFile !== 'string') {
            throw new Error('Nom de fichier invalide');
        }

        // Sécurité : empêcher les path traversal attacks
        if (pdfFile.includes('..') || pdfFile.includes('/') || pdfFile.includes('\\')) {
            throw new Error('Chemin de fichier non autorisé');
        }

        const pdfPath = path.join(__dirname, 'public', 'src', 'pdf', pdfFile);

        if (!fs.existsSync(pdfPath)) {
            throw new Error(`Fichier PDF introuvable: ${pdfFile}`);
        }

        const pdfWindow = new BrowserWindow({
            width: 900,
            height: 700,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js')
            }
        });

        pdfWindow.loadURL(`file://${pdfPath}`);
        pdfWindow.webContents.setWindowOpenHandler(({ url }) => {
            shell.openExternal(url);
            return { action: 'deny' };
        });

        pdfWindow.setTitle(title || 'PDF Viewer');

        const windowId = `pdf-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        pdfWindow.id = windowId;
        pdfWindows.set(windowId, pdfWindow);

        pdfWindow.on('closed', () => {
            pdfWindows.delete(windowId);
        });

        return { success: true, windowId };
    } catch (error) {
        console.error('❌ Erreur ouverture PDF:', error.message);
        return { success: false, error: error.message };
    }
});

/** Dossier de backup PDF traçabilité : /mnt/team/#TEAM/#TRAÇABILITÉ (exactement comme demandé) */
const TRACABILITE_PDF_BASE = '/mnt/team/#TEAM/#TRAÇABILITÉ';

/** Dossier PDF commandes : /mnt/team/#TEAM/#COMMANDES/ */
const COMMANDES_PDF_BASE = '/mnt/team/#TEAM/#COMMANDES/';

/** Dossier PDF dons stagiaires : /mnt/team/#TEAM/#TRAÇABILITÉ/don_stagiaires */
const DONS_PDF_BASE = '/mnt/team/#TEAM/#TRAÇABILITÉ/don_stagiaires';

/** Dossier PDF prêts / location matériel divers */
const PRETS_PDF_BASE = '/mnt/team/#TEAM/#TRAÇABILITÉ/prets_materiel';

/** Base partagée pour FolderManager (presets team, guest, capsule, development). */
const TEAM_BASE = '/mnt/team/#TEAM';

/** Montage équipe (chemins réels peuvent ne pas contenir le littéral « #TEAM »). */
const TEAM_MOUNT_ROOT = '/mnt/team';

/** Répertoires autorisés pour list-folders, open-path, read-file-as-base64 (sécurité). */
function getAllowedPathPrefixes() {
    const bases = [
        os.homedir(),
        app.getPath('userData'),
        app.getPath('documents'),
        app.getPath('temp'),
        TEAM_MOUNT_ROOT,
        TEAM_BASE,
        TRACABILITE_PDF_BASE,
        COMMANDES_PDF_BASE,
        DONS_PDF_BASE,
        PRETS_PDF_BASE
    ].filter(Boolean);
    return bases.map(p => path.normalize(p));
}

function isPathAllowed(resolvedPath) {
    const normalized = path.normalize(resolvedPath);
    const prefixes = getAllowedPathPrefixes();
    return prefixes.some(p => normalized === p || normalized.startsWith(p + path.sep));
}

/**
 * Formater une date ISO en "jj/mm/aaaa" pour le PDF (sans heure)
 */
function formatDateForPdf(iso) {
    if (!iso || typeof iso !== 'string') return '-';
    try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '-';
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        return `${day}/${month}/${year}`;
    } catch (_) {
        return '-';
    }
}

/**
 * Heure locale "HH-mm-ss" (pour rendre les noms de fichiers PDF uniques).
 * Utilisé uniquement quand aucun nom explicite n'est fourni.
 */
function formatTimeForFilename(d = new Date()) {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}-${mm}-${ss}`;
}

/** Échapper pour affichage dans le HTML du template PDF */
function escapeHtml(s) {
    if (s == null) return '';
    const str = String(s);
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Texte court affiché dans le PDF pour une colonne « liens » (le href reste l’URL complète).
 * http(s) → hostname seul (sans www.) ; mailto/tel → extrait utile ; sinon troncature.
 */
function getPdfLinkDisplayLabel(original, href) {
    const o = String(original).trim();
    try {
        const u = new URL(href);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
            let host = u.hostname || '';
            if (host.toLowerCase().startsWith('www.')) host = host.slice(4);
            return host || o;
        }
        if (u.protocol === 'mailto:') {
            const path = decodeURIComponent((u.pathname || '').replace(/^\/+/, ''));
            if (path.includes('@')) {
                const domain = path.split('@').pop().split('?')[0];
                return domain || 'E-mail';
            }
            return 'E-mail';
        }
        if (u.protocol === 'tel:') {
            const num = (u.pathname || '').replace(/\s/g, '');
            return num.length > 28 ? `${num.slice(0, 25)}…` : num || 'Tél.';
        }
    } catch (_) {
        /* href non standard */
    }
    if (o.length <= 48) return o;
    return `${o.slice(0, 45)}…`;
}

/**
 * Lien cliquable dans le PDF (annotations URI Chromium → lecteurs PDF).
 * Toute saisie non vide devient un <a> ; schémas dangereux neutralisés.
 * href : http(s), mailto, tel, ou préfixe https:// (y compris texte « approximatif »).
 * Affichage : domaine seul pour les URLs longues (ex. alibaba.com au lieu de la query complète).
 */
function formatPdfClickableLink(raw) {
    if (raw == null) return escapeHtml('-');
    const s = String(raw).trim();
    if (!s || s === '-') return escapeHtml('-');

    const href = buildPdfSafeLinkHref(s);
    const safeHref = escapeHtml(href);
    const display = escapeHtml(getPdfLinkDisplayLabel(s, href));
    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${display}</a>`;
}

/** Prix / montant pour PDF commande : nombre → format fr-FR avec €, sinon texte échappé. */
function formatCommandePriceForPdf(raw) {
    const s = String(raw ?? '').trim();
    if (!s || s === '-') return '-';
    const compact = s.replace(/\s/g, '');
    const normalized = compact.includes(',') && !compact.includes('.')
        ? compact.replace(',', '.')
        : compact.replace(',', '');
    const n = parseFloat(normalized);
    if (Number.isFinite(n) && normalized !== '' && /^-?\d*\.?\d+$/.test(normalized)) {
        const formatted = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(n);
        return escapeHtml(formatted);
    }
    return escapeHtml(s);
}

function commandeLineHasShipping(line) {
    const v = line?.shipping ?? line?.frais_port ?? line?.fraisPort;
    return String(v ?? '').trim() !== '';
}

function buildPdfSafeLinkHref(s) {
    const t = s.trim();
    const lower = t.toLowerCase();
    if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
        return 'about:blank';
    }
    if (/^https?:\/\//i.test(t)) return t;
    if (/^mailto:/i.test(t) || /^tel:/i.test(t)) return t;
    if (/^www\./i.test(t)) return 'https://' + t;
    if (/^\/\//.test(t)) return 'https:' + t;
    // Sous-domaine.domaine ou domaine.tld[/...] sans espace
    if (!/\s/.test(t) && /^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(t)) {
        return 'https://' + t;
    }
    // Fallback : tout est cliquable (URL souvent invalide mais annotation présente dans le PDF)
    return 'https://' + t.replace(/\s/g, '%20');
}

/** Libellés français pour les types (code API -> affichage PDF) */
const TYPE_LABELS = { portable: 'Portable', fixe: 'Fixe', ecran: 'Écran', autres: 'Autres' };
function typeLabel(code) {
    if (!code || typeof code !== 'string') return 'Non défini';
    const c = code.trim().toLowerCase();
    return TYPE_LABELS[c] || (code.trim() || 'Non défini');
}

/**
 * Formater date/heure item pour le PDF (created_at, state_changed_at, updated_at, ou date+time)
 */
function formatItemDateForPdf(it) {
    const iso = it.created_at || it.createdAt || it.state_changed_at || it.stateChangedAt || it.updated_at || it.updatedAt;
    if (iso) return formatDateForPdf(iso);
    if (it.date && it.time) {
        const d = it.date + 'T' + (String(it.time).length === 5 ? it.time + ':00' : it.time);
        return formatDateForPdf(d);
    }
    if (it.date && /^\d{4}-\d{2}-\d{2}/.test(String(it.date))) return formatDateForPdf(it.date + 'T00:00:00');
    // Chaîne type "YYYY-MM-DD HH:mm:ss" ou "YYYY-MM-DD"
    const dateStr = it.date || it.date_changed;
    if (dateStr && /^\d{4}-\d{2}-\d{2}/.test(String(dateStr))) return formatDateForPdf(String(dateStr).replace(' ', 'T').slice(0, 19) || dateStr + 'T00:00:00');
    return '-';
}

/** Construire le bloc HTML du résumé PDF : total + types en ligne, puis cartes par état */
function buildPdfSummaryBlock(totalItems, typeEntries, stateEntries) {
    const typeParts = typeEntries.map(([typeName, count]) => `${escapeHtml(typeLabel(typeName))} ${count}`).join(', ');
    const totalLine = `<p class="pdf-summary-total-line"><i class="fa-solid fa-laptop-code"></i> <strong>${escapeHtml(String(totalItems))} machine(s)</strong>${typeParts ? ` (${typeParts})` : ''}</p>`;
    const stateCards = stateEntries
        .map(([stateName, count]) => `<span class="pdf-summary-state-card"><span class="pdf-summary-state-name">${escapeHtml(stateName)}</span><span class="pdf-summary-state-count">${escapeHtml(String(count))}</span></span>`)
        .join('\n');
    return `${totalLine}\n<div class="pdf-summary-state-cards">${stateCards}</div>`;
}

/**
 * Générer le PDF d'un lot via le template HTML/CSS si présent, sinon PDFKit.
 * Template : apps/client/public/pdf-templates/lot.html + lot.css
 * Placeholders : {{lotId}}, {{lotName}}, {{created_at}}, {{finished_at}}, {{recovered_at}},
 * {{summary_block}}, {{items_rows}}
 */
// Mapping OS → icône Font Awesome (fa-brands) et libellé pour les PDF des lots
const PDF_OS_MAP = {
    windows: { icon: 'windows', title: 'Windows' },
    linux: { icon: 'linux', title: 'Linux' },
    chrome: { icon: 'chrome', title: 'Chrome OS' },
    apple: { icon: 'apple', title: 'Apple' },
    android: { icon: 'android', title: 'Android' },
    bsd: { icon: 'freebsd', title: 'BSD' }
};

async function generateLotPdfFromHtmlTemplate(payload, fullPath, stateEntries, typeEntries, totalItems) {
    const templateDir = path.join(__dirname, 'public', 'pdf-templates');
    const htmlPath = path.join(templateDir, 'lot.html');
    const cssPath = path.join(templateDir, 'lot.css');
    if (!fs.existsSync(htmlPath) || !fs.existsSync(cssPath)) {
        return null;
    }
    const {
        lotId,
        lotName,
        items = [],
        created_at,
        finished_at,
        recovered_at
    } = payload;

    const css = fs.readFileSync(cssPath, 'utf8');
    let html = fs.readFileSync(htmlPath, 'utf8');

    const summaryBlock = buildPdfSummaryBlock(totalItems, typeEntries, stateEntries);
    const itemsRows = items
        .map((it, idx) => {
            const num = it.numero != null ? it.numero : idx + 1;
            const type = escapeHtml(typeLabel(it.type));
            const marque = escapeHtml(it.marque_name || it.marqueName || '-');
            const modele = escapeHtml(it.modele_name || it.modeleName || '-');
            const sn = escapeHtml(it.serial_number || it.serialNumber || '-');
            const rawState = (it.state && String(it.state).trim()) || '';
            const stateLower = rawState.toLowerCase();
            let stateDisplay;
            if (/reconditionn[eé]s?/.test(stateLower)) stateDisplay = 'OK';
            else if (stateLower === 'pour pièces' || stateLower === 'hs') stateDisplay = 'HS';
            else stateDisplay = escapeHtml(rawState || '-');
            const dateHeure = escapeHtml(formatItemDateForPdf(it));
            const tech = escapeHtml(it.technician || it.technicien || '-');
            const osKey = (it.os && String(it.os).toLowerCase().trim()) || 'linux';
            const osInfo = PDF_OS_MAP[osKey] || PDF_OS_MAP.linux;
            const osIcon = osInfo.icon;
            const osTitle = osInfo.title;
            return `<tr><td class="col-num">${num}</td><td class="col-type">${type}</td><td class="col-marque">${marque}</td><td class="col-modele">${modele}</td><td class="col-os"><i class="fa-brands fa-${osIcon}" title="${osTitle}"></i></td><td class="col-sn">${sn}</td><td class="col-state">${stateDisplay}</td><td class="col-date">${dateHeure}</td><td class="col-tech">${tech}</td></tr>`;
        })
        .join('\n');

    const replacements = [
        [/\{\{\s*lotId\s*\}\}/g, escapeHtml(lotId)],
        [/\{\{\s*lotName\s*\}\}/g, escapeHtml(lotName || '-')],
        [/\{\{\s*created_at\s*\}\}/g, escapeHtml(formatDateForPdf(created_at))],
        [/\{\{\s*finished_at\s*\}\}/g, escapeHtml(formatDateForPdf(finished_at))],
        [/\{\{\s*recovered_at\s*\}\}/g, escapeHtml(formatDateForPdf(recovered_at))],
        [/\{\{\s*totalItems\s*\}\}/g, String(totalItems)],
        [/\{\{\s*summary_block\s*\}\}/g, summaryBlock],
        [/\{\{\s*items_rows\s*\}\}/g, itemsRows]
    ];
    replacements.forEach(([regex, value]) => { html = html.replace(regex, value); });

    html = html.replace(
        /<link\s+rel="stylesheet"\s+href="lot\.css"\s*\/?>/i,
        `<style>${css}</style>`
    );

    // FontAwesome : privilégier le fichier local (file://) pour les icônes quand le HTML est chargé depuis /tmp
    const fontawesomeCssPath = path.join(__dirname, 'public', 'assets', 'css', 'fontawesome-local.css');
    const fontawesomeFileUrl = fs.existsSync(fontawesomeCssPath) ? url.pathToFileURL(fontawesomeCssPath).href : null;
    const fontawesomeLink = fontawesomeFileUrl ? `<link rel="stylesheet" href="${fontawesomeFileUrl}">` : '';
    if (fontawesomeLink) {
        if (/<link[^>]+font-awesome[^>]*>/i.test(html))
            html = html.replace(/<link[^>]+font-awesome[^>]*>/i, fontawesomeLink);
        else if (!html.includes('fontawesome'))
            html = html.replace('</head>', `${fontawesomeLink}\n</head>`);
    }

    // Images (logo, etc.) : réécrire les src relatifs en file:// pour que ça charge depuis /tmp
    html = html.replace(/<img([^>]*)\ssrc="([^"]+)"/gi, (match, attrs, src) => {
        if (/^(https?:|\/|data:|file:)/i.test(src.trim())) return match;
        const absolutePath = path.resolve(templateDir, src.trim());
        if (!fs.existsSync(absolutePath)) return match;
        const fileUrl = url.pathToFileURL(absolutePath).href;
        return `<img${attrs} src="${fileUrl}"`;
    });

    const tempDir = app.getPath('temp');
    const outputPath = path.join(tempDir, `workspace-lot-pdf-${Date.now()}.html`);
    try {
        fs.writeFileSync(outputPath, html, 'utf8');
    } catch (e) {
        console.error('❌ generate-lot-pdf write temp HTML:', e.message);
        return null;
    }

    const win = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, offscreen: true }
    });
    try {
        await win.loadFile(outputPath);
        const pdfBuffer = await win.webContents.printToPDF({
            printBackground: true,
            pageSize: 'A4',
            preferCSSPageSize: true
        });
        fs.writeFileSync(fullPath, pdfBuffer);
        return { success: true, pdf_path: path.resolve(fullPath) };
    } finally {
        win.close();
        try { fs.unlinkSync(outputPath); } catch (_) { }
    }
}

/**
 * Générer le PDF d'un lot et l'enregistrer localement dans le dossier traçabilité.
 * Payload: { lotId, lotName, date, items, created_at?, finished_at?, recovered_at?, basePath? }
 */
ipcMain.handle('generate-lot-pdf', async (_event, payload) => {
    const {
        lotId,
        lotName,
        date,
        items = [],
        created_at,
        finished_at,
        recovered_at,
        basePath = TRACABILITE_PDF_BASE
    } = payload || {};
    if (!lotId) {
        return { success: false, error: 'lotId requis' };
    }
    const rawDate = date ? String(date).trim() : (finished_at ? String(finished_at).slice(0, 10) : '');
    const dateStr = /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const year = dateStr.slice(0, 4);
    const monthNum = parseInt(dateStr.slice(5, 7), 10) || 1;
    const MOIS_TRACABILITE = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
    const nomMois = MOIS_TRACABILITE[Math.max(0, monthNum - 1)];
    const dirPath = path.join(basePath, year, nomMois);
    try {
        fs.mkdirSync(dirPath, { recursive: true });
    } catch (e) {
        console.error('❌ generate-lot-pdf mkdir:', e.message);
        return { success: false, error: 'Impossible de créer le dossier: ' + e.message };
    }
    let sanitizedName = (lotName || '').replace(/[\s]+/g, '_').replace(/[\\/:*?"<>|]/g, '').trim();
    if (!sanitizedName) sanitizedName = `Lot_${lotId}`;
    const fileName = `${sanitizedName}_${dateStr}.pdf`;
    const fullPath = path.join(dirPath, fileName);

    const totalItems = items.length;
    const stateCounts = {};
    const typeCounts = {};
    items.forEach((it) => {
        const s = (it.state && String(it.state).trim()) || 'Non défini';
        stateCounts[s] = (stateCounts[s] || 0) + 1;
        const t = (it.type && String(it.type).trim()) || 'Non défini';
        typeCounts[t] = (typeCounts[t] || 0) + 1;
    });
    const STATE_ORDER = ['Reconditionnés', 'Pour pièces', 'HS', 'Non défini'];
    const stateEntries = STATE_ORDER.map((name) => [name, stateCounts[name] || 0]);
    const typeEntries = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);

    try {
        const htmlResult = await generateLotPdfFromHtmlTemplate(
            { lotId, lotName, date, items, created_at, finished_at, recovered_at },
            fullPath,
            stateEntries,
            typeEntries,
            totalItems
        );
        if (htmlResult) return htmlResult;
    } catch (err) {
        console.error('❌ generate-lot-pdf (template HTML):', err.message);
    }

    const margin = 50;
    const pageWidth = 595;
    const contentWidth = pageWidth - margin * 2;

    return new Promise((resolve) => {
        const doc = new PDFDocument({ margin, size: 'A4' });
        const stream = fs.createWriteStream(fullPath);
        doc.pipe(stream);

        let y = margin;

        // ---- En-tête ----
        doc.fontSize(22).font('Helvetica-Bold').text(`Lot #${lotId}`, margin, y);
        y = doc.y + 4;
        doc.fontSize(11).font('Helvetica').fillColor('#333333').text(lotName || '-', margin, y);
        y = doc.y + 16;

        // ---- Bloc Infos (créé / terminé / récupéré) - style type icônes (symboles Unicode) ----
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#1a1a1a').text('Informations du lot', margin, y);
        y += 18;
        const lineH = 16;
        const bulletX = margin;
        const labelX = margin + 14;
        const valueX = labelX + 82;
        doc.font('Helvetica').fontSize(10);
        doc.fillColor('#2e7d32').text('\u2022', bulletX, y); doc.fillColor('#444444').text('Créé le', labelX, y); doc.fillColor('#1a1a1a').text(formatDateForPdf(created_at), valueX, y);
        y += lineH;
        doc.fillColor('#2e7d32').text('\u2022', bulletX, y); doc.fillColor('#444444').text('Terminé le', labelX, y); doc.fillColor('#1a1a1a').text(formatDateForPdf(finished_at), valueX, y);
        y += lineH;
        doc.fillColor('#2e7d32').text('\u2022', bulletX, y); doc.fillColor('#444444').text('Récupéré le', labelX, y); doc.fillColor(recovered_at ? '#1a1a1a' : '#888888').text(recovered_at ? formatDateForPdf(recovered_at) : '-', valueX, y);
        y += lineH + 8;

        // ---- Résumé (total + par état) ----
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#1a1a1a').text('Résumé', margin, y);
        y += 18;
        doc.font('Helvetica').fontSize(10);
        doc.fillColor('#1565c0').text('\u2022', bulletX, y); doc.fillColor('#444444').text(`Total : ${totalItems} machine${totalItems !== 1 ? 's' : ''}`, labelX, y);
        y += lineH;
        stateEntries.forEach(([stateName, count]) => {
            doc.fillColor('#1565c0').text('\u2022', bulletX, y); doc.fillColor('#444444').text(`${stateName} : ${count}`, labelX, y);
            y += lineH;
        });
        y += 12;

        // ---- Tableau détail ----
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#1a1a1a').text('Détail des articles', margin, y);
        y += 16;
        const colN = 38;
        const colSn = 38;
        const colType = 70;
        const colMarque = 75;
        const colModele = 85;
        const colState = 75;
        const colTech = 90;
        const tableLeft = margin;
        const headerY = y;
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#333333');
        doc.text('N°', tableLeft, headerY);
        doc.text('S/N', tableLeft + colN, headerY);
        doc.text('Type', tableLeft + colN + colSn, headerY);
        doc.text('Marque', tableLeft + colN + colSn + colType, headerY);
        doc.text('Modèle', tableLeft + colN + colSn + colType + colMarque, headerY);
        doc.text('État', tableLeft + colN + colSn + colType + colMarque + colModele, headerY);
        doc.text('Technicien', tableLeft + colN + colSn + colType + colMarque + colModele + colState, headerY);
        y += 14;
        doc.moveTo(tableLeft, y).lineTo(tableLeft + contentWidth, y).strokeColor('#cccccc').stroke();
        y += 10;
        doc.font('Helvetica').fontSize(9).fillColor('#1a1a1a');
        let rowNum = 1;
        for (const it of items) {
            const num = String(it.numero != null ? it.numero : rowNum);
            rowNum += 1;
            const sn = String(it.serial_number || '-').slice(0, 18);
            const type = String(it.type || '-').slice(0, 10);
            const marque = String(it.marque_name || '-').slice(0, 12);
            const modele = String(it.modele_name || '-').slice(0, 14);
            const state = String(it.state || '-').slice(0, 12);
            const tech = String(it.technician || '-').slice(0, 14);
            doc.text(num, tableLeft, y);
            doc.text(sn, tableLeft + colN, y);
            doc.text(type, tableLeft + colN + colSn, y);
            doc.text(marque, tableLeft + colN + colSn + colType, y);
            doc.text(modele, tableLeft + colN + colSn + colType + colMarque, y);
            doc.text(state, tableLeft + colN + colSn + colType + colMarque + colModele, y);
            doc.text(tech, tableLeft + colN + colSn + colType + colMarque + colModele + colState, y);
            y += 15;
        }

        doc.end();
        stream.on('finish', () => resolve({ success: true, pdf_path: path.resolve(fullPath) }));
        stream.on('error', (err) => {
            console.error('❌ generate-lot-pdf stream:', err.message);
            resolve({ success: false, error: err.message });
        });
        doc.on('error', (err) => {
            console.error('❌ generate-lot-pdf doc:', err.message);
            resolve({ success: false, error: err.message });
        });
    });
});

// ---------- Disques PDF (template HTML/CSS, même principe que lots) ----------
const MOIS_TRACABILITE = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

function parseSizeToTo(size) {
    if (!size || typeof size !== 'string') return 0;
    const s = String(size).trim();
    if (!s) return 0;
    // Accepter To/TB/T, Go/GB/G, Mo/MB/M, Ko/KB/K (une ou deux lettres)
    const numMatch = s.match(/^([\d\s,]+(?:\.[\d]+)?)\s*(To|TB|T|Go|GB|G|Mo|MB|M|Ko|KB|K)?$/i);
    if (!numMatch) return 0;
    const num = parseFloat(numMatch[1].replace(/\s/g, '').replace(',', '.')) || 0;
    const unit = (numMatch[2] || '').toLowerCase();
    if (unit === 'to' || unit === 'tb' || unit === 't') return num;
    if (unit === 'go' || unit === 'gb' || unit === 'g') return num / 1000;
    if (unit === 'mo' || unit === 'mb' || unit === 'm') return num / 1e6;
    if (unit === 'ko' || unit === 'kb' || unit === 'k') return num / 1e9;
    // Pas d'unité : supposer Go (ex. "500" = 500 Go)
    return num / 1000;
}

function formatTo(to) {
    if (to % 1 === 0) return String(Math.round(to));
    return to.toFixed(2).replace(/\.?0+$/, '');
}

/** Affiche une taille en To ou Go : >= 1 To → "X,X To", sinon → "X Go" */
function formatSizeDisplay(to) {
    if (to >= 1) return `${formatTo(to)} To`;
    const go = to * 1000;
    return `${formatTo(go)} Go`;
}

function    buildDisquesCountByInterface(disks) {
    const byIf = {};
    disks.forEach((d) => {
        const iface = (d.interface || '-').trim() || '-';
        byIf[iface] = (byIf[iface] || 0) + 1;
    });
    const parts = Object.entries(byIf)
        .filter(([, n]) => n > 0)
        .sort((a, b) => a[0].localeCompare(b[0]));
    return parts
        .map(([iface, n]) => `<li><i class="fa-solid fa-hard-drive"></i> ${escapeHtml(iface)} : ${n}</li>`)
        .join('\n');
}

function buildDisquesSizeByInterface(disks) {
    const byIf = {};
    disks.forEach((d) => {
        const iface = (d.interface || '-').trim() || '-';
        const to = parseSizeToTo(d.size);
        byIf[iface] = (byIf[iface] || 0) + to;
    });
    const parts = Object.entries(byIf)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([iface, to]) => `<li><i class="fa-solid fa-database"></i> ${escapeHtml(iface)} = ${escapeHtml(formatSizeDisplay(to))}</li>`);
    return parts.length ? parts.join('\n') : '';
}

function formatDisquesTotalSize(disks) {
    const to = disks.reduce((sum, d) => sum + parseSizeToTo(d.size), 0);
    return to === 0 ? '—' : formatSizeDisplay(to);
}

function buildDisquesSummaryBlock(disks) {
    const totalSizeStr = formatDisquesTotalSize(disks);
    const sizeByInterfaceList = buildDisquesSizeByInterface(disks);
    const totalLine = totalSizeStr !== '—'
        ? `<p class="pdf-summary-total-line"><i class="fa-solid fa-database"></i> <strong>Taille totale : ${escapeHtml(totalSizeStr)}</strong></p>`
        : '';
    const listHtml = sizeByInterfaceList ? `<ul class="pdf-summary-by-interface">${sizeByInterfaceList}</ul>` : '';
    return totalLine + listHtml;
}

/**
 * Générer le PDF d'une session disques via le template HTML/CSS (disques.html + disques.css).
 * Placeholders : {{date}}, {{count_by_interface}}, {{size_by_interface}}, {{total_size}}, {{summary_block}}, {{items_rows}}
 */
async function generateDisquesPdfFromHtmlTemplate(payload, fullPath) {
    const templateDir = path.join(__dirname, 'public', 'pdf-templates');
    const htmlPath = path.join(templateDir, 'disques.html');
    const cssPath = path.join(templateDir, 'disques.css');
    if (!fs.existsSync(htmlPath) || !fs.existsSync(cssPath)) {
        return null;
    }
    const { date, disks = [] } = payload;

    const css = fs.readFileSync(cssPath, 'utf8');
    let html = fs.readFileSync(htmlPath, 'utf8');

    const dateStr = (date && /^\d{4}-\d{2}-\d{2}/.test(String(date).trim())) ? String(date).trim().slice(0, 10) : new Date().toISOString().slice(0, 10);
    const dateFormatted = formatDateForPdf(dateStr);

    const totalCount = disks.length;
    const countByInterfaceList = buildDisquesCountByInterface(disks);
    const sizeByInterface = buildDisquesSizeByInterface(disks);
    const totalSize = formatDisquesTotalSize(disks);
    const summaryBlock = buildDisquesSummaryBlock(disks);
    const itemsRows = disks
        .map((d, idx) => {
            const num = idx + 1;
            const sn = escapeHtml((d.serial || '-').toString().trim());
            const marque = escapeHtml((d.marque || '-').toString().trim());
            const modele = escapeHtml((d.modele || '-').toString().trim());
            const size = escapeHtml((d.size || '-').toString().trim());
            const diskType = escapeHtml((d.disk_type || '-').toString().trim());
            const iface = escapeHtml((d.interface || '-').toString().trim());
            const shred = escapeHtml((d.shred || '-').toString().trim());
            return `<tr><td class="col-select">☑</td><td class="col-num">${num}</td><td class="col-sn">${sn}</td><td class="col-marque">${marque}</td><td class="col-modele">${modele}</td><td class="col-size">${size}</td><td class="col-disk-type">${diskType}</td><td class="col-interface">${iface}</td><td class="col-shred">${shred}</td></tr>`;
        })
        .join('\n');

    const replacements = [
        [/\{\{\s*date\s*\}\}/g, escapeHtml(dateFormatted)],
        [/\{\{\s*total_count\s*\}\}/g, escapeHtml(String(totalCount))],
        [/\{\{\s*count_by_interface_list\s*\}\}/g, countByInterfaceList],
        [/\{\{\s*size_by_interface\s*\}\}/g, sizeByInterface],
        [/\{\{\s*total_size\s*\}\}/g, escapeHtml(totalSize)],
        [/\{\{\s*summary_block\s*\}\}/g, summaryBlock],
        [/\{\{\s*items_rows\s*\}\}/g, itemsRows]
    ];
    replacements.forEach(([regex, value]) => { html = html.replace(regex, value); });

    html = html.replace(
        /<link\s+rel="stylesheet"\s+href="disques\.css"\s*\/?>/i,
        `<style>${css}</style>`
    );

    const fontawesomeCssPath = path.join(__dirname, 'public', 'assets', 'css', 'fontawesome-local.css');
    const fontawesomeFileUrl = fs.existsSync(fontawesomeCssPath) ? url.pathToFileURL(fontawesomeCssPath).href : null;
    const fontawesomeLink = fontawesomeFileUrl ? `<link rel="stylesheet" href="${fontawesomeFileUrl}">` : '';
    if (fontawesomeLink) {
        if (/<link[^>]+font-awesome[^>]*>/i.test(html)) {
            html = html.replace(/<link[^>]+font-awesome[^>]*>/i, fontawesomeLink);
        } else if (!html.includes('fontawesome')) {
            html = html.replace('</head>', `${fontawesomeLink}\n</head>`);
        }
    }

    html = html.replace(/<img([^>]*)\ssrc="([^"]+)"/gi, (match, attrs, src) => {
        if (/^(https?:|\/|data:|file:)/i.test(src.trim())) return match;
        const absolutePath = path.resolve(templateDir, src.trim());
        if (!fs.existsSync(absolutePath)) return match;
        const fileUrl = url.pathToFileURL(absolutePath).href;
        return `<img${attrs} src="${fileUrl}"`;
    });

    const tempDir = app.getPath('temp');
    const outputPath = path.join(tempDir, `workspace-disques-pdf-${Date.now()}.html`);
    try {
        fs.writeFileSync(outputPath, html, 'utf8');
    } catch (e) {
        console.error('❌ generate-disques-pdf write temp HTML:', e.message);
        return null;
    }

    const win = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, offscreen: true }
    });
    try {
        await win.loadFile(outputPath);
        const pdfBuffer = await win.webContents.printToPDF({
            printBackground: true,
            pageSize: 'A4',
            preferCSSPageSize: true
        });
        fs.writeFileSync(fullPath, pdfBuffer);
        return { success: true, pdf_path: path.resolve(fullPath) };
    } finally {
        win.close();
        try { fs.unlinkSync(outputPath); } catch (_) { }
    }
}

/**
 * Générer le PDF d'une session disques (template HTML/CSS) et l'enregistrer dans .../Disques/AAAA/Mois.
 * Payload: { sessionId, date, name?, disks, basePath? }
 */
ipcMain.handle('generate-disques-pdf', async (_event, payload) => {
    const {
        sessionId,
        date,
        name,
        disks = [],
        basePath = TRACABILITE_PDF_BASE
    } = payload || {};
    if (!sessionId) {
        return { success: false, error: 'sessionId requis' };
    }
    const rawDate = (date && String(date).trim()) ? String(date).trim() : new Date().toISOString().slice(0, 10);
    const dateStr = /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const year = dateStr.slice(0, 4);
    const monthNum = parseInt(dateStr.slice(5, 7), 10) || 1;
    const nomMois = MOIS_TRACABILITE[Math.max(0, monthNum - 1)] || 'Janvier';
    const disquesBase = path.join(basePath, 'Disques');
    const dirPath = path.join(disquesBase, year, nomMois);
    try {
        fs.mkdirSync(dirPath, { recursive: true });
    } catch (e) {
        console.error('❌ generate-disques-pdf mkdir:', e.message);
        return { success: false, error: 'Impossible de créer le dossier: ' + e.message };
    }
    const sanitizedName = (name != null ? String(name).trim() : '')
        .replace(/\s+/g, '_')
        .replace(/[\\/:*?"<>|]/g, '')
        .trim();
    const baseName = sanitizedName || `disques-session-${sessionId}`;
    const fileName = `${baseName}_${dateStr}.pdf`;
    const fullPath = path.join(dirPath, fileName);

    try {
        const result = await generateDisquesPdfFromHtmlTemplate({ date: dateStr, disks }, fullPath);
        if (result) return result;
    } catch (err) {
        console.error('❌ generate-disques-pdf (template HTML):', err.message);
        return { success: false, error: err.message };
    }
    return { success: false, error: 'Template disques introuvable ou échec génération' };
});

/**
 * Générer le PDF d'une commande via le template HTML/CSS (commande.html + commande.css).
 * Placeholders : {{commande_name}}, {{date}}, {{pdf_table_head}}, {{rows}}
 */
async function generateCommandePdfFromHtmlTemplate(payload, fullPath) {
    const templateDir = path.join(__dirname, 'public', 'pdf-templates');
    const htmlPath = path.join(templateDir, 'commande.html');
    const cssPath = path.join(templateDir, 'commande.css');
    if (!fs.existsSync(htmlPath) || !fs.existsSync(cssPath)) {
        return null;
    }
    const { commandeName, date, lines = [] } = payload;

    const css = fs.readFileSync(cssPath, 'utf8');
    let html = fs.readFileSync(htmlPath, 'utf8');

    const dateStr = (date && /^\d{4}-\d{2}-\d{2}/.test(String(date).trim())) ? String(date).trim().slice(0, 10) : new Date().toISOString().slice(0, 10);
    const dateFormatted = formatDateForPdf(dateStr);

    const showShippingCol = Array.isArray(lines) && lines.some(commandeLineHasShipping);
    const pdfTableHead = [
        '<th class="col-num">N°</th>',
        '<th class="col-produit">Produit</th>',
        '<th class="col-quantite">Quantité</th>',
        '<th class="col-prix">Prix</th>',
        ...(showShippingCol ? ['<th class="col-frais-port">Frais de port (€)</th>'] : []),
        '<th class="col-liens">Liens</th>'
    ].join('');

    const rows = lines
        .map((line) => {
            const num = line.num != null ? line.num : 0;
            const produit = escapeHtml((line.produit || '-').toString().trim());
            const quantity = escapeHtml((line.quantity || '-').toString().trim());
            const price = formatCommandePriceForPdf(line.price);
            const shipRaw = (line.shipping ?? line.frais_port ?? line.fraisPort ?? '').toString().trim();
            const shippingTd = showShippingCol
                ? `<td class="col-frais-port">${shipRaw ? formatCommandePriceForPdf(shipRaw) : ''}</td>`
                : '';
            const linkCell = formatPdfClickableLink((line.link || '-').toString().trim());
            return `<tr><td class="col-num">${num}</td><td class="col-produit">${produit}</td><td class="col-quantite">${quantity}</td><td class="col-prix">${price}</td>${shippingTd}<td class="col-liens">${linkCell}</td></tr>`;
        })
        .join('\n');

    html = html.replace(/\{\{\s*commande_name\s*\}\}/g, escapeHtml((commandeName || 'Commande').toString().trim()));
    html = html.replace(/\{\{\s*date\s*\}\}/g, escapeHtml(dateFormatted));
    html = html.replace(/\{\{\s*pdf_table_head\s*\}\}/g, pdfTableHead);
    html = html.replace(/\{\{\s*rows\s*\}\}/g, rows);

    html = html.replace(
        /<link\s+rel="stylesheet"\s+href="commande\.css"\s*\/?>/i,
        `<style>${css}</style>`
    );

    const fontawesomeCssPath = path.join(__dirname, 'public', 'assets', 'css', 'fontawesome-local.css');
    const fontawesomeFileUrl = fs.existsSync(fontawesomeCssPath) ? url.pathToFileURL(fontawesomeCssPath).href : null;
    const fontawesomeLink = fontawesomeFileUrl ? `<link rel="stylesheet" href="${fontawesomeFileUrl}">` : '';
    if (fontawesomeLink) {
        if (/<link[^>]+font-awesome[^>]*>/i.test(html)) {
            html = html.replace(/<link[^>]+font-awesome[^>]*>/i, fontawesomeLink);
        } else if (!html.includes('fontawesome')) {
            html = html.replace('</head>', `${fontawesomeLink}\n</head>`);
        }
    }

    html = html.replace(/<img([^>]*)\ssrc="([^"]+)"/gi, (match, attrs, src) => {
        if (/^(https?:|\/|data:|file:)/i.test(src.trim())) return match;
        const absolutePath = path.resolve(templateDir, src.trim());
        if (!fs.existsSync(absolutePath)) return match;
        const fileUrl = url.pathToFileURL(absolutePath).href;
        return `<img${attrs} src="${fileUrl}"`;
    });

    const tempDir = app.getPath('temp');
    const outputPath = path.join(tempDir, `workspace-commande-pdf-${Date.now()}.html`);
    try {
        fs.writeFileSync(outputPath, html, 'utf8');
    } catch (e) {
        console.error('❌ generate-commande-pdf write temp HTML:', e.message);
        return null;
    }

    // Pas d'offscreen : sinon Chromium omet souvent les annotations de lien dans le PDF.
    const win = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    try {
        await win.loadFile(outputPath);
        await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
        let pdfBuffer;
        try {
            pdfBuffer = await win.webContents.printToPDF({
                printBackground: true,
                pageSize: 'A4',
                preferCSSPageSize: true,
                generateTaggedPDF: true
            });
        } catch (pdfErr) {
            console.warn('⚠️ printToPDF (tagged) commande, nouvel essai sans generateTaggedPDF:', pdfErr?.message);
            pdfBuffer = await win.webContents.printToPDF({
                printBackground: true,
                pageSize: 'A4',
                preferCSSPageSize: true
            });
        }
        fs.writeFileSync(fullPath, pdfBuffer);
        return { success: true, pdf_path: path.resolve(fullPath) };
    } finally {
        win.close();
        try { fs.unlinkSync(outputPath); } catch (_) { }
    }
}

/**
 * Générer le PDF d'une commande et l'enregistrer dans /mnt/team/#TEAM/#COMMANDES/.
 * Payload: { commandeName, date, lines, basePath? }
 */
ipcMain.handle('generate-commande-pdf', async (_event, payload) => {
    const {
        commandeName,
        category,
        date,
        lines = [],
        basePath = COMMANDES_PDF_BASE
    } = payload || {};
    if (!commandeName || !String(commandeName).trim()) {
        return { success: false, error: 'Nom de la commande requis' };
    }
    if (!category || !String(category).trim()) {
        return { success: false, error: 'Catégorie requise' };
    }
    const rawDate = (date && String(date).trim()) ? String(date).trim() : new Date().toISOString().slice(0, 10);
    const dateStr = /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const sanitizedCategory = String(category).trim().replace(/\s+/g, '_').replace(/[\\/:*?"<>|]/g, '').trim() || 'Divers';
    const targetBasePath = path.join(basePath, sanitizedCategory);
    try {
        fs.mkdirSync(targetBasePath, { recursive: true });
    } catch (e) {
        console.error('❌ generate-commande-pdf mkdir:', e.message);
        return { success: false, error: 'Impossible de créer le dossier: ' + e.message };
    }
    const sanitizedName = String(commandeName).trim().replace(/\s+/g, '_').replace(/[\\/:*?"<>|]/g, '').trim() || 'commande';
    const fileName = `${sanitizedName}_${dateStr}.pdf`;
    const fullPath = path.join(targetBasePath, fileName);

    try {
        const result = await generateCommandePdfFromHtmlTemplate({ commandeName, date: dateStr, lines }, fullPath);
        if (result) return result;
    } catch (err) {
        console.error('❌ generate-commande-pdf (template HTML):', err.message);
        return { success: false, error: err.message };
    }
    return { success: false, error: 'Template commande introuvable ou échec génération' };
});

/**
 * Générer le PDF d'un don (certificat) via le template HTML/CSS (dons.html + dons.css).
 * Placeholders : {{date}}, {{lot_name}}, {{lot_name_block}}, {{rows}}
 */
async function generateDonsPdfFromHtmlTemplate(payload, fullPath) {
    const templateDir = path.join(__dirname, 'public', 'pdf-templates');
    const htmlPath = path.join(templateDir, 'dons.html');
    const cssPath = path.join(templateDir, 'dons.css');
    if (!fs.existsSync(htmlPath) || !fs.existsSync(cssPath)) {
        return null;
    }
    const { lotName, date, lines = [] } = payload;

    const css = fs.readFileSync(cssPath, 'utf8');
    let html = fs.readFileSync(htmlPath, 'utf8');

    const dateStr = (date && /^\d{4}-\d{2}-\d{2}/.test(String(date).trim())) ? String(date).trim().slice(0, 10) : new Date().toISOString().slice(0, 10);
    const dateFormatted = formatDateForPdf(dateStr);

    const lotNameDisplay = (lotName && String(lotName).trim()) ? String(lotName).trim() : '';
    const lotNameBlock = lotNameDisplay
        ? `<p class="pdf-summary-total-line lot-name-line"><span class="label"><i class="fa-solid fa-tag"></i> Lot :</span> <span class="value">${escapeHtml(lotNameDisplay)}</span></p>`
        : '';

    const rows = lines
        .map((line) => {
            const num = line.num != null ? line.num : 0;
            const type = escapeHtml((line.type || '-').toString().trim());
            const marque = escapeHtml((line.marqueName || '-').toString().trim());
            const modele = escapeHtml((line.modeleName || '-').toString().trim());
            const sn = escapeHtml((line.serialNumber || '-').toString().trim());
            const lineDate = escapeHtml((line.date || '-').toString().trim());
            const stagiaire = escapeHtml((line.stagiaire || '-').toString().trim());
            return `<tr><td class="col-num">${num}</td><td class="col-type">${type}</td><td class="col-marque">${marque}</td><td class="col-modele">${modele}</td><td class="col-sn">${sn}</td><td class="col-date">${lineDate}</td><td class="col-stagiaire">${stagiaire}</td><td class="col-signature"></td></tr>`;
        })
        .join('\n');

    html = html.replace(/\{\{\s*date\s*\}\}/g, escapeHtml(dateFormatted));
    html = html.replace(/\{\{\s*lot_name\s*\}\}/g, escapeHtml(lotNameDisplay || 'don'));
    html = html.replace(/\{\{\s*lot_name_block\s*\}\}/g, lotNameBlock);
    html = html.replace(/\{\{\s*rows\s*\}\}/g, rows);

    html = html.replace(
        /<link\s+rel="stylesheet"\s+href="dons\.css"\s*\/?>/i,
        `<style>${css}</style>`
    );

    const fontawesomeCssPath = path.join(__dirname, 'public', 'assets', 'css', 'fontawesome-local.css');
    const fontawesomeFileUrl = fs.existsSync(fontawesomeCssPath) ? url.pathToFileURL(fontawesomeCssPath).href : null;
    const fontawesomeLink = fontawesomeFileUrl ? `<link rel="stylesheet" href="${fontawesomeFileUrl}">` : '';
    if (fontawesomeLink) {
        if (/<link[^>]+font-awesome[^>]*>/i.test(html)) {
            html = html.replace(/<link[^>]+font-awesome[^>]*>/i, fontawesomeLink);
        } else if (!html.includes('fontawesome')) {
            html = html.replace('</head>', `${fontawesomeLink}\n</head>`);
        }
    }

    html = html.replace(/<img([^>]*)\ssrc="([^"]+)"/gi, (match, attrs, src) => {
        if (/^(https?:|\/|data:|file:)/i.test(src.trim())) return match;
        const absolutePath = path.resolve(templateDir, src.trim());
        if (!fs.existsSync(absolutePath)) return match;
        const fileUrl = url.pathToFileURL(absolutePath).href;
        return `<img${attrs} src="${fileUrl}"`;
    });

    const tempDir = app.getPath('temp');
    const outputPath = path.join(tempDir, `workspace-dons-pdf-${Date.now()}.html`);
    try {
        fs.writeFileSync(outputPath, html, 'utf8');
    } catch (e) {
        console.error('❌ generate-don-pdf write temp HTML:', e.message);
        return null;
    }

    const win = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, offscreen: true }
    });
    try {
        await win.loadFile(outputPath);
        const pdfBuffer = await win.webContents.printToPDF({
            printBackground: true,
            pageSize: 'A4',
            preferCSSPageSize: true
        });
        fs.writeFileSync(fullPath, pdfBuffer);
        return { success: true, pdf_path: path.resolve(fullPath) };
    } finally {
        win.close();
        try { fs.unlinkSync(outputPath); } catch (_) { }
    }
}

/**
 * Générer le PDF d'un don (certificat) et l'enregistrer dans /mnt/team/#TEAM/#TRAÇABILITÉ/don_stagiaires.
 * Payload: { lotName?, date, lines, basePath? }
 */
ipcMain.handle('generate-don-pdf', async (_event, payload) => {
    const {
        lotName,
        date,
        lines = [],
        basePath = DONS_PDF_BASE
    } = payload || {};
    const rawDate = (date && String(date).trim()) ? String(date).trim() : new Date().toISOString().slice(0, 10);
    const dateStr = /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const [yearPart, monthPart] = dateStr.split('-');
    const year = /^\d{4}$/.test(yearPart || '') ? yearPart : new Date().toISOString().slice(0, 4);
    const monthNumber = /^(0[1-9]|1[0-2])$/.test(monthPart || '') ? Number(monthPart) : Number(new Date().toISOString().slice(5, 7));
    const monthNamesFr = [
        'Janvier', 'Fevrier', 'Mars', 'Avril', 'Mai', 'Juin',
        'Juillet', 'Aout', 'Septembre', 'Octobre', 'Novembre', 'Decembre'
    ];
    const monthName = monthNamesFr[monthNumber - 1] || 'Inconnu';
    const targetBasePath = path.join(basePath, year, monthName);
    try {
        fs.mkdirSync(targetBasePath, { recursive: true });
    } catch (e) {
        console.error('❌ generate-don-pdf mkdir:', e.message);
        return { success: false, error: 'Impossible de créer le dossier: ' + e.message };
    }
    const sanitizedName = (lotName && String(lotName).trim())
        ? String(lotName).trim().replace(/\s+/g, '_').replace(/[\\/:*?"<>|]/g, '').trim()
        : 'don';
    const isDefaultDonName = String(sanitizedName || '').trim().toLowerCase() === 'don';
    const timeSuffix = isDefaultDonName ? `_${formatTimeForFilename()}` : '';
    const fileName = `${sanitizedName}_${dateStr}${timeSuffix}.pdf`;
    const fullPath = path.join(targetBasePath, fileName);

    try {
        const result = await generateDonsPdfFromHtmlTemplate({ lotName: isDefaultDonName ? '' : (lotName || '').trim(), date: dateStr, lines }, fullPath);
        if (result) return result;
    } catch (err) {
        console.error('❌ generate-don-pdf (template HTML):', err.message);
        return { success: false, error: err.message };
    }
    return { success: false, error: 'Template dons introuvable ou échec génération' };
});

/**
 * Générer le PDF d'une fiche de prêt / location (prets-materiel.html + prets-materiel.css).
 * Placeholders : {{lotName}}, {{borrower_header}}, {{date}}, {{reference_block}}, {{borrower_block}}, {{period_block}}, {{remuneration_block}}, {{rows}}
 */
async function generatePretMaterielPdfFromHtmlTemplate(payload, fullPath) {
    const templateDir = path.join(__dirname, 'public', 'pdf-templates');
    const htmlPath = path.join(templateDir, 'prets-materiel.html');
    const cssPath = path.join(templateDir, 'prets-materiel.css');
    if (!fs.existsSync(htmlPath) || !fs.existsSync(cssPath)) {
        return null;
    }
    const {
        reference = '',
        lot_name,
        lotName,
        borrower_type = 'personne',
        borrower_name = '',
        borrower_contact = '',
        date_debut = '',
        date_fin = '',
        remuneration_gratuit = true,
        remuneration_montant = null,
        lines = []
    } = payload || {};

    const css = fs.readFileSync(cssPath, 'utf8');
    let html = fs.readFileSync(htmlPath, 'utf8');

    const dateStr = (payload?.date && /^\d{4}-\d{2}-\d{2}/.test(String(payload.date).trim()))
        ? String(payload.date).trim().slice(0, 10)
        : (/^\d{4}-\d{2}-\d{2}/.test(String(date_debut).trim()) ? String(date_debut).trim().slice(0, 10) : new Date().toISOString().slice(0, 10));
    const dateFormatted = formatDateForPdf(dateStr);

    const lotTitleRaw = String(lot_name ?? lotName ?? '').trim();
    const refDisplay = (reference && String(reference).trim()) ? String(reference).trim() : '';
    const lotTitleDisplay = lotTitleRaw || refDisplay || 'Prêt / location de matériel';

    const referenceBlock = refDisplay
        ? `<p class="pdf-summary-total-line"><span class="label"><i class="fa-solid fa-tag"></i> Référence :</span> <span class="value">${escapeHtml(refDisplay)}</span></p>`
        : '';

    const typeBorrower = String(borrower_type).toLowerCase() === 'societe' ? 'Société' : 'Personne';
    const borrowerBlock = `
        <p class="pdf-summary-total-line"><span class="label"><i class="fa-solid fa-user-tag"></i> Type :</span> <span class="value">${escapeHtml(typeBorrower)}</span></p>
        <p class="pdf-summary-total-line"><span class="label"><i class="fa-solid fa-id-card"></i> Emprunteur :</span> <span class="value">${escapeHtml(String(borrower_name || '-').trim())}</span></p>
        ${(borrower_contact && String(borrower_contact).trim()) ? `<p class="pdf-summary-total-line"><span class="label"><i class="fa-solid fa-phone"></i> Contact :</span> <span class="value">${escapeHtml(String(borrower_contact).trim())}</span></p>` : ''}
    `;

    const d0 = /^\d{4}-\d{2}-\d{2}/.test(String(date_debut).trim()) ? formatDateForPdf(String(date_debut).trim().slice(0, 10)) : escapeHtml(String(date_debut || '-'));
    const d1 = /^\d{4}-\d{2}-\d{2}/.test(String(date_fin).trim()) ? formatDateForPdf(String(date_fin).trim().slice(0, 10)) : escapeHtml(String(date_fin || '-'));
    const periodBlock = `<p class="pdf-summary-total-line"><span class="label"><i class="fa-regular fa-calendar"></i> Période :</span> <span class="value">du ${d0} au ${d1}</span></p>`;

    let remunerationBlock;
    if (remuneration_gratuit) {
        remunerationBlock = '<p class="pdf-summary-total-line"><span class="label"><i class="fa-solid fa-gift"></i> Rémunération :</span> <span class="value">Prêt gratuit</span></p>';
    } else {
        const m = remuneration_montant != null && Number.isFinite(Number(remuneration_montant)) ? Number(remuneration_montant) : 0;
        const mStr = escapeHtml(m.toFixed(2).replace('.', ',') + ' €');
        remunerationBlock = `<p class="pdf-summary-total-line"><span class="label"><i class="fa-solid fa-euro-sign"></i> Rémunération :</span> <span class="value">${mStr}</span></p>`;
    }

    const rows = (Array.isArray(lines) ? lines : [])
        .map((line) => {
            const num = line.num != null ? line.num : 0;
            const typeD = escapeHtml((line.typeDisplay || line.type || '-').toString().trim());
            const marque = escapeHtml((line.marqueName != null ? line.marqueName : (line.marque || '—')).toString().trim() || '—');
            const modele = escapeHtml((line.modeleName != null ? line.modeleName : (line.modele || '—')).toString().trim() || '—');
            const sn = escapeHtml((line.serialNumber != null ? line.serialNumber : (line.serial_number || line.serial || '—')).toString().trim() || '—');
            const qty = escapeHtml(String(line.quantite != null ? line.quantite : (line.quantity ?? '-')));
            return `<tr><td class="col-num">${num}</td><td class="col-type">${typeD}</td><td class="col-marque">${marque}</td><td class="col-modele">${modele}</td><td class="col-sn">${sn}</td><td class="col-qty">${qty}</td></tr>`;
        })
        .join('\n');

    const lotTitleEscaped = escapeHtml(lotTitleDisplay);
    const borrowerHeaderEscaped = escapeHtml(String(borrower_name || '').trim() || '—');
    html = html.replace(/\{\{\s*lotName\s*\}\}/g, lotTitleEscaped);
    html = html.replace(/\{\{\s*lotname\s*\}\}/g, lotTitleEscaped);
    html = html.replace(/\{\{\s*lot_name\s*\}\}/g, lotTitleEscaped);
    html = html.replace(/\{\{\s*borrower_header\s*\}\}/g, borrowerHeaderEscaped);
    html = html.replace(/\{\{\s*date\s*\}\}/g, escapeHtml(dateFormatted));
    html = html.replace(/\{\{\s*reference_block\s*\}\}/g, referenceBlock);
    html = html.replace(/\{\{\s*borrower_block\s*\}\}/g, borrowerBlock);
    html = html.replace(/\{\{\s*period_block\s*\}\}/g, periodBlock);
    html = html.replace(/\{\{\s*remuneration_block\s*\}\}/g, remunerationBlock);
    html = html.replace(/\{\{\s*rows\s*\}\}/g, rows);

    html = html.replace(
        /<link\s+rel="stylesheet"\s+href="prets-materiel\.css"\s*\/?>/i,
        `<style>${css}</style>`
    );

    const fontawesomeCssPath = path.join(__dirname, 'public', 'assets', 'css', 'fontawesome-local.css');
    const fontawesomeFileUrl = fs.existsSync(fontawesomeCssPath) ? url.pathToFileURL(fontawesomeCssPath).href : null;
    const fontawesomeLink = fontawesomeFileUrl ? `<link rel="stylesheet" href="${fontawesomeFileUrl}">` : '';
    if (fontawesomeLink) {
        if (/<link[^>]+font-awesome[^>]*>/i.test(html)) {
            html = html.replace(/<link[^>]+font-awesome[^>]*>/i, fontawesomeLink);
        } else if (!html.includes('fontawesome')) {
            html = html.replace('</head>', `${fontawesomeLink}\n</head>`);
        }
    }

    html = html.replace(/<img([^>]*)\ssrc="([^"]+)"/gi, (match, attrs, src) => {
        if (/^(https?:|\/|data:|file:)/i.test(src.trim())) return match;
        const absolutePath = path.resolve(templateDir, src.trim());
        if (!fs.existsSync(absolutePath)) return match;
        const fileUrl = url.pathToFileURL(absolutePath).href;
        return `<img${attrs} src="${fileUrl}"`;
    });

    const tempDir = app.getPath('temp');
    const outputPath = path.join(tempDir, `workspace-prets-materiel-pdf-${Date.now()}.html`);
    try {
        fs.writeFileSync(outputPath, html, 'utf8');
    } catch (e) {
        console.error('❌ generate-pret-materiel-pdf write temp HTML:', e.message);
        return null;
    }

    const win = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, offscreen: true }
    });
    try {
        await win.loadFile(outputPath);
        const pdfBuffer = await win.webContents.printToPDF({
            printBackground: true,
            pageSize: 'A4',
            preferCSSPageSize: true
        });
        fs.writeFileSync(fullPath, pdfBuffer);
        return { success: true, pdf_path: path.resolve(fullPath) };
    } finally {
        win.close();
        try { fs.unlinkSync(outputPath); } catch (_) { }
    }
}

/**
 * Générer le PDF prêt matériel et l'enregistrer sous PRETS_PDF_BASE (année / mois).
 * Payload: { lot_name?, lotName?, reference?, date (ISO début), borrower_type, borrower_name, borrower_contact?, date_debut, date_fin, remuneration_gratuit, remuneration_montant?, lines, basePath? }
 */
ipcMain.handle('generate-pret-materiel-pdf', async (_event, payload) => {
    const {
        lot_name,
        lotName,
        reference,
        date,
        borrower_type,
        borrower_name,
        borrower_contact,
        date_debut,
        date_fin,
        remuneration_gratuit,
        remuneration_montant,
        lines = [],
        basePath = PRETS_PDF_BASE
    } = payload || {};
    const rawDate = (date && String(date).trim()) ? String(date).trim() : (date_debut && String(date_debut).trim()) ? String(date_debut).trim() : new Date().toISOString().slice(0, 10);
    const dateStr = /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const [yearPart, monthPart] = dateStr.split('-');
    const year = /^\d{4}$/.test(yearPart || '') ? yearPart : new Date().toISOString().slice(0, 4);
    const monthNumber = /^(0[1-9]|1[0-2])$/.test(monthPart || '') ? Number(monthPart) : Number(new Date().toISOString().slice(5, 7));
    const monthNamesFr = [
        'Janvier', 'Fevrier', 'Mars', 'Avril', 'Mai', 'Juin',
        'Juillet', 'Aout', 'Septembre', 'Octobre', 'Novembre', 'Decembre'
    ];
    const monthName = monthNamesFr[monthNumber - 1] || 'Inconnu';
    const targetBasePath = path.join(basePath, year, monthName);
    try {
        fs.mkdirSync(targetBasePath, { recursive: true });
    } catch (e) {
        console.error('❌ generate-pret-materiel-pdf mkdir:', e.message);
        return { success: false, error: 'Impossible de créer le dossier: ' + e.message };
    }
    const sanitizePretPdfBaseName = (s) => {
        const t = String(s ?? '').trim();
        if (!t) return '';
        let out = t.replace(/\s+/g, '_').replace(/[\\/:*?"<>|]/g, '').replace(/[\u0000-\u001f]/g, '');
        if (out.length > 80) out = out.slice(0, 80);
        return out || '';
    };
    const refPart = sanitizePretPdfBaseName(reference);
    const borrowerPart = sanitizePretPdfBaseName(borrower_name);
    const baseName = refPart || borrowerPart || 'pret';
    const hasLotTitle = !!String(lot_name ?? lotName ?? '').trim();
    // Règle unicité: si aucun "nom de lot" n'est fourni, on ajoute l'heure (évite l'écrasement le même jour).
    const timeSuffix = !hasLotTitle ? `_${formatTimeForFilename()}` : '';
    const fileName = `${baseName}_${dateStr}${timeSuffix}.pdf`;
    const fullPath = path.join(targetBasePath, fileName);

    try {
        const result = await generatePretMaterielPdfFromHtmlTemplate({
            date: dateStr,
            lot_name: (lot_name != null && String(lot_name).trim()) ? String(lot_name).trim() : ((lotName != null && String(lotName).trim()) ? String(lotName).trim() : ''),
            reference: (reference && String(reference).trim()) ? String(reference).trim() : '',
            borrower_type,
            borrower_name,
            borrower_contact,
            date_debut,
            date_fin,
            remuneration_gratuit: !!remuneration_gratuit,
            remuneration_montant,
            lines
        }, fullPath);
        if (result) return result;
    } catch (err) {
        console.error('❌ generate-pret-materiel-pdf (template HTML):', err.message);
        return { success: false, error: err.message };
    }
    return { success: false, error: 'Template prêts matériel introuvable ou échec génération' };
});

/**
 * Lire un fichier et retourner son contenu en base64 (pour envoi du PDF au serveur).
 */
ipcMain.handle('read-file-as-base64', async (_event, payload) => {
    const filePath = typeof payload === 'string' ? payload : payload?.path;
    if (!filePath || typeof filePath !== 'string') {
        return { success: false, error: 'path requis' };
    }
    try {
        const resolved = path.resolve(filePath);
        if (!isPathAllowed(resolved)) {
            console.error('❌ read-file-as-base64: chemin non autorisé:', resolved);
            return { success: false, error: 'Chemin non autorisé' };
        }
        if (!fs.existsSync(resolved)) {
            return { success: false, error: 'Fichier introuvable' };
        }
        const buffer = fs.readFileSync(resolved);
        const base64 = buffer.toString('base64');
        return { success: true, base64 };
    } catch (err) {
        console.error('❌ read-file-as-base64:', err.message);
        return { success: false, error: err.message };
    }
});

/** Clé Giphy lue uniquement depuis l'environnement d'exécution. */
const DEFAULT_GIPHY_API_KEY = 'mvekVgYYTsuZWKdfbyHDgUvtCEfUt4IR';

function getGiphyApiKey() {
    const fromEnv = process.env.GIPHY_API_KEY && String(process.env.GIPHY_API_KEY).trim();
    if (fromEnv) return fromEnv;
    return DEFAULT_GIPHY_API_KEY;
}

/**
 * Obtenir la configuration de l'application
 */
ipcMain.handle('get-app-config', async () => {
    return {
        serverUrl: SERVER_URL,
        serverWsUrl: SERVER_WS_URL,
        serverConnected: serverConnected,
        serverMode: MODE,
        nodeEnv: isProduction ? 'production' : 'development',
        isProduction: isProduction,
        appVersion: app.getVersion(),
        giphyApiKey: getGiphyApiKey()
    };
});

/**
 * Obtenir la configuration connexion complète (connection.json) lue depuis le disque.
 * Utilisée par le renderer quand fetch('./config/connection.json') échoue (ex. en build avec file://).
 */
ipcMain.handle('get-connection-config', async () => {
    return serverConfig;
});

/**
 * Obtenir la configuration serveur complète
 */
ipcMain.handle('get-server-config', async () => {
    // Si un serveur a été découvert, mettre à jour currentConfig
    if (discoveredServer) {
        currentConfig = { url: SERVER_URL, ws: SERVER_WS_URL };
    }

    return {
        mode: MODE,
        config: currentConfig,
        discoveredServer: discoveredServer,
        serverUrl: SERVER_URL,
        serverWs: SERVER_WS_URL,
        allModes: Object.keys(serverConfig).filter(k => typeof serverConfig[k] === 'object' && serverConfig[k].url),
        healthCheckInterval: serverConfig.healthCheckInterval,
        reconnectDelay: serverConfig.reconnectDelay,
        maxReconnectAttempts: serverConfig.maxReconnectAttempts
    };
});

/**
 * Obtenir l'IP locale de la machine
 */
ipcMain.handle('get-local-ip', async () => {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Ignorer les adresses internes (127.0.0.1) et IPv6
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1'; // Fallback
});

/**
 * Obtenir les infos système locales (RAM, réseau)
 */
ipcMain.handle('get-system-info', async () => {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const usedPercent = Math.round((used / total) * 100);

    // Déterminer une interface active et son type
    const interfaces = os.networkInterfaces();
    let ifaceName = null;
    let address = null;
    let connectionType = 'unknown';

    for (const [name, list] of Object.entries(interfaces)) {
        if (!Array.isArray(list)) continue;
        const found = list.find((i) => i.family === 'IPv4' && !i.internal);
        if (found) {
            ifaceName = name;
            address = found.address;

            // Déterminer le type de connexion selon le nom de l'interface
            const lowerName = name.toLowerCase();
            if (lowerName.includes('wl') || lowerName.includes('wi-fi') || lowerName.includes('wifi') || lowerName.includes('wlan')) {
                connectionType = 'wifi';
            } else if (lowerName.includes('en') || lowerName.includes('eth') || lowerName.includes('eno') || lowerName.includes('enp')) {
                connectionType = 'ethernet';
            } else if (lowerName.includes('ppp') || lowerName.includes('wwan') || lowerName.includes('rmnet')) {
                connectionType = 'cellular';
            } else if (lowerName.includes('bt') || lowerName.includes('bluetooth')) {
                connectionType = 'bluetooth';
            }
            break;
        }
    }

    return {
        memory: {
            totalBytes: total,
            freeBytes: free,
            usedBytes: used,
            totalGb: (total / (1024 ** 3)).toFixed(2),
            usedGb: (used / (1024 ** 3)).toFixed(2),
            freeGb: (free / (1024 ** 3)).toFixed(2),
            usedPercent
        },
        network: {
            interface: ifaceName,
            address,
            type: connectionType
        }
    };
});

/** Marques connues (début de MODEL quand VENDOR vide). Plus long d’abord pour matcher "WESTERN DIGITAL" avant "WD". */
const LSBLK_KNOWN_VENDORS = ['WESTERN DIGITAL', 'SK HYNIX', 'SANDISK', 'SAMSUNG', 'SEAGATE', 'TRANSCEND', 'TEAMGROUP', 'INTEL', 'CRUCIAL', 'KINGSTON', 'TOSHIBA', 'KIOXIA', 'LITEON', 'ADATA', 'PATRIOT', 'CORSAIR', 'GIGABYTE', 'PLEXTOR', 'PHISON', 'MICRON', 'HGST', 'HITACHI', 'LEXAR', 'SABRENT', 'VMWARE', 'PNY', 'OCZ', 'WD', 'VBOX', 'QEMU', 'MSI'];

/**
 * Si vendor est vide et model commence par une marque connue, extrait marque (vendor) et référence (model).
 * Ex. "Intel SSDSC2KB240G8" → vendor="Intel", model="SSDSC2KB240G8"
 */
function splitVendorModel(vendor, model) {
    if (vendor || !model) return { vendor: vendor || '', model: model || '' };
    const m = model.trim();
    const mUpper = m.toUpperCase();
    for (const brand of LSBLK_KNOWN_VENDORS) {
        if (mUpper === brand || mUpper.startsWith(brand + ' ')) {
            const vendorStr = m.slice(0, brand.length);
            const rest = m.slice(brand.length).trim();
            return { vendor: vendorStr, model: rest };
        }
    }
    return { vendor: '', model: m };
}

/**
 * Récupérer la liste des disques via lsblk (Linux uniquement).
 * Marque = vendor (ou début de model si "Intel SSDSC2KB..."), Modèle = référence (reste de model).
 */
ipcMain.handle('run-lsblk', async () => {
    if (process.platform !== 'linux') {
        return { success: false, error: 'lsblk n\'est disponible que sous Linux.' };
    }
    try {
        const stdout = execSync('lsblk -o NAME,SERIAL,SIZE,TYPE,TRAN,ROTA,MODEL,VENDOR -J', {
            encoding: 'utf8',
            timeout: 10000,
            maxBuffer: 2 * 1024 * 1024
        });
        const data = JSON.parse(stdout);
        const blockdevices = data.blockdevices || [];
        const disks = [];
        function collectDisks(list) {
            if (!Array.isArray(list)) return;
            for (const dev of list) {
                if (dev.type === 'disk') {
                    const tran = (dev.tran || '').toUpperCase();
                    let type = 'SATA';
                    if (tran.includes('SAS')) type = 'SAS';
                    else if (tran.includes('NVME') || tran === 'NVME') type = 'NVMe';
                    else if (tran.includes('USB')) type = 'USB';
                    else if (tran.includes('SATA') || tran === 'ATA') type = 'SATA';
                    const rota = dev.rota;
                    const diskType = (rota === 0 || rota === '0' || rota === false) ? 'SSD' : 'HDD';
                    let vendor = (dev.vendor || '').trim();
                    let model = (dev.model || '').trim();
                    const split = splitVendorModel(vendor, model);
                    vendor = split.vendor;
                    model = split.model;
                    disks.push({
                        name: dev.name || '',
                        serial: (dev.serial || '').trim() || dev.name || '',
                        size: (dev.size || '').trim() || '',
                        type,
                        disk_type: diskType,
                        model,
                        vendor
                    });
                }
                if (dev.children) collectDisks(dev.children);
            }
        }
        collectDisks(blockdevices);
        return { success: true, disks };
    } catch (err) {
        const msg = err.message || String(err);
        console.warn('run-lsblk:', msg);
        return { success: false, error: msg };
    }
});
