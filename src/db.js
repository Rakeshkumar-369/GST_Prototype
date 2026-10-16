'use strict';
// Minimal JSON-file store for the demo. In production this maps to SQL Server tables
// (see docs/GST_Integration_Solution.md, section "Data model").
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'portal-db.json');

const empty = () => ({
  vendors: [],
  payments: [],
  invoices: [],
  batches: [],
  counters: { vendor: 0, payment: 0, batch: 0, invoiceByFy: {} }
});

let state = empty();
try {
  if (fs.existsSync(FILE)) state = { ...empty(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch (e) {
  console.warn('Could not read DB file, starting fresh:', e.message);
}

let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFile(FILE, JSON.stringify(state), (err) => err && console.error('DB write failed', err));
  }, 300);
}

function reset() {
  state = empty();
  save();
}

module.exports = { get: () => state, save, reset };
