// Charger la config app (dont giphyApiKey) dès que possible en Electron
if (typeof window !== 'undefined' && window.electron && window.electron.invoke) {
    window.electron.invoke('get-app-config').then(function (c) {
        if (c && typeof c === 'object') window.APP_CONFIG = Object.assign({}, window.APP_CONFIG || {}, c);
    }).catch(function () {});
}

class PageManager {
    constructor() {
        this.contentContainer = 'content';
        this.storageKey = 'workspace_current_page';
        this.themeStorageKey = 'workspace_theme_dark';
        this.authManager = null;
        this.serverUrl = null;
        this.serverConnected = false;
        this._updateInfo = null;
        this._updateDownloaded = false;
        
        // Pages et leur configuration de layout (sous-pages réception = même layout que reception)
        const receptionLayout = { showHeader: true, showFooter: false };
        this.pagesConfig = {
            'agenda': { showHeader: true, showFooter: true },
            'reception': receptionLayout,
            'entrer': receptionLayout,
            'sortie': receptionLayout,
            'inventaire': receptionLayout,
            'historique': receptionLayout,
            'disques': receptionLayout,
            'commande': receptionLayout,
            'dons': receptionLayout,
            'prets': receptionLayout
        };
        
        this.init();
    }

    async init() {
        // Initialiser le module API (configuration centralisée)
        const apiModule = await import('./assets/js/config/api.js');
        await apiModule.default.init();
        
        // Initialiser le Logger
        const loggerModule = await import('./assets/js/config/Logger.js');
        this.logger = loggerModule.default();
        window.logger = this.logger; // Exposer globalement
        
        // Initialiser le logger avec la config de l'app (pour détecter production)
        if (typeof this.logger.initializeFromAppConfig === 'function') {
            await this.logger.initializeFromAppConfig();
        }
        
        // Initialiser la configuration de connexion
        const module = await import('./assets/js/config/ConnectionConfig.js');
        const ConnectionConfig = module.default;
        this.connectionConfig = new ConnectionConfig();
        await this.connectionConfig.initialize();

        // Récupérer l'URL du serveur
        this.serverUrl = this.connectionConfig.getServerUrl();
        this.serverWsUrl = this.connectionConfig.getServerWsUrl();
        this.serverConnected = this.connectionConfig.serverConnected;
        
        this.logger.info(`Serveur: ${this.serverUrl}`);
        this.logger.info(`WebSocket: ${this.serverWsUrl}`);

        // Exposer l'instance App globalement
        window.app = this;

        // Capture automatique des erreurs JS non gérées → monitoring admin
        this.setupClientErrorReporting();
        this.initializeThemePreference();

        // Toast "Mise à jour installée" après redémarrage post-update
        if (typeof window.electron !== 'undefined' && window.electron.on) {
            window.electron.on('update-was-installed', () => {
                window.app?.showNotification('Une nouvelle version a été installée avec succès.', 'success');
            });
        }

        // Initialiser le gestionnaire de connexion serveur
        await this.initializeServerConnection();

        // Charger le header puis afficher la page tout de suite (premier rendu plus rapide)
        await this.loadComponent('header', './components/header.html', () => this.initializeAuth());
        // Check MAJ en arrière-plan pour afficher le ping Paramètres si nécessaire
        this.checkUpdateInBackground();

        // Page sauvegardée, ou agenda par défaut (accueil/dossier/tracabilite → redirection)
        const lastPage = this.getLastPage();
        const receptionSubPages = ['entrer', 'sortie', 'inventaire', 'historique', 'disques', 'commande', 'dons', 'prets'];
        const removedPages = ['home', 'dossier', 'tracabilite', 'login', 'signup', 'option'];
        let pageToLoad = 'agenda';
        if (lastPage === 'tracabilite') {
            pageToLoad = 'historique';
        } else if (lastPage && !removedPages.includes(lastPage) && (this.pagesConfig[lastPage] || receptionSubPages.includes(lastPage))) {
            pageToLoad = lastPage;
        }
        this.loadPage(pageToLoad);

        // Footer et infos système en arrière-plan pour ne pas retarder le premier affichage
        this.loadComponent('footer', './components/footer.html', () => {
            this.initializeSystemInfo();
            this.updateFooterVersion();
            this.attachFooterExternalLinks();
        });
    }

    initializeThemePreference() {
        try {
            const stored = localStorage.getItem(this.themeStorageKey);
            const isDark = stored === null ? true : stored === '1';
            this.applyThemePreference(isDark);
        } catch (_) {
            this.applyThemePreference(true);
        }
    }

    applyThemePreference(isDark) {
        const enabled = !!isDark;
        document.documentElement.setAttribute('data-theme-dark', enabled ? '1' : '0');
        document.body.style.backgroundColor = '';
        document.body.style.color = '';
        this.syncThemeToggleUI(enabled);
    }

    isDarkThemeEnabled() {
        return document.documentElement.getAttribute('data-theme-dark') !== '0';
    }

    setThemePreference(isDark) {
        const enabled = !!isDark;
        try {
            localStorage.setItem(this.themeStorageKey, enabled ? '1' : '0');
        } catch (_) {}
        this.applyThemePreference(enabled);
    }

    syncThemeToggleUI(isDark = this.isDarkThemeEnabled()) {
        const enabled = !!isDark;
        const navBtn = document.getElementById('navThemeToggle');
        const navIcon = document.getElementById('navThemeIcon');
        const navText = document.getElementById('navThemeText');
        if (navBtn) {
            const label = enabled ? 'Thème sombre' : 'Thème clair';
            navBtn.title = label;
            navBtn.setAttribute('aria-label', label);
            navBtn.dataset.theme = enabled ? 'dark' : 'light';
        }
        if (navIcon) {
            navIcon.className = enabled ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
        }
        if (navText) {
            navText.textContent = enabled ? 'Thème sombre' : 'Thème clair';
        }

        // Sync éventuel du toggle paramètres (s’il est présent)
        const settingsBtn = document.getElementById('settingsThemeDarkToggle');
        const settingsInput = document.getElementById('settingsThemeDark');
        const settingsText = document.getElementById('settingsThemeDarkToggleText');
        if (settingsInput) settingsInput.value = enabled ? '1' : '0';
        if (settingsBtn) {
            settingsBtn.setAttribute('aria-checked', enabled ? 'true' : 'false');
            settingsBtn.dataset.state = enabled ? 'on' : 'off';
        }
        if (settingsText) settingsText.textContent = enabled ? 'ON' : 'OFF';
    }

    /**
     * Branche window.onerror et unhandledrejection sur le monitoring admin.
     * Filtre les erreurs provenant de bibliothèques tierces non actionnables
     * (emoji-picker, favicon gstatic) pour ne pas polluer le panel.
     */
    setupClientErrorReporting() {
        const serverUrl = this.serverUrl || '';
        const endpoint = `${serverUrl}/api/monitoring/errors`;
        const clientId = localStorage.getItem('workspace_client_id') || (() => {
            const id = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            localStorage.setItem('workspace_client_id', id);
            return id;
        })();

        const IGNORED_PATTERNS = [
            /gstatic\.com/,
            /faviconV2/,
            /emoji-picker-element/,
            /picker\.js.*Emoji support detection/,
            /checkZwjSupport/,
        ];

        const shouldIgnore = (msg) => {
            if (!msg) return false;
            return IGNORED_PATTERNS.some(p => p.test(String(msg)));
        };

        const send = (payload) => {
            if (shouldIgnore(payload.errorMessage)) return;
            try {
                const blob = new Blob([JSON.stringify({
                    clientId,
                    clientVersion: typeof this.getAppVersion === 'function' ? this.getAppVersion() : '1.0',
                    platform: navigator.platform || '',
                    ...payload
                })], { type: 'application/json' });
                if (navigator.sendBeacon) {
                    navigator.sendBeacon(endpoint, blob);
                } else {
                    fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: blob, keepalive: true }).catch(() => {});
                }
            } catch (_) {}
        };

        window.onerror = (message, source, lineno, colno, error) => {
            send({
                errorType: 'js_error',
                errorMessage: String(message),
                errorStack: error?.stack || null,
                context: `${source || ''}:${lineno}:${colno}`
            });
            return false;
        };

        window.addEventListener('unhandledrejection', (event) => {
            const reason = event.reason;
            const msg = reason?.message || String(reason);
            send({
                errorType: 'promise_rejection',
                errorMessage: msg,
                errorStack: reason?.stack || null,
                context: 'Unhandled Promise Rejection'
            });
        });
    }

    async initializeServerConnection() {
        try {
            const module = await import('./assets/js/modules/system/ServerConnectionManager.js');
            const ServerConnectionManager = module.default;
            
            // Utiliser les paramètres de ConnectionConfig
            const config = window.APP_CONFIG;
            
            this.serverConnectionManager = new ServerConnectionManager({
                url: this.serverUrl,
                ws: this.serverWsUrl,
                healthCheckInterval: config.healthCheckInterval || 30000,
                reconnectDelay: config.reconnectDelay || 3000,
                maxReconnectAttempts: config.maxReconnectAttempts || 5
            });

            this.serverConnectionManager.onStatusChange((status, data) => {
                this.logger.debug(`Statut serveur: ${status}`, data);
                this.serverConnected = (status === 'connected');
                window.APP_CONFIG.serverConnected = this.serverConnected;
                this.updateServerStatus(status, data);
            });

            this.serverConnectionManager.start();
            this.logger.info('ServerConnectionManager initialisé');
        } catch (error) {
            this.logger.error('Erreur init ServerConnectionManager', error);
        }
    }

    updateServerStatus(status, data) {
        // Mettre à jour l'indicateur visuel dans le footer si présent
        const serverIndicator = document.getElementById('footer-server-value');
        const serverIcon = document.getElementById('footer-server-icon');
        
        if (serverIndicator && serverIcon) {
            if (status === 'connected') {
                serverIndicator.textContent = 'En ligne';
                serverIndicator.style.color = '#2ecc71';
                serverIcon.className = 'fa-solid fa-circle-check';
                serverIcon.style.color = '#2ecc71';
            } else if (status === 'disconnected') {
                serverIndicator.textContent = 'Déconnecté';
                serverIndicator.style.color = '#e74c3c';
                serverIcon.className = 'fa-solid fa-circle-xmark';
                serverIcon.style.color = '#e74c3c';
            } else if (status === 'failed') {
                serverIndicator.textContent = 'Hors ligne';
                serverIndicator.style.color = '#95a5a6';
                serverIcon.className = 'fa-solid fa-circle-exclamation';
                serverIcon.style.color = '#95a5a6';
            }
        }
    }

    async initializeAuth() {
        try {
            // Auth silencieuse : conserve le JWT en localStorage pour les API réception
            const module = await import('./assets/js/modules/auth/AuthManager.js');
            const AuthManager = module.default;
            this.authManager = new AuthManager();

            this.authManager.on('auth-change', (user) => {
                this.logger.debug('Auth change event', { user: user?.username });
            });

            window.addEventListener('session-expired', () => {
                if (this.authManager) {
                    this.authManager.clearSession();
                }
            });

            await this.loadSettingsModal();
            this.attachListeners();
            this.attachSettingsNavListener();
            this.attachThemeNavListener();
        } catch (error) {
            this.logger.error('Erreur import AuthManager', error);
            try {
                await this.loadSettingsModal();
                this.attachListeners();
                this.attachSettingsNavListener();
                this.attachThemeNavListener();
            } catch (_) { /* ignore */ }
        }
    }

    attachSettingsNavListener() {
        const navSettings = document.getElementById('navSettings');
        if (!navSettings || navSettings.dataset.listenerAttached) return;
        navSettings.addEventListener('click', (e) => {
            e.preventDefault();
            this.showSettingsModal();
        });
        navSettings.dataset.listenerAttached = 'true';
    }

    attachThemeNavListener() {
        const navTheme = document.getElementById('navThemeToggle');
        if (!navTheme || navTheme.dataset.listenerAttached) return;
        this.syncThemeToggleUI();
        navTheme.addEventListener('click', (e) => {
            e.preventDefault();
            this.setThemePreference(!this.isDarkThemeEnabled());
        });
        navTheme.dataset.listenerAttached = 'true';
    }

    async loadAuthModal() {
        try {
            const response = await fetch('./components/auth-modal.html');
            if (!response.ok) throw new Error('Auth modal not found');
            const html = await response.text();
            document.getElementById('authModalContainer').innerHTML = html;
            this.attachAuthModalListeners();
        } catch (error) {
            this.logger.error('Erreur chargement auth modal', error);
        }
    }

    attachAuthModalListeners() {
        const authModal = document.getElementById('authModal');
        const authModalClose = document.getElementById('authModalClose');
        const authModalOverlay = document.getElementById('authModalOverlay');
        const authTabs = document.querySelectorAll('.auth-tab');
        const loginForm = document.getElementById('loginForm');
        const registerForm = document.getElementById('registerForm');

        authModalClose.addEventListener('click', () => {
            authModal.classList.add('hidden');
        });

        authModalOverlay.addEventListener('click', () => {
            authModal.classList.add('hidden');
        });

        authTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const mode = tab.dataset.mode;
                authTabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');

                if (mode === 'login') {
                    loginForm.classList.remove('hidden');
                    registerForm.classList.add('hidden');
                } else {
                    loginForm.classList.add('hidden');
                    registerForm.classList.remove('hidden');
                }
            });
        });

        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('loginUsername').value;
            const password = document.getElementById('loginPassword').value;
            const errorEl = document.getElementById('loginError');

            const result = await this.authManager.login(username, password);

            if (result.success) {
                authModal.classList.add('hidden');
                loginForm.reset();
                errorEl.classList.add('hidden');
            } else {
                errorEl.textContent = result.message;
                errorEl.classList.remove('hidden');
            }
        });

        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('registerUsername').value;
            const password = document.getElementById('registerPassword').value;
            const passwordConfirm = document.getElementById('registerPasswordConfirm').value;
            const errorEl = document.getElementById('registerError');

            if (password !== passwordConfirm) {
                errorEl.textContent = 'Les mots de passe ne correspondent pas';
                errorEl.classList.remove('hidden');
                return;
            }

            const result = await this.authManager.register(username, password);

            if (result.success) {
                authModal.classList.add('hidden');
                registerForm.reset();
                errorEl.classList.add('hidden');
            } else {
                errorEl.textContent = result.message;
                errorEl.classList.remove('hidden');
            }
        });
    }

    updateProfileUI(user) {
        const profileAuth = document.getElementById('profileAuth');
        const profileUser = document.getElementById('profileUser');
        const profileUsername = document.getElementById('profileUsername');

        this.logger.debug('updateProfileUI called', { 
            user: user?.username, 
            profileAuth: !!profileAuth, 
            profileUser: !!profileUser
        });

        if (!profileAuth || !profileUser || !profileUsername) {
            this.logger.warn('Profile elements not found');
            return;
        }

        if (user) {
            this.logger.debug(`Showing user profile for: ${user.username}`);
            profileAuth.style.display = 'none';
            profileUser.style.display = 'flex';
            profileUsername.textContent = user.username;
        } else {
            this.logger.debug('Showing login buttons');
            profileAuth.style.display = 'flex';
            profileUser.style.display = 'none';
            profileUsername.textContent = '';
        }
    }

    attachProfileListeners() {
        const navProfile = document.getElementById('navProfile');
        const profileDropdown = document.getElementById('profileDropdown');
        const btnLogin = document.getElementById('btnLogin');
        const btnRegister = document.getElementById('btnRegister');
        const btnLogout = document.getElementById('btnLogout');
        const btnSettings = document.getElementById('btnSettings');
        const btnSettingsGuest = document.getElementById('btnSettingsGuest');

        if (!navProfile || !profileDropdown || !btnLogin || !btnRegister || !btnLogout) return;

        navProfile.addEventListener('click', (e) => {
            e.stopPropagation();
            profileDropdown.classList.toggle('hidden');
        });

        document.addEventListener('click', (e) => {
            if (!navProfile.contains(e.target) && !profileDropdown.contains(e.target)) {
                profileDropdown.classList.add('hidden');
            }
        });

        btnLogin.addEventListener('click', () => {
            this.showAuthModal('login');
            profileDropdown.classList.add('hidden');
        });

        btnRegister.addEventListener('click', () => {
            this.showAuthModal('register');
            profileDropdown.classList.add('hidden');
        });

        btnLogout.addEventListener('click', () => {
            this.authManager.logout();
            profileDropdown.classList.add('hidden');
        });

        if (btnSettings) {
            btnSettings.addEventListener('click', () => {
                this.showSettingsModal();
                profileDropdown.classList.add('hidden');
            });
        }
        if (btnSettingsGuest) {
            btnSettingsGuest.addEventListener('click', () => {
                this.showSettingsModal();
                profileDropdown.classList.add('hidden');
            });
        }
    }

    async checkUpdateInBackground() {
        try {
            if (!window.electron?.invoke) return;
            // Éviter de spammer GitHub si init est rappelé
            if (this._updateCheckedOnce) return;
            this._updateCheckedOnce = true;
            const res = await window.electron.invoke('check-app-update', {});
            this._updateInfo = res;
            this.refreshUpdateUI();
        } catch (_) {
            // silent (pas de bruit UX au démarrage)
        }
    }

    async loadSettingsModal() {
        try {
            const response = await fetch('./components/settings-modal.html');
            if (!response.ok) throw new Error('Settings modal not found');
            const html = await response.text();
            const container = document.getElementById('settingsModalContainer');
            if (container) container.innerHTML = html;
            this.attachSettingsModalListeners();
            this.refreshUpdateUI();
        } catch (error) {
            this.logger.error('Erreur chargement settings modal', error);
        }
    }

    showSettingsModal() {
        const modal = document.getElementById('settingsModal');
        if (!modal) return;
        // Compte utilisateur retiré de l’UI — sections auth masquées si présentes
        document.querySelectorAll('.settings-auth-only').forEach(el => { el.style.display = 'none'; });
        const accountDropdown = document.getElementById('settingsDropdownAccount');
        if (accountDropdown) accountDropdown.style.display = 'none';
        this.syncThemeToggleUI();
        // Ne pas reset _updateDownloaded : le bouton Redémarrer doit rester disponible
        this.syncPendingUpdateFromMain().then(() => this.refreshUpdateUI());
        modal.classList.remove('hidden');
    }

    async syncPendingUpdateFromMain() {
        try {
            if (!window.electron?.invoke) return;
            const pending = await window.electron.invoke('get-pending-app-update', {});
            if (pending?.ready) {
                this._updateDownloaded = true;
                if (pending.latestVersion && this._updateInfo?.success) {
                    this._updateInfo = {
                        ...this._updateInfo,
                        available: true,
                        latestVersion: pending.latestVersion
                    };
                }
            }
        } catch (_) { /* ignore */ }
    }

    attachSettingsModalListeners() {
        const modal = document.getElementById('settingsModal');
        const overlay = document.getElementById('settingsModalOverlay');
        const closeBtn = document.getElementById('settingsModalClose');
        const formUsername = document.getElementById('settingsFormUsername');
        const formPassword = document.getElementById('settingsFormPassword');
        const btnDeleteAccount = document.getElementById('settingsBtnDeleteAccount');
        const deleteConfirm = document.getElementById('settingsDeleteConfirm');
        const deletePassword = document.getElementById('settingsDeletePassword');
        const deleteConfirmBtn = document.getElementById('settingsDeleteConfirmBtn');
        const deleteCancelBtn = document.getElementById('settingsDeleteCancelBtn');
        const themeToggleBtn = document.getElementById('settingsThemeDarkToggle');
        const btnCheckUpdate = document.getElementById('settingsBtnCheckUpdate');
        const btnDownloadUpdate = document.getElementById('settingsBtnDownloadUpdate');
        const btnRestartUpdate = document.getElementById('settingsBtnRestartUpdate');

        if (!modal) return;

        const hideModal = () => modal.classList.add('hidden');

        if (closeBtn) closeBtn.addEventListener('click', hideModal);
        if (overlay) overlay.addEventListener('click', hideModal);
        if (themeToggleBtn) {
            this.syncThemeToggleUI();
            themeToggleBtn.addEventListener('click', () => {
                this.setThemePreference(!this.isDarkThemeEnabled());
            });
        }

        const doCheckUpdate = async () => {
            const status = document.getElementById('settingsUpdateStatus');
            const errEl = document.getElementById('settingsUpdateError');
            const hint = document.getElementById('settingsUpdateHint');
            const progressWrap = document.getElementById('settingsUpdateProgress');
            const progressFill = document.getElementById('settingsUpdateProgressFill');
            const progressText = document.getElementById('settingsUpdateProgressText');
            if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; }
            // Ne pas effacer un téléchargement déjà prêt sauf si l’utilisateur revérifie
            if (hint && !this._updateDownloaded) hint.classList.add('hidden');
            if (progressWrap) progressWrap.classList.add('hidden');
            if (progressFill) progressFill.style.width = '0%';
            if (progressText) progressText.textContent = '0%';
            if (status) status.textContent = 'Vérification…';
            try {
                if (!window.electron?.invoke) {
                    if (status) status.textContent = 'Disponible uniquement dans l’application desktop';
                    this._updateInfo = null;
                    this.refreshUpdateUI();
                    return;
                }
                const res = await window.electron.invoke('check-app-update', {});
                this._updateInfo = res;
                if (res?.updateReady) this._updateDownloaded = true;
                this.refreshUpdateUI();
            } catch (e) {
                if (status) status.textContent = 'Erreur de vérification';
                if (errEl) {
                    errEl.textContent = e?.message || String(e);
                    errEl.classList.remove('hidden');
                }
            }
        };

        if (btnCheckUpdate) btnCheckUpdate.addEventListener('click', () => doCheckUpdate());
        if (btnDownloadUpdate) {
            btnDownloadUpdate.addEventListener('click', async () => {
                const status = document.getElementById('settingsUpdateStatus');
                const errEl = document.getElementById('settingsUpdateError');
                const hint = document.getElementById('settingsUpdateHint');
                const progressWrap = document.getElementById('settingsUpdateProgress');
                const progressFill = document.getElementById('settingsUpdateProgressFill');
                const progressText = document.getElementById('settingsUpdateProgressText');
                if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; }
                this._updateDownloaded = false;
                if (hint) hint.classList.add('hidden');
                try {
                    if (!window.electron?.invoke) throw new Error('Disponible uniquement dans l’application desktop');
                    btnDownloadUpdate.disabled = true;
                    if (status) status.textContent = 'Téléchargement…';
                    if (progressWrap) progressWrap.classList.remove('hidden');
                    if (progressFill) progressFill.style.width = '0%';
                    if (progressText) progressText.textContent = '0%';
                    const res = await window.electron.invoke('download-app-update', {});
                    if (!res?.success) {
                        throw new Error(res?.error || res?.detail || 'Téléchargement impossible');
                    }
                    if (status) status.textContent = res?.latestVersion ? `Prête (v${res.latestVersion})` : 'Mise à jour prête';
                    this._updateDownloaded = true;
                    // Toast + hint via l'événement app-update-download-done (évite le double affichage)
                } catch (e) {
                    if (status) status.textContent = 'Erreur téléchargement';
                    if (errEl) {
                        errEl.textContent = e?.message || String(e);
                        errEl.classList.remove('hidden');
                    }
                } finally {
                    this.refreshUpdateUI();
                }
            });
        }

        if (btnRestartUpdate) {
            btnRestartUpdate.addEventListener('click', async () => {
                const status = document.getElementById('settingsUpdateStatus');
                const errEl = document.getElementById('settingsUpdateError');
                if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; }
                try {
                    if (!window.electron?.invoke) throw new Error('Disponible uniquement dans l’application desktop');
                    btnRestartUpdate.disabled = true;
                    if (status) status.textContent = 'Installation et redémarrage…';
                    const res = await window.electron.invoke('install-app-update', {});
                    if (!res?.success) {
                        throw new Error(res?.error || 'Installation impossible');
                    }
                    if (status) status.textContent = res?.message || 'Redémarrage…';
                } catch (e) {
                    if (status) status.textContent = 'Erreur installation';
                    if (errEl) {
                        errEl.textContent = e?.message || String(e);
                        errEl.classList.remove('hidden');
                    }
                    btnRestartUpdate.disabled = false;
                    this.refreshUpdateUI();
                }
            });
        }

        // Progression du téléchargement (événements envoyés par le main process)
        if (window.electron?.on && !this._updateDownloadListenersAttached) {
            this._updateDownloadListenersAttached = true;
            window.electron.on('app-update-download-progress', (p) => {
                const progressWrap = document.getElementById('settingsUpdateProgress');
                const progressFill = document.getElementById('settingsUpdateProgressFill');
                const progressText = document.getElementById('settingsUpdateProgressText');
                const status = document.getElementById('settingsUpdateStatus');
                if (progressWrap) progressWrap.classList.remove('hidden');
                const percent = typeof p?.percent === 'number' ? p.percent : null;
                if (percent != null) {
                    if (progressFill) progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
                    if (progressText) progressText.textContent = `${Math.max(0, Math.min(100, percent))}%`;
                    if (status) status.textContent = `Téléchargement… ${Math.max(0, Math.min(100, percent))}%`;
                } else {
                    if (progressFill) progressFill.style.width = '100%';
                    if (progressText) progressText.textContent = '…';
                    if (status) status.textContent = 'Téléchargement…';
                }
            });
            window.electron.on('app-update-download-done', (payload) => {
                const hint = document.getElementById('settingsUpdateHint');
                const errEl = document.getElementById('settingsUpdateError');
                const status = document.getElementById('settingsUpdateStatus');
                const progressWrap = document.getElementById('settingsUpdateProgress');
                const btnDownload = document.getElementById('settingsBtnDownloadUpdate');
                if (payload?.success) {
                    if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; }
                    if (status) status.textContent = payload?.latestVersion ? `Prête (v${payload.latestVersion})` : 'Mise à jour prête';
                    this._updateDownloaded = true;
                    if (hint) hint.classList.remove('hidden');
                    if (this.showNotification && payload?.needsRestart !== false) {
                        this.showNotification(
                            'Mise à jour téléchargée. Redémarrez pour l’appliquer.',
                            'success'
                        );
                    }
                } else {
                    this._updateDownloaded = false;
                    if (status) status.textContent = 'Erreur téléchargement';
                    if (errEl) {
                        errEl.textContent = payload?.error || 'Téléchargement impossible';
                        errEl.classList.remove('hidden');
                    }
                }
                if (progressWrap) progressWrap.classList.add('hidden');
                if (btnDownload) btnDownload.disabled = true;
                this.refreshUpdateUI();
            });
        }

        // Check automatique (non bloquant) quand la modale est chargée
        setTimeout(() => { doCheckUpdate(); }, 200);

        if (formUsername) {
            formUsername.addEventListener('submit', async (e) => {
                e.preventDefault();
                const errEl = document.getElementById('settingsUsernameError');
                const input = document.getElementById('settingsNewUsername');
                const newUsername = (input && input.value || '').trim();
                if (!newUsername || newUsername.length < 3) {
                    if (errEl) { errEl.textContent = 'Le pseudo doit faire entre 3 et 20 caractères.'; errEl.classList.remove('hidden'); }
                    return;
                }
                if (errEl) errEl.classList.add('hidden');
                const result = await this.authManager.updateUsername(newUsername);
                if (result.success) {
                    hideModal();
                    if (this.showNotification) this.showNotification('Pseudo mis à jour.', 'success');
                } else {
                    if (errEl) { errEl.textContent = result.message || 'Erreur'; errEl.classList.remove('hidden'); }
                }
            });
        }

        if (formPassword) {
            formPassword.addEventListener('submit', async (e) => {
                e.preventDefault();
                const errEl = document.getElementById('settingsPasswordError');
                const current = document.getElementById('settingsCurrentPassword').value;
                const newPwd = document.getElementById('settingsNewPassword').value;
                const confirm = document.getElementById('settingsNewPasswordConfirm').value;
                if (newPwd !== confirm) {
                    if (errEl) { errEl.textContent = 'Les deux mots de passe ne correspondent pas.'; errEl.classList.remove('hidden'); return; }
                }
                if (errEl) errEl.classList.add('hidden');
                const result = await this.authManager.changePassword(current, newPwd);
                if (result.success) {
                    hideModal();
                    if (this.showNotification) this.showNotification('Mot de passe modifié.', 'success');
                    document.getElementById('settingsCurrentPassword').value = '';
                    document.getElementById('settingsNewPassword').value = '';
                    document.getElementById('settingsNewPasswordConfirm').value = '';
                } else {
                    if (errEl) { errEl.textContent = result.message || 'Erreur'; errEl.classList.remove('hidden'); }
                }
            });
        }

        if (btnDeleteAccount) {
            btnDeleteAccount.addEventListener('click', () => {
                document.getElementById('settingsDeleteError').classList.add('hidden');
                if (deleteConfirm) deleteConfirm.classList.remove('hidden');
                if (deletePassword) deletePassword.value = '';
            });
        }
        if (deleteCancelBtn) {
            deleteCancelBtn.addEventListener('click', () => {
                if (deleteConfirm) deleteConfirm.classList.add('hidden');
                document.getElementById('settingsDeleteConfirmError').classList.add('hidden');
            });
        }
        if (deleteConfirmBtn && deletePassword) {
            deleteConfirmBtn.addEventListener('click', async () => {
                const errEl = document.getElementById('settingsDeleteConfirmError');
                const password = deletePassword.value;
                if (!password) {
                    if (errEl) { errEl.textContent = 'Saisissez votre mot de passe.'; errEl.classList.remove('hidden'); return; }
                }
                if (errEl) errEl.classList.add('hidden');
                const result = await this.authManager.deleteAccount(password);
                if (result.success) {
                    hideModal();
                    window.location.reload();
                } else {
                    if (errEl) { errEl.textContent = result.message || 'Erreur'; errEl.classList.remove('hidden'); }
                }
            });
        }
    }

    refreshUpdateUI() {
        const info = this._updateInfo;
        const status = document.getElementById('settingsUpdateStatus');
        const btnDownload = document.getElementById('settingsBtnDownloadUpdate');
        const btnRestart = document.getElementById('settingsBtnRestartUpdate');
        const hint = document.getElementById('settingsUpdateHint');
        const badgeUser = document.getElementById('profileUpdateBadge');
        const badgeGuest = document.getElementById('profileUpdateBadgeGuest');
        const ping = document.getElementById('profileUpdatePing');

        const available = !!(info && info.success && info.available);
        const readyToInstall = !!this._updateDownloaded;

        if (badgeUser) badgeUser.classList.toggle('hidden', !available && !readyToInstall);
        if (badgeGuest) badgeGuest.classList.toggle('hidden', !available && !readyToInstall);
        if (ping) ping.classList.toggle('hidden', !available && !readyToInstall);

        if (status) {
            if (!window.electron?.invoke) status.textContent = 'Disponible uniquement dans l’application desktop';
            else if (readyToInstall) {
                const v = info?.latestVersion;
                status.textContent = v ? `Prête à installer (v${v})` : 'Mise à jour prête — redémarrez pour appliquer';
            }
            else if (!info) status.textContent = 'Vérification…';
            else if (!info.success) status.textContent = info.error ? `Vérification impossible (${info.error})` : 'Vérification impossible';
            else if (available) status.textContent = `Mise à jour disponible : v${info.latestVersion} (actuelle v${info.currentVersion})`;
            else status.textContent = `À jour (v${info.currentVersion})`;
        }

        if (btnDownload) {
            // Masquer le téléchargement si déjà prêt ; sinon afficher si MAJ dispo
            btnDownload.classList.toggle('hidden', readyToInstall || !(info && info.success && available));
            btnDownload.disabled = !(window.electron?.invoke && available) || readyToInstall;
        }

        if (btnRestart) {
            btnRestart.classList.toggle('hidden', !readyToInstall);
            btnRestart.disabled = !(window.electron?.invoke && readyToInstall);
        }

        // Le hint ne doit apparaître qu'après un téléchargement réel et réussi.
        if (hint) {
            hint.classList.toggle('hidden', !readyToInstall);
        }
    }

    showAuthModal(mode) {
        const authModal = document.getElementById('authModal');
        const authTabs = document.querySelectorAll('.auth-tab');
        const loginForm = document.getElementById('loginForm');
        const registerForm = document.getElementById('registerForm');

        authModal.classList.remove('hidden');

        authTabs.forEach(tab => {
            if (tab.dataset.mode === mode) {
                tab.classList.add('active');
            } else {
                tab.classList.remove('active');
            }
        });

        if (mode === 'login') {
            loginForm.classList.remove('hidden');
            registerForm.classList.add('hidden');
        } else {
            loginForm.classList.add('hidden');
            registerForm.classList.remove('hidden');
        }
    }

    getLastPage() {
        try {
            return localStorage.getItem(this.storageKey);
        } catch (error) {
            logger.warn('⚠️ Impossible d\'accéder au localStorage:', error);
            return null;
        }
    }

    saveCurrentPage(pageName) {
        try {
            localStorage.setItem(this.storageKey, pageName);
        } catch (error) {
            logger.warn('⚠️ Impossible de sauvegarder la page:', error);
        }
    }

    trackPageVisit(pageName) {
        try {
            // Ne pas tracker la page d'accueil pour éviter les doublons
            if (pageName === 'home') return;

            // Créer le gestionnaire s'il n'existe pas
            if (!window.recentItemsManager) {
                import('./assets/js/modules/recent/RecentItemsManager.js')
                    .then(module => {
                        const RecentItemsManager = module.default;
                        window.recentItemsManager = new RecentItemsManager({ maxItems: 5 });
                        window.recentItemsManager.trackPageVisit(pageName);
                    })
                    .catch(error => {
                        logger.error('❌ Erreur import RecentItemsManager:', error);
                    });
            } else {
                // Tracker la visite si le gestionnaire existe
                window.recentItemsManager.trackPageVisit(pageName);
            }
        } catch (error) {
            logger.warn('⚠️ Impossible de tracker la visite:', error);
        }
    }

    loadComponentDirect(elementId, html, onLoad) {
        try {
            const element = document.getElementById(elementId);
            if (!element) {
                logger.error(`❌ Element ${elementId} not found`);
                return;
            }
            element.innerHTML = html;
            if (onLoad) onLoad();
        } catch (error) {
            logger.error(`❌ Erreur chargement ${elementId}:`, error);
        }
    }

    async loadComponent(elementId, url, onLoad) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Component ${elementId} not found`);
            const html = await response.text();
            document.getElementById(elementId).innerHTML = html;
            if (onLoad) onLoad();
        } catch (error) {
            logger.error(`❌ Erreur chargement ${elementId}:`, error);
        }
    }

    initializeSystemInfo() {
        import('./assets/js/modules/system/SystemInfoManager.js')
            .then(module => {
                const SystemInfoManager = module.default;
                window.systemInfoManager = new SystemInfoManager({
                    ipElementId: 'footer-ip-value',
                    ramElementId: 'footer-ram-value',
                    connectionElementId: 'footer-connection-value',
                    connectionIconId: 'footer-connection-icon',
                    serverElementId: 'footer-server-value',
                    serverIconId: 'footer-server-icon',
                    updateInterval: 5000
                });
            })
            .catch(error => {
                logger.error('❌ Erreur import SystemInfoManager:', error);
            });
    }

    /**
     * Afficher la version de l'app dans le footer (Electron = app.getVersion(), sinon fallback V3.0).
     */
    updateFooterVersion() {
        const el = document.getElementById('footer-app-version');
        if (!el) return;
        if (typeof window.electron?.invoke === 'function') {
            window.electron.invoke('get-app-config')
                .then(config => {
                    if (config?.appVersion) el.textContent = 'V' + config.appVersion;
                })
                .catch(() => {});
        }
    }

    /**
     * Dans Electron : les clics sur les liens externes du footer ouvrent le navigateur système (openExternal)
     * au lieu d'une fenêtre dans l'app. En mode web, le comportement par défaut est conservé.
     */
    attachFooterExternalLinks() {
        const footer = document.getElementById('footer');
        if (!footer) return;
        footer.addEventListener('click', (e) => {
            const a = e.target.closest('a[href^="http"]');
            if (!a || !a.href) return;
            if (typeof window.electron !== 'undefined' && (window.electron.openExternal || window.electron.invoke)) {
                e.preventDefault();
                e.stopPropagation();
                const openExternal = window.electron.openExternal || ((url) => window.electron.invoke('open-external', url));
                openExternal(a.href).catch(() => {});
            }
        });
    }

    /**
     * Ferme tous les <dialog> dans un conteneur (évite que les modales s'ouvrent automatiquement après injection HTML).
     */
    closeAllDialogsIn(container) {
        if (!container || !container.querySelectorAll) return;
        const dialogs = container.querySelectorAll('dialog');
        dialogs.forEach(dialog => {
            if (typeof dialog.close === 'function') dialog.close();
            dialog.removeAttribute('open');
            const id = dialog.id;
            if (id && window.modalManager && typeof window.modalManager.forget === 'function') {
                window.modalManager.forget(id);
            }
        });
    }

    async loadPage(pageName) {
        try {
            const isReceptionSubPage = ['entrer', 'sortie', 'inventaire', 'historique', 'disques', 'commande', 'dons', 'prets'].includes(pageName);

            // Ancienne page traçabilité fusionnée dans historique
            if (pageName === 'tracabilite') {
                return this.loadPage('historique');
            }
            if (pageName === 'home' || pageName === 'dossier') {
                return this.loadPage('agenda');
            }
            
            // Si c'est une sous-page de réception, charger d'abord reception.html
            if (isReceptionSubPage) {
                const receptionResponse = await fetch('./pages/reception.html');
                if (!receptionResponse.ok) throw new Error(`HTTP error! status: ${receptionResponse.status}`);
                let receptionHtml = await receptionResponse.text();
                receptionHtml = this.transformFileManagers(receptionHtml);
                receptionHtml = this.transformAppManagers(receptionHtml);
                const contentEl = document.getElementById(this.contentContainer);
                contentEl.innerHTML = receptionHtml;
                this.closeAllDialogsIn(contentEl);

                // Puis charger la sous-page dans recep-section
                const pagePath = `./pages/reception-pages/${pageName}.html`;
                const response = await fetch(pagePath);
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                let html = await response.text();
                html = this.transformFileManagers(html);
                html = this.transformAppManagers(html);
                const recepSection = document.querySelector('.recep-section');
                if (recepSection) {
                    recepSection.innerHTML = html;
                    this.closeAllDialogsIn(recepSection);
                    recepSection.scrollTop = 0;
                }
                this.setReceptionNavActive(pageName);
                this.setReceptionPageTitle(pageName);
                this.setReceptionPageDescription(pageName);
            } else {
                // Si on clique sur "Réception" du header, rediriger vers "entrer" par défaut
                if (pageName === 'reception') {
                    return this.loadPage('entrer');
                }
                
                // Déterminer le chemin de la page
                let pagePath = `./pages/${pageName}.html`;
                const response = await fetch(pagePath);
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                
                let html = await response.text();
                html = this.transformFileManagers(html);
                html = this.transformAppManagers(html);
                const contentEl = document.getElementById(this.contentContainer);
                // Retirer les modales agenda du body si elles y ont été déplacées (évite doublons d’id au rechargement agenda)
                ['agenda-create-modal', 'agenda-edit-modal', 'agenda-delete-modal'].forEach((id) => {
                    document.getElementById(id)?.remove();
                });
                contentEl.innerHTML = html;
                this.closeAllDialogsIn(contentEl);
            }

            /* Fermer tout dialog restant dans le document (sécurité) */
            this.closeAllDialogsIn(document.body);

            this.saveCurrentPage(pageName);
            this.trackPageVisit(pageName);
            this.setReceptionScrollMode(pageName, isReceptionSubPage);
            // Pour les sous-pages reception, utiliser la config 'reception'
            const layoutPageName = isReceptionSubPage ? 'reception' : pageName;
            this.updateLayout(layoutPageName);
            this.initializeTimeIfNeeded();
            this.initializePageElements(pageName);
            this.attachListeners();
            this.attachReceptionPageListeners();
            this.initializeFileManagers();
            if (isReceptionSubPage) {
                requestAnimationFrame(() => {
                    const recepSection = document.querySelector('.recep-section');
                    if (recepSection) recepSection.scrollTop = 0;
                });
            }
        } catch (error) {
            logger.error(`❌ Erreur lors du chargement de ${pageName}:`, error);
            this.showError(pageName);
        }
    }

    transformFileManagers(html) {
        // Remplace {{filemanagerX}} ... {{/filemanagerX}} (avec espaces tolérés) par un conteneur dédié
        const re = /\{\{\s*filemanager(\w+)\s*\}\}[\s\S]*?\{\{\s*\/filemanager\1\s*\}\}/gi;
        return html.replace(re, (_match, name) => {
            const key = name.toLowerCase();
            return `<div class="filemanager" data-fm="${key}"></div>`;
        });
    }

    transformAppManagers(html) {
        // Remplace {{appmanagerX}} ... {{/appmanagerX}} par un conteneur dédié
        const re = /\{\{\s*appmanager(\w+)\s*\}\}[\s\S]*?\{\{\s*\/appmanager\1\s*\}\}/gi;
        return html.replace(re, (_match, name) => {
            const key = name.toLowerCase();
            return `<div class="app-manager" data-app="${key}"></div>`;
        });
    }

    initializeTimeIfNeeded() {
        const timeElement = document.getElementById('current-time');
        const dateElement = document.getElementById('current-date');
        
        if (timeElement && dateElement) {
            if (window.timeManager) {
                window.timeManager.destroy();
            }
            
            import('./assets/js/modules/time/TimeManager.js')
                .then(module => {
                    const TimeManager = module.default;
                    window.timeManager = new TimeManager({
                        dateElementId: 'current-date',
                        timeElementId: 'current-time',
                        updateInterval: 1000
                    });
                })
                .catch(error => {
                    logger.error('❌ Erreur import TimeManager:', error);
                });
        } else {
            if (window.timeManager) {
                window.timeManager.destroy();
                window.timeManager = null;
            }
        }
    }

    initializePageElements(pageName) {
        if (pageName === 'agenda') {
            import('./assets/js/modules/agenda/AgendaInit.js')
                .then(module => {
                    module.destroyAgenda();
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => module.initAgenda());
                    });
                })
                .catch(error => {
                    logger.error('❌ Erreur import AgendaInit:', error);
                });
        } else if (pageName === 'entrer') {
            // Empêcher la double initialisation
            if (window.gestionLotsManagerInitializing) {
                logger.debug('⏳ GestionLotsManager déjà en cours d\'initialisation, skip');
                return;
            }
            
            // Détruire l'ancien manager s'il existe (changement de page)
            if (window.gestionLotsManager) {
                window.gestionLotsManager.destroy();
                window.gestionLotsManager = null;
                logger.debug('ℹ️ Ancien GestionLotsManager détruit');
            }
            
            // Marquer comme en cours d'initialisation
            window.gestionLotsManagerInitializing = true;
            
            // Initialiser un nouveau gestionnaire de lots
            import('./assets/js/modules/reception/gestion-lots.js')
                .then(module => {
                    const GestionLotsManager = module.default;
                    window.gestionLotsManager = new GestionLotsManager(window.modalManager);
                    logger.debug('✅ GestionLotsManager initialisé depuis app.js');
                    // Libérer le flag après un court délai
                    setTimeout(() => {
                        window.gestionLotsManagerInitializing = false;
                    }, 500);
                })
                .catch(error => {
                    logger.error('❌ Erreur import GestionLotsManager:', error);
                    window.gestionLotsManagerInitializing = false;
                });
        } else if (pageName === 'inventaire') {
            // Détruire l'ancien manager s'il existe
            if (window.inventaireManager) {
                window.inventaireManager.destroy();
                window.inventaireManager = null;
            }
            
            // Initialiser le gestionnaire d'inventaire
            import('./assets/js/modules/reception/inventaire.js')
                .then(module => {
                    const InventaireManager = module.default;
                    window.inventaireManager = new InventaireManager(window.modalManager);
                    logger.debug('✅ InventaireManager initialisé depuis app.js');
                })
                .catch(error => {
                    logger.error('❌ Erreur import InventaireManager:', error);
                });
        } else if (pageName === 'historique') {
            // Détruire l'ancien manager s'il existe
            if (window.historiqueManager) {
                window.historiqueManager.destroy();
                window.historiqueManager = null;
            }
            if (window.tracabiliteManager) {
                window.tracabiliteManager.destroy();
                window.tracabiliteManager = null;
            }
            
            // Initialiser le gestionnaire d'historique (inclut traçabilité / PDF)
            import('./assets/js/modules/reception/historique.js')
                .then(module => {
                    const HistoriqueManager = module.default;
                    window.historiqueManager = new HistoriqueManager(window.modalManager);
                    logger.debug('✅ HistoriqueManager initialisé depuis app.js');
                })
                .catch(error => {
                    logger.error('❌ Erreur import HistoriqueManager:', error);
                });
        } else if (pageName === 'disques') {
            if (window.disquesManagerInitializing) {
                logger.debug('⏳ DisquesManager déjà en cours d\'initialisation, skip');
                return;
            }
            if (window.disquesManager) {
                window.disquesManager.destroy();
                window.disquesManager = null;
            }
            window.disquesManagerInitializing = true;
            import('./assets/js/modules/reception/disques.js')
                .then(module => {
                    const DisquesManager = module.default;
                    window.disquesManager = new DisquesManager(window.modalManager);
                    window.disquesManagerInitializing = false;
                    logger.debug('✅ DisquesManager initialisé depuis app.js');
                })
                .catch(error => {
                    logger.error('❌ Erreur import DisquesManager:', error);
                    window.disquesManagerInitializing = false;
                });
        } else if (pageName === 'commande') {
            if (window.commandeManagerInitializing) {
                logger.debug('⏳ CommandeManager déjà en cours d\'initialisation, skip');
                return;
            }
            if (window.commandeManager) {
                window.commandeManager.destroy();
                window.commandeManager = null;
            }
            window.commandeManagerInitializing = true;
            import('./assets/js/modules/reception/commande.js')
                .then(module => {
                    if (window.commandeManager) {
                        window.commandeManager.destroy();
                        window.commandeManager = null;
                    }
                    const CommandeManager = module.default;
                    window.commandeManager = new CommandeManager(window.modalManager);
                    window.commandeManagerInitializing = false;
                    logger.debug('✅ CommandeManager initialisé depuis app.js');
                })
                .catch(error => {
                    logger.error('❌ Erreur import CommandeManager:', error);
                    window.commandeManagerInitializing = false;
                });
        } else if (pageName === 'dons') {
            if (window.donsManager) {
                window.donsManager.destroy();
                window.donsManager = null;
            }
            import('./assets/js/modules/reception/dons.js')
                .then(module => {
                    if (window.donsManager) {
                        window.donsManager.destroy();
                        window.donsManager = null;
                    }
                    const DonsManager = module.default;
                    window.donsManager = new DonsManager(window.modalManager);
                    logger.debug('✅ DonsManager initialisé depuis app.js');
                })
                .catch(error => {
                    logger.error('❌ Erreur import DonsManager:', error);
                });
        } else if (pageName === 'prets') {
            if (window.pretsManager) {
                window.pretsManager.destroy();
                window.pretsManager = null;
            }
            import('./assets/js/modules/reception/prets.js')
                .then(module => {
                    if (window.pretsManager) {
                        window.pretsManager.destroy();
                        window.pretsManager = null;
                    }
                    const PretsManager = module.default;
                    window.pretsManager = new PretsManager(window.modalManager);
                    logger.debug('✅ PretsManager initialisé depuis app.js');
                })
                .catch(error => {
                    logger.error('❌ Erreur import PretsManager:', error);
                });
        }
    }

    async initializeFileManagers() {
        const fmContainers = document.querySelectorAll('.filemanager[data-fm]');
        if (!fmContainers.length) return;

        try {
            const [managerModule, configModule] = await Promise.all([
                import('./assets/js/modules/folder/FolderManager.js'),
                import('./assets/js/config/FolderConfig.js')
            ]);
            const FolderManager = managerModule.default;
            const folderConfig = configModule.folderConfig || configModule.default;

            // Nettoyer une instance globale éventuelle
            if (window.folderManagers) {
                window.folderManagers.forEach(m => m.destroy());
            }
            window.folderManagers = [];

            fmContainers.forEach(container => {
                const key = container.dataset.fm?.toLowerCase();
                const cfg = folderConfig.resolvePreset(key);

                // Construire le markup interne
                container.innerHTML = `<div class="folders-list"></div>`;

                const manager = new FolderManager({
                    scope: container,
                    buttonSelector: '.folder-open-btn',
                    listSelector: '.folders-list',
                    preset: key,
                    config: cfg
                });
                window.folderManagers.push(manager);
            });
        } catch (error) {
            logger.error('❌ Erreur initialisation FileManagers:', error);
        }
    }

    async loadTodayEvents(AgendaStore) {
        try {
            const today = new Date();
            const todayStr = this.formatLocalISODate(today);
            
            const allEvents = await AgendaStore.getAllEvents();
            const todayEvents = allEvents.filter(ev => {
                const eventStart = ev.start.substring(0, 10);
                const eventEnd = ev.end.substring(0, 10);
                return todayStr >= eventStart && todayStr <= eventEnd;
            });

            todayEvents.sort((a, b) => a.start.localeCompare(b.start));

            const homeSection = document.querySelector('.home.section');
            if (!homeSection) return;
            
            const blockContents = homeSection.querySelectorAll('.block-content');
            const calendarContent = blockContents[1];
            
            if (calendarContent) {
                if (todayEvents.length === 0) {
                    calendarContent.innerHTML = '<p class="home-event-item-empty">Aucun événement pour aujourd\'hui</p>';
                } else {
                    calendarContent.innerHTML = todayEvents.map(event => {
                        const startTime = event.start.substring(11, 16);
                        const endTime = event.end.substring(11, 16);
                        const eventColor = event.color || '#3788d8';
                        const backgroundColor = eventColor + '20';
                        return `
                            <div class="home-event-item" data-bg-color="${backgroundColor}">
                                <div class="home-event-item-title">${event.title}</div>
                                <div class="home-event-item-time">
                                    ${startTime} à ${endTime}
                                </div>
                                ${event.description ? `<div class="home-event-item-description">${event.description}</div>` : ''}
                            </div>
                        `;
                    }).join('');
                    
                    document.querySelectorAll('.home-event-item').forEach(el => {
                        const bgColor = el.getAttribute('data-bg-color');
                        el.style.backgroundColor = bgColor;
                    });
                }
            }
        } catch (error) {
            logger.error('❌ Erreur chargement événements du jour:', error);
            const calendarContent = document.querySelector('.calendar-content');
            if (calendarContent) {
                calendarContent.innerHTML = '<p class="home-event-item-empty">Erreur lors du chargement des événements</p>';
            }
        }
    }

    formatLocalISODate(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    /**
     * Affiche une notification toast (erreur, succès, info, warning).
     * @param {string} message
     * @param {string} [type='info'] success | error | info | warning
     * @param {object} [options]
     * @param {number} [options.duration] ms (défaut 3000, 5000 si onUndo)
     * @param {string} [options.undoLabel='Annuler']
     * @param {() => void} [options.onUndo] callback annulation (toast ~5 s)
     * @param {'bottom'|'top-right'} [options.position='top-right']
     */
    showNotification(message, type = 'info', options = {}) {
        const duration = options.duration ?? (options.onUndo ? 5000 : 3000);
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        if (options.onUndo) notification.classList.add('has-action');
        if (options.position === 'bottom') notification.classList.add('notification--bottom');
        notification.setAttribute('role', 'status');

        let icon = '<i class="fa-solid fa-circle-info"></i>';
        if (type === 'success') icon = '<i class="fa-solid fa-check-circle"></i>';
        else if (type === 'error') icon = '<i class="fa-solid fa-exclamation-circle"></i>';
        else if (type === 'warning') icon = '<i class="fa-solid fa-triangle-exclamation"></i>';

        notification.innerHTML = icon;
        const messageSpan = document.createElement('span');
        messageSpan.textContent = String(message);
        notification.appendChild(messageSpan);

        let hideTimer;
        const dismiss = () => {
            clearTimeout(hideTimer);
            notification.classList.add('hide');
            setTimeout(() => notification.remove(), 300);
        };

        if (options.onUndo) {
            const undoBtn = document.createElement('button');
            undoBtn.type = 'button';
            undoBtn.className = 'notification-action';
            undoBtn.textContent = options.undoLabel || 'Annuler';
            undoBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                options.onUndo();
                dismiss();
            });
            notification.appendChild(undoBtn);
        }

        document.body.appendChild(notification);
        requestAnimationFrame(() => notification.classList.add('show'));
        hideTimer = setTimeout(dismiss, duration);
    }

    updateLayout(pageName) {
        const header = document.getElementById('header');
        const footer = document.getElementById('footer');
        
        const config = this.pagesConfig[pageName];
        
        if (!config) {
            logger.warn(`⚠️ Configuration manquante pour : ${pageName}`);
            return;
        }
        
        window.navManager?.closeMenu();
        
        header.style.display = config.showHeader ? 'block' : 'none';
        footer.style.display = config.showFooter ? 'block' : 'none';
    }

    showError(pageName) {
        const errorHTML = `
            <div style="color: red; padding: 20px;">
                <h2>❌ Erreur de chargement</h2>
                <p>Impossible de charger la page : <strong>${pageName}</strong></p>
                <p>Vérifiez que le fichier existe : <code>public/pages/${pageName}.html</code></p>
            </div>
        `;
        document.getElementById(this.contentContainer).innerHTML = errorHTML;
    }

    attachListeners() {
        const buttons = document.querySelectorAll('[data-page]');
        
        buttons.forEach(button => {
            if (button.dataset.receptionPage === 'true') return;
            if (!button.dataset.listenerAttached) {
                button.addEventListener('click', (event) => {
                    event.preventDefault();
                    const pageName = button.dataset.page;
                    this.loadPage(pageName);
                });
                
                button.dataset.listenerAttached = 'true';
            }
        });
    }

    setReceptionNavActive(pageName) {
        const buttons = document.querySelectorAll('[data-reception-page="true"]');
        buttons.forEach(btn => {
            btn.classList.remove('active');
            btn.removeAttribute('aria-current');
            if (btn.dataset.page === pageName) {
                btn.classList.add('active');
                btn.setAttribute('aria-current', 'page');
            }
        });
    }

    setReceptionPageTitle(pageName) {
        const titles = {
            entrer: 'Réception de Lots',
            inventaire: 'Inventaire',
            historique: 'Historique & traçabilité',
            disques: 'Réception de Disques',
            commande: 'Réception de Commande',
            dons: 'Réception de Dons',
            prets: 'Prêts de matériel'
        };
        const titleEl = document.getElementById('reception-page-title');
        if (titleEl) titleEl.textContent = titles[pageName] || 'Réception';

        // Synchroniser l'icône du h2 avec celle du bouton actif de la sidebar
        const mainTitleIcon = document.querySelector('.r-main-title-icon');
        const activeBtn = document.querySelector(`[data-reception-page="true"][data-page="${pageName}"]`);
        const sidebarIcon = activeBtn?.querySelector('.r-nav-icon i');
        if (mainTitleIcon && sidebarIcon) {
            mainTitleIcon.className = 'r-main-title-icon ' + (sidebarIcon.className || '').trim();
        } else if (mainTitleIcon) {
            mainTitleIcon.className = 'r-main-title-icon fa-solid fa-folder-open';
        }
    }

    setReceptionPageDescription(pageName) {
        const descriptions = {
            entrer: 'Saisissez les numéros de série et les informations des machines.',
            inventaire: 'Gérez l\'état des PC et assignez les techniciens.',
            historique: 'Archives des lots, disques, commandes, dons et prêts — détails, édition, PDF et email.',
            disques: 'Saisissez les disques puis enregistrez en traçabilité.',
            commande: 'Constituer une liste de produits et générer le PDF.',
            dons: 'Enregistrez les dons de matériel aux stagiaires et générez le certificat.',
            prets: 'Enregistrez les prêts ou locations de matériel et générez la fiche PDF.'
        };
        const descEl = document.getElementById('reception-page-desc');
        const descTextEl = document.getElementById('reception-page-desc-text');
        if (!descEl) return;
        const text = descriptions[pageName] || '';
        if (descTextEl) descTextEl.textContent = text;
        else descEl.textContent = text;
        descEl.classList.toggle('is-empty', !text);
    }

    setReceptionScrollMode(pageName, isReceptionSubPage) {
        const body = document.body;
        const html = document.documentElement;
        const root = document.querySelector('.r-root');
        if (!body || !root || !html) return;
        const onlyHistorique = !!isReceptionSubPage && pageName === 'historique';
        body.classList.toggle('reception-single-scroll', onlyHistorique);
        html.classList.toggle('reception-single-scroll', onlyHistorique);
        root.classList.toggle('reception-single-scroll', onlyHistorique);
    }

    attachReceptionPageListeners() {
        const receptionButtons = document.querySelectorAll('[data-reception-page="true"]');
        
        receptionButtons.forEach(button => {
            if (!button.dataset.receptionListenerAttached) {
                button.addEventListener('click', (event) => {
                    event.preventDefault();
                    const pageName = button.dataset.page;
                    this.loadPage(pageName);
                });
                
                button.dataset.receptionListenerAttached = 'true';
            }
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.pageManager = new PageManager();
});