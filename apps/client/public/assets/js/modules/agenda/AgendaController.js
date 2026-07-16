import AgendaStore from './AgendaStore.js';
import CalendarRenderer from './CalendarRenderer.js';
import ModalManager from './ModalManager.js';
import ColorManager from './ColorManager.js';
import { getDateRange } from './DateUtils.js';
import getLogger from '../../config/Logger.js';
const logger = getLogger();


export default class AgendaController {
    constructor() {
        this.currentDate = new Date();
        this.currentView = 'week';
        this.selectedEvent = null;
        this.colorManager = new ColorManager();
        this.listeners = [];
        
        this.calendarGrid = document.getElementById('dashboard-calendar-grid');
        this.calendarLabel = document.getElementById('dashboard-calendar-label');
        this.loadingIndicator = document.getElementById('dashboard-calendar-loading');
        this.errorIndicator = document.getElementById('dashboard-calendar-error');
        this.detailsPanel = document.getElementById('public-calendar-details');
        
        this.createModal = document.getElementById('agenda-create-modal');
        this.editModal = document.getElementById('agenda-edit-modal');
        this.deleteModal = document.getElementById('agenda-delete-modal');

        this.renderer = new CalendarRenderer({
            calendarGrid: this.calendarGrid,
            calendarLabel: this.calendarLabel,
            loadingIndicator: this.loadingIndicator,
            errorIndicator: this.errorIndicator,
            detailsPanel: this.detailsPanel,
            onEventClick: (ev) => this.handleEventClick(ev),
            onDayClick: (date) => this.modalManager.openCreateModal(date)
        });

        this.modalManager = new ModalManager({
            createModal: this.createModal,
            editModal: this.editModal,
            deleteModal: this.deleteModal,
            colorManager: this.colorManager,
            onCreateSubmit: (event) => this.handleCreateSubmit(event),
            onEditSubmit: (id, updates) => this.handleEditSubmit(id, updates),
            onDeleteConfirm: () => this.handleDeleteConfirm()
        });
    }

    async init() {
        if (!this.calendarGrid) return;

        this.setupNavigation();
        this.setupViewSwitch();
        this.modalManager.init();

        await this.renderCalendar();
    }

    destroy() {
        this.listeners.forEach(({ element, event, handler }) => {
            element?.removeEventListener(event, handler);
        });
        this.listeners = [];
        this.modalManager.destroy();
    }

    addListener(element, event, handler) {
        if (element) {
            element.addEventListener(event, handler);
            this.listeners.push({ element, event, handler });
        }
    }

    setupNavigation() {
        document.querySelectorAll('[data-calendar-nav]').forEach(btn => {
            const handler = () => {
                const delta = parseInt(btn.getAttribute('data-calendar-nav'));
                if (this.currentView === 'week') {
                    this.currentDate.setDate(this.currentDate.getDate() + delta * 7);
                } else if (this.currentView === 'month') {
                    this.currentDate.setMonth(this.currentDate.getMonth() + delta);
                } else if (this.currentView === 'year') {
                    this.currentDate.setFullYear(this.currentDate.getFullYear() + delta);
                }
                this.renderCalendar().catch(err => logger.error('❌ Erreur rendu:', err));
            };
            this.addListener(btn, 'click', handler);
        });

        const addEventBtn = document.getElementById('addEventBtn');
        if (addEventBtn) {
            const handler = () => {
                this.modalManager.openCreateModal(new Date());
            };
            this.addListener(addEventBtn, 'click', handler);
        }
    }

    setupViewSwitch() {
        document.querySelectorAll('.calendar-view-btn').forEach(btn => {
            const handler = () => {
                document.querySelectorAll('.calendar-view-btn').forEach(b => b.classList.remove('is-active'));
                btn.classList.add('is-active');
                this.currentView = btn.getAttribute('data-calendar-view');
                this.renderCalendar().catch(err => logger.error('❌ Erreur rendu:', err));
            };
            this.addListener(btn, 'click', handler);
        });
    }

    async renderCalendar() {
        this.renderer.resetDetails();
        this.renderer.clear();
        this.calendarGrid.className = `calendar-grid calendar-grid--${this.currentView}`;
        this.renderer.updateLabel(this.currentView, this.currentDate);
        this.renderer.showLoading();

        try {
            const { startDate, endDate } = getDateRange(this.currentDate, this.currentView);
            const [events, holidays] = await Promise.all([
                AgendaStore.getEventsByRange(startDate, endDate),
                AgendaStore.getHolidaysByRange(startDate, endDate)
            ]);
            const mergedEvents = [...events, ...holidays];

            if (this.currentView === 'week') {
                this.renderer.renderWeek(this.currentDate, mergedEvents);
            } else if (this.currentView === 'month') {
                this.renderer.renderMonth(this.currentDate, mergedEvents);
            } else if (this.currentView === 'year') {
                this.renderer.renderYear(this.currentDate, mergedEvents);
            }

            this.renderer.hideLoading();
        } catch (err) {
            logger.error('❌ Erreur rendu calendrier:', err);
            this.renderer.showError('Erreur lors du chargement du calendrier');
        }
    }

    handleEventClick(ev) {
        this.selectedEvent = ev;
        const isLocked = ev?.locked === true || ev?.source === 'holiday' || (typeof ev?.id === 'string' && ev.id.startsWith('holiday:'));
        this.renderer.displayEventDetails(ev, isLocked ? null : (event) => {
            this.modalManager.openEditModal(event);
        });
    }

    async handleCreateSubmit(event) {
        try {
            await AgendaStore.addEvent(event);
            this.modalManager.closeModal(this.createModal);
            await this.renderCalendar();
            window.app?.showNotification?.(`L'événement « ${event.title} » a été créé avec succès.`, 'success');
        } catch (error) {
            logger.error('❌ Erreur création événement:', error);
            window.app?.showNotification?.('Une erreur est survenue lors de la création de l\'événement.', 'error');
        }
    }

    async handleEditSubmit(id, updates) {
        try {
            await AgendaStore.updateEvent(id, updates);
            this.modalManager.closeModal(this.editModal);
            await this.renderCalendar();
            window.app?.showNotification?.(`L'événement « ${updates.title} » a été modifié avec succès.`, 'success');
        } catch (error) {
            logger.error('❌ Erreur modification événement:', error);
            window.app?.showNotification?.('Une erreur est survenue lors de la modification de l\'événement.', 'error');
        }
    }

    async handleDeleteConfirm() {
        const id = document.getElementById('delete_eventId').value;

        try {
            const success = await AgendaStore.deleteEvent(id);
            if (success) {
                this.modalManager.closeModal(this.deleteModal);
                await this.renderCalendar();
                window.app?.showNotification?.('L\'événement a été supprimé avec succès.', 'success');
            } else {
                window.app?.showNotification?.('L\'événement est introuvable.', 'error');
            }
        } catch (error) {
            logger.error('❌ Erreur suppression:', error);
            window.app?.showNotification?.('Une erreur est survenue lors de la suppression.', 'error');
        }
    }
}
