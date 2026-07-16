/**
 * DISQUES - Même structure UI qu’Entrer (carte config + tableau éditable ligne à ligne).
 * Colonnes : sélection, n°, S/N, type disque, marque, modèle, taille, interface/shred, action.
 */

import getLogger from '../../config/Logger.js';
import api from '../../config/api.js';
import { createSession } from './disquesApi.js';

const logger = getLogger();

let sessionDisksCache = [];

const INTERFACES_HDD = [{ value: 'SATA', label: 'SATA' }, { value: 'SAS', label: 'SAS' }];
const INTERFACES_SSD = [{ value: 'M.2', label: 'M.2' }, { value: 'NVMe', label: 'NVMe' }, { value: 'SATA', label: 'SATA' }];
const INTERFACES_ALL = [{ value: 'SATA', label: 'SATA' }, { value: 'SAS', label: 'SAS' }, { value: 'NVMe', label: 'NVMe' }, { value: 'M.2', label: 'M.2' }];

const SIZE_PRESETS = ['250 Go', '500 Go', '1 To', '2 To', '4 To', '8 To'];

function getShredForDisk(disk) {
    const existing = (disk.shred || '').trim();
    if (existing && existing === 'Destruction physique') return existing;
    const t = (disk.disk_type || '').toUpperCase();
    if (t === 'SSD') return 'Secure E. + Sanitize';
    if (t === 'HDD') return 'DoD';
    return '-';
}

function emptyDisk() {
    const d = {
        serial: '',
        marque: '-',
        modele: '-',
        size: '-',
        disk_type: '',
        interface: 'SATA',
        shred: '',
        autoDetected: false
    };
    d.shred = getShredForDisk(d);
    return d;
}

const VALUE_AUTRE = '__autre__';

export default class DisquesManager {
    constructor(modalManager) {
        this.modalManager = modalManager;
        this.sessionDisks = Array.isArray(sessionDisksCache) ? [...sessionDisksCache] : [];
        this.lsblkPendingDisks = [];
        this.marques = [];
        this.modeles = [];
        this.listeners = [];
        this._barcodeBuf = '';
        this._barcodeTimer = null;
        this._onSerialEnter = null;
        this._onBarcodeKeydown = null;
        this.init();
    }

    async init() {
        logger.debug('Initialisation DisquesManager');
        await this.loadReferenceData();
        if (!this.sessionDisks.length) {
            this.sessionDisks = [emptyDisk()];
        }
        this.setupEventListeners();
        this.renderSessionTable();
        setTimeout(() => this.focusSerialInput(), 100);
        logger.debug('DisquesManager prêt');
    }

    async loadReferenceData() {
        try {
            const marquesRes = await api.get('marques.list');
            if (!marquesRes.ok) throw new Error('Erreur chargement marques');
            const marquesData = await marquesRes.json();
            this.marques = Array.isArray(marquesData) ? marquesData : (marquesData.items || marquesData.marques || []);
            const modelesRes = await api.get('marques.all');
            if (!modelesRes.ok) throw new Error('Endpoint modèles non trouvé');
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
            logger.error('Erreur chargement marques/modèles disques:', err);
            this.marques = [];
            this.modeles = [];
        }
    }

    addListener(el, event, handler) {
        if (!el) return;
        el.addEventListener(event, handler);
        this.listeners.push({ element: el, event, handler });
    }

    destroy() {
        this.syncAllFromDom();
        sessionDisksCache = [...(this.sessionDisks || [])];
        if (this._onSerialEnter) {
            document.removeEventListener('keydown', this._onSerialEnter);
            this._onSerialEnter = null;
        }
        if (this._onBarcodeKeydown) {
            document.removeEventListener('keydown', this._onBarcodeKeydown);
            this._onBarcodeKeydown = null;
        }
        if (this._barcodeTimer) clearTimeout(this._barcodeTimer);
        this.listeners.forEach(({ element, event, handler }) => {
            element?.removeEventListener(event, handler);
        });
        this.listeners = [];
        logger.debug('Destruction DisquesManager (session conservée: ' + sessionDisksCache.length + ' ligne(s))');
    }

    focusSerialInput() {
        const inp = document.querySelector('#disques-session-tbody tr:last-child input[name="disques_serial"]');
        if (inp) inp.focus();
    }

    syncAllFromDom() {
        const tbody = document.getElementById('disques-session-tbody');
        if (!tbody) return;
        const rows = [...tbody.querySelectorAll('tr')];
        if (rows.length) {
            this.sessionDisks = rows.map(tr => this.readRow(tr));
        }
    }

    readRow(tr) {
        const autoDetected = tr.dataset.lsblk === '1';
        const serial = tr.querySelector('input[name="disques_serial"]')?.value?.trim() || '';
        const disk_type = tr.querySelector('select[name="disk_type"]')?.value?.trim() || '';
        const marqueSel = tr.querySelector('select[name="disques_marque"]');
        const marqueAutre = tr.querySelector('input[name="disques_marque_autre"]');
        let marque = '-';
        if (marqueSel?.value === VALUE_AUTRE && marqueAutre?.value?.trim()) {
            marque = marqueAutre.value.trim();
        } else if (marqueSel?.value && marqueSel.value !== VALUE_AUTRE) {
            const m = this.marques.find(x => String(x.id) === String(marqueSel.value));
            marque = m ? m.name : '-';
        }
        const modeleSel = tr.querySelector('select[name="disques_modele"]');
        const modeleAutre = tr.querySelector('input[name="disques_modele_autre"]');
        let modele = '-';
        if (modeleSel?.value === VALUE_AUTRE && modeleAutre?.value?.trim()) {
            modele = modeleAutre.value.trim();
        } else if (modeleSel?.value && modeleSel.value !== VALUE_AUTRE) {
            const m = this.modeles.find(x => String(x.id) === String(modeleSel.value));
            modele = m ? m.name : '-';
        }
        const sizeSel = tr.querySelector('select[name="disques_size"]');
        const sizeCustom = tr.querySelector('input[name="disques_size_custom"]');
        let size = '-';
        if (sizeSel?.value === 'autre' && sizeCustom?.value?.trim()) {
            size = sizeCustom.value.trim();
        } else if (sizeSel?.value) {
            size = sizeSel.value;
        }
        const interfaceVal = tr.querySelector('select[name="disques_interface"]')?.value || 'SATA';
        const destruction = tr.querySelector('.js-disques-destruction')?.checked === true;
        let shred = destruction ? 'Destruction physique' : '';
        const d = {
            serial,
            marque,
            modele,
            size,
            disk_type: disk_type || '-',
            interface: interfaceVal,
            shred,
            autoDetected
        };
        if (!d.shred) d.shred = getShredForDisk(d);
        return d;
    }

    buildMarqueCell(d) {
        const current = (d.marque || '').trim();
        let val = '';
        let autre = '';
        if (!current || current === '-') {
            val = '';
        } else {
            const m = this.marques.find(x => (x.name || '').trim() === current);
            if (m) val = String(m.id);
            else {
                val = VALUE_AUTRE;
                autre = escapeAttr(current);
            }
        }
        const opts = '<option value="">--</option>' +
            this.marques.map(m =>
                `<option value="${escapeHtml(String(m.id))}" ${String(m.id) === val ? 'selected' : ''}>${escapeHtml(m.name)}</option>`
            ).join('') +
            `<option value="${VALUE_AUTRE}" ${val === VALUE_AUTRE ? 'selected' : ''}>Autre</option>`;
        const showAutre = val === VALUE_AUTRE ? 'inline-block' : 'none';
        return `<select name="disques_marque" class="js-disques-marque">${opts}</select>` +
            `<input type="text" name="disques_marque_autre" class="type-other-input disques-marque-autre" style="display:${showAutre}" value="${autre}" placeholder="Autre marque" autocomplete="off">`;
    }

    buildModeleCell(d) {
        const marqueName = (d.marque || '').trim();
        const marque = this.marques.find(x => (x.name || '').trim() === marqueName);
        const marqueId = marque ? String(marque.id) : '';
        const modeleName = (d.modele || '').trim();
        let val = '';
        let autre = '';
        if (!modeleName || modeleName === '-') {
            val = '';
        } else if (marqueId) {
            const mo = this.modeles.find(x =>
                String(x.marque_id) === marqueId && (x.name || '').trim() === modeleName
            );
            if (mo) val = String(mo.id);
            else {
                val = VALUE_AUTRE;
                autre = escapeAttr(modeleName);
            }
        } else {
            val = VALUE_AUTRE;
            autre = escapeAttr(modeleName);
        }
        const filtered = marqueId
            ? this.modeles.filter(m => String(m.marque_id) === String(marqueId))
            : [];
        const opts = '<option value="">--</option>' +
            filtered.map(m =>
                `<option value="${escapeHtml(String(m.id))}" ${String(m.id) === val ? 'selected' : ''}>${escapeHtml(m.name)}</option>`
            ).join('') +
            `<option value="${VALUE_AUTRE}" ${val === VALUE_AUTRE ? 'selected' : ''}>Autre</option>`;
        const showAutre = val === VALUE_AUTRE ? 'inline-block' : 'none';
        return `<select name="disques_modele" class="js-disques-modele">${opts}</select>` +
            `<input type="text" name="disques_modele_autre" class="type-other-input disques-modele-autre" style="display:${showAutre}" value="${autre}" placeholder="Autre modèle" autocomplete="off">`;
    }

    buildSizeCell(d) {
        const raw = (d.size || '').trim();
        let selVal = '';
        let custom = '';
        if (!raw || raw === '-') {
            selVal = '';
        } else if (SIZE_PRESETS.includes(raw)) {
            selVal = raw;
        } else {
            selVal = 'autre';
            custom = escapeAttr(raw);
        }
        const opts = '<option value="">--</option>' +
            SIZE_PRESETS.map(p =>
                `<option value="${escapeHtml(p)}" ${selVal === p ? 'selected' : ''}>${escapeHtml(p)}</option>`
            ).join('') +
            `<option value="autre" ${selVal === 'autre' ? 'selected' : ''}>Autre</option>`;
        const showC = selVal === 'autre' ? 'inline-block' : 'none';
        return `<select name="disques_size">${opts}</select>` +
            `<input type="text" name="disques_size_custom" class="type-other-input" style="display:${showC}" value="${custom}" placeholder="Ex: 512 Go" autocomplete="off">`;
    }

    buildInterfaceSelect(d) {
        const dt = (d.disk_type || '').toUpperCase();
        const list = dt === 'HDD' ? INTERFACES_HDD : dt === 'SSD' ? INTERFACES_SSD : INTERFACES_ALL;
        let cur = (d.interface || 'SATA').trim();
        if (!list.some(o => o.value === cur)) cur = list[0]?.value || 'SATA';
        const opts = list.map(o =>
            `<option value="${escapeHtml(o.value)}" ${o.value === cur ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
        ).join('');
        return `<select name="disques_interface">${opts}</select>`;
    }

    buildRowHtml(d, i) {
        const serial = escapeHtml((d.serial || ''));
        const dt = (d.disk_type || '').trim();
        const diskTypeSelect =
            `<select name="disk_type" class="js-disques-disk-type">` +
            `<option value="">--</option>` +
            `<option value="HDD" ${dt === 'HDD' ? 'selected' : ''}>HDD</option>` +
            `<option value="SSD" ${dt === 'SSD' ? 'selected' : ''}>SSD</option>` +
            `</select>`;
        const destruct = (d.shred || '') === 'Destruction physique';
        const shredPreview = escapeHtml(d.shred || getShredForDisk(d));
        const lsblk = d.autoDetected ? '1' : '0';
        return `
            <tr data-row-index="${i}" data-lsblk="${lsblk}">
                <td data-label="Sélection"><input type="checkbox" class="row-checkbox js-disques-row-check" title="Sélectionner"></td>
                <td data-label="N°"><span>${i + 1}</span></td>
                <td data-label="S/N"><input type="text" name="disques_serial" value="${serial}" placeholder="S/N" autocomplete="off"></td>
                <td data-label="Type">${diskTypeSelect}</td>
                <td data-label="Marque"><div class="type-cell-wrapper">${this.buildMarqueCell(d)}</div></td>
                <td data-label="Modèle"><div class="type-cell-wrapper">${this.buildModeleCell(d)}</div></td>
                <td data-label="Taille"><div class="type-cell-wrapper">${this.buildSizeCell(d)}</div></td>
                <td data-label="Interface"><div class="type-cell-wrapper">${this.buildInterfaceSelect(d)}</div></td>
                <td data-label="Destr. phy."><label class="disques-row-dest-label" title="Destruction physique"><input type="checkbox" class="js-disques-destruction" ${destruct ? 'checked' : ''}></label></td>
                <td data-label="Shred"><span class="js-disques-shred-label disques-shred-text">${shredPreview}</span></td>
                <td data-label="Action"><button type="button" class="btn-delete-row" data-row-index="${i}" title="Supprimer la ligne"><i class="fa-solid fa-trash"></i></button></td>
            </tr>`;
    }

    renderSessionTable() {
        const tbody = document.getElementById('disques-session-tbody');
        const selAll = document.getElementById('disques-select-all');
        if (!tbody) return;
        tbody.innerHTML = this.sessionDisks.map((d, i) => this.buildRowHtml(d, i)).join('');
        if (selAll) selAll.checked = false;
        this.updateSaveButtonState();
    }

    updateSaveButtonState() {
        const btn = document.getElementById('disques-btn-save');
        if (btn) {
            btn.disabled = !this.sessionDisks.some(d => (d.serial || '').trim());
        }
    }

    updateShredCell(tr) {
        const d = this.readRow(tr);
        const span = tr.querySelector('.js-disques-shred-label');
        if (span) span.textContent = d.shred || '-';
    }

    populateModeleSelect(tr, marqueId) {
        const sel = tr.querySelector('select[name="disques_modele"]');
        const autre = tr.querySelector('.disques-modele-autre');
        if (!sel) return;
        const current = sel.value;
        const filtered = marqueId && marqueId !== VALUE_AUTRE
            ? this.modeles.filter(m => String(m.marque_id) === String(marqueId))
            : [];
        sel.innerHTML = '<option value="">--</option>' +
            filtered.map(m =>
                `<option value="${escapeHtml(String(m.id))}">${escapeHtml(m.name)}</option>`
            ).join('') +
            `<option value="${VALUE_AUTRE}">Autre</option>`;
        if (current && Array.from(sel.options).some(o => o.value === current)) sel.value = current;
        else sel.value = '';
        if (autre) {
            autre.style.display = sel.value === VALUE_AUTRE ? 'inline-block' : 'none';
            if (sel.value !== VALUE_AUTRE) autre.value = '';
        }
    }

    refillInterfaceSelect(tr) {
        const typeSel = tr.querySelector('select[name="disk_type"]');
        const iface = tr.querySelector('select[name="disques_interface"]');
        if (!typeSel || !iface) return;
        const dt = (typeSel.value || '').toUpperCase();
        const list = dt === 'HDD' ? INTERFACES_HDD : dt === 'SSD' ? INTERFACES_SSD : INTERFACES_ALL;
        const cur = iface.value;
        iface.innerHTML = list.map(o =>
            `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`
        ).join('');
        iface.value = list.some(o => o.value === cur) ? cur : (list[0]?.value || 'SATA');
    }

    handleTableChange(e) {
        const t = e.target;
        const tr = t.closest('tr');
        if (!tr || !tr.closest('#disques-session-tbody')) return;

        if (t.matches('select[name="disques_marque"]')) {
            const autre = tr.querySelector('.disques-marque-autre');
            if (autre) {
                autre.style.display = t.value === VALUE_AUTRE ? 'inline-block' : 'none';
                if (t.value !== VALUE_AUTRE) autre.value = '';
            }
            this.populateModeleSelect(tr, t.value === VALUE_AUTRE ? '' : t.value);
        }
        if (t.matches('select[name="disques_modele"]')) {
            const autre = tr.querySelector('.disques-modele-autre');
            if (autre) {
                autre.style.display = t.value === VALUE_AUTRE ? 'inline-block' : 'none';
                if (t.value !== VALUE_AUTRE) autre.value = '';
            }
        }
        if (t.matches('select[name="disk_type"]')) {
            this.refillInterfaceSelect(tr);
        }
        if (t.matches('select[name="disques_size"]')) {
            const cust = tr.querySelector('input[name="disques_size_custom"]');
            if (cust) {
                cust.style.display = t.value === 'autre' ? 'inline-block' : 'none';
                if (t.value !== 'autre') cust.value = '';
            }
        }
        this.updateShredCell(tr);
    }

    removeDiskAt(index) {
        this.syncAllFromDom();
        if (index < 0 || index >= this.sessionDisks.length) return;

        const removed = { ...this.sessionDisks[index] };
        const hadSingleEmpty = this.sessionDisks.length === 1 && !(removed.serial || '').trim();

        this.sessionDisks.splice(index, 1);
        const addedPlaceholder = !this.sessionDisks.length;
        if (addedPlaceholder) this.sessionDisks.push(emptyDisk());
        this.renderSessionTable();
        this.focusSerialInput();

        if (hadSingleEmpty) return;

        window.app?.showNotification?.('Ligne supprimée', 'success', {
            onUndo: () => {
                if (addedPlaceholder && this.sessionDisks.length === 1 && !(this.sessionDisks[0].serial || '').trim()) {
                    this.sessionDisks.length = 0;
                }
                this.sessionDisks.splice(index, 0, removed);
                this.renderSessionTable();
                this.focusSerialInput();
            }
        });
    }

    addDisk(diskOrSerial, interfaceOrUndef, sizeOrUndef, fromLsblk = false) {
        let d;
        if (diskOrSerial && typeof diskOrSerial === 'object') {
            d = {
                serial: (diskOrSerial.serial || '').trim(),
                marque: (diskOrSerial.marque || '').trim() || '-',
                modele: (diskOrSerial.modele || '').trim() || '-',
                size: (diskOrSerial.size || '').trim() || '-',
                disk_type: (diskOrSerial.disk_type || '').trim() || '',
                interface: (diskOrSerial.interface || '').trim() || 'SATA',
                shred: (diskOrSerial.shred || '').trim() || '',
                autoDetected: !!diskOrSerial.autoDetected || !!fromLsblk
            };
            if (diskOrSerial.physicalDestruction === true) d.shred = 'Destruction physique';
            else if (!d.shred) d.shred = getShredForDisk(d);
        } else {
            d = {
                serial: (diskOrSerial || '').trim(),
                marque: '-',
                modele: '-',
                size: (sizeOrUndef || '').trim() || '-',
                disk_type: '-',
                interface: (interfaceOrUndef || 'SATA').trim(),
                shred: '',
                autoDetected: false
            };
            d.shred = getShredForDisk(d);
        }
        if (!d.serial) {
            window.app?.showNotification?.('Saisissez un numéro de série', 'warning');
            return;
        }
        const serialNorm = d.serial.toUpperCase();
        if (this.sessionDisks.some(ex => (ex.serial || '').trim().toUpperCase() === serialNorm)) {
            window.app?.showNotification?.('Déjà scanné', 'warning');
            return;
        }
        this.syncAllFromDom();
        this.sessionDisks.push(d);
        this.renderSessionTable();
        this.focusSerialInput();
        window.app?.showNotification?.('Disque ajouté', 'success');
    }

    addManualLine() {
        this.syncAllFromDom();
        this.sessionDisks.push(emptyDisk());
        this.renderSessionTable();
        this.focusSerialInput();
        window.app?.showNotification?.('Ligne ajoutée', 'success');
    }

    async submitNewMarque() {
        const input = document.getElementById('disques-input-new-marque');
        if (!input?.value?.trim()) {
            window.app?.showNotification?.('Veuillez saisir un nom de marque', 'warning');
            return;
        }
        const newMarque = input.value.trim();
        const exists = this.marques.some(m => (m.name || '').trim().toLowerCase() === newMarque.toLowerCase());
        if (exists) {
            window.app?.showNotification?.('Cette marque existe déjà', 'warning');
            return;
        }
        try {
            const response = await api.post('marques.list', { name: newMarque });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const data = await response.json();
            this.marques.push({ id: data.id || this.marques.length + 1, name: newMarque });
            window.app?.showNotification?.(`Marque "${newMarque}" ajoutée`, 'success');
            this.modalManager?.close?.('disques-modal-add-marque');
            input.value = '';
            this.syncAllFromDom();
            this.renderSessionTable();
        } catch (err) {
            logger.error('submitNewMarque:', err);
            window.app?.showNotification?.(err?.message || 'Erreur lors de l\'ajout de la marque', 'error');
        }
    }

    async submitNewModele() {
        const selectMarque = document.getElementById('disques-select-marque-for-modele');
        const inputModele = document.getElementById('disques-input-new-modele');
        if (!selectMarque?.value || !inputModele?.value?.trim()) {
            window.app?.showNotification?.('Veuillez choisir une marque et saisir un modèle', 'warning');
            return;
        }
        const marqueId = selectMarque.value;
        const newModele = inputModele.value.trim();
        const exists = this.modeles.some(m =>
            m.marque_id == marqueId && (m.name || '').trim().toLowerCase() === newModele.toLowerCase()
        );
        if (exists) {
            window.app?.showNotification?.('Ce modèle existe déjà pour cette marque', 'warning');
            return;
        }
        try {
            const serverUrl = api.getServerUrl();
            const url = `${serverUrl}/api/marques/${marqueId}/modeles`;
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('workspace_jwt') || ''}`
                },
                body: JSON.stringify({ name: newModele })
            });
            if (!res.ok) throw new Error(await res.text().catch(() => 'HTTP ' + res.status));
            const data = await res.json();
            this.modeles.push({
                id: data.id || this.modeles.length + 1,
                name: newModele,
                marque_id: parseInt(marqueId, 10)
            });
            window.app?.showNotification?.(`Modèle "${newModele}" ajouté`, 'success');
            this.modalManager?.close?.('disques-modal-add-modele');
            inputModele.value = '';
            selectMarque.value = '';
            this.syncAllFromDom();
            this.renderSessionTable();
        } catch (err) {
            logger.error('submitNewModele:', err);
            window.app?.showNotification?.(err?.message || 'Erreur lors de l\'ajout du modèle', 'error');
        }
    }

    setupEventListeners() {
        const table = document.getElementById('disques-session-table');
        if (table) {
            const onChange = e => this.handleTableChange(e);
            table.addEventListener('change', onChange);
            this.listeners.push({ element: table, event: 'change', handler: onChange });
            // Activer/désactiver "Enregistrer" dès la saisie (le bouton est disabled par défaut dans le HTML).
            const onInput = () => {
                this.syncAllFromDom();
                this.updateSaveButtonState();
            };
            table.addEventListener('input', onInput);
            this.listeners.push({ element: table, event: 'input', handler: onInput });
            const onClick = e => {
                const btn = e.target.closest('.btn-delete-row');
                if (!btn || !table.contains(btn)) return;
                const idx = parseInt(btn.dataset.rowIndex, 10);
                if (!Number.isNaN(idx)) this.removeDiskAt(idx);
            };
            table.addEventListener('click', onClick);
            this.listeners.push({ element: table, event: 'click', handler: onClick });
        }

        const selAll = document.getElementById('disques-select-all');
        if (selAll) {
            this.addListener(selAll, 'change', () => {
                document.querySelectorAll('#disques-session-tbody .js-disques-row-check').forEach(c => {
                    c.checked = selAll.checked;
                });
            });
        }

        this._onSerialEnter = e => {
            if (e.target.name !== 'disques_serial' || e.key !== 'Enter') return;
            if (!e.target.closest('#disques-session-tbody')) return;
            const sn = (e.target.value || '').trim();
            if (!sn) return;
            e.preventDefault();
            e.stopPropagation();
            this.syncAllFromDom();
            const tbody = document.getElementById('disques-session-tbody');
            const row = e.target.closest('tr');
            const rows = [...tbody.querySelectorAll('tr')];
            const idx = rows.indexOf(row);
            const dup = this.sessionDisks.some((d, i) =>
                i !== idx && (d.serial || '').trim().toUpperCase() === sn.toUpperCase()
            );
            if (dup) {
                window.app?.showNotification?.('S/N déjà présent', 'warning');
                return;
            }
            this.sessionDisks.splice(idx + 1, 0, emptyDisk());
            this.renderSessionTable();
            const newRows = [...tbody.querySelectorAll('tr')];
            const focusEl = newRows[idx + 1]?.querySelector('input[name="disques_serial"]');
            if (focusEl) {
                focusEl.focus();
                focusEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
            window.app?.showNotification?.('S/N enregistré, prêt pour le prochain scan', 'success');
        };
        document.addEventListener('keydown', this._onSerialEnter);

        this._onBarcodeKeydown = e => {
            if (!document.getElementById('disques-session-tbody')) return;
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
            if (e.key === 'Enter' && this._barcodeBuf.length > 3) {
                const code = this._barcodeBuf.trim();
                this._barcodeBuf = '';
                clearTimeout(this._barcodeTimer);
                this.addDiskFromBarcode(code);
                return;
            }
            if (e.key.length === 1) {
                this._barcodeBuf += e.key;
                clearTimeout(this._barcodeTimer);
                this._barcodeTimer = setTimeout(() => {
                    this._barcodeBuf = '';
                }, 100);
            }
        };
        document.addEventListener('keydown', this._onBarcodeKeydown);

        const btnAddLine = document.getElementById('disques-btn-add-line');
        if (btnAddLine) this.addListener(btnAddLine, 'click', () => this.addManualLine());

        const btnAddMarque = document.getElementById('disques-btn-add-marque');
        if (btnAddMarque) this.addListener(btnAddMarque, 'click', () => this.modalManager?.open?.('disques-modal-add-marque'));
        const btnAddModele = document.getElementById('disques-btn-add-modele');
        if (btnAddModele) {
            this.addListener(btnAddModele, 'click', () => {
                const sel = document.getElementById('disques-select-marque-for-modele');
                if (sel) {
                    sel.innerHTML = '<option value="">-- Sélectionner une marque --</option>' +
                        this.marques.map(m =>
                            `<option value="${escapeHtml(String(m.id))}">${escapeHtml(m.name)}</option>`
                        ).join('');
                }
                this.modalManager?.open?.('disques-modal-add-modele');
            });
        }
        const btnSubmitMarque = document.getElementById('disques-btn-submit-marque');
        if (btnSubmitMarque) this.addListener(btnSubmitMarque, 'click', () => this.submitNewMarque());
        const btnSubmitModele = document.getElementById('disques-btn-submit-modele');
        if (btnSubmitModele) this.addListener(btnSubmitModele, 'click', () => this.submitNewModele());

        const btnLsblk = document.getElementById('disques-btn-lsblk');
        if (btnLsblk) this.addListener(btnLsblk, 'click', () => this.runLsblk());

        const btnNewSession = document.getElementById('disques-btn-new-session');
        if (btnNewSession) {
            this.addListener(btnNewSession, 'click', () => {
                this.sessionDisks = [emptyDisk()];
                this.renderSessionTable();
                const sa = document.getElementById('disques-select-all');
                if (sa) sa.checked = false;
                this.focusSerialInput();
                window.app?.showNotification?.('Nouvelle session', 'info');
            });
        }

        const btnSave = document.getElementById('disques-btn-save');
        if (btnSave) this.addListener(btnSave, 'click', () => this.saveSession());

        const lsblkAddSelected = document.getElementById('lsblk-btn-add-selected');
        if (lsblkAddSelected) this.addListener(lsblkAddSelected, 'click', () => this.addLsblkSelected());
    }

    addDiskFromBarcode(serial) {
        if (!serial) return;
        this.syncAllFromDom();
        const norm = serial.toUpperCase();
        if (this.sessionDisks.some(d => (d.serial || '').trim().toUpperCase() === norm)) {
            window.app?.showNotification?.('S/N déjà scanné', 'warning');
            return;
        }
        this.addDisk({
            serial,
            marque: '-',
            modele: '-',
            size: '-',
            disk_type: '',
            interface: 'SATA',
            autoDetected: false
        });
    }

    async runLsblk() {
        if (typeof window.electron?.invoke !== 'function') {
            window.app?.showNotification?.('Détection automatique disponible uniquement dans l\'application desktop (Linux).', 'warning');
            return;
        }
        try {
            const result = await window.electron.invoke('run-lsblk', {});
            if (!result.success) {
                window.app?.showNotification?.(result.error || 'Détection échouée', 'error');
                return;
            }
            const disks = result.disks || [];
            if (!disks.length) {
                window.app?.showNotification?.('Aucun disque détecté', 'info');
                return;
            }
            this.lsblkPendingDisks = disks;
            this.openLsblkModal(disks);
        } catch (err) {
            logger.error('run-lsblk:', err?.message ?? String(err));
            window.app?.showNotification?.(err?.message || 'Erreur détection automatique', 'error');
        }
    }

    openLsblkModal(disks) {
        const listEl = document.getElementById('lsblk-disks-list');
        if (!listEl) return;
        listEl.innerHTML = disks.map((d, i) => {
            const meta = [d.disk_type || '', d.type || '', d.size || ''].filter(Boolean).join(' · ');
            const modelVendor = [d.vendor, d.model].filter(Boolean).join(' ');
            return `
            <label class="lsblk-disk-row">
                <input type="checkbox" class="lsblk-disk-check" data-index="${i}" checked>
                <span>${escapeHtml(d.serial || d.name || '-')}</span>
                <span class="lsblk-disk-meta">${escapeHtml(meta)}${modelVendor ? ' · ' + escapeHtml(modelVendor) : ''}</span>
            </label>
        `;
        }).join('');
        this.modalManager?.open?.('modal-lsblk-disks');
    }

    addLsblkSelected() {
        const listEl = document.getElementById('lsblk-disks-list');
        if (!listEl) return;
        this.syncAllFromDom();
        const checked = listEl.querySelectorAll('.lsblk-disk-check:checked');
        let added = 0;
        checked.forEach(cb => {
            const i = parseInt(cb.dataset.index, 10);
            const src = this.lsblkPendingDisks[i];
            if (!src) return;
            const serial = (src.serial || src.name || '').trim();
            if (!serial) return;
            const norm = serial.toUpperCase();
            if (this.sessionDisks.some(ex => (ex.serial || '').trim().toUpperCase() === norm)) return;
            const row = {
                serial,
                marque: (src.vendor || '').trim() || '-',
                modele: (src.model || '').trim() || '-',
                size: (src.size || '').trim() || '-',
                disk_type: (src.disk_type || '').trim() || '-',
                interface: (src.type || 'SATA').trim(),
                shred: '',
                autoDetected: true
            };
            row.shred = getShredForDisk(row);
            this.sessionDisks.push(row);
            added += 1;
        });
        this.modalManager?.close?.('modal-lsblk-disks');
        this.lsblkPendingDisks = [];
        if (added) {
            this.renderSessionTable();
            this.focusSerialInput();
            window.app?.showNotification?.(`${added} disque(s) ajouté(s)`, 'success');
        }
    }

    async saveSession() {
        this.syncAllFromDom();
        const filled = this.sessionDisks.filter(d => (d.serial || '').trim());
        if (!filled.length) {
            window.app?.showNotification?.('Aucun disque à enregistrer (S/N requis)', 'warning');
            return;
        }
        const serials = filled.map(d => (d.serial || '').trim().toUpperCase());
        if (new Set(serials).size !== serials.length) {
            window.app?.showNotification?.('Des numéros de série sont en doublon', 'warning');
            return;
        }
        if (this._savingSession) return;
        this._savingSession = true;
        const nameEl = document.getElementById('disques-session-name');
        const sessionName = (nameEl && nameEl.value) ? nameEl.value.trim() : '';
        const dateStr = new Date().toISOString().slice(0, 10);
        const btnSave = document.getElementById('disques-btn-save');
        if (btnSave) btnSave.disabled = true;
        try {
            const disksPayload = filled.map(({ autoDetected, ...rest }) => rest);
            const session = await createSession({ name: sessionName || undefined, date: dateStr, disks: disksPayload });
            this.sessionDisks = [emptyDisk()];
            this.renderSessionTable();
            if (nameEl) nameEl.value = '';
            window.app?.showNotification?.('Session enregistrée en traçabilité', 'success');

            if (window.electron?.invoke && session?.id) {
                const basePath = '/mnt/team/#TEAM/#TRAÇABILITÉ';
                try {
                    window.app?.showNotification?.('Génération du PDF...', 'info');
                    const result = await window.electron.invoke('generate-disques-pdf', {
                        sessionId: session.id,
                        date: session.date || dateStr,
                        name: session.name ?? sessionName,
                        disks: session.disks || disksPayload,
                        basePath
                    });
                    if (result?.success && result.pdf_path) {
                        const readResult = await window.electron.invoke('read-file-as-base64', { path: result.pdf_path });
                        if (readResult?.success && readResult.base64) {
                            const serverUrl = api.getServerUrl();
                            const res = await fetch(`${serverUrl}/api/disques/sessions/${session.id}/pdf`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${localStorage.getItem('workspace_jwt') || ''}`
                                },
                                body: JSON.stringify({
                                    pdf_base64: readResult.base64,
                                    session_name: session.name ?? sessionName,
                                    date: session.date || dateStr,
                                    save_path_hint: basePath
                                })
                            });
                            if (res.ok) {
                                window.app?.showNotification?.('PDF généré et enregistré', 'success');
                            } else {
                                window.app?.showNotification?.('PDF généré en local ; envoi serveur à configurer (POST /api/disques/sessions/:id/pdf)', 'warning');
                            }
                        }
                    }
                } catch (pdfErr) {
                    logger.error('Génération PDF disques après create:', pdfErr);
                    window.app?.showNotification?.(pdfErr?.message || 'PDF non généré (disponible dans l\'app desktop)', 'warning');
                }
            }
        } catch (err) {
            logger.error('createSession:', err);
            window.app?.showNotification?.(err?.message || 'Erreur lors de l\'enregistrement', 'error');
        } finally {
            this._savingSession = false;
            this.updateSaveButtonState();
        }
    }
}

function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
}

function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
