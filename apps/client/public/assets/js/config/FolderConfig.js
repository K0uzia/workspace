/**
 * Configuration générique pour l'ouverture de dossiers
 */

export const folderConfig = {
    // Presets nommés accessibles via {{filemanager<nom>}}
    // Exemple: {{filemanagerteam}} ... {{/filemanagerteam}} => preset "team"
    fileManagers: {
        team: {
            basePath: '/mnt/team/#TEAM/',
            // Blacklist spécifique à ce preset (vide = utilise la globale)
            blacklist: ['#TRAÇABILITÉ', '#INTERNE', '#INVITES', '#COMMANDES','#OVERLAYS','lacapsule-git','CapsuleOS','CapsuleOS-app']
        },
        guest: {
            basePath: '/mnt/team/#TEAM/#INVITES',
        },
        development: {
            basePath: '/mnt/team/#TEAM/#INTERNE/#WEB',
            blacklist: []
        },
        capsule: {
            basePath: '/mnt/team/#TEAM/#INTERNE',
            blacklist: ['#WEB']
        }
    },

    // Fichiers et dossiers à exclure (global, fallback si pas défini dans preset)
    blacklist: [],

    ignoreSuffixes: ['.tmp', '.bak', '.swp', '.swo', '~'],
    ignoreExtensions: ['.tmp', '.bak', '.log', '.lock'],

    isBlacklisted(name) {
        if (this.blacklist.includes(name)) return true;
        if (name.startsWith('~$')) return true;
        if (name.startsWith('.') && name !== '.' && name !== '..') return true;

        for (const suffix of this.ignoreSuffixes) {
            if (name.endsWith(suffix)) return true;
        }
        for (const ext of this.ignoreExtensions) {
            if (name.endsWith(ext)) return true;
        }
        return false;
    },

    /**
     * Récupère la config d'un preset ou la config par défaut
     */
    resolvePreset(name) {
        if (!name) return this;
        const key = name.toLowerCase();
        const preset = this.fileManagers?.[key];
        if (!preset) return this;
        return {
            ...this,
            ...preset,
            blacklist: preset.blacklist !== undefined ? preset.blacklist : this.blacklist,
            ignoreSuffixes: preset.ignoreSuffixes || this.ignoreSuffixes,
            ignoreExtensions: preset.ignoreExtensions || this.ignoreExtensions
        };
    }
};

export default folderConfig;
