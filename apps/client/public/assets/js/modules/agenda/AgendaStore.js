/**
 * AgendaStore.js
 * Gestion du stockage des événements
 * Support localStorage (démo) et API BDD
 */

import api from '../../config/api.js';
import { parseLocalDate } from './DateUtils.js';

class AgendaStore {
    constructor() {
        this.storageKey = 'workspace_events';
        const env = window.SERVER_CONFIG?.environment || 'local';
        this.useApi = (env === 'proxmox' || env === 'production');
        this.initializeStore();
    }

    _isLockedEventId(id) {
        return typeof id === 'string' && id.startsWith('holiday:');
    }

    _isLockedEvent(eventLike) {
        if (!eventLike || typeof eventLike !== 'object') return false;
        if (eventLike.locked === true) return true;
        if (eventLike.source === 'holiday') return true;
        if (this._isLockedEventId(eventLike.id)) return true;
        return false;
    }

    _getAuthHeaders() {
        const token = localStorage.getItem('workspace_jwt');
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        return headers;
    }

    /**
     * Initialiser le store avec des données de démo si vide
     */
    initializeStore() {
        const stored = localStorage.getItem(this.storageKey);
        if (!stored && !this.useApi) {
            this.initializeDemoData();
        }
    }

    /**
     * Initialiser avec des données de démo
     */
    initializeDemoData() {
        const today = new Date();
        const demoEvents = [
            {
                id: '1',
                title: 'Réunion d\'équipe',
                start: `${this.formatDate(today)}T09:00:00`,
                end: `${this.formatDate(today)}T10:00:00`,
                color: '#5b7cfa',
                description: 'Réunion hebdomadaire avec l\'équipe'
            },
            {
                id: '2',
                title: 'Déjeuner client',
                start: `${this.formatDate(today)}T12:00:00`,
                end: `${this.formatDate(today)}T13:30:00`,
                color: '#43c466',
                description: 'Déjeuner avec le client ABC'
            },
            {
                id: '3',
                title: 'Deadline projet',
                start: `${this.addDays(today, 3)}T17:00:00`,
                end: `${this.addDays(today, 3)}T17:00:00`,
                color: '#fdb544',
                description: 'Remise du projet à la date limite'
            },
            {
                id: '4',
                title: 'Conférence',
                start: `${this.addDays(today, 5)}T14:00:00`,
                end: `${this.addDays(today, 5)}T16:00:00`,
                color: '#5b7cfa',
                description: 'Conférence sur les nouvelles technologies'
            }
        ];
        this.saveEvents(demoEvents);
    }

    /**
     * Récupérer tous les événements
     */
    async getAllEvents() {
        if (this.useApi) {
            try {
                await api.init();
                const baseUrl = api.getUrl('agenda.events');
                const url = `${baseUrl}?start=1900-01-01&end=2100-12-31&_t=${Date.now()}`;
                const response = await fetch(url, { headers: this._getAuthHeaders(), cache: 'no-store' });
                const data = await response.json();
                return (data.success && Array.isArray(data.data)) ? data.data : [];
            } catch (error) {
                console.error('❌ Erreur récupération API:', error);
                return [];
            }
        }

        const stored = localStorage.getItem(this.storageKey);
        return stored ? JSON.parse(stored) : [];
    }

    /**
     * Récupérer les événements dans une plage de dates
     */
    async getEventsByRange(startDate, endDate) {
        if (this.useApi) {
            try {
                await api.init();
                const baseUrl = api.getUrl('agenda.events');
                const url = `${baseUrl}?start=${startDate}&end=${endDate}&_t=${Date.now()}`;
                const response = await fetch(url, { headers: this._getAuthHeaders(), cache: 'no-store' });
                const data = await response.json();
                return (data.success && Array.isArray(data.data)) ? data.data : [];
            } catch (error) {
                console.error('❌ Erreur récupération API:', error);
                return [];
            }
        }

        const all = await this.getAllEvents();
        return all.filter(event => {
            // `new Date("YYYY-MM-DD")` est UTC => peut décaler la fenêtre selon le fuseau.
            // On compare donc en dates locales.
            const eventStart = new Date((event.start ?? '').replace(' ', 'T'));
            const start = parseLocalDate(startDate) ?? new Date(startDate);
            const end = parseLocalDate(endDate) ?? new Date(endDate);
            return eventStart >= start && eventStart <= end;
        });
    }

    /**
     * Récupérer les jours fériés (événements verrouillés) dans une plage
     * Backend attendu: GET /api/agenda/holidays?year=YYYY&zone=metropole
     */
    async getHolidaysByRange(startDate, endDate, options = {}) {
        const zone = options.zone || 'metropole';
        const start = parseLocalDate(startDate);
        const end = parseLocalDate(endDate);
        if (!start || !end) return [];

        const startYear = start.getFullYear();
        const endYear = end.getFullYear();
        const years = [];
        for (let y = startYear; y <= endYear; y++) years.push(y);

        if (!this.useApi) {
            // En mode localStorage (démo), on n’injecte rien automatiquement
            return [];
        }

        try {
            await api.init();
            const baseUrl = api.getUrl('agenda.holidays');

            const results = await Promise.all(years.map(async (year) => {
                const url = `${baseUrl}?year=${encodeURIComponent(year)}&zone=${encodeURIComponent(zone)}&_t=${Date.now()}`;
                const response = await fetch(url, { headers: this._getAuthHeaders(), cache: 'no-store' });
                if (!response.ok) return [];
                const data = await response.json().catch(() => ({}));
                return (data?.success && Array.isArray(data.data)) ? data.data : [];
            }));

            const all = results.flat();
            const filtered = all.filter((ev) => {
                const d = (ev?.start || '').substring(0, 10);
                return d && d >= startDate && d <= endDate;
            });

            // Normaliser/verrouiller côté client (défense en profondeur)
            return filtered.map((ev) => ({
                ...ev,
                locked: true,
                source: 'holiday',
                all_day: true,
                color: ev.color || '#e74c3c'
            }));
        } catch (e) {
            console.warn('⚠️ Impossible de charger les jours fériés:', e);
            return [];
        }
    }

    /**
     * Ajouter un événement
     */
    async addEvent(event) {
        if (this.useApi) {
            try {
                await api.init();
                const response = await api.post('agenda.events', event, { useCache: false });
                const data = await response.json();
                if (data.success) {
                    return data.data;
                } else {
                    throw new Error(data.message);
                }
            } catch (error) {
                console.error('❌ Erreur création API:', error);
                throw error;
            }
        }

        const events = await this.getAllEvents();
        const newEvent = {
            id: Date.now().toString(),
            ...event,
            createdAt: new Date().toISOString()
        };
        events.push(newEvent);
        this.saveEvents(events);
        return newEvent;
    }

    /**
     * Mettre à jour un événement
     */
    async updateEvent(id, updates) {
        if (this._isLockedEventId(id) || this._isLockedEvent(updates)) {
            throw new Error('Cet événement est verrouillé et ne peut pas être modifié.');
        }
        if (this.useApi) {
            try {
                await api.init();
                const url = `${api.getUrl('agenda.events')}/${id}`;
                const response = await fetch(url, {
                    method: 'PUT',
                    headers: this._getAuthHeaders(),
                    body: JSON.stringify(updates)
                });
                const data = await response.json();
                if (data.success) {
                    return data.data;
                } else {
                    throw new Error(data.message);
                }
            } catch (error) {
                console.error('❌ Erreur modification API:', error);
                throw error;
            }
        }

        const events = await this.getAllEvents();
        const eventIndex = events.findIndex(e => e.id === id);
        if (eventIndex !== -1) {
            events[eventIndex] = {
                ...events[eventIndex],
                ...updates,
                updatedAt: new Date().toISOString()
            };
            this.saveEvents(events);
            return events[eventIndex];
        }
        return null;
    }

    /**
     * Supprimer un événement
     */
    async deleteEvent(id) {
        if (this._isLockedEventId(id)) {
            throw new Error('Cet événement est verrouillé et ne peut pas être supprimé.');
        }
        if (this.useApi) {
            try {
                await api.init();
                const url = `${api.getUrl('agenda.events')}/${id}`;
                const response = await fetch(url, {
                    method: 'DELETE',
                    headers: this._getAuthHeaders()
                });
                const data = await response.json();
                if (data.success) {
                    return true;
                } else {
                    throw new Error(data.message);
                }
            } catch (error) {
                console.error('❌ Erreur suppression API:', error);
                throw error;
            }
        }

        const events = await this.getAllEvents();
        const filtered = events.filter(e => e.id !== id);
        this.saveEvents(filtered);
        return filtered.length < events.length;
    }

    /**
     * Sauvegarder tous les événements (localStorage seulement)
     */
    saveEvents(events) {
        localStorage.setItem(this.storageKey, JSON.stringify(events));
    }

    /**
     * Formater une date en YYYY-MM-DD
     */
    formatDate(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    /**
     * Ajouter des jours à une date
     */
    addDays(date, days) {
        const result = new Date(date);
        result.setDate(result.getDate() + days);
        return this.formatDate(result);
    }

    /**
     * Exporter les données (pour migration BDD future)
     */
    async exportData() {
        return {
            version: '1.0',
            exportedAt: new Date().toISOString(),
            events: await this.getAllEvents()
        };
    }

    /**
     * Importer les données (pour restauration depuis BDD)
     */
    importData(data) {
        if (data.events && Array.isArray(data.events)) {
            this.saveEvents(data.events);
            return true;
        }
        return false;
    }

    /**
     * Réinitialiser complètement le store
     */
    resetStore() {
        localStorage.removeItem(this.storageKey);
        this.initializeDemoData();
    }

    /**
     * Basculer vers API
     */
    switchToApi(shouldUse = true) {
        this.useApi = shouldUse;
    }
}

export default new AgendaStore();

