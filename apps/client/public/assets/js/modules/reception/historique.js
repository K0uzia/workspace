/**
 * HISTORIQUE - MODULE JS
 * Affiche les lots terminés et les sessions disques shreddés (icône PC vs disque)
 */

import api from '../../config/api.js';
import getLogger from '../../config/Logger.js';
import { showAppNotification } from '../../config/notifications.js';
import { loadLotsWithItems } from './lotsApi.js';
import { getSessions, getSession, getSessionPdfUrl, updateSession } from './disquesApi.js';
import { OS_OPTIONS, getOsIcon, getOsLabel, getOsOption } from './osOptions.js';
const logger = getLogger();


const VALUE_AUTRE_DISQUES = '__autre__';
const VALUE_AUTRE_GENERIC = '__autre__';
const LOT_TYPE_OPTIONS = ['', 'portable', 'fixe', 'ecran', 'Autre'];
const DON_TYPE_OPTIONS = ['', 'portable', 'fixe', 'Autre'];

export default class HistoriqueManager {
    constructor(modalManager) {
        this.modalManager = modalManager;
        this.lots = [];
        this.sessionsDisques = [];
        this.commandes = [];
        this.dons = [];
        this.prets = [];
        this.marques = [];
        this.modeles = [];
        this.init();
    }

    async init() {
        logger.debug('🚀 Initialisation HistoriqueManager');
        await this.loadData();
        this.setupEventListeners();
        logger.debug('✅ HistoriqueManager prêt');
    }

    /**
     * Charger lots terminés + sessions disques + commandes + dons
     */
    async loadData() {
        try {
            const serverUrl = api.getServerUrl();
            const headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('workspace_jwt') || ''}`
            };
            const endpointCommandes = (window.SERVER_CONFIG?.getEndpoint?.('commandes.tracabilite')) || '/api/commandes/tracabilite';
            const endpointDons = (window.SERVER_CONFIG?.getEndpoint?.('dons.tracabilite')) || '/api/dons/tracabilite';
            const endpointPrets = (window.SERVER_CONFIG?.getEndpoint?.('pretsMateriel.tracabilite')) || '/api/prets-materiel/tracabilite';

            const [lots, sessions, commandesRes, donsRes, pretsRes] = await Promise.all([
                loadLotsWithItems({ status: 'finished' }),
                getSessions().catch(() => []),
                fetch(`${serverUrl}${endpointCommandes.startsWith('/') ? endpointCommandes : '/' + endpointCommandes}`, { method: 'GET', headers }).catch(() => ({ ok: false })),
                fetch(`${serverUrl}${endpointDons.startsWith('/') ? endpointDons : '/' + endpointDons}`, { method: 'GET', headers }).catch(() => ({ ok: false })),
                fetch(`${serverUrl}${endpointPrets.startsWith('/') ? endpointPrets : '/' + endpointPrets}`, { method: 'GET', headers }).catch(() => ({ ok: false }))
            ]);
            this.lots = (lots || []).sort((a, b) =>
                new Date(b.finished_at || b.created_at) - new Date(a.finished_at || a.created_at)
            );
            this.sessionsDisques = (sessions || []).sort((a, b) => {
                const da = a.date || (a.created_at || '').slice(0, 10);
                const db = b.date || (b.created_at || '').slice(0, 10);
                return new Date(db) - new Date(da);
            });

            if (commandesRes.ok) {
                try {
                    const data = await commandesRes.json();
                    this.commandes = this.extractListFromApiPayload(data, ['commandes', 'items', 'data', 'results', 'rows']);
                    this.commandes = this.commandes.map((c) => ({
                        ...c,
                        lines: this.extractCommandeLinesFromRecord(c)
                    }));
                    this.commandes.sort((a, b) => this.parseFlexibleDate(b.date || b.created_at) - this.parseFlexibleDate(a.date || a.created_at));
                } catch (_) { this.commandes = []; }
            } else {
                this.commandes = [];
            }

            if (donsRes.ok) {
                try {
                    const data = await donsRes.json();
                    this.dons = this.extractListFromApiPayload(data, ['dons', 'items', 'data', 'results', 'rows']);
                    this.dons = this.dons.map((d) => ({
                        ...d,
                        lines: this.extractDonLinesFromRecord(d)
                    }));
                    this.dons.sort((a, b) => this.parseFlexibleDate(b.date || b.created_at) - this.parseFlexibleDate(a.date || a.created_at));
                } catch (_) { this.dons = []; }
            } else {
                this.dons = [];
            }

            if (pretsRes.ok) {
                try {
                    const data = await pretsRes.json();
                    this.prets = this.extractListFromApiPayload(data, [
                        'prets', 'prets_materiel', 'pret_materiels', 'pretMateriels',
                        'items', 'data', 'results', 'rows'
                    ]);
                    this.prets = this.prets.map((p) => ({
                        ...p,
                        lines: this.extractPretLinesFromRecord(p)
                    }));
                    this.prets.sort((a, b) => this.parseFlexibleDate(this.getPretSortDateHist(b)) - this.parseFlexibleDate(this.getPretSortDateHist(a)));
                } catch (_) { this.prets = []; }
            } else {
                this.prets = [];
            }

            logger.info('📦 Historique : ' + this.lots.length + ' lot(s), ' + this.sessionsDisques.length + ' session(s) disques, ' + this.commandes.length + ' commande(s), ' + this.dons.length + ' don(s), ' + this.prets.length + ' prêt(s)');
            this.renderLots();
        } catch (error) {
            logger.error('❌ Erreur chargement historique:', error);
            this.lots = [];
            this.sessionsDisques = [];
            this.commandes = [];
            this.dons = [];
            this.prets = [];
            this.renderLotsError(error);
        }
    }

    getPretSortDateHist(p) {
        if (!p || typeof p !== 'object') return '';
        const d = p.date_debut || p.date || p.created_at || '';
        return String(d).trim().slice(0, 10);
    }

    extractPretLinesFromRecord(obj) {
        if (!obj || typeof obj !== 'object') return [];
        const keys = ['lines', 'lignes', 'items', 'pret_lignes', 'pretLignes', 'pret_lines'];
        for (const k of keys) {
            const arr = this.parseLinesArray(obj[k]);
            if (arr.length > 0) return arr;
        }
        return [];
    }

    pretLineTypeDisplayHist(line) {
        if (!line || typeof line !== 'object') return '-';
        if (line.typeDisplay) return String(line.typeDisplay).trim();
        const labels = { pc: 'PC', ecran: 'Écran', clavier: 'Clavier', souris: 'Souris', autres: 'Autres' };
        const t = String(line.type || '').toLowerCase();
        const detail = String(
            line.type_detail
            || [line.marque, line.modele].filter((x) => String(x || '').trim()).join(' · ')
            || line.marque
            || line.designation
            || ''
        ).trim();
        if (t === 'autres' && detail) return detail;
        return labels[t] || String(line.type || '-').trim() || '-';
    }

    /**
     * Afficher un bloc d'erreur avec bouton Réessayer
     */
    renderLotsError(error) {
        const container = document.getElementById('historique-list');
        if (!container) return;
        const message = error && error.message ? error.message : 'Erreur inconnue';
        container.innerHTML = `
            <div class="empty-state error-state">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <p>Erreur de chargement</p>
                <small>${String(message).replace(/</g, '&lt;')}</small>
                <button type="button" class="btn-retry-lots" id="btn-retry-lots-historique">
                    <i class="fa-solid fa-sync"></i> Réessayer
                </button>
            </div>
        `;
        const btn = document.getElementById('btn-retry-lots-historique');
        if (btn) btn.addEventListener('click', () => this.loadData());
    }

    /**
     * Afficher les lots + sessions disques (fusionnés, triés par date)
     */
    renderLots() {
        const container = document.getElementById('historique-list');
        if (!container) return;

        const searchText = (document.getElementById('filter-search-historique')?.value || '').trim().toLowerCase();
        const typeFilter = (document.getElementById('filter-type-historique')?.value || 'tous').trim();

        const merged = [
            ...this.lots.map(lot => ({ type: 'lot', date: lot.finished_at || lot.created_at, item: lot })),
            ...this.sessionsDisques.map(s => ({ type: 'disque', date: s.date || (s.created_at || '').slice(0, 10), item: s })),
            ...this.dons.map(d => ({ type: 'don', date: d.date || (d.created_at || '').slice(0, 10), item: d })),
            ...this.prets.map(p => ({ type: 'pret', date: this.getPretSortDateHist(p) || (p.created_at || '').slice(0, 10), item: p })),
            ...this.commandes.map(c => ({ type: 'commande', date: c.date || (c.created_at || '').slice(0, 10), item: c }))
        ].sort((a, b) => this.parseFlexibleDate(b.date) - this.parseFlexibleDate(a.date));

        let toRender = merged.filter(({ type }) => typeFilter === 'tous' || type === typeFilter);
        if (searchText) {
            toRender = toRender.filter(({ type, item }) => {
                // Recherche sur le texte affiché dans le titre (h3) de la carte
                if (type === 'lot') {
                    const id = String(item.id || '');
                    const lotName = String(item.lot_name || item.name || '').trim();
                    const titleText = ('Lot #' + id + (lotName ? ' | ' + lotName : '')).toLowerCase();
                    return titleText.includes(searchText);
                }
                if (type === 'disque') {
                    const name = (item.name || '').trim() || 'Lot disques';
                    const titleText = name.toLowerCase();
                    return titleText.includes(searchText);
                }
                if (type === 'don') {
                    const lotName = String(item.lot_name || item.name || '').trim();
                    const stagiaire = String(item.stagiaire_afpa || item.stagiaire || '').trim();
                    const titleText = (`don ${lotName} ${stagiaire}`).toLowerCase();
                    return titleText.includes(searchText);
                }
                if (type === 'commande') {
                    const name = String(item.commande_name || item.name || '').trim();
                    const category = String(item.category || '').trim();
                    const titleText = (`commande ${name} ${category}`).toLowerCase();
                    return titleText.includes(searchText);
                }
                if (type === 'pret') {
                    const ref = String(item.reference || item.title || item.lot_name || item.name || '').trim();
                    const borrower = String(item.borrower_name || item.emprunteur || '').trim();
                    const titleText = (`prêt ${ref} ${borrower}`).toLowerCase();
                    return titleText.includes(searchText);
                }
                return false;
            });
        }

        if (toRender.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fa-solid fa-inbox"></i>
                    <p>${merged.length === 0 ? 'Aucun élément' : 'Aucun résultat'}</p>
                    <small>${merged.length === 0 ? 'Lots, disques, dons, prêts matériel et commandes apparaîtront ici' : 'Modifiez la recherche ou le filtre type'}</small>
                </div>
            `;
            return;
        }

        container.innerHTML = toRender.map(({ type, item }) => {
            if (type === 'lot') return this.createLotElement(item);
            if (type === 'disque') return this.createDisqueElement(item);
            if (type === 'don') return this.createDonElement(item);
            if (type === 'pret') return this.createPretElement(item);
            return this.createCommandeElement(item);
        }).join('');
        this.attachLotEventListeners();
    }

    createDonElement(don) {
        const lotName = (don.lot_name || don.name || '').trim();
        const dateFormatted = this.formatDateDDMMYYYY(don.date || (don.created_at || '').slice(0, 10));
        const stagiaireFromLines = Array.isArray(don.lines)
            ? (don.lines.map(l => String(l?.stagiaire || '').trim()).find(Boolean) || '')
            : '';
        const stagiaire = (don.stagiaire_afpa || don.stagiaire || stagiaireFromLines || '').trim() || '-';
        const title = lotName ? `Don | ${this.escapeHtml(lotName)}` : `Don #${this.escapeHtml(String(don.id || ''))}`;
        return `
            <div class="historique-lot-card historique-don-card" data-type="don" data-don-id="${this.escapeHtml(String(don.id || ''))}">
                <div class="historique-lot-header">
                    <div class="historique-lot-title">
                        <h3><i class="fa-solid fa-hand-holding-heart historique-type-icon" aria-hidden="true"></i> ${title}</h3>
                        <span class="badge-created">Créé le ${this.escapeHtml(dateFormatted)}</span>
                    </div>
                    <div class="historique-lot-stats">
                        <span class="historique-stat"><i class="fa-solid fa-user-graduate" aria-hidden="true"></i> ${this.escapeHtml(stagiaire)}</span>
                    </div>
                    <div class="historique-lot-actions">
                        <button type="button" class="btn-view-don-details-hist" data-don-id="${this.escapeHtml(String(don.id || ''))}" title="Voir les détails du don">
                            <i class="fa-solid fa-eye" aria-hidden="true"></i> Voir détails
                        </button>
                        <button type="button" class="btn-edit-don-name-hist" data-don-id="${this.escapeHtml(String(don.id || ''))}" title="Éditer le nom du don">
                            <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i> Éditer nom
                        </button>
                        <button type="button" class="btn-edit-don-items-hist" data-don-id="${this.escapeHtml(String(don.id || ''))}" title="Éditer le matériel du don">
                            <i class="fa-solid fa-list-check" aria-hidden="true"></i> Éditer matériel
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    createPretElement(pret) {
        const ref = (pret.reference || pret.title || pret.lot_name || pret.name || '').trim();
        const dateFormatted = this.formatDateDDMMYYYY(this.getPretSortDateHist(pret) || (pret.created_at || '').slice(0, 10));
        const borrower = String(pret.borrower_name || pret.emprunteur || '-').trim() || '-';
        const title = ref ? `Prêt | ${this.escapeHtml(ref)}` : `Prêt #${this.escapeHtml(String(pret.id || ''))}`;
        return `
            <div class="historique-lot-card historique-pret-card" data-type="pret" data-pret-id="${this.escapeHtml(String(pret.id || ''))}">
                <div class="historique-lot-header">
                    <div class="historique-lot-title">
                        <h3><i class="fa-solid fa-handshake historique-type-icon" aria-hidden="true"></i> ${title}</h3>
                        <span class="badge-created">Créé le ${this.escapeHtml(dateFormatted)}</span>
                    </div>
                    <div class="historique-lot-stats">
                        <span class="historique-stat"><i class="fa-solid fa-user" aria-hidden="true"></i> ${this.escapeHtml(borrower)}</span>
                    </div>
                    <div class="historique-lot-actions">
                        <button type="button" class="btn-view-pret-details-hist" data-pret-id="${this.escapeHtml(String(pret.id || ''))}" title="Voir les détails du prêt">
                            <i class="fa-solid fa-eye" aria-hidden="true"></i> Voir détails
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    createCommandeElement(commande) {
        const name = (commande.commande_name || commande.name || '').trim() || 'Commande';
        const dateFormatted = this.formatDateDDMMYYYY(commande.date || (commande.created_at || '').slice(0, 10));
        const category = (commande.category || '').trim() || '-';
        const lineCount = Array.isArray(commande.lines) ? commande.lines.length : (commande.line_count ?? 0);
        return `
            <div class="historique-lot-card historique-commande-card" data-type="commande" data-commande-id="${this.escapeHtml(String(commande.id || ''))}">
                <div class="historique-lot-header">
                    <div class="historique-lot-title">
                        <h3><i class="fa-solid fa-file-invoice historique-type-icon" aria-hidden="true"></i> ${this.escapeHtml(name)}</h3>
                        <span class="badge-created">Créé le ${this.escapeHtml(dateFormatted)}</span>
                    </div>
                    <div class="historique-lot-stats">
                        <span class="historique-stat"><i class="fa-solid fa-tag" aria-hidden="true"></i> ${this.escapeHtml(category)}</span>
                        <span class="historique-stat"><strong>${lineCount}</strong> produit(s)</span>
                    </div>
                    <div class="historique-lot-actions">
                        <button type="button" class="btn-view-commande-details-hist" data-commande-id="${this.escapeHtml(String(commande.id || ''))}" title="Voir les détails de la commande">
                            <i class="fa-solid fa-eye" aria-hidden="true"></i> Voir détails
                        </button>
                        <button type="button" class="btn-edit-commande-name-hist" data-commande-id="${this.escapeHtml(String(commande.id || ''))}" title="Éditer le nom et la catégorie">
                            <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i> Éditer nom
                        </button>
                        <button type="button" class="btn-edit-commande-items-hist" data-commande-id="${this.escapeHtml(String(commande.id || ''))}" title="Éditer le matériel de la commande">
                            <i class="fa-solid fa-list-check" aria-hidden="true"></i> Éditer matériel
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Créer un élément de lot
     */
    createLotElement(lot) {
        const total = lot.total || 0;
        const recond = lot.recond || 0;
        const hs = lot.hs || 0;
        
        // Déterminer le statut de récupération
        // Vérifier null, undefined, ou chaîne vide
        const isRecovered = lot.recovered_at != null && lot.recovered_at !== '';
        const recoveryBadgeClass = isRecovered ? 'badge-recovered' : 'badge-to-recover';
        const recoveryBadgeText = isRecovered 
            ? `Récupéré le ${this.formatDateTime(lot.recovered_at)}` 
            : 'À récupérer';
        
        // Vérifier si le lot peut être récupéré (tous les items doivent avoir un état et un technicien)
        const items = Array.isArray(lot.items) ? lot.items : [];
        const totalItems = lot.total !== undefined ? lot.total : items.length;
        
        // Calculer pending si non fourni
        let pending = lot.pending !== undefined ? lot.pending : 0;
        if (pending === 0 && items.length > 0) {
            // Un item est "pending" s'il n'a pas d'état défini OU pas de technicien
            pending = items.filter(item => 
                !item.state || item.state.trim() === '' || 
                !item.technician || item.technician.trim() === ''
            ).length;
        }
        
        // Le lot peut être récupéré uniquement si tous les items ont état + technicien
        const isFinishedFromItems = total > 0 && pending === 0 && items.length > 0 && items.every(item => 
            item.state && item.state.trim() !== '' && 
            item.technician && item.technician.trim() !== ''
        );
        const canRecover = isFinishedFromItems;
        
        logger.debug(`Lot ${lot.id} - canRecover:`, { 
            canRecover, 
            total, 
            pending, 
            itemsCount: items.length,
            finished_at: lot.finished_at,
            status: lot.status,
            items: items.map(item => ({ id: item.id, state: item.state, technician: item.technician }))
        });
        const recoveryButtonClass = isRecovered ? 'btn-recovered' : (canRecover ? 'btn-to-recover' : 'btn-to-recover disabled');
        const recoveryButtonText = isRecovered ? '✓ Récupéré' : (canRecover ? 'Récupérer' : 'Récupérer (incomplet)');
        const recoveryButtonDisabled = isRecovered || !canRecover;

        return `
            <div class="historique-lot-card" data-type="lot" data-lot-id="${lot.id}">
                <div class="historique-lot-header">
                    <div class="historique-lot-title">
                        <h3><i class="fa-solid fa-desktop historique-type-icon" aria-hidden="true"></i> Lot #${lot.id}${lot.lot_name ? ' | ' + this.escapeHtml(lot.lot_name) : ''}</h3>
                        <span class="${recoveryBadgeClass}">${recoveryBadgeText}</span>
                        <span class="badge-created">Terminé le ${this.formatDate(lot.finished_at)}</span>
                    </div>
                    <div class="historique-lot-stats">
                        <span class="historique-stat">
                            <i class="fa-solid fa-check-circle"></i>
                            <strong>${recond}</strong> reconditionnés
                        </span>
                        <span class="historique-stat">
                            <i class="fa-solid fa-exclamation-circle"></i>
                            <strong>${hs}</strong> HS
                        </span>
                        <span class="historique-stat">
                            <strong>${total}</strong> total
                        </span>
                    </div>
                    <div class="historique-lot-actions">
                        <button type="button" class="btn-view-details" data-lot-id="${lot.id}" title="Afficher les détails du lot (PC, états, techniciens)">
                            <i class="fa-solid fa-eye" aria-hidden="true"></i> Voir détails
                        </button>
                        <button type="button" class="btn-edit-lot" data-lot-id="${lot.id}" title="Modifier le nom du lot">
                            <i class="fa-solid fa-edit" aria-hidden="true"></i> Éditer nom
                        </button>
                        <button type="button" class="btn-edit-items" data-lot-id="${lot.id}" title="Modifier le matériel (état, technicien par PC)">
                            <i class="fa-solid fa-list-check" aria-hidden="true"></i> Éditer matériel
                        </button>
                        <button type="button" class="btn-regenerate-lot-pdf" data-lot-id="${lot.id}" title="Régénérer le PDF avec les données actuelles">
                            <i class="fa-solid fa-file-pdf" aria-hidden="true"></i> Régénérer PDF
                        </button>
                        <button type="button" class="${recoveryButtonClass}" data-lot-id="${lot.id}" ${recoveryButtonDisabled ? 'disabled' : ''} title="${!canRecover && !isRecovered ? 'Tous les items doivent avoir un état et un technicien' : 'Marquer le lot comme récupéré'}">
                            ${recoveryButtonText}
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Formater une date en DD/MM/AAAA (sans heure)
     */
    formatDateDDMMYYYY(dateStr) {
        if (!dateStr) return '-';
        const d = this.parseFlexibleDate(dateStr);
        if (isNaN(d.getTime())) return '-';
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        return `${day}/${month}/${year}`;
    }

    parseFlexibleDate(raw) {
        const value = String(raw || '').trim();
        if (!value) return new Date(0);
        if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
            const d = new Date(value.slice(0, 10));
            if (!Number.isNaN(d.getTime())) return d;
        }
        const fr = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (fr) {
            const [, dd, mm, yyyy] = fr;
            const d = new Date(`${yyyy}-${mm}-${dd}`);
            if (!Number.isNaN(d.getTime())) return d;
        }
        const fallback = new Date(value);
        return Number.isNaN(fallback.getTime()) ? new Date(0) : fallback;
    }

    extractListFromApiPayload(payload, keys = []) {
        if (Array.isArray(payload)) return payload;
        if (!payload || typeof payload !== 'object') return [];
        for (const key of keys) {
            if (Array.isArray(payload[key])) return payload[key];
        }
        if (payload.data && typeof payload.data === 'object') {
            for (const key of keys) {
                if (Array.isArray(payload.data[key])) return payload.data[key];
            }
            if (Array.isArray(payload.data)) return payload.data;
        }
        return [];
    }

    parseLinesArray(rawLines) {
        if (Array.isArray(rawLines)) return rawLines;
        if (rawLines == null) return [];
        if (typeof rawLines === 'object') {
            if (Array.isArray(rawLines.lines)) return rawLines.lines;
            if (Array.isArray(rawLines.lignes)) return rawLines.lignes;
            if (Array.isArray(rawLines.items)) return rawLines.items;
            if (Array.isArray(rawLines.commande_lignes)) return rawLines.commande_lignes;
            if (Array.isArray(rawLines.commandeLignes)) return rawLines.commandeLignes;
            if (Array.isArray(rawLines.data)) return rawLines.data;
            if (Array.isArray(rawLines.results)) return rawLines.results;
            return [];
        }
        if (typeof rawLines === 'string') {
            try {
                const parsed = JSON.parse(rawLines);
                if (Array.isArray(parsed)) return parsed;
                if (parsed && typeof parsed === 'object') {
                    if (Array.isArray(parsed.lines)) return parsed.lines;
                    if (Array.isArray(parsed.lignes)) return parsed.lignes;
                    if (Array.isArray(parsed.items)) return parsed.items;
                    if (Array.isArray(parsed.commande_lignes)) return parsed.commande_lignes;
                    if (Array.isArray(parsed.commandeLignes)) return parsed.commandeLignes;
                    if (Array.isArray(parsed.data)) return parsed.data;
                    if (Array.isArray(parsed.results)) return parsed.results;
                }
                return [];
            } catch (_) {
                return [];
            }
        }
        return [];
    }

    /**
     * Réponse GET détail souvent enveloppée ({ data: { lignes: [...] } }) : évite full.lines vide.
     */
    unwrapDetailRecord(data) {
        if (!data || typeof data !== 'object') return data;
        const nestedKeys = ['commande', 'don', 'pret', 'pret_materiel', 'item', 'record', 'result', 'body'];
        for (const k of nestedKeys) {
            const v = data[k];
            if (v && typeof v === 'object' && !Array.isArray(v)) return v;
        }
        if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) return data.data;
        return data;
    }

    extractCommandeLinesFromRecord(obj) {
        if (!obj || typeof obj !== 'object') return [];
        const keys = ['lines', 'lignes', 'items', 'commande_lignes', 'commandeLignes', 'commande_lines', 'lignes_commande', 'products'];
        for (const k of keys) {
            const arr = this.parseLinesArray(obj[k]);
            if (arr.length > 0) return arr;
        }
        return [];
    }

    extractDonLinesFromRecord(obj) {
        if (!obj || typeof obj !== 'object') return [];
        const keys = ['lines', 'lignes', 'items', 'don_lignes', 'donLignes', 'don_lines'];
        for (const k of keys) {
            const arr = this.parseLinesArray(obj[k]);
            if (arr.length > 0) return arr;
        }
        return [];
    }

    normalizeTypeValue(rawType) {
        const value = String(rawType || '').trim().toLowerCase();
        if (!value) return '';
        if (value === 'pc portable') return 'portable';
        if (value === 'pc fixe') return 'fixe';
        if (value === 'écran') return 'ecran';
        return value;
    }

    hasAuthToken() {
        const token = String(localStorage.getItem('workspace_jwt') || '').trim();
        return token.length > 20 && token.includes('.');
    }

    resolveDetailEndpoint(kind, id) {
        if (kind === 'commande') {
            const dynamic = window.SERVER_CONFIG?.getEndpoint?.('commandes.get');
            if (dynamic && /:id/.test(dynamic)) return dynamic.replace(':id', String(id));
            return `/api/commandes/${id}`;
        }
        if (kind === 'don') {
            const dynamic = window.SERVER_CONFIG?.getEndpoint?.('dons.get');
            if (dynamic && /:id/.test(dynamic)) return dynamic.replace(':id', String(id));
            return `/api/dons/${id}`;
        }
        if (kind === 'pret') {
            const dynamic = window.SERVER_CONFIG?.getEndpoint?.('pretsMateriel.get');
            if (dynamic && /:id/.test(dynamic)) return dynamic.replace(':id', String(id));
            return `/api/prets-materiel/${id}`;
        }
        return null;
    }

    async loadCommandeProductsReference() {
        if (Array.isArray(this.commandeProductsRef) && this.commandeProductsRef.length) return;
        this.commandeProductsRef = [];
        try {
            const res = await api.get('/api/commandes/products', { useCache: false });
            if (!res.ok) return;
            const data = await res.json();
            const list = this.extractListFromApiPayload(data, ['items', 'products', 'data', 'rows']);
            this.commandeProductsRef = Array.isArray(list) ? list : [];
        } catch (_) { /* noop */ }
    }

    /**
     * Créer un élément de session disques. Nom seul dans le titre, date dans le badge "Créé le". Option « Récupérer » (historique/traçabilité uniquement, pas les PDF).
     */
    createDisqueElement(session) {
        const name = (session.name || '').trim() || 'Lot disques';
        const dateFormatted = this.formatDateDDMMYYYY(session.date || (session.created_at || '').slice(0, 10));
        const count = Array.isArray(session.disks) ? session.disks.length : (session.disk_count ?? 0);
        const isRecovered = session.recovered_at != null && session.recovered_at !== '';
        const recoveryBadgeClass = isRecovered ? 'badge-recovered' : 'badge-to-recover';
        const recoveryBadgeText = isRecovered
            ? `Récupéré le ${this.formatDateTime(session.recovered_at)}`
            : 'À récupérer';
        const recoveryButtonClass = isRecovered ? 'btn-recovered' : 'btn-to-recover btn-to-recover-disque';
        const recoveryButtonText = isRecovered ? '✓ Récupéré' : 'Récupérer';
        return `
            <div class="historique-lot-card historique-disque-card" data-type="disque" data-session-id="${session.id}">
                <div class="historique-lot-header">
                    <div class="historique-lot-title">
                        <h3><i class="fa-solid fa-hard-drive historique-type-icon" aria-hidden="true"></i> ${this.escapeHtml(name)}</h3>
                        <span class="${recoveryBadgeClass}">${recoveryBadgeText}</span>
                        <span class="badge-created">Créé le ${this.escapeHtml(dateFormatted)}</span>
                    </div>
                    <div class="historique-lot-stats">
                        <span class="historique-stat"><i class="fa-solid fa-hard-drive" aria-hidden="true"></i> <strong>${count}</strong> disque(s)</span>
                    </div>
                    <div class="historique-lot-actions">
                        <button type="button" class="btn-view-details btn-view-disque" data-session-id="${session.id}" title="Afficher la liste des disques de cette session">
                            <i class="fa-solid fa-eye" aria-hidden="true"></i> Voir détails
                        </button>
                        <button type="button" class="btn-edit-disque-name" data-session-id="${session.id}" title="Modifier le nom de la session">
                            <i class="fa-solid fa-edit" aria-hidden="true"></i> Éditer le nom
                        </button>
                        <button type="button" class="btn-edit-disque-items" data-session-id="${session.id}" title="Modifier S/N, marque, modèle des disques">
                            <i class="fa-solid fa-list-check" aria-hidden="true"></i> Éditer matériel
                        </button>
                        <button type="button" class="${recoveryButtonClass}" data-session-id="${session.id}" ${isRecovered ? 'disabled' : ''} title="Marquer comme récupéré (traçabilité uniquement, pas les PDF)">
                            ${recoveryButtonText}
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    escapeHtml(s) {
        const div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }

    escapeAttr(s) {
        return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    /**
     * Lien modal commande : libellé = domaine (sans www), href = URL complète, title = texte brut (comme le PDF).
     */
    linkCellHtmlForCommandeModal(raw) {
        const s = String(raw ?? '').trim();
        if (!s || s === '-') return '—';
        if (/^mailto:/i.test(s)) {
            try {
                const u = new URL(s);
                const path = decodeURIComponent((u.pathname || '').replace(/^\//, ''));
                const at = path.indexOf('@');
                const label = at > 0 ? path.slice(at + 1).split('?')[0] : path;
                return `<a href="${this.escapeAttr(s)}" class="hist-cmd-link-modal" title="${this.escapeAttr(s)}">${this.escapeHtml(label || '—')}</a>`;
            } catch {
                /* fallthrough */
            }
        }
        let href = s;
        if (!/^https?:\/\//i.test(href) && !/^mailto:/i.test(href) && !/^tel:/i.test(href)) {
            if (/^\/\//.test(href)) href = `https:${href}`;
            else if (/[a-z0-9.-]+\.[a-z]{2,}/i.test(href)) href = `https://${href}`;
        }
        try {
            const u = new URL(href);
            const label = (u.hostname || '').replace(/^www\./i, '') || u.hostname || '—';
            return `<a href="${this.escapeAttr(u.href)}" target="_blank" rel="noopener noreferrer" class="hist-cmd-link-modal" title="${this.escapeAttr(s)}">${this.escapeHtml(label)}</a>`;
        } catch {
            const short = s.length > 48 ? `${s.slice(0, 45)}…` : s;
            return `<span class="hist-cmd-link-muted" title="${this.escapeAttr(s)}">${this.escapeHtml(short)}</span>`;
        }
    }

    /**
     * Attacher les événements aux lots et sessions disques
     */
    attachLotEventListeners() {
        document.querySelectorAll('.btn-view-details[data-lot-id]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const lotId = btn.dataset.lotId;
                this.viewLotDetails(lotId);
            });
        });

        document.querySelectorAll('.btn-edit-lot').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const lotId = btn.dataset.lotId;
                this.editLotName(lotId);
            });
        });

        document.querySelectorAll('.btn-edit-items').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const lotId = btn.dataset.lotId;
                this.editLotItems(lotId);
            });
        });

        document.querySelectorAll('.btn-regenerate-lot-pdf').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.regenerateLotPdf(btn.dataset.lotId);
            });
        });

        document.querySelectorAll('.btn-to-recover').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const lotId = btn.dataset.lotId;
                this.markAsRecovered(lotId);
            });
        });

        document.querySelectorAll('.btn-view-disque').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const sessionId = btn.dataset.sessionId;
                this.viewDisqueSessionDetails(sessionId);
            });
        });

        document.querySelectorAll('.btn-edit-disque-name').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.editDisqueSessionName(btn.dataset.sessionId);
            });
        });

        document.querySelectorAll('.btn-edit-disque-items').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.editDisqueItems(btn.dataset.sessionId);
            });
        });

        document.querySelectorAll('.btn-to-recover-disque').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const sessionId = btn.dataset.sessionId;
                this.markDisqueSessionAsRecovered(sessionId);
            });
        });

        document.querySelectorAll('.btn-view-commande-details-hist').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.viewCommandeDetails(btn.dataset.commandeId);
            });
        });
        document.querySelectorAll('.btn-edit-commande-name-hist').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.editCommandeFromHistorique(btn.dataset.commandeId);
            });
        });
        document.querySelectorAll('.btn-edit-commande-items-hist').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                this.editCommandeItemsFromHistorique(btn.dataset.commandeId);
            });
        });
        document.querySelectorAll('.btn-view-don-details-hist').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.viewDonDetails(btn.dataset.donId);
            });
        });
        document.querySelectorAll('.btn-edit-don-name-hist').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.editDonFromHistorique(btn.dataset.donId);
            });
        });
        document.querySelectorAll('.btn-edit-don-items-hist').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                this.editDonItemsFromHistorique(btn.dataset.donId);
            });
        });
        document.querySelectorAll('.btn-view-pret-details-hist').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.viewPretDetails(btn.dataset.pretId);
            });
        });
    }

    async editCommandeFromHistorique(commandeId) {
        const commande = this.commandes.find(c => String(c.id) === String(commandeId));
        if (!commande) return;
        this.currentEditingCommandeId = String(commandeId);
        const nameInput = document.getElementById('input-commande-name-hist');
        const catInput = document.getElementById('input-commande-category-hist');
        if (nameInput) nameInput.value = String(commande.commande_name || commande.name || '').trim();
        if (catInput) catInput.value = String(commande.category || '').trim();
        this.modalManager.open('modal-edit-commande-hist');
    }

    async saveCommandeFromHistorique() {
        const commandeId = this.currentEditingCommandeId;
        if (!commandeId) return;
        const nameInput = document.getElementById('input-commande-name-hist');
        const catInput = document.getElementById('input-commande-category-hist');
        const newName = String(nameInput?.value || '').trim();
        const newCategory = String(catInput?.value || '').trim();
        if (!newName) {
            this.showNotification('Le nom de la commande est obligatoire', 'warning');
            return;
        }
        try {
            const res = await api.put(`/api/commandes/${commandeId}`, {
                commande_name: newName,
                category: newCategory
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await this.loadData();
            this.modalManager.close('modal-edit-commande-hist');
            this.showNotification('Commande mise à jour', 'success');
        } catch (err) {
            this.showNotification(err?.message || 'Édition impossible', 'error');
        }
    }

    async editCommandeItemsFromHistorique(commandeId) {
        let commande = this.commandes.find(c => String(c.id) === String(commandeId));
        if (!commande) return;
        let lines = this.extractCommandeLinesFromRecord(commande);
        const endpoint = this.resolveDetailEndpoint('commande', commandeId);
        if (endpoint) {
            try {
                const res = await api.get(endpoint, { useCache: false });
                if (res.ok) {
                    const data = await res.json();
                    const full = this.unwrapDetailRecord(data);
                    if (full && typeof full === 'object' && !Array.isArray(full)) {
                        commande = { ...commande, ...full };
                        lines = this.extractCommandeLinesFromRecord(commande);
                    }
                }
            } catch (_) { /* noop */ }
        }
        await this.loadCommandeProductsReference();
        this.currentEditingCommandeId = String(commandeId);
        const tbody = document.getElementById('modal-edit-commande-items-body');
        if (!tbody) return;
        if (lines.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6">Aucune ligne disponible</td></tr>`;
        } else {
            tbody.innerHTML = lines.map((line, idx) => `
                <tr data-line-index="${idx}">
                    <td>${idx + 1}</td>
                    <td>
                        <select class="hist-cmd-product-select">
                            ${(() => {
                        const val = String(line?.product_name || line?.product_name_ref || line?.produit || '').trim();
                                const names = (this.commandeProductsRef || []).map(p => String(p?.name || '').trim()).filter(Boolean);
                                const isKnown = val && names.includes(val);
                                return '<option value="">-- Produit --</option>'
                                    + names.map(n => `<option value="${this.escapeAttr(n)}" ${val === n ? 'selected' : ''}>${this.escapeHtml(n)}</option>`).join('')
                                    + `<option value="${VALUE_AUTRE_GENERIC}" ${val && !isKnown ? 'selected' : ''}>Autre</option>`;
                            })()}
                        </select>
                        <input type="text" class="hist-cmd-product-other" value="${this.escapeAttr(String(line?.product_name || line?.product_name_ref || line?.produit || ''))}" placeholder="Produit libre" style="margin-top:6px;display:${(() => {
                            const val = String(line?.product_name || line?.product_name_ref || line?.produit || '').trim();
                            const names = (this.commandeProductsRef || []).map(p => String(p?.name || '').trim()).filter(Boolean);
                            return val && !names.includes(val) ? 'block' : 'none';
                        })()};">
                    </td>
                    <td><input type="number" class="hist-cmd-quantity" min="0" step="1" value="${this.escapeAttr(String(line?.quantity ?? ''))}" placeholder="Qté"></td>
                    <td><input type="number" class="hist-cmd-price" min="0" step="0.01" value="${this.escapeAttr(String(line?.unit_price ?? line?.price ?? ''))}" placeholder="Prix"></td>
                    <td><input type="number" class="hist-cmd-shipping" min="0" step="0.01" value="${this.escapeAttr(String(line?.shipping_cost ?? line?.shipping ?? ''))}" placeholder="Port"></td>
                    <td><input type="text" class="hist-cmd-link" value="${this.escapeAttr(String(line?.link || line?.lien || line?.url || ''))}" placeholder="Lien"></td>
                </tr>
            `).join('');
            tbody.querySelectorAll('.hist-cmd-product-select').forEach((sel) => {
                sel.addEventListener('change', () => {
                    const row = sel.closest('tr');
                    const otherInput = row?.querySelector('.hist-cmd-product-other');
                    if (!otherInput) return;
                    const isOther = sel.value === VALUE_AUTRE_GENERIC;
                    otherInput.style.display = isOther ? 'block' : 'none';
                    if (!isOther) otherInput.value = sel.value || '';
                });
            });
        }
        this.modalManager.open('modal-edit-commande-items-hist');
    }

    async saveCommandeItemsFromHistorique() {
        const commandeId = this.currentEditingCommandeId;
        if (!commandeId) return;
        const rows = Array.from(document.querySelectorAll('#modal-edit-commande-items-body tr[data-line-index]'));
        const lines = rows.map((row) => {
            const productSel = row.querySelector('.hist-cmd-product-select');
            const productOther = row.querySelector('.hist-cmd-product-other');
            const productName = productSel?.value === VALUE_AUTRE_GENERIC
                ? String(productOther?.value || '').trim()
                : String(productSel?.value || '').trim();
            return {
            product_name: productName || null,
            quantity: Number(row.querySelector('.hist-cmd-quantity')?.value || 0) || 0,
            price: String(row.querySelector('.hist-cmd-price')?.value || '').trim(),
            shipping: String(row.querySelector('.hist-cmd-shipping')?.value || '').trim(),
            link: String(row.querySelector('.hist-cmd-link')?.value || '').trim() || null
        };});
        try {
            const res = await api.put(`/api/commandes/${commandeId}`, { lines });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await this.loadData();
            this.modalManager.close('modal-edit-commande-items-hist');
            this.showNotification('Matériel commande mis à jour', 'success');
        } catch (err) {
            this.showNotification(err?.message || 'Édition impossible', 'error');
        }
    }

    async viewCommandeDetails(commandeId) {
        let commande = this.commandes.find(c => String(c.id) === String(commandeId));
        if (!commande) return;
        let lines = this.extractCommandeLinesFromRecord(commande);
        const endpoint = this.resolveDetailEndpoint('commande', commandeId);
        if (endpoint) {
            try {
                const res = await api.get(endpoint, { useCache: false });
                if (res.ok) {
                    const data = await res.json();
                    const full = this.unwrapDetailRecord(data);
                    if (full && typeof full === 'object' && !Array.isArray(full)) {
                        commande = { ...commande, ...full };
                        lines = this.extractCommandeLinesFromRecord(commande);
                    }
                }
            } catch (_) { /* on garde la version de base */ }
        }
        const idxCmd = this.commandes.findIndex(c => String(c.id) === String(commandeId));
        if (idxCmd >= 0) this.commandes[idxCmd] = { ...this.commandes[idxCmd], ...commande, lines };
        const linesCount = lines.length > 0 ? lines.length : (commande.line_count ?? 0);
        const setText = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };
        setText('modal-commande-title', String(commande.commande_name || commande.name || 'Commande'));
        setText('modal-commande-date', this.formatDateDDMMYYYY(commande.date || commande.created_at));
        setText('modal-commande-category', String(commande.category || '-'));
        setText('modal-commande-products', String(linesCount));
        const tbody = document.getElementById('modal-commande-lines');
        if (tbody) {
            if (lines.length === 0) {
                tbody.innerHTML = `<tr><td colspan="6">Aucun détail produit disponible</td></tr>`;
            } else {
                tbody.innerHTML = lines.map((line, idx) => `
                    <tr>
                        <td>${idx + 1}</td>
                        <td class="hist-cmd-product-td"><span class="hist-cmd-produit-line">${this.escapeHtml(String(line?.product_name || line?.product_name_ref || line?.produit || '-'))}</span></td>
                        <td>${this.escapeHtml(String(line?.quantity ?? '-'))}</td>
                        <td>${this.escapeHtml(String(line?.unit_price ?? line?.price ?? '-'))}</td>
                        <td>${this.escapeHtml(String(line?.shipping_cost ?? line?.shipping ?? '-'))}</td>
                        <td class="hist-cmd-link-td">${this.linkCellHtmlForCommandeModal(line?.link || line?.lien || line?.url || '')}</td>
                    </tr>
                `).join('');
            }
        }
        this.modalManager.open('modal-commande-details');
    }

    async viewDonDetails(donId) {
        let don = this.dons.find(d => String(d.id) === String(donId));
        if (!don) return;
        let lines = this.extractDonLinesFromRecord(don);
        const endpoint = this.resolveDetailEndpoint('don', donId);
        if (endpoint) {
            try {
                const res = await api.get(endpoint, { useCache: false });
                if (res.ok) {
                    const data = await res.json();
                    const full = this.unwrapDetailRecord(data);
                    if (full && typeof full === 'object' && !Array.isArray(full)) {
                        don = { ...don, ...full };
                        lines = this.extractDonLinesFromRecord(don);
                    }
                }
            } catch (_) { /* on garde la version de base */ }
        }
        const linesCount = lines.length;
        const stagiaireFromLines = Array.isArray(lines)
            ? (lines.map(l => String(l?.stagiaire || '').trim()).find(Boolean) || '')
            : '';
        const stagiaire = String(don.stagiaire_afpa || don.stagiaire || stagiaireFromLines || '-');
        const setText = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };
        setText('modal-don-title', String(don.lot_name || don.name || `Don #${don.id || ''}`));
        setText('modal-don-date', this.formatDateDDMMYYYY(don.date || don.created_at));
        setText('modal-don-stagiaire', stagiaire);
        setText('modal-don-lines', String(linesCount));
        const tbody = document.getElementById('modal-don-lines-body');
        if (tbody) {
            if (lines.length === 0) {
                tbody.innerHTML = `<tr><td colspan="7">Aucune ligne de don disponible</td></tr>`;
            } else {
                tbody.innerHTML = lines.map((line, idx) => `
                    <tr>
                        <td>${idx + 1}</td>
                        <td>${this.escapeHtml(String(line?.type || '-'))}</td>
                        <td>${this.escapeHtml(String(line?.marqueName || line?.marque || '-'))}</td>
                        <td>${this.escapeHtml(String(line?.modeleName || line?.modele || '-'))}</td>
                        <td>${this.escapeHtml(String(line?.serialNumber || line?.serial || '-'))}</td>
                        <td>${this.escapeHtml(String(line?.date || '-'))}</td>
                        <td>${this.escapeHtml(String(line?.stagiaire || '-'))}</td>
                    </tr>
                `).join('');
            }
        }
        this.modalManager.open('modal-don-details');
    }

    async viewPretDetails(pretId) {
        let pret = this.prets.find(p => String(p.id) === String(pretId));
        if (!pret) return;
        let lines = this.extractPretLinesFromRecord(pret);
        const endpoint = this.resolveDetailEndpoint('pret', pretId);
        if (endpoint) {
            try {
                const res = await api.get(endpoint, { useCache: false });
                if (res.ok) {
                    const data = await res.json();
                    const full = this.unwrapDetailRecord(data);
                    if (full && typeof full === 'object' && !Array.isArray(full)) {
                        pret = { ...pret, ...full };
                        lines = this.extractPretLinesFromRecord(pret);
                    }
                }
            } catch (_) { /* garde liste */ }
        }
        const idx = this.prets.findIndex(p => String(p.id) === String(pretId));
        if (idx >= 0) this.prets[idx] = { ...this.prets[idx], ...pret, lines };
        const setText = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };
        const ref = String(pret.reference || pret.title || pret.lot_name || pret.name || `Prêt #${pret.id || ''}`);
        const dateDoc = this.formatDateDDMMYYYY(pret.date || this.getPretSortDateHist(pret) || pret.created_at);
        const d0 = this.formatDateDDMMYYYY(pret.date_debut || pret.dateDebut || pret.date || pret.created_at);
        const d1 = this.formatDateDDMMYYYY(pret.date_fin || pret.dateFin || pret.date_debut || pret.date);
        const borrower = String(pret.borrower_name || pret.borrowerName || pret.emprunteur || '-').trim();
        const bt = String(pret.borrower_type || pret.borrowerType || 'personne').toLowerCase() === 'societe' ? 'Société' : 'Personne';
        const rgRaw = pret.remuneration_gratuit ?? pret.remunerationGratuit;
        const gratuit = rgRaw !== false && rgRaw !== 0 && String(rgRaw).toLowerCase() !== 'false';
        const montant = pret.remuneration_montant ?? pret.remunerationMontant;
        const remTxt = gratuit
            ? 'Prêt gratuit'
            : (montant != null && Number.isFinite(Number(montant)) ? `${Number(montant).toFixed(2).replace('.', ',')} €` : '—');
        setText('modal-pret-title', ref);
        setText('modal-pret-date', dateDoc);
        setText('modal-pret-period', `du ${d0} au ${d1}`);
        setText('modal-pret-borrower', `${bt} — ${borrower}`);
        setText('modal-pret-remuneration', remTxt);
        setText('modal-pret-lines-count', String(lines.length));
        const tbody = document.getElementById('modal-pret-lines-body');
        if (tbody) {
            if (lines.length === 0) {
                tbody.innerHTML = `<tr><td colspan="6">Aucune ligne</td></tr>`;
            } else {
                const cell = (v) => this.escapeHtml(String(v ?? '').trim() || '—');
                tbody.innerHTML = lines.map((line, idx) => {
                    const t = String(line?.type || '').toLowerCase();
                    const isAutres = t === 'autres';
                    const typeCol = this.escapeHtml(this.pretLineTypeDisplayHist(line));
                    const marque = cell(line?.marque ?? line?.marqueName);
                    const modele = cell(line?.modele ?? line?.modeleName);
                    const sn = isAutres ? '—' : cell(line?.serialNumber ?? line?.serial_number ?? line?.serial);
                    return `
                    <tr>
                        <td>${idx + 1}</td>
                        <td>${typeCol}</td>
                        <td>${marque}</td>
                        <td>${modele}</td>
                        <td>${sn}</td>
                        <td>${this.escapeHtml(String(line?.quantite ?? line?.quantity ?? '-'))}</td>
                    </tr>
                `;
                }).join('');
            }
        }
        this.modalManager.open('modal-pret-details');
    }

    async editDonFromHistorique(donId) {
        const don = this.dons.find(d => String(d.id) === String(donId));
        if (!don) return;
        this.currentEditingDonId = String(donId);
        const lotNameInput = document.getElementById('input-don-lot-name-hist');
        if (lotNameInput) lotNameInput.value = String(don.lot_name || don.name || '').trim();
        this.modalManager.open('modal-edit-don-hist');
    }

    async saveDonFromHistorique() {
        const donId = this.currentEditingDonId;
        if (!donId) return;
        const lotNameInput = document.getElementById('input-don-lot-name-hist');
        const newName = String(lotNameInput?.value || '').trim();
        if (!newName) {
            this.showNotification('Le nom du lot du don est obligatoire', 'warning');
            return;
        }
        try {
            const res = await api.put(`/api/dons/${donId}`, { lot_name: newName });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await this.loadData();
            this.modalManager.close('modal-edit-don-hist');
            this.showNotification('Don mis à jour', 'success');
        } catch (err) {
            this.showNotification(err?.message || 'Édition impossible', 'error');
        }
    }

    async editDonItemsFromHistorique(donId) {
        let don = this.dons.find(d => String(d.id) === String(donId));
        if (!don) return;
        let lines = this.parseLinesArray(don.lines || don.lignes || don.items);
        const endpoint = this.resolveDetailEndpoint('don', donId);
        if (lines.length === 0 && endpoint) {
            try {
                const res = await api.get(endpoint, { useCache: false });
                if (res.ok) {
                    const data = await res.json();
                    const full = data?.don || data?.item || data;
                    if (full && typeof full === 'object') {
                        don = { ...don, ...full };
                        lines = this.parseLinesArray(full.lines || full.lignes || full.items);
                    }
                }
            } catch (_) { /* noop */ }
        }
        await this.loadReferenceDataDisques();
        this.currentEditingDonId = String(donId);
        const tbody = document.getElementById('modal-edit-don-items-body');
        if (!tbody) return;
        if (lines.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7">Aucune ligne disponible</td></tr>`;
        } else {
            tbody.innerHTML = lines.map((line, idx) => `
                <tr data-line-index="${idx}">
                    <td>${idx + 1}</td>
                    <td>
                        <select class="hist-don-type-select">
                            ${(() => {
                                const val = this.normalizeTypeValue(line?.type);
                                const known = DON_TYPE_OPTIONS.slice(1, -1);
                                const isOther = val && !known.includes(val);
                                return DON_TYPE_OPTIONS.map(opt => {
                                    const value = opt === 'Autre' ? VALUE_AUTRE_GENERIC : opt;
                                    const selected = (opt === 'Autre' && isOther) || (opt !== 'Autre' && val === opt);
                                    return `<option value="${this.escapeAttr(value)}" ${selected ? 'selected' : ''}>${this.escapeHtml(opt || '-- Type --')}</option>`;
                                }).join('');
                            })()}
                        </select>
                        <input type="text" class="hist-don-type-other" value="${this.escapeAttr(this.normalizeTypeValue(line?.type))}" placeholder="Type libre" style="margin-top:6px;display:${(() => {
                            const val = this.normalizeTypeValue(line?.type);
                            const known = DON_TYPE_OPTIONS.slice(1, -1);
                            return val && !known.includes(val) ? 'block' : 'none';
                        })()};">
                    </td>
                    <td>
                        ${(() => {
                            const marqueVal = String(line?.marqueName || line?.marque || '').trim();
                            const marqueMatch = this.marques.find(m => (m.name || '').trim() === marqueVal);
                            const marqueSelVal = marqueMatch ? String(marqueMatch.id) : (marqueVal ? VALUE_AUTRE_DISQUES : '');
                            const options = '<option value="">-- Marque --</option>'
                                + this.marques.map(m => `<option value="${m.id}" ${marqueSelVal === String(m.id) ? 'selected' : ''}>${this.escapeHtml(m.name)}</option>`).join('')
                                + `<option value="${VALUE_AUTRE_DISQUES}" ${marqueSelVal === VALUE_AUTRE_DISQUES ? 'selected' : ''}>Autre</option>`;
                            return `<select class="hist-don-marque-select">${options}</select>
                                    <input type="text" class="hist-don-marque-other" value="${this.escapeAttr(marqueVal)}" placeholder="Marque libre" style="margin-top:6px;display:${marqueSelVal === VALUE_AUTRE_DISQUES ? 'block' : 'none'};">`;
                        })()}
                    </td>
                    <td>
                        ${(() => {
                            const marqueVal = String(line?.marqueName || line?.marque || '').trim();
                            const modeleVal = String(line?.modeleName || line?.modele || '').trim();
                            const marqueMatch = this.marques.find(m => (m.name || '').trim() === marqueVal);
                            const modelesForMarque = marqueMatch ? this.modeles.filter(m => m.marque_id == marqueMatch.id) : [];
                            const modeleMatch = modelesForMarque.find(m => (m.name || '').trim() === modeleVal);
                            const modeleSelVal = modeleMatch ? String(modeleMatch.id) : (modeleVal ? VALUE_AUTRE_DISQUES : '');
                            const options = '<option value="">-- Modèle --</option>'
                                + modelesForMarque.map(m => `<option value="${m.id}" ${modeleSelVal === String(m.id) ? 'selected' : ''}>${this.escapeHtml(m.name)}</option>`).join('')
                                + `<option value="${VALUE_AUTRE_DISQUES}" ${modeleSelVal === VALUE_AUTRE_DISQUES ? 'selected' : ''}>Autre</option>`;
                            return `<select class="hist-don-modele-select">${options}</select>
                                    <input type="text" class="hist-don-modele-other" value="${this.escapeAttr(modeleVal)}" placeholder="Modèle libre" style="margin-top:6px;display:${modeleSelVal === VALUE_AUTRE_DISQUES ? 'block' : 'none'};">`;
                        })()}
                    </td>
                    <td><input type="text" class="hist-don-serial" value="${this.escapeAttr(String(line?.serialNumber || line?.serial || ''))}" placeholder="S/N"></td>
                    <td><input type="text" class="hist-don-date" value="${this.escapeAttr(String(line?.date || ''))}" placeholder="Date"></td>
                    <td><input type="text" class="hist-don-stagiaire" value="${this.escapeAttr(String(line?.stagiaire || ''))}" placeholder="Stagiaire"></td>
                </tr>
            `).join('');
            tbody.querySelectorAll('.hist-don-type-select').forEach((sel) => {
                sel.addEventListener('change', () => {
                    const row = sel.closest('tr');
                    const otherInput = row?.querySelector('.hist-don-type-other');
                    if (!otherInput) return;
                    const isOther = sel.value === VALUE_AUTRE_GENERIC;
                    otherInput.style.display = isOther ? 'block' : 'none';
                    if (!isOther) otherInput.value = sel.value || '';
                });
            });
            tbody.querySelectorAll('.hist-don-marque-select').forEach((sel) => {
                sel.addEventListener('change', () => {
                    const row = sel.closest('tr');
                    const marqueOther = row?.querySelector('.hist-don-marque-other');
                    const modeleSel = row?.querySelector('.hist-don-modele-select');
                    const modeleOther = row?.querySelector('.hist-don-modele-other');
                    const isAutre = sel.value === VALUE_AUTRE_DISQUES;
                    if (marqueOther) marqueOther.style.display = isAutre ? 'block' : 'none';
                    if (modeleSel) {
                        const filtered = sel.value && sel.value !== VALUE_AUTRE_DISQUES
                            ? this.modeles.filter(m => String(m.marque_id) === String(sel.value))
                            : [];
                        modeleSel.innerHTML = '<option value="">-- Modèle --</option>'
                            + filtered.map(m => `<option value="${m.id}">${this.escapeHtml(m.name)}</option>`).join('')
                            + `<option value="${VALUE_AUTRE_DISQUES}">Autre</option>`;
                    }
                    if (modeleOther) {
                        modeleOther.style.display = 'none';
                        modeleOther.value = '';
                    }
                });
            });
            tbody.querySelectorAll('.hist-don-modele-select').forEach((sel) => {
                sel.addEventListener('change', () => {
                    const row = sel.closest('tr');
                    const modeleOther = row?.querySelector('.hist-don-modele-other');
                    if (!modeleOther) return;
                    const isAutre = sel.value === VALUE_AUTRE_DISQUES;
                    modeleOther.style.display = isAutre ? 'block' : 'none';
                    if (!isAutre) modeleOther.value = '';
                });
            });
        }
        this.modalManager.open('modal-edit-don-items-hist');
    }

    async saveDonItemsFromHistorique() {
        const donId = this.currentEditingDonId;
        if (!donId) return;
        const rows = Array.from(document.querySelectorAll('#modal-edit-don-items-body tr[data-line-index]'));
        const lines = rows.map((row) => {
            const typeSel = row.querySelector('.hist-don-type-select');
            const typeOther = row.querySelector('.hist-don-type-other');
            const type = typeSel?.value === VALUE_AUTRE_GENERIC
                ? String(typeOther?.value || '').trim()
                : String(typeSel?.value || '').trim();
            const marqueSel = row.querySelector('.hist-don-marque-select');
            const marqueOther = row.querySelector('.hist-don-marque-other');
            const modeleSel = row.querySelector('.hist-don-modele-select');
            const modeleOther = row.querySelector('.hist-don-modele-other');
            let marque = null;
            if (marqueSel?.value === VALUE_AUTRE_DISQUES) marque = String(marqueOther?.value || '').trim() || null;
            else if (marqueSel?.value) {
                const m = this.marques.find(x => String(x.id) === String(marqueSel.value));
                marque = m?.name || null;
            }
            let modele = null;
            if (modeleSel?.value === VALUE_AUTRE_DISQUES) modele = String(modeleOther?.value || '').trim() || null;
            else if (modeleSel?.value) {
                const m = this.modeles.find(x => String(x.id) === String(modeleSel.value));
                modele = m?.name || null;
            }
            return {
            type: this.normalizeTypeValue(type) || null,
            marque,
            modele,
            serial: String(row.querySelector('.hist-don-serial')?.value || '').trim() || null,
            date: String(row.querySelector('.hist-don-date')?.value || '').trim() || null,
            stagiaire: String(row.querySelector('.hist-don-stagiaire')?.value || '').trim() || null
        };});
        try {
            const res = await api.put(`/api/dons/${donId}`, { lines });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await this.loadData();
            this.modalManager.close('modal-edit-don-items-hist');
            this.showNotification('Matériel don mis à jour', 'success');
        } catch (err) {
            this.showNotification(err?.message || 'Édition impossible', 'error');
        }
    }

    async openPathOnDesktop(targetPath) {
        if (!window.electron || typeof window.electron.invoke !== 'function') {
            this.showNotification('Ouverture disponible uniquement dans l’application desktop', 'warning');
            return;
        }
        try {
            const result = await window.electron.invoke('open-path', { path: targetPath });
            if (!result?.success) throw new Error(result?.error || 'Impossible d’ouvrir le dossier');
        } catch (err) {
            this.showNotification(err?.message || 'Impossible d’ouvrir le dossier', 'error');
        }
    }

    openPdfUrl(url) {
        if (!url) return;
        if (window.electron?.invoke) {
            window.electron.invoke('open-pdf-with-system-app', {
                url,
                token: localStorage.getItem('workspace_jwt') || '',
                suggestedFilename: 'commande.pdf'
            }).catch(() => window.open(url, '_blank', 'noopener'));
            return;
        }
        window.open(url, '_blank', 'noopener');
    }

    async downloadPdfUrl(url, filename) {
        if (!url) return;
        try {
            const response = await fetch(url, {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('workspace_jwt') || ''}` }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            const downloadUrl = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = downloadUrl;
            a.download = filename || 'commande.pdf';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(downloadUrl);
        } catch (err) {
            this.showNotification(err?.message || 'Téléchargement impossible', 'error');
        }
    }

    /**
     * Marquer une session disques comme récupérée (historique/traçabilité uniquement, pas les PDF).
     */
    async markDisqueSessionAsRecovered(sessionId) {
        const session = this.sessionsDisques.find(s => String(s.id) === String(sessionId));
        if (!session) return;
        const button = document.querySelector(`.btn-to-recover-disque[data-session-id="${sessionId}"]`);
        if (button) {
            button.disabled = true;
            button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> En cours...';
        }
        try {
            const data = await updateSession(sessionId, { recovered_at: new Date().toISOString() });
            session.recovered_at = data.recovered_at ?? data.session?.recovered_at ?? new Date().toISOString();
            this.showNotification('Lot disques marqué comme récupéré', 'success');
            this.renderLots();
        } catch (err) {
            logger.error('Erreur récupération lot disques:', err);
            this.showNotification(err?.message || 'Erreur lors de la mise à jour', 'error');
            if (button) {
                button.disabled = false;
                button.textContent = 'Récupérer';
            }
        }
    }

    /**
     * Ouvrir la modale d'édition du nom de la session disques
     */
    editDisqueSessionName(sessionId) {
        const session = this.sessionsDisques.find(s => String(s.id) === String(sessionId));
        if (!session) return;
        this.currentEditingSessionId = sessionId;
        const input = document.getElementById('input-disque-session-name');
        if (input) input.value = (session.name || '').trim();
        this.modalManager.open('modal-edit-disque-name');
    }

    /**
     * Sauvegarder le nom de la session disques
     */
    async saveDisqueSessionName() {
        if (!this.currentEditingSessionId) return;
        const input = document.getElementById('input-disque-session-name');
        const newName = input?.value?.trim() ?? '';
        if (!newName) {
            this.showNotification('Le nom ne peut pas être vide', 'warning');
            return;
        }
        try {
            const serverUrl = api.getServerUrl();
            const url = `${serverUrl}/api/disques/sessions/${this.currentEditingSessionId}`;
            const res = await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('workspace_jwt') || ''}` },
                body: JSON.stringify({ name: newName })
            });
            if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
            const session = this.sessionsDisques.find(s => String(s.id) === String(this.currentEditingSessionId));
            if (session) session.name = newName;
            this.currentEditingSessionId = null;
            this.modalManager.close('modal-edit-disque-name');
            this.renderLots();
            this.showNotification('Nom mis à jour', 'success');
        } catch (err) {
            logger.error('saveDisqueSessionName:', err);
            this.showNotification(err?.message || 'Erreur lors de la mise à jour', 'error');
        }
    }

    async loadReferenceDataDisques() {
        try {
            const marquesRes = await api.get('marques.list');
            if (!marquesRes.ok) return;
            const marquesData = await marquesRes.json();
            this.marques = Array.isArray(marquesData) ? marquesData : (marquesData.items || marquesData.marques || []);
            const modelesRes = await api.get('marques.all');
            if (!modelesRes.ok) return;
            const modelesData = await modelesRes.json();
            const marquesAvecModeles = Array.isArray(modelesData) ? modelesData : (modelesData.items || []);
            this.modeles = [];
            marquesAvecModeles.forEach(marque => {
                if (marque.modeles && Array.isArray(marque.modeles)) {
                    marque.modeles.forEach(modele => {
                        this.modeles.push({
                            id: modele.id,
                            name: modele.name,
                            marque_id: marque.id
                        });
                    });
                }
            });
        } catch (err) {
            logger.error('loadReferenceDataDisques:', err);
            this.marques = [];
            this.modeles = [];
        }
    }

    /**
     * Ouvrir la modale d'édition du matériel (disques) d'un lot disques
     */
    async editDisqueItems(sessionId) {
        const session = this.sessionsDisques.find(s => String(s.id) === String(sessionId));
        if (!session) return;
        await this.loadReferenceDataDisques();
        const full = await getSession(sessionId).catch(() => session);
        const disks = Array.isArray(full.disks) ? full.disks : [];
        this.currentEditingSessionId = sessionId;
        document.getElementById('modal-edit-disque-session-title').textContent = (full.name || '').trim() || 'Lot disques';
        const container = document.getElementById('modal-edit-disque-items-list');
        if (!container) return;
        const sizeOpts = ['', '250 Go', '500 Go', '1 To', '2 To', '4 To', '8 To', 'autre'];
        const typeOpts = ['', 'HDD', 'SSD'];
        const ifaceOpts = ['SATA', 'SAS', 'NVMe', 'M.2'];
        container.innerHTML = disks.map((d, i) => {
            const sizeVal = (d.size || '').trim();
            const sizeOpt = sizeOpts.includes(sizeVal) ? sizeVal : (sizeVal ? 'autre' : '');
            const marqueVal = (d.marque || '').trim();
            const modeleVal = (d.modele || '').trim();
            const marqueMatch = this.marques.find(m => (m.name || '').trim() === marqueVal);
            const marqueId = marqueMatch ? marqueMatch.id : null;
            const modelesForMarque = marqueId ? this.modeles.filter(m => m.marque_id == marqueId) : [];
            const modeleMatch = modelesForMarque.find(m => (m.name || '').trim() === modeleVal);
            const marqueSelVal = marqueMatch ? marqueMatch.id : (marqueVal ? VALUE_AUTRE_DISQUES : '');
            const modeleSelVal = modeleMatch ? modeleMatch.id : (modeleVal ? VALUE_AUTRE_DISQUES : '');
            const marqueOpts = '<option value="">-- Marque --</option>' +
                this.marques.map(m => `<option value="${m.id}" ${marqueSelVal === m.id ? 'selected' : ''}>${this.escapeHtml(m.name)}</option>`).join('') +
                `<option value="${VALUE_AUTRE_DISQUES}" ${marqueSelVal === VALUE_AUTRE_DISQUES ? 'selected' : ''}>Autre</option>`;
            const modeleOpts = '<option value="">-- Modèle --</option>' +
                modelesForMarque.map(m => `<option value="${m.id}" ${modeleSelVal === m.id ? 'selected' : ''}>${this.escapeHtml(m.name)}</option>`).join('') +
                `<option value="${VALUE_AUTRE_DISQUES}" ${modeleSelVal === VALUE_AUTRE_DISQUES ? 'selected' : ''}>Autre</option>`;
            const showMarqueAutre = marqueSelVal === VALUE_AUTRE_DISQUES;
            const showModeleAutre = modeleSelVal === VALUE_AUTRE_DISQUES;
            return `<tr class="historique-disque-edit-row" data-disk-index="${i}">
                <td>${i + 1}</td>
                <td><input type="text" class="disque-edit-serial" value="${this.escapeAttr(d.serial || '')}" placeholder="S/N"></td>
                <td>
                    <select class="disque-edit-marque">${marqueOpts}</select>
                    <input type="text" class="disque-edit-marque-autre" value="${showMarqueAutre ? this.escapeAttr(marqueVal) : ''}" placeholder="Autre marque" style="margin-top:6px;display:${showMarqueAutre ? 'block' : 'none'};">
                </td>
                <td>
                    <select class="disque-edit-modele">${modeleOpts}</select>
                    <input type="text" class="disque-edit-modele-autre" value="${showModeleAutre ? this.escapeAttr(modeleVal) : ''}" placeholder="Autre modèle" style="margin-top:6px;display:${showModeleAutre ? 'block' : 'none'};">
                </td>
                <td>
                    <select class="disque-edit-size-select">${sizeOpts.map(o => `<option value="${o}" ${sizeOpt === o ? 'selected' : ''}>${o || '--'}</option>`).join('')}</select>
                    <input type="text" class="disque-edit-size-custom" value="${sizeOpt === 'autre' ? this.escapeAttr(sizeVal) : ''}" placeholder="Ex: 512 Go" style="margin-top:6px;display:${sizeOpt === 'autre' ? 'block' : 'none'};">
                </td>
                <td><select class="disque-edit-type">${typeOpts.map(o => `<option value="${o}" ${(d.disk_type || '') === o ? 'selected' : ''}>${o || '--'}</option>`).join('')}</select></td>
                <td><select class="disque-edit-interface">${ifaceOpts.map(o => `<option value="${o}" ${(d.interface || '') === o ? 'selected' : ''}>${o}</option>`).join('')}</select></td>
                <td style="text-align:center;"><input type="checkbox" class="disque-edit-destruction-physique" ${(d.shred || '') === 'Destruction physique' ? 'checked' : ''} title="Destruction physique"></td>
            </tr>`;
        }).join('');
        container.querySelectorAll('.disque-edit-size-select').forEach(sel => {
            sel.addEventListener('change', () => {
                const row = sel.closest('.historique-disque-edit-row');
                const custom = row?.querySelector('.disque-edit-size-custom');
                if (custom) custom.style.display = sel.value === 'autre' ? 'inline-block' : 'none';
            });
        });
        container.querySelectorAll('.disque-edit-marque').forEach(sel => {
            sel.addEventListener('change', () => {
                const row = sel.closest('.historique-disque-edit-row');
                const marqueAutre = row?.querySelector('.disque-edit-marque-autre');
                const modeleSel = row?.querySelector('.disque-edit-modele');
                const modeleAutre = row?.querySelector('.disque-edit-modele-autre');
                const isAutre = sel.value === VALUE_AUTRE_DISQUES;
                if (marqueAutre) {
                    marqueAutre.style.display = isAutre ? 'inline-block' : 'none';
                    if (!isAutre) marqueAutre.value = '';
                }
                if (modeleSel) {
                    const marqueId = sel.value && sel.value !== VALUE_AUTRE_DISQUES ? sel.value : '';
                    const filtered = marqueId ? this.modeles.filter(m => m.marque_id == marqueId) : [];
                    modeleSel.innerHTML = '<option value="">-- Modèle --</option>' +
                        filtered.map(m => `<option value="${m.id}">${this.escapeHtml(m.name)}</option>`).join('') +
                        `<option value="${VALUE_AUTRE_DISQUES}">Autre</option>`;
                }
                if (modeleAutre) {
                    modeleAutre.style.display = 'none';
                    modeleAutre.value = '';
                }
            });
        });
        container.querySelectorAll('.disque-edit-modele').forEach(sel => {
            sel.addEventListener('change', () => {
                const row = sel.closest('.historique-disque-edit-row');
                const modeleAutre = row?.querySelector('.disque-edit-modele-autre');
                const isAutre = sel.value === VALUE_AUTRE_DISQUES;
                if (modeleAutre) {
                    modeleAutre.style.display = isAutre ? 'inline-block' : 'none';
                    if (!isAutre) modeleAutre.value = '';
                }
            });
        });
        this.modalManager.open('modal-edit-disque-items');
    }

    /**
     * Enregistrer les modifications du matériel (lot disques)
     */
    async applyDisqueItemsEdits() {
        if (!this.currentEditingSessionId) return;
        const container = document.getElementById('modal-edit-disque-items-list');
        if (!container) return;
        const rows = container.querySelectorAll('.historique-disque-edit-row[data-disk-index]');
        const disks = [];
        for (const row of rows) {
            const serial = row.querySelector('.disque-edit-serial')?.value?.trim();
            const sizeSelect = row.querySelector('.disque-edit-size-select');
            const sizeCustom = row.querySelector('.disque-edit-size-custom');
            const size = (sizeSelect?.value === 'autre' && sizeCustom?.value?.trim()) ? sizeCustom.value.trim() : (sizeSelect?.value || '');
            if (!serial) {
                this.showNotification('Chaque disque doit avoir un S/N', 'warning');
                return;
            }
            const t = (row.querySelector('.disque-edit-type')?.value || '').toUpperCase();
            const destructionPhysique = row.querySelector('.disque-edit-destruction-physique')?.checked === true;
            const shred = destructionPhysique ? 'Destruction physique' : (t === 'SSD' ? 'Secure E. + Sanitize' : t === 'HDD' ? 'DoD' : '');
            const marqueSel = row.querySelector('.disque-edit-marque');
            const marqueAutre = row.querySelector('.disque-edit-marque-autre');
            const modeleSel = row.querySelector('.disque-edit-modele');
            const modeleAutre = row.querySelector('.disque-edit-modele-autre');
            let marque = null;
            if (marqueSel?.value === VALUE_AUTRE_DISQUES && marqueAutre?.value?.trim()) marque = marqueAutre.value.trim();
            else if (marqueSel?.value && marqueSel.value !== VALUE_AUTRE_DISQUES) {
                const m = this.marques.find(x => String(x.id) === String(marqueSel.value));
                marque = m ? m.name : null;
            }
            let modele = null;
            if (modeleSel?.value === VALUE_AUTRE_DISQUES && modeleAutre?.value?.trim()) modele = modeleAutre.value.trim();
            else if (modeleSel?.value && modeleSel.value !== VALUE_AUTRE_DISQUES) {
                const m = this.modeles.find(x => String(x.id) === String(modeleSel.value));
                modele = m ? m.name : null;
            }
            disks.push({
                serial,
                marque,
                modele,
                size: size || null,
                disk_type: row.querySelector('.disque-edit-type')?.value || null,
                interface: row.querySelector('.disque-edit-interface')?.value || null,
                shred
            });
        }
        try {
            const serverUrl = api.getServerUrl();
            const url = `${serverUrl}/api/disques/sessions/${this.currentEditingSessionId}`;
            const res = await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('workspace_jwt') || ''}` },
                body: JSON.stringify({ disks })
            });
            if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
            const session = this.sessionsDisques.find(s => String(s.id) === String(this.currentEditingSessionId));
            if (session) session.disks = disks;
            this.currentEditingSessionId = null;
            this.modalManager.close('modal-edit-disque-items');
            this.renderLots();
            this.showNotification('Matériel mis à jour', 'success');
        } catch (err) {
            logger.error('applyDisqueItemsEdits:', err);
            this.showNotification(err?.message || 'Erreur lors de l\'enregistrement', 'error');
        }
    }

    /**
     * Afficher les détails d'une session disques
     */
    async viewDisqueSessionDetails(sessionId) {
        const session = this.sessionsDisques.find(s => String(s.id) === String(sessionId));
        if (!session) return;
        const full = await getSession(sessionId).catch(() => session);
        const name = (full.name || '').trim() || 'Lot disques';
        const dateFormatted = this.formatDateDDMMYYYY(full.date || (full.created_at || '').slice(0, 10));
        const disks = Array.isArray(full.disks) ? full.disks : [];
        document.getElementById('modal-disque-title').textContent = name;
        document.getElementById('modal-disque-total').textContent = disks.length;
        const tbody = document.getElementById('modal-disque-items');
        if (tbody) {
            tbody.innerHTML = disks.map((d, i) => {
                const t = (d.disk_type || '').toUpperCase();
                const shredDisplay = d.shred || (t === 'SSD' ? 'Secure E. + Sanitize' : t === 'HDD' ? 'DoD' : '-');
                return `
                <tr>
                    <td>${i + 1}</td>
                    <td>${this.escapeHtml((d.serial != null ? d.serial : d.serial_number) || '-')}</td>
                    <td>${this.escapeHtml(d.marque || '-')}</td>
                    <td>${this.escapeHtml(d.modele || '-')}</td>
                    <td>${this.escapeHtml(d.size || '-')}</td>
                    <td>${this.escapeHtml(d.disk_type || '-')}</td>
                    <td>${this.escapeHtml(d.interface || '-')}</td>
                    <td>${this.escapeHtml(shredDisplay)}</td>
                </tr>
            `;
            }).join('');
        }
        this.modalManager.open('modal-disque-details');
    }

    /**
     * Voir les détails d'un lot
     */
    viewLotDetails(lotId) {
        const lot = this.lots.find(l => l.id == lotId);
        if (!lot) return;

        const total = lot.total || 0;
        const recond = lot.recond || 0;
        const hs = lot.hs || 0;

        // Remplir la modale
        document.getElementById('modal-lot-number').textContent = lot.id;
        document.getElementById('modal-lot-created').textContent = this.formatDateTime(lot.created_at);
        document.getElementById('modal-lot-finished').textContent = this.formatDateTime(lot.finished_at);
        document.getElementById('modal-lot-total').textContent = total;
        document.getElementById('modal-lot-recond').textContent = recond;
        document.getElementById('modal-lot-hs').textContent = hs;

        // Stats détail (taux reconditionnement, barre)
        const pctRecond = total > 0 ? Math.round((recond / total) * 100) : 0;
        const statRecondEl = document.getElementById('recep-stat-recond');
        const progressRecondEl = document.getElementById('recep-progress-recond');
        if (statRecondEl) statRecondEl.textContent = pctRecond + '%';
        if (progressRecondEl) progressRecondEl.style.width = pctRecond + '%';
        const statStateEl = document.getElementById('recep-stat-state');
        if (statStateEl) statStateEl.textContent = pctRecond >= 50 ? 'Bon' : pctRecond >= 25 ? 'Moyen' : 'Faible';

        // Items
        const itemsContainer = document.getElementById('modal-lot-items');
        if (!itemsContainer) {
            logger.error('modal-lot-items non trouvé');
            return;
        }
        
        // S'assurer que lot.items est un tableau
        const items = Array.isArray(lot.items) ? lot.items : [];
        logger.debug('Items du lot:', JSON.stringify({ 
            lotId, 
            itemsCount: items.length, 
            lotItemsRaw: lot.items,
            lotItemsType: Array.isArray(lot.items) ? 'array' : typeof lot.items,
            items: items.slice(0, 5)
        }, null, 2));
        
        const formatItemDateTime = (it) => {
            if (it.created_at) return this.formatDateTime(it.created_at);
            if (it.state_changed_at) return this.formatDateTime(it.state_changed_at);
            if (it.date && it.time) return `${it.date} ${it.time}`;
            return '-';
        };
        itemsContainer.innerHTML = items.map((item, idx) => `
            <tr>
                <td>${idx + 1}</td>
                <td>${item.serial_number || '-'}</td>
                <td>${item.type || '-'}</td>
                <td>${item.marque_name || '-'}</td>
                <td>${item.modele_name || '-'}</td>
                <td class="col-os"><i class="fa-brands fa-${getOsIcon(item.os)}" title="${getOsLabel(item.os)}"></i></td>
                <td>
                    <span class="state-badge state-${item.state?.replace(/\s+/g, '-')}">
                        ${item.state || '-'}
                    </span>
                </td>
                <td>${item.technician || '-'}</td>
                <td>${formatItemDateTime(item)}</td>
            </tr>
        `).join('');

        this.modalManager.open('modal-lot-details');
    }

    /**
     * Configurer les événements
     */
    setupEventListeners() {
        // Bouton rafraîchir
        const refreshBtn = document.getElementById('btn-refresh-historique');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async () => {
                refreshBtn.disabled = true;
                try {
                    await this.loadData();
                } finally {
                    refreshBtn.disabled = false;
                }
            });
        }

        // Recherche
        const searchInput = document.getElementById('filter-search-historique');
        if (searchInput) {
            searchInput.addEventListener('input', () => this.renderLots());
        }
        const typeSelect = document.getElementById('filter-type-historique');
        if (typeSelect) {
            typeSelect.addEventListener('change', () => this.renderLots());
        }

        // Bouton appliquer les modifications des items
        const applyBtn = document.getElementById('btn-apply-item-edits');
        if (applyBtn) {
            applyBtn.addEventListener('click', () => this.applyItemEdits());
        }

        // Bouton sauvegarder le nom du lot
        const saveLotNameBtn = document.getElementById('btn-save-lot-name');
        if (saveLotNameBtn) {
            saveLotNameBtn.addEventListener('click', () => this.saveLotName());
        }

        // Bouton sauvegarder le nom de la session disques
        const saveDisqueNameBtn = document.getElementById('btn-save-disque-name');
        if (saveDisqueNameBtn) {
            saveDisqueNameBtn.addEventListener('click', () => this.saveDisqueSessionName());
        }

        // Bouton appliquer les modifications du matériel (lot disques)
        const applyDisqueItemsBtn = document.getElementById('btn-apply-disque-items-edits');
        if (applyDisqueItemsBtn) {
            applyDisqueItemsBtn.addEventListener('click', () => this.applyDisqueItemsEdits());
        }

        const saveCommandeBtn = document.getElementById('btn-save-commande-hist');
        if (saveCommandeBtn) {
            saveCommandeBtn.addEventListener('click', () => this.saveCommandeFromHistorique());
        }

        const saveDonBtn = document.getElementById('btn-save-don-hist');
        if (saveDonBtn) {
            saveDonBtn.addEventListener('click', () => this.saveDonFromHistorique());
        }
        const saveCommandeItemsBtn = document.getElementById('btn-save-commande-items-hist');
        if (saveCommandeItemsBtn) {
            saveCommandeItemsBtn.addEventListener('click', () => this.saveCommandeItemsFromHistorique());
        }
        const saveDonItemsBtn = document.getElementById('btn-save-don-items-hist');
        if (saveDonItemsBtn) {
            saveDonItemsBtn.addEventListener('click', () => this.saveDonItemsFromHistorique());
        }
    }

    /**
     * Éditer le nom du lot
     */
    editLotName(lotId) {
        const lot = this.lots.find(l => l.id == lotId);
        if (!lot) return;

        // Stocker l'ID du lot en cours d'édition
        this.currentEditingLotId = lotId;

        // Remplir le champ d'entrée avec le nom actuel
        const inputLotName = document.getElementById('input-lot-name');
        if (inputLotName) {
            inputLotName.value = lot.lot_name || '';
        }

        // Ouvrir la modale
        this.modalManager.open('modal-edit-lot-name');
    }

    /**
     * Sauvegarder le nom du lot
     */
    saveLotName() {
        const lot = this.lots.find(l => l.id == this.currentEditingLotId);
        if (!lot) return;

        const inputLotName = document.getElementById('input-lot-name');
        const newName = inputLotName.value.trim();

        if (!newName) {
            this.showNotification('Le nom du lot ne peut pas être vide', 'warning');
            return;
        }

        // Mettre à jour localement
        lot.lot_name = newName;

        // Faire un appel API pour sauvegarder
        const serverUrl = api.getServerUrl();
        const endpointPath = '/api/lots/:id'.replace(':id', this.currentEditingLotId);
        const fullUrl = `${serverUrl}${endpointPath}`;
        logger.debug('💾 Sauvegarde nom lot:', JSON.stringify({ lotId: this.currentEditingLotId, newName, fullUrl }, null, 2));
        fetch(fullUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('workspace_jwt') || ''}`
            },
            body: JSON.stringify({ lot_name: newName })
        })
        .then(async res => {
            logger.debug('📡 Réponse sauvegarde nom:', JSON.stringify({ 
                status: res.status, 
                statusText: res.statusText,
                ok: res.ok 
            }, null, 2));
            
            if (res.ok) {
                const data = await res.json();
                logger.debug('✅ Nom du lot mis à jour:', JSON.stringify(data, null, 2));
                this.showNotification('Nom du lot mis à jour', 'success');
                this.modalManager.close('modal-edit-lot-name');
                this.renderLots();
            } else {
                const errorText = await res.text();
                logger.error('❌ Erreur réponse:', JSON.stringify({ 
                    status: res.status, 
                    errorText 
                }, null, 2));
                const errorData = JSON.parse(errorText).catch(() => ({}));
                throw new Error(errorData.message || `Erreur ${res.status}: ${errorText}`);
            }
        })
        .catch(err => {
            logger.error('❌ Erreur sauvegarde nom:', JSON.stringify({ error: err.message, stack: err.stack }, null, 2));
            this.showNotification('Erreur lors de la mise à jour', 'error');
        });
    }

    /**
     * Marquer un lot comme récupéré
     */
    async markAsRecovered(lotId) {
        const lot = this.lots.find(l => l.id == lotId);
        if (!lot) return;

        const items = Array.isArray(lot.items) ? lot.items : [];
        const canRecover = items.length > 0 && items.every(item =>
            item.state && item.state.trim() !== '' &&
            item.technician && item.technician.trim() !== ''
        );
        if (!canRecover) {
            this.showNotification('Tous les PC doivent avoir un état et un technicien avant la récupération', 'warning');
            return;
        }

        // Désactiver le bouton immédiatement
        const button = document.querySelector(`.btn-to-recover[data-lot-id="${lotId}"]`);
        if (button) {
            button.disabled = true;
            button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> En cours...';
        }

        try {
            // Faire un appel API pour sauvegarder
            const serverUrl = api.getServerUrl();
            const endpointPath = '/api/lots/:id'.replace(':id', lotId);
            const fullUrl = `${serverUrl}${endpointPath}`;
            logger.debug('🔄 Récupération lot:', JSON.stringify({ lotId, fullUrl, endpointPath }, null, 2));
            const response = await fetch(fullUrl, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('workspace_jwt') || ''}`
                },
                body: JSON.stringify({ recovered_at: new Date().toISOString() })
            });
            
            logger.debug('📡 Réponse récupération:', JSON.stringify({ 
                status: response.status, 
                statusText: response.statusText,
                ok: response.ok 
            }, null, 2));
            
            if (!response.ok) {
                const errorText = await response.text();
                logger.error('❌ Erreur réponse récupération:', JSON.stringify({ 
                    status: response.status, 
                    errorText,
                    lotId 
                }, null, 2));
                throw new Error(`Erreur ${response.status}: ${errorText}`);
            }
            
            const data = await response.json();
            logger.debug('📡 Données récupération reçues:', JSON.stringify(data, null, 2));
            
            // Mettre à jour localement
            lot.recovered_at = data.item?.recovered_at || data.recovered_at || new Date().toISOString();
            logger.debug('✅ Lot mis à jour localement:', JSON.stringify({ lotId, recovered_at: lot.recovered_at }, null, 2));
            
            this.showNotification('Lot marqué comme récupéré - PDF régénéré', 'success');
            this.renderLots();
        } catch (err) {
            logger.error('Erreur:', err);
            this.showNotification('Erreur lors de la mise à jour', 'error');
            
            // Réactiver le bouton en cas d'erreur
            if (button) {
                button.disabled = false;
                button.innerHTML = 'Récupérer';
            }
        }
    }

    /**
     * Éditer l'état du matériel et les techniciens
     */
    async editLotItems(lotId) {
        const lot = this.lots.find(l => l.id == lotId);
        if (!lot) {
            logger.error('Lot non trouvé:', lotId);
            return;
        }
        await this.loadReferenceDataDisques();

        // Utiliser la modale d'édition des items (similaire à inventaire)
        const modal = document.getElementById('modal-edit-lot-items');
        if (!modal) {
            this.showNotification('Modale d\'édition non trouvée', 'error');
            return;
        }

        // S'assurer que lot.items est un tableau
        const items = Array.isArray(lot.items) ? lot.items : [];
        logger.debug('Items du lot pour édition:', JSON.stringify({ 
            lotId, 
            itemsCount: items.length, 
            lotItemsRaw: lot.items,
            lotItemsType: Array.isArray(lot.items) ? 'array' : typeof lot.items,
            items: items.slice(0, 5)
        }, null, 2));

        const formatItemDateTime = (it) => {
            if (it.created_at) return this.formatDateTime(it.created_at);
            if (it.state_changed_at) return this.formatDateTime(it.state_changed_at);
            if (it.date && it.time) return `${it.date} ${it.time}`;
            return '-';
        };
        this.currentEditingLotId = lotId;
        const itemsContainer = document.getElementById('modal-edit-items-body');
        if (itemsContainer) {
            itemsContainer.innerHTML = items.map((item, idx) => {
                const itemState = item.state || '';
                const knownStates = ['Reconditionnés', 'Pour pièces', 'HS'];
                const isOtherState = itemState && !knownStates.includes(itemState);
                const itemType = this.normalizeTypeValue(item.type);
                const isOtherType = itemType && !LOT_TYPE_OPTIONS.slice(1, -1).includes(itemType);
                const itemMarque = String(item.marque_name || '').trim();
                const itemModele = String(item.modele_name || '').trim();
                const marqueMatch = this.marques.find(m => (m.name || '').trim() === itemMarque);
                const marqueSelVal = marqueMatch ? String(marqueMatch.id) : (itemMarque ? VALUE_AUTRE_DISQUES : '');
                const modelesForMarque = marqueMatch ? this.modeles.filter(m => String(m.marque_id) === String(marqueMatch.id)) : [];
                const modeleMatch = modelesForMarque.find(m => (m.name || '').trim() === itemModele);
                const modeleSelVal = modeleMatch ? String(modeleMatch.id) : (itemModele ? VALUE_AUTRE_DISQUES : '');
                return `
                <tr data-item-id="${item.id}">
                    <td><span class="item-number">${idx + 1}</span></td>
                    <td>
                        <input type="text" class="item-serial-input" data-item-id="${item.id}" value="${this.escapeAttr(item.serial_number || '')}" placeholder="S/N">
                    </td>
                    <td>
                        <select class="item-type-select" data-item-id="${item.id}">
                            ${LOT_TYPE_OPTIONS.map(opt => {
                                const value = opt === 'Autre' ? VALUE_AUTRE_GENERIC : opt;
                                const selected = (opt === 'Autre' && isOtherType) || (opt !== 'Autre' && itemType === opt);
                                return `<option value="${this.escapeAttr(value)}" ${selected ? 'selected' : ''}>${this.escapeHtml(opt || '-- Type --')}</option>`;
                            }).join('')}
                        </select>
                        <input type="text" class="item-type-other-input" data-item-id="${item.id}" value="${isOtherType ? this.escapeAttr(itemType) : ''}" placeholder="Précisez le type" style="margin-top:6px;display:${isOtherType ? 'block' : 'none'};">
                    </td>
                    <td>
                        <select class="item-marque-select" data-item-id="${item.id}">
                            <option value="">-- Marque --</option>
                            ${this.marques.map(m => `<option value="${m.id}" ${marqueSelVal === String(m.id) ? 'selected' : ''}>${this.escapeHtml(m.name)}</option>`).join('')}
                            <option value="${VALUE_AUTRE_DISQUES}" ${marqueSelVal === VALUE_AUTRE_DISQUES ? 'selected' : ''}>Autre</option>
                        </select>
                        <input type="text" class="item-marque-other-input" data-item-id="${item.id}" value="${marqueSelVal === VALUE_AUTRE_DISQUES ? this.escapeAttr(itemMarque) : ''}" placeholder="Précisez la marque" style="margin-top:6px;display:${marqueSelVal === VALUE_AUTRE_DISQUES ? 'block' : 'none'};">
                    </td>
                    <td>
                        <select class="item-modele-select" data-item-id="${item.id}">
                            <option value="">-- Modèle --</option>
                            ${modelesForMarque.map(m => `<option value="${m.id}" ${modeleSelVal === String(m.id) ? 'selected' : ''}>${this.escapeHtml(m.name)}</option>`).join('')}
                            <option value="${VALUE_AUTRE_DISQUES}" ${modeleSelVal === VALUE_AUTRE_DISQUES ? 'selected' : ''}>Autre</option>
                        </select>
                        <input type="text" class="item-modele-other-input" data-item-id="${item.id}" value="${modeleSelVal === VALUE_AUTRE_DISQUES ? this.escapeAttr(itemModele) : ''}" placeholder="Précisez le modèle" style="margin-top:6px;display:${modeleSelVal === VALUE_AUTRE_DISQUES ? 'block' : 'none'};">
                    </td>
                    <td class="col-os">
                        <select class="item-os-select" data-item-id="${item.id}">
                            ${OS_OPTIONS.map(o => `<option value="${o.value}" ${getOsOption(item.os).value === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
                        </select>
                    </td>
                    <td>
                        <select class="item-state-select" data-item-id="${item.id}">
                            <option value="">-- Sélectionner --</option>
                            <option value="Reconditionnés" ${itemState === 'Reconditionnés' ? 'selected' : ''}>Reconditionnés</option>
                            <option value="Pour pièces" ${itemState === 'Pour pièces' ? 'selected' : ''}>Pour pièces</option>
                            <option value="HS" ${itemState === 'HS' ? 'selected' : ''}>HS</option>
                            <option value="autres" ${isOtherState ? 'selected' : ''}>Autres</option>
                        </select>
                        <input
                            type="text"
                            class="item-state-other-input"
                            data-item-id="${item.id}"
                            value="${isOtherState ? this.escapeHtml(itemState) : ''}"
                            placeholder="Précisez l'état"
                            style="margin-top:6px;display:${isOtherState ? 'block' : 'none'};"
                        >
                    </td>
                    <td>
                        <input type="text" class="item-technician-input" data-item-id="${item.id}" value="${item.technician || ''}" placeholder="Technicien">
                    </td>
                    <td><span class="item-text">${formatItemDateTime(item)}</span></td>
                </tr>
            `;
            }).join('');
            itemsContainer.querySelectorAll('.item-state-select').forEach(sel => {
                sel.addEventListener('change', () => {
                    const row = sel.closest('tr');
                    const otherInput = row?.querySelector('.item-state-other-input');
                    if (!otherInput) return;
                    const isOther = sel.value === 'autres';
                    otherInput.style.display = isOther ? 'block' : 'none';
                    if (!isOther) otherInput.value = '';
                });
            });
            itemsContainer.querySelectorAll('.item-type-select').forEach(sel => {
                sel.addEventListener('change', () => {
                    const row = sel.closest('tr');
                    const otherInput = row?.querySelector('.item-type-other-input');
                    if (!otherInput) return;
                    const isOther = sel.value === VALUE_AUTRE_GENERIC;
                    otherInput.style.display = isOther ? 'block' : 'none';
                    if (!isOther) otherInput.value = sel.value || '';
                });
            });
            itemsContainer.querySelectorAll('.item-marque-select').forEach(sel => {
                sel.addEventListener('change', () => {
                    const row = sel.closest('tr');
                    const marqueOther = row?.querySelector('.item-marque-other-input');
                    const modeleSel = row?.querySelector('.item-modele-select');
                    const modeleOther = row?.querySelector('.item-modele-other-input');
                    const isAutre = sel.value === VALUE_AUTRE_DISQUES;
                    if (marqueOther) marqueOther.style.display = isAutre ? 'block' : 'none';
                    if (modeleSel) {
                        const filtered = sel.value && sel.value !== VALUE_AUTRE_DISQUES
                            ? this.modeles.filter(m => String(m.marque_id) === String(sel.value))
                            : [];
                        modeleSel.innerHTML = '<option value="">-- Modèle --</option>'
                            + filtered.map(m => `<option value="${m.id}">${this.escapeHtml(m.name)}</option>`).join('')
                            + `<option value="${VALUE_AUTRE_DISQUES}">Autre</option>`;
                    }
                    if (modeleOther) {
                        modeleOther.style.display = 'none';
                        modeleOther.value = '';
                    }
                });
            });
            itemsContainer.querySelectorAll('.item-modele-select').forEach(sel => {
                sel.addEventListener('change', () => {
                    const row = sel.closest('tr');
                    const modeleOther = row?.querySelector('.item-modele-other-input');
                    if (!modeleOther) return;
                    const isOther = sel.value === VALUE_AUTRE_DISQUES;
                    modeleOther.style.display = isOther ? 'block' : 'none';
                    if (!isOther) modeleOther.value = '';
                });
            });
        }

        // Mettre à jour le numéro du lot dans la modale
        document.getElementById('modal-edit-lot-number').textContent = lot.id;

        this.modalManager.open('modal-edit-lot-items');
    }

    /**
     * Apliquer les changements à l'édition des items
     */
    async applyItemEdits() {
        const lot = this.lots.find(l => l.id == this.currentEditingLotId);
        if (!lot) return;

        await this.loadReferenceDataDisques();

        const updates = [];

        // Collecter les mises à jour à partir des selects et inputs
        document.querySelectorAll('#modal-edit-items-body .item-state-select').forEach(stateSelect => {
            const itemId = stateSelect.dataset.itemId;
            const row = stateSelect.closest('tr');
            const technicianInput = row.querySelector('.item-technician-input');
            const osSelect = row.querySelector('.item-os-select');

            if (itemId && technicianInput) {
                const serialInput = row.querySelector('.item-serial-input');
                const otherStateInput = row.querySelector('.item-state-other-input');
                const stateSelectValue = stateSelect.value.trim();
                const customState = (otherStateInput?.value || '').trim();
                const state = stateSelectValue === 'autres' ? customState : stateSelectValue;
                const technician = technicianInput.value.trim();
                const os = osSelect ? (osSelect.value || 'linux') : 'linux';
                
                // Valider que l'état est défini
                if (!state || state === '') {
                    this.showNotification(stateSelectValue === 'autres' ? 'Veuillez préciser un état pour tous les items' : 'Veuillez sélectionner un état pour tous les items', 'warning');
                    return;
                }
                
                updates.push({
                    itemId,
                    serial_number: String(serialInput?.value || '').trim() || null,
                    state: state,
                    technician: technician || null,
                    os: os || 'linux',
                    type: (() => {
                        const typeSel = row.querySelector('.item-type-select');
                        const typeOther = row.querySelector('.item-type-other-input');
                        const rawType = typeSel?.value === VALUE_AUTRE_GENERIC ? String(typeOther?.value || '').trim() : String(typeSel?.value || '').trim();
                        return this.normalizeTypeValue(rawType);
                    })() || null,
                    marque_name: (() => {
                        const marqueSel = row.querySelector('.item-marque-select');
                        const marqueOther = row.querySelector('.item-marque-other-input');
                        if (marqueSel?.value === VALUE_AUTRE_DISQUES) return String(marqueOther?.value || '').trim() || null;
                        if (marqueSel?.value) {
                            const m = this.marques.find(x => String(x.id) === String(marqueSel.value));
                            return m?.name || null;
                        }
                        return null;
                    })(),
                    modele_name: (() => {
                        const modeleSel = row.querySelector('.item-modele-select');
                        const modeleOther = row.querySelector('.item-modele-other-input');
                        if (modeleSel?.value === VALUE_AUTRE_DISQUES) return String(modeleOther?.value || '').trim() || null;
                        if (modeleSel?.value) {
                            const m = this.modeles.find(x => String(x.id) === String(modeleSel.value));
                            return m?.name || null;
                        }
                        return null;
                    })()
                });
            }
        });

        if (updates.length === 0) {
            this.showNotification('Aucun élément à mettre à jour', 'info');
            return;
        }

        // Valider que tous les items ont un état, un technicien et un S/N
        const invalidUpdates = updates.filter(u =>
            !u.serial_number || !u.state || u.state.trim() === '' || !u.technician || u.technician.trim() === ''
        );
        if (invalidUpdates.length > 0) {
            this.showNotification('Tous les items doivent avoir un S/N, un état et un technicien', 'warning');
            return;
        }

        // Envoyer les mises à jour
        Promise.all(updates.map(async update => {
            const serverUrl = api.getServerUrl();
            const endpointPath = '/api/lots/items/:id'.replace(':id', update.itemId);
            const fullUrl = `${serverUrl}${endpointPath}`;
            logger.debug('💾 Mise à jour item:', JSON.stringify({ itemId: update.itemId, serial_number: update.serial_number, state: update.state, technician: update.technician, os: update.os, fullUrl }, null, 2));
            const response = await fetch(fullUrl, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('workspace_jwt') || ''}`
                },
                body: JSON.stringify({
                    serial_number: update.serial_number,
                    state: update.state,
                    technician: update.technician || null,
                    os: update.os || 'linux',
                    type: update.type || null,
                    marque_name: update.marque_name || null,
                    modele_name: update.modele_name || null
                })
            });
            if (!response.ok) {
                let errorText = '';
                try {
                    errorText = await response.text();
                    // Essayer de parser comme JSON pour un meilleur affichage
                    try {
                        const errorJson = JSON.parse(errorText);
                        logger.error('❌ Erreur mise à jour item:', JSON.stringify({ 
                            status: response.status, 
                            error: errorJson,
                            itemId: update.itemId 
                        }, null, 2));
                        const errorMessage = errorJson.message || errorJson.error || errorText;
                        throw new Error(`HTTP ${response.status}: ${errorMessage}`);
                    } catch (e) {
                        if (e.message && e.message.startsWith('HTTP')) {
                            throw e; // Re-throw si c'est déjà notre erreur formatée
                        }
                        logger.error('❌ Erreur mise à jour item (texte):', JSON.stringify({ 
                            status: response.status, 
                            errorText,
                            itemId: update.itemId 
                        }, null, 2));
                        throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 200)}`);
                    }
                } catch (e) {
                    if (e.message && e.message.startsWith('HTTP')) {
                        throw e; // Re-throw si c'est déjà notre erreur formatée
                    }
                    logger.error('❌ Erreur lors de la lecture de la réponse:', e);
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
            }
            return response.json();
        }))
        .then(() => {
            this.showNotification('Matériel mis à jour', 'success');
            this.modalManager.close('modal-edit-lot-items');
            this.loadData();
        })
        .catch(err => {
            logger.error('Erreur:', err);
            this.showNotification('Erreur lors de la mise à jour', 'error');
        });
    }

    /**
     * Régénérer le PDF d'un lot terminé avec les données actuelles.
     */
    async regenerateLotPdf(lotId) {
        if (!window.electron?.invoke) {
            this.showNotification('Génération PDF disponible uniquement dans l\'application Electron', 'warning');
            return;
        }
        const lot = this.lots.find(l => l.id == lotId);
        if (!lot) return;

        const btn = document.querySelector(`.btn-regenerate-lot-pdf[data-lot-id="${lotId}"]`);
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Génération...';
        }

        try {
            const basePath = '/mnt/team/#TEAM/#TRAÇABILITÉ';
            const dateForFile = lot.finished_at
                ? String(lot.finished_at).slice(0, 10)
                : new Date().toISOString().slice(0, 10);
            const serverUrl = api.getServerUrl();
            const res = await fetch(`${serverUrl}/api/lots/${lotId}`, {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('workspace_jwt') || ''}` }
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const fullLot = data.item || data;
            if (fullLot && !fullLot.items && data.items) fullLot.items = data.items;
            if (!fullLot?.items?.length) throw new Error('Lot sans items');

            const lotName = (fullLot.lot_name || fullLot.name) ? String(fullLot.lot_name || fullLot.name).trim() : `Lot_${lotId}`;
            const result = await window.electron.invoke('generate-lot-pdf', {
                lotId: String(lotId),
                lotName,
                date: dateForFile,
                items: fullLot.items,
                created_at: fullLot.created_at,
                finished_at: fullLot.finished_at,
                recovered_at: fullLot.recovered_at,
                basePath
            });
            if (!result?.success || !result.pdf_path) {
                throw new Error(result?.error || 'Échec génération PDF');
            }

            const readResult = await window.electron.invoke('read-file-as-base64', { path: result.pdf_path });
            if (readResult?.success && readResult.base64) {
                await fetch(`${serverUrl}/api/lots/${lotId}/pdf`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('workspace_jwt') || ''}`
                    },
                    body: JSON.stringify({
                        pdf_base64: readResult.base64,
                        lot_name: lotName,
                        date: dateForFile
                    })
                });
            }

            const year = dateForFile.slice(0, 4);
            const monthNum = parseInt(dateForFile.slice(5, 7), 10);
            const moisNoms = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
            const monthName = monthNum >= 1 && monthNum <= 12 ? moisNoms[monthNum - 1] : dateForFile.slice(5, 7);
            this.showNotification(`PDF régénéré dans ${basePath}/${year}/${monthName}/`, 'success');
        } catch (err) {
            logger.error('regenerateLotPdf:', err);
            this.showNotification('Erreur lors de la régénération du PDF', 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-file-pdf" aria-hidden="true"></i> Régénérer PDF';
            }
        }
    }

    /**
     * Formater une date
     */
    formatDate(dateStr) {
        if (!dateStr) return '-';
        const date = new Date(dateStr);
        return date.toLocaleDateString('fr-FR', { year: 'numeric', month: 'short', day: 'numeric' });
    }

    /**
     * Formater une date et heure
     */
    formatDateTime(dateStr) {
        if (!dateStr) return '-';
        const date = new Date(dateStr);
        return date.toLocaleString('fr-FR', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    /**
     * Afficher une notification
     */
    showNotification(message, type = 'info', options) {
        showAppNotification(message, type, options);
    }

    destroy() {
        logger.debug('🧹 Destruction HistoriqueManager');
        this.lots = [];
        this.sessionsDisques = [];
        this.commandes = [];
        this.dons = [];
        this.prets = [];
    }
}
