/**
 * FolderManager - Gestion optimisée d'ouverture de dossiers
 */

import folderConfig from '../../config/FolderConfig.js';

export default class FolderManager {
    constructor(options = {}) {
        this.preset = options.preset;
        this.config = { ...folderConfig, ...(options.config || {}) };
        this.buttonSelector = options.buttonSelector || '.folder-open-btn';
        this.listSelector = options.listSelector || '.folders-list';
        this.scope = options.scope || document;
        this.buttons = [];
        this.listContainer = null;
        this.cache = new Map();
        this.isOpening = false;
        this.init();
    }

    async init() {
        this.config = await this._loadConfig();
        this.buttons = Array.from(this.scope.querySelectorAll(this.buttonSelector));
        this.listContainer = this.scope.querySelector(this.listSelector);

        if (!this.listContainer) {
            console.warn('⚠️ Conteneur liste introuvable');
            return;
        }

        this.attachListeners();
        this.loadAndRender();
    }

    async _loadConfig() {
        try {
            const serverUrl = window.SERVER_CONFIG?.serverUrl || window.APP_CONFIG?.serverUrl;
            if (serverUrl) {
                const res = await fetch(`${serverUrl}/api/admin/config/folders`);
                if (res.ok) {
                    const data = await res.json();
                    if (data?.fileManagers) {
                        const key = (this.preset || '').toLowerCase();
                        const preset = data.fileManagers[key];
                        const base = {
                            ...folderConfig,
                            blacklist: data.blacklist ?? folderConfig.blacklist,
                            ignoreSuffixes: data.ignoreSuffixes || folderConfig.ignoreSuffixes,
                            ignoreExtensions: data.ignoreExtensions || folderConfig.ignoreExtensions,
                        };
                        if (preset) {
                            console.log('✅ FolderManager config chargée depuis serveur, preset:', this.preset);
                            return {
                                ...base,
                                ...preset,
                                blacklist: preset.blacklist !== undefined ? preset.blacklist : base.blacklist,
                            };
                        }
                        return base;
                    }
                }
            }
        } catch {
            // Serveur inaccessible ou route non disponible — fallback local silencieux
        }
        if (this.preset) return folderConfig.resolvePreset(this.preset);
        return { ...folderConfig };
    }

    attachListeners() {
        this.buttons.forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                const targetPath = this.resolvePath(btn);
                await this.openFolder(btn, targetPath);
            });
        });
    }

    resolvePath(btn) {
        const explicitPath = btn.dataset.folderPath;
        if (explicitPath) return explicitPath;

        const base = btn.dataset.folderBase || this.config.basePath || '';
        const sub = btn.dataset.folderSubpath || '';
        return [base, sub].filter(Boolean).join('/').replace(/\/+/g, '/');
    }

    async openFolder(btn, path) {
        if (!path) return;
        
        if (this.isOpening) {
            console.log('⏳ Ouverture en cours, mise en attente');
            return;
        }
        
        this.isOpening = true;
        
        try {
            btn.disabled = true;
            btn.classList.add('is-loading');
            
            // Tracker l'ouverture du dossier
            const folderName = btn.dataset.folderName || path.split('/').pop() || path;
            if (window.recentItemsManager) {
                window.recentItemsManager.trackFolderOpen(folderName, path);
                window.recentItemsManager.display();
                console.log('📁 Dossier tracké:', folderName);
            }
            
            if (window.ipcRenderer?.invoke) {
                await window.ipcRenderer.invoke('open-path', { path });
            }
        } catch (error) {
            console.error('Erreur ouverture:', error.message);
        } finally {
            btn.disabled = false;
            btn.classList.remove('is-loading');
            // Délai court pour éviter de surcharger
            setTimeout(() => {
                this.isOpening = false;
            }, 500);
        }
    }

    getListPath() {
        return this.config.basePath || '';
    }

    async listFolders(pathOverride) {
        const path = pathOverride || this.getListPath();

        if (!path) return [];

        if (this.cache.has(path)) {
            return this.cache.get(path);
        }
        
        if (window.ipcRenderer?.invoke) {
            try {
                const data = await window.ipcRenderer.invoke('list-folders', {
                    path,
                    blacklist: this.config.blacklist,
                    ignoreSuffixes: this.config.ignoreSuffixes,
                    ignoreExtensions: this.config.ignoreExtensions
                });
                const filtered = this.filterBlacklisted(data?.folders || []);
                this.cache.set(path, filtered);
                return filtered;
            } catch (error) {
                const msg = error?.message || String(error);
                if (msg.includes('Chemin non autorisé') || msg.includes('path')) {
                    console.warn('FolderManager list-folders: chemin non autorisé ou indisponible:', path);
                } else {
                    console.warn('FolderManager list-folders:', msg);
                }
            }
        }
        
        return [];
    }

    filterBlacklisted(items) {
        return (items || []).filter((item) => !this.config.isBlacklisted(item));
    }

    async loadAndRender() {
        if (!this.listContainer) return;
        
        const folders = await this.listFolders();
        if (!folders || folders.length === 0) return;
        
        this.renderList(folders);
    }

    renderList(folders) {
        if (!this.listContainer) return;

        this.listContainer.classList.toggle('folders-list--scrollable', folders.length > 10);
        
        const fragment = document.createDocumentFragment();
        folders.forEach((name) => {
            const btn = document.createElement('button');
            btn.className = 'folder-open-btn folder-item-btn';
            btn.dataset.folderPath = this.buildPath(name);
            btn.innerHTML = `<i class="fa-solid fa-folder"></i> ${name}`;
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                await this.openFolder(btn, btn.dataset.folderPath);
            });
            fragment.appendChild(btn);
        });
        
        this.listContainer.innerHTML = '';
        this.listContainer.appendChild(fragment);
    }

    buildPath(name) {
        const base = this.config.basePath || '';
        return [base, name].filter(Boolean).join('/').replace(/\/+/g, '/');
    }

    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        this.cache.clear();
    }

    destroy() {
        this.cache.clear();
        this.isOpening = false;
        this.buttons = [];
        if (this.listContainer) {
            this.listContainer.innerHTML = '';
        }
    }
}
