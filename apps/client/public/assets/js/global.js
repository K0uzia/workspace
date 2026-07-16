/**
 * GLOBAL.JS - Point d'entrée de l'application
 * Importe et initialise tous les modules
 */

import NavManager from './modules/nav/NavManager.js';
import TimeManager from './modules/time/TimeManager.js';
import { modalManager, initModals } from './modules/modal/universalModal.js';

// Exposer modalManager globalement
window.modalManager = modalManager;

// Initialiser après le chargement complet du DOM
document.addEventListener('DOMContentLoaded', () => {
    // Initialiser le système de modales universel
    initModals();
    console.log('✅ Système de modales universel initialisé');

    // Ajouter un délai pour laisser le temps à app.js de charger le header
    setTimeout(() => {
        const navBurger = document.getElementById('navBurger');
        const navLinks = document.getElementById('navLinks');
        
        if (navBurger && navLinks) {
            window.navManager = new NavManager();
        } else {
            console.warn('⚠️ Header pas trouvé');
        }
    }, 500);

    // Initialiser TimeManager
    const currentDate = document.getElementById('current-date');
    const currentTime = document.getElementById('current-time');
    
    if (currentDate && currentTime) {
        window.timeManager = new TimeManager({
            dateElementId: 'current-date',
            timeElementId: 'current-time',
            updateInterval: 1000
        });
    }
});
