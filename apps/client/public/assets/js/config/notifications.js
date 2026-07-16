import getLogger from './Logger.js';

const logger = getLogger();

/**
 * Délègue l'affichage des toasts à window.app.showNotification (fallback silencieux).
 */
export function showAppNotification(message, type = 'info', options) {
    logger.debug(`[${type.toUpperCase()}] ${message}`);
    window.app?.showNotification?.(message, type, options);
}
