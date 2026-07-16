/**
 * Module partagé pour le chargement des lots avec leurs items.
 * Utilisé par Inventaire, Historique et Traçabilité.
 */

import api from '../../config/api.js';
import getLogger from '../../config/Logger.js';
const logger = getLogger();

/**
 * Charge la liste des lots avec leurs items.
 * @param {{ status: 'active' | 'finished' | 'all' }} options
 * @returns {Promise<Array>} Tableau de lots (chaque lot a .items)
 * @throws {Error} En cas d'échec HTTP ou parsing
 */
export async function loadLotsWithItems({ status }) {
    const serverUrl = api.getServerUrl();
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('workspace_jwt') || ''}`
    };

    let rawLots = [];
    if (status === 'all') {
        const [activeRes, finishedRes] = await Promise.all([
            fetch(`${serverUrl}/api/lots?status=active`, { method: 'GET', headers }),
            fetch(`${serverUrl}/api/lots?status=finished`, { method: 'GET', headers })
        ]);
        if (!activeRes.ok) throw new Error(`HTTP ${activeRes.status}`);
        if (!finishedRes.ok) throw new Error(`HTTP ${finishedRes.status}`);
        const activeData = await activeRes.json();
        const finishedData = await finishedRes.json();
        const activeList = Array.isArray(activeData) ? activeData : (activeData.items || activeData.lots || []);
        const finishedList = Array.isArray(finishedData) ? finishedData : (finishedData.items || finishedData.lots || []);
        const seen = new Set();
        rawLots = [...activeList, ...finishedList].filter(lot => {
            const id = lot.id;
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        });
        logger.debug('Lots liste reçus (all = active + finished):', { count: rawLots.length });
    } else {
        const url = `${serverUrl}/api/lots?status=${status}`;
        const response = await fetch(url, { method: 'GET', headers });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        rawLots = Array.isArray(data) ? data : (data.items || data.lots || []);
        logger.debug('Lots liste reçus:', { status, count: rawLots.length });
    }

    if (!Array.isArray(rawLots)) {
        logger.warn('Données lots invalides:', rawLots);
        return [];
    }

    const lotsWithItems = await Promise.all(rawLots.map(async (lot) => {
        try {
            const lotUrl = `${serverUrl}/api/lots/${lot.id}`;
            const lotResponse = await fetch(lotUrl, { method: 'GET', headers });
            if (!lotResponse.ok) {
                logger.debug(`Erreur GET lot ${lot.id}:`, lotResponse.status);
                return { ...lot, items: [] };
            }
            const lotData = await lotResponse.json();
            const items = Array.isArray(lotData.items) ? lotData.items : (lotData.item?.items || []);
            logger.debug(`Lot ${lot.id} items:`, items.length);
            return {
                ...lot,
                ...(lotData.item || {}),
                items
            };
        } catch (err) {
            logger.error(`Erreur chargement lot ${lot.id}:`, err);
            return { ...lot, items: [] };
        }
    }));

    return lotsWithItems;
}

function authHeaders() {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('workspace_jwt') || ''}`
    };
}

/**
 * Ajoute un item à un lot actif.
 * @param {string|number} lotId
 * @param {object} payload
 * @returns {Promise<object>} item créé
 */
export async function addLotItem(lotId, payload) {
    const serverUrl = api.getServerUrl();
    const response = await fetch(`${serverUrl}/api/lots/${lotId}/items`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload || {})
    });
    if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
            const err = await response.json();
            message = err.message || err.error || message;
        } catch (_) { /* ignore */ }
        throw new Error(message);
    }
    const data = await response.json();
    return data.item || data;
}

/**
 * Soft-supprime un item de lot.
 * @param {string|number} itemId
 * @returns {Promise<object>}
 */
export async function removeLotItem(itemId) {
    const serverUrl = api.getServerUrl();
    const response = await fetch(`${serverUrl}/api/lots/items/${itemId}`, {
        method: 'DELETE',
        headers: authHeaders()
    });
    if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
            const err = await response.json();
            message = err.message || err.error || message;
        } catch (_) { /* ignore */ }
        throw new Error(message);
    }
    return response.json();
}

/**
 * Restaure un item soft-supprimé (undo).
 * @param {string|number} itemId
 * @returns {Promise<object>}
 */
export async function restoreLotItem(itemId) {
    const serverUrl = api.getServerUrl();
    const response = await fetch(`${serverUrl}/api/lots/items/${itemId}/restore`, {
        method: 'POST',
        headers: authHeaders()
    });
    if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
            const err = await response.json();
            message = err.message || err.error || message;
        } catch (_) { /* ignore */ }
        throw new Error(message);
    }
    return response.json();
}
