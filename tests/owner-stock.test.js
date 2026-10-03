const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'owner.html'), 'utf8');
const functions = [
    'normalizeAdminColorStockEntries',
    'getAdminColorStockTotals',
    'getFilteredAdminColorStockEntries',
    'getInventoryHealth',
    'getFilteredInventory',
    'formatAdminColorStockSummary',
    'renderAdminColorStockEditor',
    'renderAdminStats',
    'focusAdminDashboardArea'
];

function createDashboard() {
    const elements = new Map();
    const context = vm.createContext({
        ADMIN_INVENTORY_SIZE_OPTIONS: ['Adult S', 'Adult M', 'Adult L'],
        adminDashboardState: { inventory: [], sales: {} },
        adminColorStockEntries: [],
        adminNewOrderAlert: false,
        document: {
            getElementById(id) {
                if (!elements.has(id)) {
                    elements.set(id, {
                        value: '', innerHTML: '', textContent: '', hidden: false,
                        querySelectorAll() { return []; },
                        scrollIntoView() {}
                    });
                }
                return elements.get(id);
            }
        },
        escapeHtml: String,
        formatPriceAmount: amount => '$' + amount.toFixed(2),
        getAdminSizeLabel: String,
        getAdminWebsiteColorHex: () => '#fff',
        populateAdminColorStockSelect() {},
        renderAdminStockMetrics(entries) { context.metricEntries = entries; },
        renderAdminInventory() {},
        showAdminMetricModal(action) { context.modalAction = action; }
    });
    functions.forEach(name => {
        const start = html.indexOf('        function ' + name + '(');
        assert.ok(start >= 0, name + ' exists');
        const rest = html.slice(start + 1);
        const next = rest.search(/^        (?:function |async function |let |const )/m);
        vm.runInContext(html.slice(start, next < 0 ? undefined : start + 1 + next), context);
    });
    return { context, element: id => context.document.getElementById(id) };
}

const entries = [
    { color: 'Black', size: 'Adult S', stock: 0, outOfStock: false },
    { color: 'Black', size: 'Adult M', stock: 3, outOfStock: false },
    { color: 'White', size: 'Adult L', stock: 8, outOfStock: false },
    { color: 'Red', size: 'Adult M', stock: 9, outOfStock: true },
    { color: 'Blue', size: 'Adult S', stock: 0, outOfStock: true },
    { color: 'Green', size: '', stock: 5, outOfStock: true },
    { color: 'Green', size: 'Adult L', stock: 6, outOfStock: false }
];

test('in-stock colors exclude zero units, manually sold-out sizes and blocked legacy colors', () => {
    const { context } = createDashboard();
    const visible = context.getFilteredAdminColorStockEntries(entries, 'in-stock', 4);
    assert.deepEqual(Array.from(visible, record => record.index), [1, 2]);
    const totals = context.getAdminColorStockTotals(entries);
    assert.equal(Array.from(totals.values()).filter(color => !color.outOfStock && color.stock > 0).length, 2);
});

test('low stock includes the reorder boundary but never sold-out or healthy entries', () => {
    const { context } = createDashboard();
    const variants = entries.concat({ color: 'Yellow', size: 'Adult S', stock: 4, outOfStock: false });
    assert.deepEqual(Array.from(context.getFilteredAdminColorStockEntries(variants, 'low', 4), record => record.index), [1, 7]);
    assert.equal(context.getFilteredAdminColorStockEntries(variants, 'low', 0).length, 0);
});

test('all and sold-out color views preserve their intended scopes', () => {
    const { context } = createDashboard();
    assert.equal(context.getFilteredAdminColorStockEntries(entries, 'all', 4).length, entries.length);
    assert.deepEqual(Array.from(context.getFilteredAdminColorStockEntries(entries, 'out-colors', 4), record => record.index), [3, 4, 5, 6]);
});

test('stock cards set matching editor and item filters and restore the full inventory view', () => {
    const { context, element } = createDashboard();
    element('admin-color-stock-view').value = 'all';
    element('admin-inventory-search').value = 'previous search';
    context.focusAdminDashboardArea('in-stock');
    assert.equal(element('admin-color-stock-view').value, 'in-stock');
    assert.equal(element('admin-inventory-filter').value, 'in-stock');
    assert.equal(element('admin-inventory-items-section').hidden, true);
    assert.equal(element('admin-inventory-search').value, '');
    context.focusAdminDashboardArea('low-stock');
    assert.equal(element('admin-color-stock-view').value, 'low');
    assert.equal(element('admin-inventory-filter').value, 'low');
    assert.equal(element('admin-inventory-items-section').hidden, false);
    context.focusAdminDashboardArea('inventory-units');
    assert.equal(element('admin-color-stock-view').value, 'all');
    assert.equal(element('admin-inventory-filter').value, 'all');
});

test('editor rows, metrics and summaries use only the selected stock view with original edit indexes', () => {
    const { context, element } = createDashboard();
    context.adminColorStockEntries = entries.slice(0, 5);
    context.adminDashboardState.inventory = [{ id: 'shirts', reorderLevel: 4 }];
    element('admin-item-id').value = 'shirts';
    element('admin-color-stock-view').value = 'low';
    context.renderAdminColorStockEditor();
    assert.deepEqual(Array.from(context.metricEntries, entry => entry.color), ['Black']);
    const markup = element('admin-color-stock-list').innerHTML;
    assert.match(markup, /data-color-stock-index="1"/);
    assert.doesNotMatch(markup, /data-color-stock-index="0"|White|Red|Blue/);
    assert.match(element('admin-color-stock-summary').textContent, /3 shirts in this view/);
    context.adminColorStockEntries = [];
    context.renderAdminColorStockEditor();
    assert.equal(context.metricEntries.length, 0);
});

test('item low-stock and in-stock lists and their color summaries exclude sold-out entries', () => {
    const { context, element } = createDashboard();
    const items = [
        { name: 'Out', stock: 0, reorderLevel: 4 },
        { name: 'Low', stock: 4, reorderLevel: 4, colorStock: entries },
        { name: 'Healthy', stock: 5, reorderLevel: 4 }
    ];
    element('admin-inventory-filter').value = 'low';
    assert.deepEqual(Array.from(context.getFilteredInventory(items), item => item.name), ['Low']);
    assert.equal(context.formatAdminColorStockSummary(items[1]), 'Black (Adult M): 3 in stock');
    element('admin-inventory-filter').value = 'in-stock';
    assert.deepEqual(Array.from(context.getFilteredInventory(items), item => item.name), ['Low', 'Healthy']);
    assert.doesNotMatch(context.formatAdminColorStockSummary(items[1]), /Out of stock|Red|Blue|Green/);
});

test('in-stock card is named In Stock Colors and counts distinct available colors', () => {
    const { context, element } = createDashboard();
    context.adminDashboardState.inventory = [{ colorStock: entries }];
    context.renderAdminStats({}, {});
    assert.match(element('admin-stats-grid').innerHTML, /aria-label="Open In Stock Colors"><span>In Stock Colors<\/span><strong>2<\/strong>/);
    assert.match(html, /\.admin-stat-card\[data-stat-action="in-stock"\][\s\S]*?rgba\(78, 201, 126/);
});

test('all inline owner scripts parse', () => {
    for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
        new vm.Script(script[1]);
    }
});
