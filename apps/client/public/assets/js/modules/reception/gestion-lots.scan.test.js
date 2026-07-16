/**
 * Tests Enter sur S/N (Réception > Lots) :
 * chaque Enter doit créer une nouvelle ligne SCAN vide + autofocus,
 * y compris aux 2e, 3e, 4e… et jusqu’à 20 scans successifs.
 */

jest.mock('../../config/api.js', () => ({
    __esModule: true,
    default: {
        get: jest.fn(),
        post: jest.fn(),
        put: jest.fn(),
        delete: jest.fn()
    }
}));

jest.mock('../../config/Logger.js', () => {
    const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        setLevel: jest.fn(),
        disable: jest.fn(),
        enable: jest.fn()
    };
    return {
        __esModule: true,
        default: () => logger,
        Logger: jest.fn()
    };
});

jest.mock('../../config/notifications.js', () => ({
    __esModule: true,
    showAppNotification: jest.fn()
}));

const GestionLotsManager = require('./gestion-lots.js').default;

function mountMinimalLotTable() {
    document.body.innerHTML = `
        <span id="lot-line-count-value">0</span>
        <div id="lot-selection-bar" hidden aria-hidden="true">
            <span id="lot-selection-count">0 sélectionnées</span>
        </div>
        <table>
            <thead>
                <tr>
                    <th><input type="checkbox" id="select-all"></th>
                    <th>N°</th>
                    <th>S/N</th>
                </tr>
            </thead>
            <tbody id="lot-table-body"></tbody>
        </table>
    `;
}

function getSerialValues() {
    const tbody = document.getElementById('lot-table-body');
    return [...tbody.querySelectorAll('input[name="serial_number"]')].map(
        (input) => input.value
    );
}

function pressEnterOnSerial(input) {
    input.focus();
    const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true
    });
    Object.defineProperty(event, 'target', { value: input, enumerable: true });
    input.dispatchEvent(event);
}

describe('GestionLotsManager — Enter sur S/N (scan)', () => {
    let manager;
    let initSpy;

    beforeEach(() => {
        jest.useRealTimers();
        mountMinimalLotTable();

        if (!HTMLElement.prototype.scrollIntoView) {
            HTMLElement.prototype.scrollIntoView = jest.fn();
        } else {
            jest.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
        }

        initSpy = jest
            .spyOn(GestionLotsManager.prototype, 'init')
            .mockImplementation(function lightweightInit() {
                this.marques = [{ id: 1, name: 'Dell' }];
                this.modeles = [{ id: 1, name: 'Latitude', marque_id: 1 }];
                this.setupEventListeners();
            });

        manager = new GestionLotsManager(null);

        const tbody = document.getElementById('lot-table-body');
        tbody.appendChild(manager.createRow('', 'scan'));
        manager.updateLotUI();
    });

    afterEach(() => {
        if (manager) {
            manager.destroy();
            manager = null;
        }
        initSpy?.mockRestore();
        document.body.innerHTML = '';
        jest.restoreAllMocks();
    });

    it('crée une nouvelle ligne SCAN vide + autofocus à chaque Enter (4 scans)', () => {
        const serials = ['SN-001', 'SN-002', 'SN-003', 'SN-004'];

        serials.forEach((sn, index) => {
            const tbody = document.getElementById('lot-table-body');
            const rowsBefore = tbody.querySelectorAll('tr').length;
            const previousValues = getSerialValues();

            // La dernière ligne doit être vide et prête pour le scan
            const lastInput = tbody.querySelector('tr:last-child input[name="serial_number"]');
            expect(lastInput.value).toBe('');

            lastInput.value = sn;
            pressEnterOnSerial(lastInput);

            const rowsAfter = tbody.querySelectorAll('tr').length;
            expect(rowsAfter).toBe(rowsBefore + 1);

            const values = getSerialValues();
            // Les S/N déjà saisis restent
            for (let i = 0; i <= index; i++) {
                expect(values[i]).toBe(serials[i]);
            }
            // Les lignes précédentes non touchées gardent leur valeur
            previousValues.forEach((prev, i) => {
                if (prev) expect(values[i]).toBe(prev);
            });
            // Dernière ligne vide
            expect(values[values.length - 1]).toBe('');
            expect(values).toHaveLength(index + 2);

            const focused = document.activeElement;
            expect(focused).toBeTruthy();
            expect(focused.name).toBe('serial_number');
            expect(focused.value).toBe('');
            expect(focused.closest('tr')).toBe(tbody.querySelector('tr:last-child'));
        });

        expect(document.getElementById('lot-table-body').querySelectorAll('tr').length).toBe(5);
        expect(getSerialValues()).toEqual(['SN-001', 'SN-002', 'SN-003', 'SN-004', '']);
    });


    it('crée une nouvelle ligne SCAN vide + autofocus à chaque Enter (20 scans)', () => {
        const serials = Array.from({ length: 20 }, (_, i) => `SN-${String(i + 1).padStart(3, '0')}`);

        serials.forEach((sn, index) => {
            const tbody = document.getElementById('lot-table-body');
            const rowsBefore = tbody.querySelectorAll('tr').length;
            const previousValues = getSerialValues();

            const lastInput = tbody.querySelector('tr:last-child input[name="serial_number"]');
            expect(lastInput.value).toBe('');

            lastInput.value = sn;
            pressEnterOnSerial(lastInput);

            const rowsAfter = tbody.querySelectorAll('tr').length;
            expect(rowsAfter).toBe(rowsBefore + 1);

            const values = getSerialValues();
            for (let i = 0; i <= index; i++) {
                expect(values[i]).toBe(serials[i]);
            }
            previousValues.forEach((prev, i) => {
                if (prev) expect(values[i]).toBe(prev);
            });
            expect(values[values.length - 1]).toBe('');
            expect(values).toHaveLength(index + 2);

            const focused = document.activeElement;
            expect(focused).toBeTruthy();
            expect(focused.name).toBe('serial_number');
            expect(focused.value).toBe('');
            expect(focused.closest('tr')).toBe(tbody.querySelector('tr:last-child'));
        });

        const finalValues = getSerialValues();
        expect(document.getElementById('lot-table-body').querySelectorAll('tr').length).toBe(21);
        expect(finalValues).toEqual([...serials, '']);
        expect(new Set(serials).size).toBe(20);
        expect(finalValues.slice(0, 20)).toEqual(serials);

        const focused = document.activeElement;
        expect(focused.name).toBe('serial_number');
        expect(focused.value).toBe('');
        expect(focused.closest('tr')).toBe(
            document.getElementById('lot-table-body').querySelector('tr:last-child')
        );
    });

    it('n’ajoute pas de ligne si le S/N est vide', () => {
        const tbody = document.getElementById('lot-table-body');
        const input = tbody.querySelector('input[name="serial_number"]');
        input.value = '   ';
        pressEnterOnSerial(input);
        expect(tbody.querySelectorAll('tr').length).toBe(1);
    });

    it('n’ajoute pas de ligne et garde le focus en cas de doublon', () => {
        const tbody = document.getElementById('lot-table-body');
        const first = tbody.querySelector('input[name="serial_number"]');
        first.value = 'DUP-1';
        pressEnterOnSerial(first);
        expect(tbody.querySelectorAll('tr').length).toBe(2);

        const second = tbody.querySelector('tr:last-child input[name="serial_number"]');
        second.value = 'dup-1';
        pressEnterOnSerial(second);

        expect(tbody.querySelectorAll('tr').length).toBe(2);
        expect(document.activeElement).toBe(second);
        expect(getSerialValues()).toEqual(['DUP-1', 'dup-1']);
    });

    it('insertBefore place la nouvelle ligne juste après la ligne courante', () => {
        const tbody = document.getElementById('lot-table-body');
        const first = manager.createRow('A', 'scan');
        const third = manager.createRow('C', 'scan');
        tbody.innerHTML = '';
        tbody.appendChild(first);
        tbody.appendChild(third);

        const snA = first.querySelector('input[name="serial_number"]');
        // Simule Enter sur la première ligne alors qu'une ligne existe déjà après
        snA.value = 'A';
        pressEnterOnSerial(snA);

        const values = getSerialValues();
        expect(values).toEqual(['A', '', 'C']);
        expect(document.activeElement.value).toBe('');
        expect(document.activeElement.closest('tr')).toBe(tbody.children[1]);
    });
});
