const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_CHANNELS = {
    send: ['open-pdf', 'chat-new-message'],
    invoke: [
        'open-external',
        'open-pdf-window',
        'open-pdf-with-system-app',
        'get-app-config',
        'get-connection-config',
        'get-server-config',
        'get-local-ip',
        'get-system-info',
        'list-folders',
        'open-path',
        'launch-app',
        'get-app-icon',
        'generate-lot-pdf',
        'generate-disques-pdf',
        'generate-commande-pdf',
        'generate-don-pdf',
        'generate-pret-materiel-pdf',
        'read-file-as-base64',
        'run-lsblk',
        'check-app-update',
        'download-app-update',
        'install-app-update',
        'get-pending-app-update'
    ],
    on: [
        'update-was-installed',
        'app-update-available',
        'app-update-download-progress',
        'app-update-download-done'
    ]
};

function validateChannel(channel, type) {
    if (!ALLOWED_CHANNELS[type] || !ALLOWED_CHANNELS[type].includes(channel)) {
        throw new Error(`Canal IPC non autorisé: ${channel}`);
    }
}

contextBridge.exposeInMainWorld('electron', {
    send: (channel, data) => {
        validateChannel(channel, 'send');
        ipcRenderer.send(channel, data);
    },

    on: (channel, callback) => {
        validateChannel(channel, 'on');
        if (typeof callback !== 'function') {
            throw new Error('Le callback doit être une fonction');
        }
        ipcRenderer.on(channel, (event, args) => callback(args));
    },

    once: (channel, callback) => {
        validateChannel(channel, 'on');
        if (typeof callback !== 'function') {
            throw new Error('Le callback doit être une fonction');
        }
        ipcRenderer.once(channel, (event, args) => callback(args));
    },

    invoke: (channel, args) => {
        validateChannel(channel, 'invoke');
        return ipcRenderer.invoke(channel, args);
    },

    openExternal: async (url) => {
        if (typeof url !== 'string' || !url.startsWith('http')) {
            throw new Error('URL invalide');
        }
        return ipcRenderer.invoke('open-external', url);
    },

    openPDF: () => {
        ipcRenderer.send('open-pdf');
    }
});

// Exposer ipcRenderer pour la compatibilité
contextBridge.exposeInMainWorld('ipcRenderer', {
    invoke: (channel, args) => {
        if (!ALLOWED_CHANNELS.invoke.includes(channel)) {
            throw new Error(`Canal IPC non autorisé: ${channel}`);
        }
        return ipcRenderer.invoke(channel, args);
    }
});

// Exposer electronAPI comme alias pour electron (pour la compatibilité)
contextBridge.exposeInMainWorld('electronAPI', {
    openExternal: async (url) => {
        if (typeof url !== 'string' || !url.startsWith('http')) {
            throw new Error('URL invalide');
        }
        return ipcRenderer.invoke('open-external', url);
    },
    openPath: async (path) => {
        return ipcRenderer.invoke('open-path', { path });
    }
});

