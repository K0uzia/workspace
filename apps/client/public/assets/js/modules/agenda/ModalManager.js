import ColorManager from './ColorManager.js';
import { parseLocalDateTime, syncDateInputs } from './DateUtils.js';

export default class ModalManager {
    constructor(config) {
        this.createModal = config.createModal;
        this.editModal = config.editModal;
        this.deleteModal = config.deleteModal;
        this.colorManager = config.colorManager || new ColorManager();
        this.onCreateSubmit = config.onCreateSubmit;
        this.onEditSubmit = config.onEditSubmit;
        this.onDeleteConfirm = config.onDeleteConfirm;
        this.listeners = [];
    }

    init() {
        this.setupCloseButtons();
        this.setupColorPickers();
        this.setupForms();
        this.setupAllDayCheckboxes();
    }

    destroy() {
        this.listeners.forEach(({ element, event, handler }) => {
            element?.removeEventListener(event, handler);
        });
        this.listeners = [];
    }

    addListener(element, event, handler) {
        if (element) {
            element.addEventListener(event, handler);
            this.listeners.push({ element, event, handler });
        }
    }

    setupCloseButtons() {
        document.querySelectorAll('[data-close]').forEach(btn => {
            const handler = () => {
                const modalId = btn.getAttribute('data-close');
                document.getElementById(modalId)?.close();
            };
            this.addListener(btn, 'click', handler);
        });
    }

    setupColorPickers() {
        const createColorBtn = document.getElementById('create_add_color_btn');
        const createColorInput = document.getElementById('create_color');
        
        if (createColorBtn && createColorInput) {
            const handler = (e) => {
                e.preventDefault();
                this.colorManager.addFavorite(createColorInput.value);
                this.updateColorPalette('create');
            };
            this.addListener(createColorBtn, 'click', handler);
        }

        const editColorBtn = document.getElementById('edit_add_color_btn');
        const editColorInput = document.getElementById('edit_color');
        
        if (editColorBtn && editColorInput) {
            const handler = (e) => {
                e.preventDefault();
                this.colorManager.addFavorite(editColorInput.value);
                this.updateColorPalette('edit');
            };
            this.addListener(editColorBtn, 'click', handler);
        }
    }

    setupForms() {
        const createForm = document.getElementById('createEventForm');
        if (createForm) {
            const handler = async (e) => {
                e.preventDefault();
                await this.handleCreateSubmit(e);
            };
            this.addListener(createForm, 'submit', handler);
        }

        const editForm = document.getElementById('editEventForm');
        if (editForm) {
            const handler = async (e) => {
                e.preventDefault();
                await this.handleEditSubmit(e);
            };
            this.addListener(editForm, 'submit', handler);
        }

        const triggerDeleteBtn = document.getElementById('triggerDeleteBtn');
        if (triggerDeleteBtn) {
            const handler = () => {
                this.closeModal(this.editModal);
                const id = document.getElementById('edit_eventId').value;
                const title = document.getElementById('edit_title').value;
                this.openDeleteModal(id, title);
            };
            this.addListener(triggerDeleteBtn, 'click', handler);
        }

        const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
        if (confirmDeleteBtn) {
            const handler = async () => {
                await this.onDeleteConfirm?.();
            };
            this.addListener(confirmDeleteBtn, 'click', handler);
        }
    }

    setupAllDayCheckboxes() {
        const createAllDay = document.getElementById('create_all_day');
        if (createAllDay) {
            const handler = () => this.toggleAllDayFields('create');
            this.addListener(createAllDay, 'change', handler);
        }

        const editAllDay = document.getElementById('edit_all_day');
        if (editAllDay) {
            const handler = () => this.toggleAllDayFields('edit');
            this.addListener(editAllDay, 'change', handler);
        }
    }

    toggleAllDayFields(modalType) {
        const checkbox = document.getElementById(`${modalType}_all_day`);
        const timeSection = document.getElementById(`${modalType}-time-section`);

        if (checkbox?.checked) {
            timeSection?.setAttribute('hidden', '');
        } else {
            timeSection?.removeAttribute('hidden');
        }
    }

    updateColorPalette(modalType) {
        const favorites = this.colorManager.getFavorites();
        const container = document.getElementById(`${modalType}-color-favorites`);
        const colorInput = document.getElementById(`${modalType}_color`);

        if (!container) return;

        container.innerHTML = '';
        
        favorites.forEach(color => {
            const wrapper = document.createElement('div');
            wrapper.className = 'color-favorite-wrapper';
            wrapper.style.position = 'relative';
            wrapper.style.display = 'inline-block';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'color-favorite-btn';
            btn.style.backgroundColor = color;
            btn.title = color;
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                colorInput.value = color;
            });
            wrapper.appendChild(btn);

            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'color-favorite-delete';
            deleteBtn.title = 'Supprimer cette couleur';
            deleteBtn.innerHTML = '<i class="fas fa-times"></i>';
            deleteBtn.style.position = 'absolute';
            deleteBtn.style.top = '-8px';
            deleteBtn.style.right = '-8px';
            deleteBtn.style.width = '20px';
            deleteBtn.style.height = '20px';
            deleteBtn.style.padding = '0';
            deleteBtn.style.borderRadius = '50%';
            deleteBtn.style.backgroundColor = '#e74c3c';
            deleteBtn.style.color = 'white';
            deleteBtn.style.border = 'none';
            deleteBtn.style.cursor = 'pointer';
            deleteBtn.style.display = 'flex';
            deleteBtn.style.alignItems = 'center';
            deleteBtn.style.justifyContent = 'center';
            deleteBtn.style.fontSize = '10px';
            deleteBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.colorManager.removeFavorite(color);
                this.updateColorPalette(modalType);
            });
            wrapper.appendChild(deleteBtn);

            container.appendChild(wrapper);
        });
    }

    /** Déplace le dialog dans body pour éviter les problèmes d'affichage (stacking context, overflow) */
    ensureDialogInBody(dialogEl) {
        if (!dialogEl || dialogEl.parentNode === document.body) return;
        document.body.appendChild(dialogEl);
    }

    showModal(modalEl) {
        const el = typeof modalEl?.id === 'string' ? document.getElementById(modalEl.id) : modalEl;
        if (!el) return;
        this.ensureDialogInBody(el);
        if (typeof el.showModal === 'function') {
            try {
                el.showModal();
            } catch (err) {
                console.warn('dialog.showModal() failed, fallback to open attribute', err);
                el.setAttribute('open', '');
            }
        } else {
            el.setAttribute('open', '');
        }
    }

    closeModal(modalEl) {
        modalEl?.close();
    }

    openCreateModal(dateObj) {
        const createModalEl = document.getElementById('agenda-create-modal');
        if (!createModalEl) return;

        const form = document.getElementById('createEventForm');
        form?.reset();

        const colorInput = document.getElementById('create_color');
        if (colorInput) colorInput.value = '#5b7cfa';

        const allDayCheckbox = document.getElementById('create_all_day');
        if (allDayCheckbox) {
            allDayCheckbox.checked = false;
            this.toggleAllDayFields('create');
        }

        if (dateObj) {
            const ymd = this.formatLocalISODate(dateObj);
            const dateInput = document.getElementById('create_date');
            const endDateInput = document.getElementById('create_end_date');
            if (dateInput) dateInput.value = ymd;
            if (endDateInput) endDateInput.value = ymd;
        }

        const startTimeInput = document.getElementById('create_start_time');
        const endTimeInput = document.getElementById('create_end_time');
        if (startTimeInput) startTimeInput.value = '09:00';
        if (endTimeInput) endTimeInput.value = '10:00';

        syncDateInputs('create_date', 'create_end_date', { forceUpdate: true });
        this.updateColorPalette('create');
        this.showModal(createModalEl);
    }

    openEditModal(ev) {
        const form = document.getElementById('editEventForm');
        form?.reset();

        document.getElementById('edit_eventId').value = ev.id;
        document.getElementById('edit_title').value = ev.title;

        const startDate = parseLocalDateTime(ev.start) ?? new Date(ev.start.replace(' ', 'T'));
        const endDate = parseLocalDateTime(ev.end) ?? new Date(ev.end.replace(' ', 'T'));

        const startDateStr = this.formatLocalISODate(startDate);
        const endDateStr = this.formatLocalISODate(endDate);
        const startTimeStr = startDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        const endTimeStr = endDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

        const isAllDay = ev.all_day || (startTimeStr === '00:00' && endTimeStr === '23:59');
        const editAllDay = document.getElementById('edit_all_day');
        if (editAllDay) {
            editAllDay.checked = isAllDay;
            this.toggleAllDayFields('edit');
        }

        const editDate = document.getElementById('edit_date');
        const editEndDate = document.getElementById('edit_end_date');
        const editStartTime = document.getElementById('edit_start_time');
        const editEndTime = document.getElementById('edit_end_time');

        if (editDate) editDate.value = startDateStr;
        if (editEndDate) editEndDate.value = endDateStr;
        if (editStartTime) editStartTime.value = startTimeStr;
        if (editEndTime) editEndTime.value = endTimeStr;

        document.getElementById('edit_description').value = ev.description || '';

        const colorToSelect = ev.color || '#5b7cfa';
        const editColor = document.getElementById('edit_color');
        if (editColor) editColor.value = colorToSelect;

        syncDateInputs('edit_date', 'edit_end_date', { forceUpdate: true });
        this.updateColorPalette('edit');

        const isLocked = ev?.locked === true || ev?.source === 'holiday' || (typeof ev?.id === 'string' && ev.id.startsWith('holiday:'));
        const lockInputs = (locked) => {
            const modal = document.getElementById('agenda-edit-modal');
            if (!modal) return;

            // Inputs en read-only/disabled
            const inputIds = [
                'edit_title', 'edit_all_day', 'edit_date', 'edit_end_date',
                'edit_start_time', 'edit_end_time', 'edit_description', 'edit_color'
            ];
            inputIds.forEach((id) => {
                const el = document.getElementById(id);
                if (!el) return;
                if (el.tagName === 'INPUT' && el.type === 'checkbox') {
                    el.disabled = !!locked;
                } else if ('disabled' in el) {
                    el.disabled = !!locked;
                }
            });

            // Boutons footer
            const deleteBtn = document.getElementById('triggerDeleteBtn');
            const submitBtn = modal.querySelector('button[type="submit"][form="editEventForm"]');
            if (deleteBtn) deleteBtn.style.display = locked ? 'none' : '';
            if (submitBtn) submitBtn.style.display = locked ? 'none' : '';

            // Petit message dans la modale
            let note = modal.querySelector('[data-agenda-locked-note]');
            if (locked) {
                if (!note) {
                    note = document.createElement('p');
                    note.setAttribute('data-agenda-locked-note', '1');
                    note.className = 'text-mute small';
                    note.style.margin = '0 0 10px 0';
                    note.innerHTML = '<strong>Info :</strong> cet événement est verrouillé (jour férié / fête).';
                    const body = modal.querySelector('.modal-body');
                    body?.prepend(note);
                }
            } else {
                note?.remove();
            }
        };

        lockInputs(isLocked);
        this.showModal(document.getElementById('agenda-edit-modal'));
    }

    openDeleteModal(id, title) {
        document.getElementById('delete_eventId').value = id;
        document.getElementById('delete-event-title').textContent = title;
        this.showModal(document.getElementById('agenda-delete-modal'));
    }

    async handleCreateSubmit(e) {
        const isAllDay = document.getElementById('create_all_day')?.checked || false;
        const startDate = document.getElementById('create_date')?.value || '';
        const endDate = document.getElementById('create_end_date')?.value || startDate;
        const title = document.getElementById('create_title')?.value || '';
        const color = document.getElementById('create_color')?.value || '#5b7cfa';
        const description = document.getElementById('create_description')?.value || '';

        if (!title || !startDate || !endDate) {
            alert('Veuillez remplir les champs obligatoires');
            return;
        }

        let startTime = '00:00';
        let endTime = '23:59';

        if (!isAllDay) {
            startTime = document.getElementById('create_start_time')?.value || '09:00';
            endTime = document.getElementById('create_end_time')?.value || '10:00';
        }

        const event = {
            title,
            start: `${startDate}T${startTime}:00`,
            end: `${endDate}T${endTime}:00`,
            color,
            description,
            all_day: isAllDay
        };

        await this.onCreateSubmit?.(event);
    }

    async handleEditSubmit(e) {
        const id = document.getElementById('edit_eventId').value;
        const title = document.getElementById('edit_title')?.value || '';
        const startDate = document.getElementById('edit_date')?.value || '';
        const endDate = document.getElementById('edit_end_date')?.value || startDate;
        const isAllDay = document.getElementById('edit_all_day')?.checked || false;
        const startTime = isAllDay ? '00:00' : (document.getElementById('edit_start_time')?.value || '09:00');
        const endTime = isAllDay ? '23:59' : (document.getElementById('edit_end_time')?.value || '10:00');
        const color = document.getElementById('edit_color')?.value || '#5b7cfa';
        const description = document.getElementById('edit_description')?.value || '';

        if (typeof id === 'string' && id.startsWith('holiday:')) {
            window.app?.showNotification?.('Cet événement est verrouillé et ne peut pas être modifié.', 'warning');
            return;
        }

        if (!title || !startDate || !endDate) {
            alert('Veuillez remplir les champs obligatoires');
            return;
        }

        const updates = {
            title,
            start: `${startDate}T${startTime}:00`,
            end: `${endDate}T${endTime}:00`,
            color,
            description,
            all_day: isAllDay
        };

        await this.onEditSubmit?.(id, updates);
    }

    formatLocalISODate(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
}
