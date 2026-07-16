export default class ColorManager {
    constructor() {
        this.storageKey = 'agenda_favorite_colors';
        this.defaultColors = ['#5b7cfa', '#4ade80', '#fb923c'];
        this.initializeFavorites();
    }

    initializeFavorites() {
        const stored = localStorage.getItem(this.storageKey);
        if (!stored) {
            localStorage.setItem(this.storageKey, JSON.stringify(this.defaultColors));
        }
    }

    getFavorites() {
        try {
            return JSON.parse(localStorage.getItem(this.storageKey)) || this.defaultColors;
        } catch (e) {
            return this.defaultColors;
        }
    }

    addFavorite(color) {
        const favorites = this.getFavorites();
        if (!favorites.includes(color)) {
            favorites.unshift(color);
            if (favorites.length > 12) favorites.pop();
            localStorage.setItem(this.storageKey, JSON.stringify(favorites));
        }
    }

    removeFavorite(color) {
        const favorites = this.getFavorites().filter(c => c !== color);
        localStorage.setItem(this.storageKey, JSON.stringify(favorites));
    }
}
