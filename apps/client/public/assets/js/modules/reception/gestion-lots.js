/**
 * GESTION DES LOTS - MODULE JS
 * Gère la saisie des lots de matériel reconditionné
 * Vanilla JS ES6+ - Pas de frameworks
 */

import api from '../../config/api.js';
import getLogger from '../../config/Logger.js';
import { showAppNotification } from '../../config/notifications.js';
const logger = getLogger();


export default class GestionLotsManager {
    constructor(modalManager) {
        this.modalManager = modalManager;
        this.currentRowNumber = 1;
        this.marques = [];
        this.modeles = [];
        this.lots = [];
        this.listeners = [];
        this._barcodeBuffer = '';
        this._barcodeTimer = null;
        this._lastSerialEnterAt = 0;
        
        this.init();
    }

    /**
     * Initialisation
     */
    async init() {
        logger.debug('🚀 Initialisation GestionLotsManager');
        
        await this.loadReferenceData();
        this.setupEventListeners();
        
        // Ajouter une première ligne par défaut SCAN pour le scan
        setTimeout(() => {
            const tbody = document.getElementById('lot-table-body');
            if (tbody) {
                const row = this.createRow('', 'scan');
                tbody.appendChild(row);
                logger.debug('➕ Ligne SCAN initiale ajoutée');
                
                // AutoFocus sur le S/N de la première ligne
                const snInput = row.querySelector('input[name="serial_number"]');
                if (snInput) {
                    snInput.focus();
                    logger.debug('✅ AutoFocus sur S/N de la première ligne');
                }
                this.updateLotUI();
            }
        }, 500);
        logger.debug('✅ GestionLotsManager prêt');
    }

    /**
     * Charger les données de référence (marques, modèles) depuis l'API
     */
    async loadReferenceData() {
        try {
            // Charger les marques
            const marquesRes = await api.get('marques.list');
            if (!marquesRes.ok) throw new Error('Erreur chargement marques');
            const marquesData = await marquesRes.json();
            // Gérer les deux formats : tableau direct ou avec wrapper
            this.marques = Array.isArray(marquesData) ? marquesData : (marquesData.items || marquesData.marques || []);
            logger.debug('Marques chargées:', this.marques);
            
            // Charger tous les modèles avec leurs marques
            const modelesRes = await api.get('marques.all');
            if (!modelesRes.ok) {
                // Endpoint alternatif si /all n'existe pas
                throw new Error('Endpoint modèles non trouvé');
            }
            const modelesData = await modelesRes.json();
            
            // Parser la structure imbriquée : [{id, name, modeles: [{id, name}]}]
            // Pour créer un tableau plat avec marque_id
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
            
            logger.debug('📦 Données chargées:', this.marques.length, 'marques', this.modeles.length, 'modèles');
            logger.debug('Modèles avec marque_id:', this.modeles);
            
            // Remplir les selects de marques
            this.updateMarqueSelects();
        } catch (error) {
            logger.error('❌ Erreur chargement données:', error);
            // Charger données par défaut en cas d'erreur
            this.loadDefaultData();
        }
    }

    /**
     * Charger données par défaut (fallback)
     */
    loadDefaultData() {
        this.marques = [
            { id: 1, name: 'Dell' },
            { id: 2, name: 'HP' },
            { id: 3, name: 'Lenovo' }
        ];
        this.modeles = [
            { id: 1, name: 'Latitude 5410', marque_id: 1 },
            { id: 2, name: 'ProBook 450', marque_id: 2 },
            { id: 3, name: 'ThinkPad T14', marque_id: 3 }
        ];
        logger.debug('ℹ️ Données par défaut chargées');
        this.updateMarqueSelects();
    }

    /**
     * Mettre à jour tous les selects de marques
     */
    updateMarqueSelects() {
        const selects = document.querySelectorAll('select[name="marque"], #select-marque-for-modele');
        selects.forEach(select => {
            const currentValue = select.value;
            select.innerHTML = '<option value="">-- Sélectionner une marque --</option>';
            this.marques.forEach(marque => {
                const option = document.createElement('option');
                option.value = marque.id;
                option.textContent = marque.name;
                select.appendChild(option);
            });
            select.value = currentValue;
        });
    }

    /**
     * Mettre à jour les modèles basé sur la marque sélectionnée
     */
    updateModeleSelect(marqueId, selectElement) {
        if (!marqueId || !selectElement) return;
        
        const currentValue = selectElement.value;
        logger.debug('Filtrage modèles pour marque:', { marqueId, totalModeles: this.modeles.length, currentValue });
        const filteredModeles = this.modeles.filter(m => m.marque_id == marqueId);
        logger.debug('Modèles filtrés:', { count: filteredModeles.length, modeles: filteredModeles });
        
        selectElement.innerHTML = '<option value="">Modèle...</option>';
        filteredModeles.forEach(modele => {
            const option = document.createElement('option');
            option.value = modele.id;
            option.textContent = modele.name;
            if (modele.id == currentValue) {
                option.selected = true;
            }
            selectElement.appendChild(option);
        });
        
        // Restaurer la valeur si elle existe toujours
        if (currentValue && Array.from(selectElement.options).some(opt => opt.value == currentValue)) {
            selectElement.value = currentValue;
        }
        
        if (filteredModeles.length === 0) {
            logger.warn('Aucun modèle trouvé pour la marque:', marqueId);
        }
    }

    addListener(element, event, handler) {
        if (!element) return;
        element.addEventListener(event, handler);
        this.listeners.push({ element, event, handler });
    }

    /**
     * Configuration des événements (nettoyables via destroy)
     */
    setupEventListeners() {
        logger.debug('🔧 Configuration événements');

        const attachButton = (id, handler) => {
            const btn = document.getElementById(id);
            if (!btn) {
                logger.warn(`⚠️ ${id} non trouvé`);
                return;
            }
            this.addListener(btn, 'click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                logger.debug(`🖱️ Clic sur ${id}`);
                handler();
            });
            logger.debug(`✅ ${id} attaché`);
        };

        setTimeout(() => {
            attachButton('btn-add-manual', () => this.addManualRow());
            attachButton('btn-save-lot', () => this.saveLot());
            attachButton('btn-cancel-lot', () => this.cancelLot());
            attachButton('btn-submit-marque', () => this.submitNewMarque());
            attachButton('btn-submit-modele', () => this.submitNewModele());
            attachButton('btn-confirm-clear-lot', () => this.confirmCancelLot());
            attachButton('btn-apply-mass', () => this.applyMassValues());
            attachButton('btn-confirm-mass-apply', () => this.confirmMassApply());

            const selectMarque = document.getElementById('select-marque-for-modele');
            if (selectMarque) {
                this.addListener(selectMarque, 'change', (e) => {
                    logger.debug('📦 Marque sélectionnée pour modèle:', e.target.value);
                });
            }

            const selectAll = document.getElementById('select-all');
            if (selectAll) {
                this.addListener(selectAll, 'change', (e) => {
                    document.querySelectorAll('.row-checkbox').forEach(cb => {
                        cb.checked = e.target.checked;
                    });
                    this.updateSelectionBar();
                });
            }

            const tbody = document.getElementById('lot-table-body');
            if (tbody) {
                this._onRowCheckboxChange = (e) => {
                    if (!e.target.classList?.contains('row-checkbox')) return;
                    this.updateSelectionBar();
                };
                this.addListener(tbody, 'change', this._onRowCheckboxChange);
            }

            this.populateMassSelects();

            const modalMassType = document.getElementById('modal-mass-type');
            const modalMassTypeOther = document.getElementById('modal-mass-type-other');
            if (modalMassType && modalMassTypeOther) {
                this.addListener(modalMassType, 'change', () => {
                    const isAutres = modalMassType.value === 'autres';
                    modalMassTypeOther.style.display = isAutres ? 'block' : 'none';
                    modalMassTypeOther.required = isAutres;
                    if (!isAutres) modalMassTypeOther.value = '';
                });
            }

            const btnAddModele = document.getElementById('btn-add-modele');
            if (btnAddModele) {
                this.addListener(btnAddModele, 'click', () => {
                    setTimeout(() => this.populateMarqueSelect(), 150);
                });
            }
        }, 300);

        this._onMarqueChange = (e) => {
            if (e.target.name !== 'marque' || !e.target.closest('#lot-table-body')) return;
            const row = e.target.closest('tr');
            if (!row) return;
            const modeleSelect = row.querySelector('select[name="modele"]');
            const selectedMarqueId = e.target.value;
            if (!modeleSelect) return;
            if (selectedMarqueId) {
                this.updateModeleSelect(selectedMarqueId, modeleSelect);
            } else {
                modeleSelect.innerHTML = '<option value="">Modèle...</option>';
                modeleSelect.value = '';
            }
        };
        document.addEventListener('change', this._onMarqueChange);

        this._onBarcodeKeydown = (e) => {
            if (!document.getElementById('lot-table-body')) return;
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

            if (e.key === 'Enter' && this._barcodeBuffer.length > 3) {
                e.preventDefault();
                e.stopPropagation();
                const code = this._barcodeBuffer.trim();
                this._barcodeBuffer = '';
                clearTimeout(this._barcodeTimer);
                this.addRowFromScan(code);
                return;
            }
            if (e.key.length === 1) {
                this._barcodeBuffer += e.key;
                clearTimeout(this._barcodeTimer);
                this._barcodeTimer = setTimeout(() => {
                    this._barcodeBuffer = '';
                }, 100);
            }
        };
        document.addEventListener('keydown', this._onBarcodeKeydown);

        this._onSerialEnter = (e) => {
            if (e.target.name !== 'serial_number' || e.key !== 'Enter') return;
            if (!e.target.closest('#lot-table-body')) return;

            const now = Date.now();
            if (now - this._lastSerialEnterAt < 300) return;
            this._lastSerialEnterAt = now;

            const snInput = e.target;
            const value = (snInput.value || '').trim();
            if (!value) return;

            e.preventDefault();
            e.stopPropagation();

            const tbody = document.getElementById('lot-table-body');
            const row = snInput.closest('tr');
            if (!tbody || !row) return;

            if (this.isDuplicateSerial(value, row)) {
                this.showNotification(`S/N déjà présent: ${value}`, 'warning');
                return;
            }

            const newRow = this.createRow('', 'scan');
            tbody.appendChild(newRow);
            const newSnInput = newRow.querySelector('input[name="serial_number"]');
            if (newSnInput) {
                newSnInput.focus();
                newSnInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
            this.updateLotUI();
            this.showNotification('S/N enregistré, prêt pour le prochain scan', 'success');
        };
        document.addEventListener('keydown', this._onSerialEnter);

        logger.debug('✅ Événements configurés');
    }

    isDuplicateSerial(serial, excludeRow = null) {
        const tbody = document.getElementById('lot-table-body');
        if (!tbody) return false;
        const normalized = serial.trim().toUpperCase();
        return [...tbody.querySelectorAll('tr')].some(r => {
            if (r === excludeRow) return false;
            const other = r.querySelector('input[name="serial_number"]');
            return other && other.value.trim().toUpperCase() === normalized;
        });
    }

    /**
     * Ajouter une ligne depuis un scan
     */
    addRowFromScan(serialNumber) {
        logger.debug('📷 Scan détecté:', serialNumber);

        const value = (serialNumber || '').trim();
        if (!value) {
            logger.warn('⚠️ S/N vide');
            return;
        }

        const tbody = document.getElementById('lot-table-body');
        if (!tbody) return;

        if (this.isDuplicateSerial(value)) {
            logger.warn('⚠️ Doublon détecté:', value);
            this.showNotification(`S/N déjà scanné: ${value}`, 'warning');
            return;
        }

        const row = this.createRow(value, 'scan');
        tbody.appendChild(row);

        const snInput = row.querySelector('input[name="serial_number"]');
        if (snInput) {
            snInput.focus();
            snInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        this.flashScanPanel();
        this.updateLotUI();
        this.showNotification('Appareil scanné ajouté', 'success');
    }

    /**
     * Ajouter une ligne manuellement
     */
    addManualRow() {
        logger.debug('➕ Ajout manuel');
        
        const tbody = document.getElementById('lot-table-body');
        if (!tbody) return;

        const row = this.createRow('', 'manual');
        tbody.appendChild(row);
        
        // Focus sur le champ S/N
        const snInput = row.querySelector('input[name="serial_number"]');
        if (snInput) snInput.focus();

        this.updateLotUI();
        this.showNotification('Ligne ajoutée', 'success');
    }

    /**
     * Créer une ligne de tableau
     */
    createRow(serialNumber = '', entryType = 'manual') {
        const row = document.createElement('tr');
        const now = new Date();
        const rowNum = this.currentRowNumber++;
        const escSn = (serialNumber || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

        row.innerHTML = `
            <td data-label="Sélection">
                <input type="checkbox" class="row-checkbox" title="Sélectionner cette ligne">
            </td>
            <td data-label="N°">
                <span>${rowNum}</span>
            </td>
            <td data-label="S/N">
                <input type="text" name="serial_number" value="${escSn}" placeholder="S/N" required>
            </td>
            <td data-label="Type">
                <div class="type-cell-wrapper">
                    <select name="type" required>
                        <option value="">Type...</option>
                        <option value="portable">Portable</option>
                        <option value="fixe">Fixe</option>
                        <option value="ecran">Écran</option>
                        <option value="autres">Autres</option>
                    </select>
                    <input type="text" name="type_other" class="type-other-input" placeholder="Précisez..." style="display: none;" maxlength="100">
                </div>
            </td>
            <td data-label="Marque">
                <select name="marque" required>
                    <option value="">Marque...</option>
                    ${this.marques.map(m => `<option value="${m.id}">${m.name}</option>`).join('')}
                </select>
            </td>
            <td data-label="Modèle">
                <select name="modele" required>
                    <option value="">Modèle...</option>
                </select>
            </td>
            <td data-label="Date / Heure">
                <span class="row-date-display">${now.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${now.toTimeString().slice(0, 5)}</span>
            </td>
            <td data-label="Entrée">
                <span class="entry-badge ${entryType}">${entryType === 'scan' ? 'SCAN' : 'MANUEL'}</span>
            </td>
            <td data-label="Action">
                <button type="button" class="btn-delete-row" title="Supprimer cette ligne">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </td>
            <td class="lot-table__meta" hidden aria-hidden="true">
                <input type="hidden" name="date" value="${now.toISOString().split('T')[0]}">
                <input type="hidden" name="time" value="${now.toTimeString().slice(0, 5)}">
            </td>
        `;
        
        // Attacher les événements
        const deleteBtn = row.querySelector('.btn-delete-row');
        const typeSelect = row.querySelector('select[name="type"]');
        const typeOtherInput = row.querySelector('input[name="type_other"]');
        const marqueSelect = row.querySelector('select[name="marque"]');
        const modeleSelect = row.querySelector('select[name="modele"]');
        
        // Afficher/masquer "Précisez" quand Type = Autres
        if (typeSelect && typeOtherInput) {
            typeSelect.addEventListener('change', () => {
                const isAutres = typeSelect.value === 'autres';
                typeOtherInput.style.display = isAutres ? 'inline-block' : 'none';
                typeOtherInput.required = isAutres;
                if (isAutres) typeOtherInput.focus();
                else typeOtherInput.value = '';
            });
        }
        
        // Événement changement de marque - FILTRE LES MODÈLES
        if (marqueSelect) {
            marqueSelect.addEventListener('change', (e) => {
                const selectedMarqueId = e.target.value;
                if (selectedMarqueId) {
                    logger.debug('Marque sélectionnée dans ligne:', selectedMarqueId);
                    this.updateModeleSelect(selectedMarqueId, modeleSelect);
                } else {
                    // Aucune marque sélectionnée, vider le select de modèles
                    modeleSelect.innerHTML = '<option value="">Modèle...</option>';
                    modeleSelect.value = '';
                }
            });
        }
        
        // Événement suppression
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => this.deleteRow(row));
        }

        return row;
    }

    /**
     * Enregistrer le lot
     */
    async saveLot() {
        logger.debug('💾 Enregistrement du lot');
        
        const tbody = document.getElementById('lot-table-body');
        if (!tbody) return;

        const rows = tbody.querySelectorAll('tr');
        if (rows.length === 0) {
            this.showNotification('Aucune ligne à enregistrer', 'error');
            return;
        }

        const lotData = [];
        let isValid = true;

        rows.forEach((row, index) => {
            const snInput = row.querySelector('[name="serial_number"]');
            const typeSelect = row.querySelector('[name="type"]');
            const typeOtherInput = row.querySelector('[name="type_other"]');
            const marqueSelect = row.querySelector('[name="marque"]');
            const modeleSelect = row.querySelector('[name="modele"]');
            const dateInput = row.querySelector('[name="date"]');
            const timeInput = row.querySelector('[name="time"]');
            const entryBadge = row.querySelector('.entry-badge');
            const entryType = entryBadge?.classList.contains('scan') ? 'scan' : 'manual';

            const typeValue = typeSelect.value === 'autres'
                ? (typeOtherInput?.value?.trim() || '')
                : typeSelect.value;
            if (!snInput.value || !typeValue || !marqueSelect.value || !modeleSelect.value) {
                isValid = false;
                row.style.backgroundColor = '#ffebee';
                return;
            }

            lotData.push({
                numero: index + 1,
                serialNumber: snInput.value,
                type: typeValue,
                marqueId: marqueSelect.value,
                modeleId: modeleSelect.value,
                entryType,
                date: dateInput.value,
                time: timeInput.value
            });
        });

        if (!isValid) {
            this.showNotification('Veuillez remplir tous les champs obligatoires', 'error');
            return;
        }

        // Récupérer le nom optionnel du lot
        const lotName = document.getElementById('input-lot-name')?.value?.trim() || null;

        try {
            logger.debug('📤 Envoi des données:', { items: lotData, lotName });
            const response = await api.post('lots.create', { items: lotData, lotName });

            if (!response.ok) {
                const msg = `HTTP ${response.status}`;
                throw new Error(msg);
            }

            const data = await response.json();
            const lotId = data?.id;
            this.showNotification(`Lot #${lotId || ''} enregistré (${lotData.length} articles)`, 'success');
            
            // Générer le PDF du lot (body attendu par le backend pour nommage et rangement)
            const dateIso = new Date().toISOString().slice(0, 10);
            setTimeout(async () => {
                try {
                    const serverUrl = api.getServerUrl();
                    const endpointPath = '/api/lots/:id/pdf'.replace(':id', lotId);
                    const fullUrl = `${serverUrl}${endpointPath}`;
                    const pdfResponse = await fetch(fullUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${localStorage.getItem('workspace_jwt') || ''}`
                        },
                        body: JSON.stringify({
                            lot_name: lotName || `Lot_${lotId}`,
                            date: dateIso,
                            save_path_hint: '/mnt/team/#TEAM/#TRAÇABILITÉ'
                        })
                    });
                    if (pdfResponse.ok) {
                        logger.debug('✅ PDF généré');
                    } else {
                        const errBody = await pdfResponse.text();
                        logger.warn('⚠️ Génération PDF:', pdfResponse.status, errBody);
                    }
                } catch (pdfError) {
                    logger.warn('⚠️ Erreur génération PDF:', pdfError);
                }
                
                // Rediriger vers l'inventaire
                setTimeout(() => {
                    // Utiliser le système de navigation interne
                    const receptionNav = document.querySelector('[data-page="inventaire"][data-reception-page="true"]');
                    if (receptionNav) {
                        receptionNav.click();
                        logger.debug('✅ Navigation vers Inventaire');
                    } else {
                        logger.debug('⚠️ Bouton inventaire non trouvé, redirection URL');
                        window.location.href = '/pages/reception.html?section=inventaire';
                    }
                }, 500);
            }, 500);
        } catch (error) {
            logger.error('❌ Erreur sauvegarde:', error);
            this.showNotification('Erreur lors de l\'enregistrement', 'error');
        }
    }

    /**
     * Annuler / Réinitialiser
     */
    cancelLot() {
        logger.debug('🔄 Réinitialisation');
        
        // Ouvrir la modale de confirmation
        this.modalManager.open('modal-clear-lot');
    }

    /**
     * Confirmer l'annulation du lot
     */
    confirmCancelLot() {
        const tbody = document.getElementById('lot-table-body');
        if (tbody) tbody.innerHTML = '';
        
        // Réinitialiser le champ d'information du lot
        const lotNameInput = document.getElementById('input-lot-name');
        if (lotNameInput) lotNameInput.value = '';
        
        this.currentRowNumber = 1;
        
        // Ajouter une nouvelle ligne SCAN par défaut
        setTimeout(() => {
            const row = this.createRow('', 'scan');
            tbody.appendChild(row);
            this.updateLotUI();
        }, 100);
        
        this.modalManager.close('modal-clear-lot');
        this.showNotification('Nouveau lot initialisé', 'success');
    }

    /**
     * Soumettre une nouvelle marque
     */
    async submitNewMarque() {
        logger.debug('📋 Soumission marque');
        
        const input = document.getElementById('input-new-marque');
        if (!input || !input.value.trim()) {
            this.showNotification('Veuillez saisir un nom de marque', 'error');
            return;
        }

        const newMarque = input.value.trim();

        try {
            // Appel API réel
            const response = await api.post('marques.list', { name: newMarque });
            
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const data = await response.json();
            
            // Ajouter à la liste locale
            this.marques.push({
                id: data.id || this.marques.length + 1,
                name: newMarque
            });
            
            this.showNotification(`Marque "${newMarque}" ajoutée`, 'success');
            this.modalManager.close('modal-add-marque');
            input.value = '';

            // Mise à jour UI sans recharger l'API (évite que la liste écrasée n'ait pas encore la nouvelle marque)
            this.updateMarqueSelects();
            this.populateMassSelects();
            this.populateMarqueSelect();
            setTimeout(() => {
                this.updateAllMarqueSelects();
            }, 50);
        } catch (error) {
            logger.error('❌ Erreur ajout marque:', error);
            this.showNotification('Erreur lors de l\'ajout de la marque', 'error');
        }
    }

    /**
     * Soumettre un nouveau modèle
     */
    async submitNewModele() {
        logger.debug('📋 Soumission modèle');
        
        const selectMarque = document.getElementById('select-marque-for-modele');
        const inputModele = document.getElementById('input-new-modele');

        if (!selectMarque || !inputModele || !selectMarque.value || !inputModele.value.trim()) {
            this.showNotification('Veuillez remplir tous les champs', 'error');
            return;
        }

        const marqueId = parseInt(selectMarque.value);
        const newModele = inputModele.value.trim();

        try {
            // Appel API réel - construire l'URL complète avec l'ID remplacé
            const serverUrl = api.getServerUrl();
            const endpointPath = '/api/marques/:id/modeles'.replace(':id', marqueId);
            const fullUrl = `${serverUrl}${endpointPath}`;
            
            logger.debug('Ajout modèle:', { marqueId, newModele, fullUrl });
            
            const response = await fetch(fullUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('workspace_jwt') || ''}`
                },
                body: JSON.stringify({ name: newModele })
            });
            
            if (!response.ok) {
                let errorMessage = `Erreur ${response.status}`;
                try {
                    const errorData = await response.json();
                    logger.error('Erreur serveur:', errorData);
                    errorMessage = errorData.message || errorData.error || errorMessage;
                } catch (e) {
                    errorMessage = `Erreur ${response.status}: ${response.statusText}`;
                }
                throw new Error(errorMessage);
            }
            
            const data = await response.json();
            logger.debug('Modèle ajouté:', data);
            
            // Ajouter à la liste locale
            this.modeles.push({
                id: data.id || this.modeles.length + 1,
                name: newModele,
                marque_id: marqueId
            });
            
            this.showNotification(`Modèle "${newModele}" ajouté`, 'success');
            this.modalManager.close('modal-add-modele');
            inputModele.value = '';
            selectMarque.value = '';

            // Mise à jour UI sans recharger l'API (évite que la liste écrasée n'ait pas encore le nouveau modèle)
            this.populateMassSelects();
            this.updateMarqueSelects();
            setTimeout(() => {
                this.updateAllModeleSelects();
            }, 50);

        } catch (error) {
            logger.error('❌ Erreur ajout modèle:', error);
            this.showNotification('Erreur lors de l\'ajout du modèle', 'error');
        }
    }

    /**
     * Remplir le select des marques dans la modale
     */
    populateMarqueSelect() {
        const select = document.getElementById('select-marque-for-modele');
        if (!select) return;

        select.innerHTML = `
            <option value="">-- Sélectionner une marque --</option>
            ${this.marques.map(m => `<option value="${m.id}">${m.name}</option>`).join('')}
        `;
    }
    
    /**
     * Remplir les selects d'application en masse (modale)
     */
    populateMassSelects() {
        const modalMassMarque = document.getElementById('modal-mass-marque');
        const modalMassModele = document.getElementById('modal-mass-modele');
        
        if (modalMassMarque) {
            modalMassMarque.innerHTML = `
                <option value="">-- Non modifier --</option>
                ${this.marques.map(m => `<option value="${m.id}">${m.name}</option>`).join('')}
            `;
        }
        
        if (modalMassModele) {
            modalMassModele.innerHTML = `
                <option value="">-- Non modifier --</option>
                ${this.modeles.map(m => `<option value="${m.id}">${m.name}</option>`).join('')}
            `;
        }
    }
    
    /**
     * Mettre à jour tous les selects de marque dans les lignes existantes
     */
    updateAllMarqueSelects() {
        const tbody = document.getElementById('lot-table-body');
        if (!tbody) {
            logger.warn('⚠️ tbody non trouvé pour updateAllMarqueSelects - peut-être que la page n\'est pas encore chargée');
            // Réessayer après un court délai
            setTimeout(() => {
                const retryTbody = document.getElementById('lot-table-body');
                if (retryTbody) {
                    logger.info('🔄 Réessai de mise à jour des selects de marque');
                    this.updateAllMarqueSelects();
                } else {
                    logger.error('❌ tbody toujours introuvable après réessai');
                }
            }, 200);
            return;
        }
        
        const marqueSelects = tbody.querySelectorAll('select[name="marque"]');
        logger.info(`🔄 Mise à jour de ${marqueSelects.length} select(s) de marque (${this.marques.length} marques disponibles)`);
        
        if (marqueSelects.length === 0) {
            logger.warn('⚠️ Aucun select de marque trouvé dans le tbody');
        }
        
        marqueSelects.forEach((select, index) => {
            const currentValue = select.value;
            const oldOptionsCount = select.options.length;
            
            // Sauvegarder les événements si nécessaire
            const wasDisabled = select.disabled;
            
            // Vider le select d'abord
            select.innerHTML = '';
            
            // Ajouter l'option par défaut
            const defaultOption = document.createElement('option');
            defaultOption.value = '';
            defaultOption.textContent = 'Marque...';
            select.appendChild(defaultOption);
            
            // Ajouter toutes les marques
            this.marques.forEach(m => {
                const option = document.createElement('option');
                option.value = m.id;
                option.textContent = m.name;
                if (m.id == currentValue) {
                    option.selected = true;
                }
                select.appendChild(option);
            });
            
            // Restaurer la valeur sélectionnée explicitement
            if (currentValue) {
                select.value = currentValue;
                // Vérifier que la valeur a bien été définie
                if (select.value != currentValue) {
                    logger.warn(`⚠️ Impossible de restaurer la valeur ${currentValue} pour le select marque ${index + 1}`);
                }
            }
            
            // Restaurer l'état disabled
            select.disabled = wasDisabled;
            
            logger.info(`Select marque ${index + 1}: ${oldOptionsCount} -> ${select.options.length} options, valeur conservée: ${currentValue || 'aucune'}, valeur actuelle: ${select.value}, options: [${Array.from(select.options).map(opt => `${opt.value}:${opt.text}`).join(', ')}]`);
            
            // Si une marque était sélectionnée, mettre à jour le select de modèle correspondant
            if (currentValue) {
                const row = select.closest('tr');
                const modeleSelect = row?.querySelector('select[name="modele"]');
                if (modeleSelect) {
                    this.updateModeleSelect(currentValue, modeleSelect);
                }
            }
            
            // Forcer le reflow pour s'assurer que le navigateur met à jour l'affichage
            select.offsetHeight;
            
            // Déclencher un événement change pour forcer la mise à jour visuelle
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
    }
    
    /**
     * Mettre à jour tous les selects de modèle dans les lignes existantes
     */
    updateAllModeleSelects() {
        const tbody = document.getElementById('lot-table-body');
        if (!tbody) {
            logger.warn('⚠️ tbody non trouvé pour updateAllModeleSelects - peut-être que la page n\'est pas encore chargée');
            // Réessayer après un court délai
            setTimeout(() => {
                const retryTbody = document.getElementById('lot-table-body');
                if (retryTbody) {
                    logger.info('🔄 Réessai de mise à jour des selects de modèle');
                    this.updateAllModeleSelects();
                } else {
                    logger.error('❌ tbody toujours introuvable après réessai');
                }
            }, 200);
            return;
        }
        
        const rows = tbody.querySelectorAll('tr');
        logger.info(`🔄 Mise à jour des selects de modèle pour ${rows.length} ligne(s) (${this.modeles.length} modèles disponibles)`);
        
        if (rows.length === 0) {
            logger.warn('⚠️ Aucune ligne trouvée dans le tbody');
        }
        
        rows.forEach((row, index) => {
            const marqueSelect = row.querySelector('select[name="marque"]');
            const modeleSelect = row.querySelector('select[name="modele"]');
            if (marqueSelect && modeleSelect && marqueSelect.value) {
                const currentModeleValue = modeleSelect.value;
                const oldOptionsCount = modeleSelect.options.length;
                const wasDisabled = modeleSelect.disabled;
                
                this.updateModeleSelect(marqueSelect.value, modeleSelect);
                logger.info(`Ligne ${index + 1}: Select modèle ${oldOptionsCount} -> ${modeleSelect.options.length} options`);
                
                // Restaurer la valeur sélectionnée si elle existe toujours
                if (currentModeleValue && Array.from(modeleSelect.options).some(opt => opt.value === currentModeleValue)) {
                    modeleSelect.value = currentModeleValue;
                    logger.info(`Ligne ${index + 1}: Valeur restaurée: ${currentModeleValue}, valeur actuelle: ${modeleSelect.value}`);
                }
                
                // Restaurer l'état disabled
                modeleSelect.disabled = wasDisabled;
                
                // Déclencher un événement change pour forcer la mise à jour visuelle
                modeleSelect.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
    }
    
    /**
     * Supprimer une ligne (toast avec annulation, pas de modale)
     */
    deleteRow(row) {
        const tbody = document.getElementById('lot-table-body');
        if (!tbody || !row?.isConnected) return;

        const nextSibling = row.nextElementSibling;
        row.remove();
        this.renumberRows();
        this.ensureScanRow();
        this.updateLotUI();

        this.showNotification('Ligne supprimée', 'success', {
            onUndo: () => {
                if (nextSibling) tbody.insertBefore(row, nextSibling);
                else tbody.appendChild(row);
                this.renumberRows();
                this.ensureScanRow();
                this.updateLotUI();
            }
        });
    }

    ensureScanRow() {
        const tbody = document.getElementById('lot-table-body');
        if (!tbody) return;

        const rows = [...tbody.querySelectorAll('tr')];
        if (rows.length === 0) {
            const row = this.createRow('', 'scan');
            tbody.appendChild(row);
            row.querySelector('input[name="serial_number"]')?.focus();
            return;
        }

        const lastRow = rows[rows.length - 1];
        const lastSn = lastRow.querySelector('input[name="serial_number"]');
        if (lastSn && lastSn.value.trim()) {
            const row = this.createRow('', 'scan');
            tbody.appendChild(row);
        }
    }
    
    /**
     * Renuméroter les lignes après suppression
     */
    renumberRows() {
        const tbody = document.getElementById('lot-table-body');
        if (!tbody) return;
        
        const rows = tbody.querySelectorAll('tr');
        rows.forEach((row, index) => {
            const numCell = row.querySelector('td:nth-child(2) span');
            if (numCell) numCell.textContent = index + 1;
        });
        
        this.currentRowNumber = rows.length + 1;
    }
    
    /**
     * Ouvrir la modale d'application en masse
     */
    applyMassValues() {
        const selectedRows = document.querySelectorAll('.row-checkbox:checked');
        
        if (selectedRows.length === 0) {
            this.showNotification('Sélectionnez au moins une ligne', 'error');
            return;
        }
        
        // Ouvrir la modale
        this.modalManager.open('modal-mass-apply');
        
        // Stocker le nombre de lignes sélectionnées
        const infoDiv = document.getElementById('mass-apply-info');
        if (infoDiv) {
            infoDiv.textContent = `${selectedRows.length} ligne(s) sélectionnée(s)`;
        }
    }
    
    /**
     * Confirmer l'application en masse
     */
    confirmMassApply() {
        const massType = document.getElementById('modal-mass-type')?.value;
        const massTypeOther = document.getElementById('modal-mass-type-other')?.value?.trim() || '';
        const massMarque = document.getElementById('modal-mass-marque')?.value;
        const massModele = document.getElementById('modal-mass-modele')?.value;
        
        const selectedRows = document.querySelectorAll('.row-checkbox:checked');
        
        if (selectedRows.length === 0) {
            this.showNotification('Aucune ligne sélectionnée', 'error');
            return;
        }
        if (massType === 'autres' && !massTypeOther) {
            this.showNotification('Précisez le type pour "Autres"', 'warning');
            return;
        }
        
        selectedRows.forEach(checkbox => {
            const row = checkbox.closest('tr');
            if (!row) return;
            
            if (massType) {
                const typeSelect = row.querySelector('[name="type"]');
                const typeOtherInput = row.querySelector('[name="type_other"]');
                if (typeSelect) {
                    typeSelect.value = massType;
                    if (massType === 'autres' && typeOtherInput) {
                        typeOtherInput.value = massTypeOther;
                        typeOtherInput.style.display = 'inline-block';
                        typeOtherInput.required = true;
                    }
                }
            }
            
            if (massMarque) {
                const marqueSelect = row.querySelector('[name="marque"]');
                if (marqueSelect) marqueSelect.value = massMarque;
            }
            
            if (massModele) {
                const modeleSelect = row.querySelector('[name="modele"]');
                if (modeleSelect) modeleSelect.value = massModele;
            }
        });
        
        this.showNotification(`Valeurs appliquées à ${selectedRows.length} ligne(s)`, 'success');
        this.modalManager.close('modal-mass-apply');
        
        // Réinitialiser les selects et checkboxes
        document.getElementById('modal-mass-type').value = '';
        const modalTypeOther = document.getElementById('modal-mass-type-other');
        if (modalTypeOther) {
            modalTypeOther.value = '';
            modalTypeOther.style.display = 'none';
        }
        document.getElementById('modal-mass-marque').value = '';
        document.getElementById('modal-mass-modele').value = '';
        document.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = false);
        document.getElementById('select-all').checked = false;
        this.updateSelectionBar();
    }

    updateLotUI() {
        this.updateLineCount();
        this.updateSelectionBar();
    }

    updateLineCount() {
        const tbody = document.getElementById('lot-table-body');
        const countEl = document.getElementById('lot-line-count-value');
        if (!tbody || !countEl) return;
        countEl.textContent = String(tbody.querySelectorAll('tr').length);
    }

    updateSelectionBar() {
        const bar = document.getElementById('lot-selection-bar');
        const countEl = document.getElementById('lot-selection-count');
        const selected = document.querySelectorAll('.row-checkbox:checked');
        const count = selected.length;

        if (bar) {
            const visible = count > 0;
            bar.hidden = !visible;
            bar.setAttribute('aria-hidden', visible ? 'false' : 'true');
        }

        if (countEl) {
            countEl.textContent = count === 1 ? '1 sélectionnée' : `${count} sélectionnées`;
        }

        const selectAll = document.getElementById('select-all');
        const all = document.querySelectorAll('.row-checkbox');
        if (selectAll && all.length > 0) {
            selectAll.indeterminate = count > 0 && count < all.length;
            selectAll.checked = count === all.length;
        } else if (selectAll) {
            selectAll.indeterminate = false;
            selectAll.checked = false;
        }
    }

    flashScanPanel() {
        const toolbar = document.getElementById('lot-toolbar');
        if (!toolbar) return;

        toolbar.classList.add('is-scanning');
        clearTimeout(this._scanFlashTimer);
        this._scanFlashTimer = setTimeout(() => {
            toolbar.classList.remove('is-scanning');
        }, 600);
    }

    showNotification(message, type = 'info', options) {
        showAppNotification(message, type, options);
    }

    /**
     * Nettoyer/Détruire le manager
     */
    destroy() {
        logger.debug('🧹 Destruction GestionLotsManager');

        if (this._onSerialEnter) {
            document.removeEventListener('keydown', this._onSerialEnter);
            this._onSerialEnter = null;
        }
        if (this._onBarcodeKeydown) {
            document.removeEventListener('keydown', this._onBarcodeKeydown);
            this._onBarcodeKeydown = null;
        }
        if (this._onMarqueChange) {
            document.removeEventListener('change', this._onMarqueChange);
            this._onMarqueChange = null;
        }
        if (this._barcodeTimer) {
            clearTimeout(this._barcodeTimer);
            this._barcodeTimer = null;
        }
        if (this._scanFlashTimer) {
            clearTimeout(this._scanFlashTimer);
            this._scanFlashTimer = null;
        }
        this._barcodeBuffer = '';

        this.listeners.forEach(({ element, event, handler }) => {
            element?.removeEventListener(event, handler);
        });
        this.listeners = [];

        this.lots = [];
        this.currentRowNumber = 1;

        const tbody = document.getElementById('lot-table-body');
        if (tbody) tbody.innerHTML = '';

        logger.debug('✅ GestionLotsManager nettoyé');
    }
}
