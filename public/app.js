'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const periodLabel = (p) => new Date(Number(p.slice(2)), Number(p.slice(0, 2)) - 1, 1).toLocaleString('en-IN', { month: 'short', year: 'numeric' });
const nowPeriod = () => { const d = new Date(); return String(d.getMonth() + 1).padStart(2, '0') + d.getFullYear(); };

async function api(path, opts = {}) {
  const res = await fetch(path, { method: opts.method || 'GET', headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}
function msg(el, text, kind = 'ok') { el.className = `msg ${kind}`; el.innerHTML = text; }
const formData = (f) => Object.fromEntries(new FormData(f).entries());

let STATS = null;
let currentBatch = null;

// ---------------------------------------------------------------- navigation
function show(tab, step) {
  $$('.tab').forEach((t) => (t.hidden = t.id !== `tab-${tab}`));
  $$('#flow button').forEach((b) => b.classList.toggle('active', step ? b.dataset.step === String(step) : b.dataset.tab === tab));
  refresh(tab);
}
$$('#flow button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab, b.dataset.step)));
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => show(b.dataset.goto)));
$('.brand').addEventListener('click', () => show('dashboard'));

async function refresh(tab) {
  STATS = await api('/api/stats');
  renderHeader();
  if (tab === 'dashboard') renderKpis();
  if (tab === 'vendors') loadVendors();
  if (tab === 'payments') { loadVendorSelect(); loadPayments(); }
  if (tab === 'invoices') { fillPeriods($('#invPeriod'), true); loadInvoices(); }
  if (tab === 'filing') { fillPeriods($('#batchPeriod')); loadBatches(); }
  if (tab === 'itc') { loadItcSelectors(); }
}

function renderHeader() {
  const s = STATS.supplier;
  $('#supplierBox').innerHTML = `<div class="small muted">Supplier (invoice issuer)</div><div><b>${esc(s.tradeName)}</b></div><div class="mono small">GSTIN ${esc(s.gstin)}</div>`;
  $('#mediatorName').textContent = `${STATS.mediator.name}`;
}

function renderKpis() {
  const k = STATS;
  const tiles = [
    ['Vendors registered', k.vendors, `${k.vendorsWithGstin} with verified GSTIN`],
    ['Fee payments', k.payments.toLocaleString('en-IN'), 'transaction fee collected'],
    ['Tax invoices issued', k.invoices.toLocaleString('en-IN'), `${k.b2b.toLocaleString('en-IN')} B2B (ITC eligible)`],
    ['GST collected', inr(k.gstCollected), 'on transaction fee @18%'],
    ['ITC passed to vendors', inr(k.itcPassedOn), 'filed in GSTR-1 (B2B)'],
    ['Pending for GSTR-1', k.pendingFiling.toLocaleString('en-IN'), 'invoices not yet filed']
  ];
  $('#kpis').innerHTML = tiles.map(([l, v, s]) => `<div class="kpi"><div class="kl">${l}</div><div class="kv">${v}</div><div class="ks">${s}</div></div>`).join('');
}

function fillPeriods(sel, withAll) {
  const cur = sel.value;
  const periods = [...new Set([...STATS.periods, nowPeriod()])].reverse();
  sel.innerHTML = (withAll ? '<option value="">All periods</option>' : '') + periods.map((p) => `<option value="${p}">${periodLabel(p)} (${p})</option>`).join('');
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

// ---------------------------------------------------------------- vendors
const gstinInput = $('#gstinInput');
gstinInput.addEventListener('input', async () => {
  gstinInput.value = gstinInput.value.toUpperCase();
  const b = $('#gstinCheck');
  if (!gstinInput.value) { b.textContent = ''; b.className = 'badge'; return; }
  if (gstinInput.value.length < 15) { b.textContent = `${gstinInput.value.length}/15`; b.className = 'badge'; return; }
  const v = await api('/api/gstin/validate', { method: 'POST', body: { gstin: gstinInput.value } });
  b.textContent = v.ok ? `✓ ${v.stateName}` : `✗ ${v.reason}`;
  b.className = `badge ${v.ok ? 'good' : 'bad'}`;
});

$('#vendorForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const el = $('#vendorMsg');
  msg(el, 'Calling mediator → GSTN public search…', 'info');
  try {
    const v = await api('/api/vendors', { method: 'POST', body: formData(e.target) });
    msg(el, v.gstin
      ? `✓ Registered <b>${esc(v.legalName)}</b> (${v.id}). GSTIN ${v.gstin} is <b>${v.gstinStatus}</b> — verified via ${esc(v.verification.via)}${v.verification.mockGenerated ? ' (not in sample registry: mock record returned)' : ''}.`
      : `Registered <b>${esc(v.legalName)}</b> without GSTIN → invoices will be B2C (no ITC).`, v.gstin ? 'ok' : 'warn');
    e.target.reset(); $('#gstinCheck').textContent = '';
    loadVendors(); refresh();
  } catch (err) { msg(el, esc(err.message), 'err'); }
  loadApiLog();
});

$('#loadSamples').addEventListener('click', async () => {
  const el = $('#vendorMsg');
  msg(el, 'Verifying sample GSTINs through the mediator…', 'info');
  try { const r = await api('/api/vendors/load-samples', { method: 'POST' }); msg(el, `Added ${r.added} sample vendor(s).`); }
  catch (err) { msg(el, esc(err.message), 'err'); }
  loadVendors(); loadApiLog();
});

async function loadVendors() {
  const list = await api('/api/vendors');
  $('#vendorCount').textContent = list.length;
  $('#vendorTable tbody').innerHTML = list.map((v) => `<tr>
    <td class="mono">${v.id}</td><td>${esc(v.legalName)}${v.tradeName ? `<div class="small muted">${esc(v.tradeName)}</div>` : ''}</td>
    <td class="mono">${v.gstin || '<span class="muted">—</span>'}</td>
    <td>${v.gstin ? `<span class="pill good">${v.gstinStatus}</span>` : '<span class="pill warn">Unregistered (B2C)</span>'}</td>
    <td>${v.stateCode}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No vendors yet.</td></tr>';
  const samples = await api('/api/sample-gstins');
  $('#sampleList').innerHTML = samples.map((s) => `<div class="sample"><code class="click" data-g="${s.gstin}">${s.gstin}</code> ${esc(s.name)} <span class="pill ${s.status === 'Active' ? 'good' : 'bad'}">${s.status}</span></div>`).join('');
  $$('#sampleList .click').forEach((c) => c.addEventListener('click', () => { gstinInput.value = c.dataset.g; gstinInput.dispatchEvent(new Event('input')); }));
}

// ---------------------------------------------------------------- payments
let VENDORS = [];
async function loadVendorSelect() {
  VENDORS = await api('/api/vendors');
  $('#paySelect').innerHTML = VENDORS.map((v) => `<option value="${v.id}">${esc(v.legalName)} — ${v.gstin || 'no GSTIN (B2C)'}</option>`).join('') || '<option value="">Register a vendor first</option>';
  $('#simPeriod').value ||= nowPeriod();
  updatePreview();
}
function updatePreview() {
  const f = formData($('#payForm'));
  const v = VENDORS.find((x) => x.id === f.vendorId);
  if (!v) { $('#payPreview').innerHTML = ''; return; }
  const supState = STATS.supplier.stateCode;
  const pos = v.gstin ? v.gstin.slice(0, 2) : v.stateCode;
  const tf = Number(f.transactionFee || 0), gst = Math.round(tf * 18) / 100;
  const other = Number(f.corpusFund || 0) + Number(f.documentationFee || 0) + Number(f.processFee || 0);
  const intra = pos === supState;
  $('#payPreview').innerHTML = `
    <div class="row between"><span>Invoice type</span><b>${v.gstin ? 'B2B tax invoice (ITC eligible)' : 'B2C tax invoice'}</b></div>
    <div class="row between"><span>Place of supply</span><b>${pos} ${intra ? '(intra-state → CGST 9% + SGST 9%)' : '(inter-state → IGST 18%)'}</b></div>
    <div class="row between"><span>Transaction fee + GST</span><b>${inr(tf)} + ${inr(gst)}</b></div>
    <div class="row between"><span>Non-taxable fees</span><b>${inr(other)}</b></div>
    <div class="row between total"><span>Total payable</span><b>${inr(tf + gst + other)}</b></div>`;
}
$('#payForm').addEventListener('input', updatePreview);
$('#payForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/payments', { method: 'POST', body: formData(e.target) });
    msg($('#payMsg'), `✓ Payment ${r.payment.id} successful. Invoice <b>${r.invoice.number}</b> issued instantly (${r.invoice.type}). <a href="invoice.html?id=${r.invoice.id}" target="_blank">Open invoice ↗</a>`);
    loadPayments();
  } catch (err) { msg($('#payMsg'), esc(err.message), 'err'); }
});
$('#simForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const el = $('#simMsg');
  msg(el, 'Generating…', 'info');
  try {
    const r = await api('/api/simulate', { method: 'POST', body: formData(e.target) });
    msg(el, `✓ ${r.created.toLocaleString('en-IN')} payments + invoices created in ${(r.ms / 1000).toFixed(1)}s.`);
    loadPayments(); STATS = await api('/api/stats');
  } catch (err) { msg(el, esc(err.message), 'err'); }
});
async function loadPayments() {
  const list = await api('/api/payments');
  const vmap = Object.fromEntries((VENDORS.length ? VENDORS : await api('/api/vendors')).map((v) => [v.id, v]));
  $('#payTable tbody').innerHTML = list.slice(0, 15).map((p) => `<tr>
    <td class="mono small">${p.id}<div class="muted">${new Date(p.paidAt).toLocaleString('en-IN')}</div></td>
    <td>${esc(vmap[p.vendorId]?.legalName || p.vendorId)}</td>
    <td class="num">${inr(p.components.transactionFee)}</td><td class="num">${inr(p.gst.totalTax)}</td><td class="num"><b>${inr(p.grandTotal)}</b></td>
    <td><a href="invoice.html?id=${p.invoiceId}" target="_blank">Invoice</a></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No payments yet.</td></tr>';
}

// ---------------------------------------------------------------- invoices
let searchTimer;
$('#invSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadInvoices, 250); });
$('#invPeriod').addEventListener('change', loadInvoices);
const statusPill = (s) => ({ PENDING: 'warn', IN_BATCH: 'info', FILED: 'good', REJECTED: 'bad' }[s] || '');
async function loadInvoices() {
  const q = encodeURIComponent($('#invSearch').value);
  const r = await api(`/api/invoices?q=${q}&period=${$('#invPeriod').value}`);
  $('#invCount').textContent = r.total.toLocaleString('en-IN');
  $('#invTable tbody').innerHTML = r.items.map((i) => `<tr>
    <td class="mono">${i.number}</td><td>${new Date(i.date).toLocaleDateString('en-IN')}</td>
    <td><span class="pill ${i.type === 'B2B' ? 'good' : 'warn'}">${i.type}</span></td>
    <td>${esc(i.recipient.legalName)}</td><td class="mono small">${i.recipient.gstin || '—'}</td><td>${i.placeOfSupply.code}</td>
    <td class="num">${inr(i.totals.taxable)}</td><td class="num">${inr(i.totals.igst)}</td><td class="num">${inr(i.totals.cgst)}</td><td class="num">${inr(i.totals.sgst)}</td>
    <td class="num"><b>${inr(i.totals.total)}</b></td>
    <td><span class="pill ${statusPill(i.gstr1.status)}">${i.gstr1.status}</span></td>
    <td><a href="invoice.html?id=${i.id}" target="_blank">View</a></td></tr>`).join('') || '<tr><td colspan="13" class="muted">No invoices.</td></tr>';
}

// ---------------------------------------------------------------- filing
$('#batchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const b = await api('/api/batches', { method: 'POST', body: formData(e.target) });
    msg($('#batchMsg'), `✓ Batch ${b.id} created.`);
    currentBatch = b.id; loadBatches();
  } catch (err) { msg($('#batchMsg'), esc(err.message), 'err'); }
});

const batchPill = (s) => ({ FILED: 'good', READY_TO_FILE: 'info', SAVED_WITH_ERRORS: 'warn', UPLOAD_FAILED: 'bad' }[s] || '');
async function loadBatches() {
  const list = await api('/api/batches');
  $('#batchList').innerHTML = list.map((b) => `<div class="batch ${b.id === currentBatch ? 'sel' : ''}" data-id="${b.id}">
    <div class="row between"><b>${b.id} · ${periodLabel(b.period)}</b><span class="pill ${batchPill(b.status)}">${b.status}</span></div>
    <div class="small muted">${b.summary.invoiceCount.toLocaleString('en-IN')} invoices · ${b.partCount} part(s) · tax ${inr(b.summary.totalTax)}</div></div>`).join('') || '<p class="muted">No batches yet.</p>';
  $$('#batchList .batch').forEach((d) => d.addEventListener('click', () => { currentBatch = d.dataset.id; loadBatches(); }));
  if (currentBatch) renderBatch(await api(`/api/batches/${currentBatch}`));
}

let pollTimer;
function renderBatch(b) {
  clearTimeout(pollTimer);
  const s = b.summary;
  const steps = [
    ['Batch built', true],
    ['GSTN session (OTP)', !!b.session || b.status === 'FILED'],
    ['Upload & validate', ['READY_TO_FILE', 'SAVED_WITH_ERRORS', 'FILED'].includes(b.status)],
    ['File with EVC', b.status === 'FILED']
  ];
  const errors = b.parts.flatMap((p) => p.errors);
  $('#batchDetail').innerHTML = `
    <div class="row between"><h2>${b.id} · GSTR-1 ${periodLabel(b.period)}</h2><span class="pill ${batchPill(b.status)}">${b.status}</span></div>
    <div class="steps">${steps.map(([l, d], i) => `<div class="st ${d ? 'done' : ''}"><span>${d ? '✓' : i + 1}</span>${l}</div>`).join('')}</div>
    <div class="kpis small4">
      <div class="kpi"><div class="kl">Invoices</div><div class="kv">${s.invoiceCount.toLocaleString('en-IN')}</div><div class="ks">${s.b2bCount.toLocaleString('en-IN')} B2B · ${s.b2cCount.toLocaleString('en-IN')} B2C</div></div>
      <div class="kpi"><div class="kl">Recipients (ctin)</div><div class="kv">${s.recipients}</div><div class="ks">get ITC in GSTR-2B</div></div>
      <div class="kpi"><div class="kl">Taxable value</div><div class="kv">${inr(s.taxable)}</div><div class="ks">SAC transaction fee</div></div>
      <div class="kpi"><div class="kl">Tax</div><div class="kv">${inr(s.totalTax)}</div><div class="ks">IGST ${inr(s.igst)} · CGST ${inr(s.cgst)} · SGST ${inr(s.sgst)}</div></div>
    </div>
    ${b.gstnSummary ? `<div class="recon ${Math.abs(b.gstnSummary.summary.total_liability - s.totalTax) < 1 ? 'ok' : 'warn'}">Reconciliation: Portal tax ${inr(s.totalTax)} vs GSTN summary ${inr(b.gstnSummary.summary.total_liability)}</div>` : ''}
    ${b.arn ? `<div class="arn">ARN <b class="mono">${b.arn}</b> · filed ${new Date(b.filedAt).toLocaleString('en-IN')}</div>` : ''}
    ${b.status === 'FILED' ? '' : `<div class="actions">
      ${`
        <div class="act"><b>Step A</b> Connect to GSTN
          <div class="row"><button class="btn ghost" id="otpReq">Send OTP</button><input id="otp1" placeholder="OTP" size="8"><button class="btn" id="connect">Connect</button></div></div>
        <div class="act"><b>Step B</b> Upload ${b.partCount} part(s) via mediator
          <div class="row"><button class="btn" id="upload" ${b.session ? '' : 'disabled'}>Upload &amp; validate</button></div></div>
        <div class="act"><b>Step C</b> File GSTR-1 with EVC
          <div class="row"><input id="otp2" placeholder="EVC OTP" size="8"><button class="btn" id="file" ${['READY_TO_FILE', 'SAVED_WITH_ERRORS'].includes(b.status) ? '' : 'disabled'}>File GSTR-1</button></div></div>`}
      <div id="batchActMsg" class="msg"></div>
    </div>`}
    <h3>Parts</h3>
    <div class="tablewrap"><table><thead><tr><th>#</th><th>B2B invoices</th><th>Status</th><th>Reference ID</th><th>JSON</th></tr></thead><tbody>
      ${b.parts.map((p) => `<tr><td>${p.no}</td><td>${p.invoices.toLocaleString('en-IN')}</td><td><span class="pill ${p.status === 'PROCESSED' ? 'good' : p.status === 'FAILED' ? 'bad' : p.errors.length ? 'warn' : ''}">${p.status}</span></td><td class="mono small">${p.referenceId || '—'}</td><td><a href="/api/batches/${b.id}/gstr1.json?part=${p.no}" target="_blank">part ${p.no}</a></td></tr>`).join('')}
    </tbody></table></div>
    <p><a href="/api/batches/${b.id}/gstr1.json" download>⬇ Download full GSTR-1 JSON (offline-tool format)</a></p>
    ${errors.length ? `<h3>Error report (${errors.length})</h3><div class="errors">${errors.slice(0, 50).map((e) => `<div>${esc(e.inum || '')} ${esc(e.error)}</div>`).join('')}</div>` : ''}
    <h3>Timeline</h3>
    <div class="events">${b.events.slice().reverse().map((e) => `<div><span class="muted small">${new Date(e.at).toLocaleTimeString('en-IN')}</span> ${esc(e.msg)}</div>`).join('')}</div>`;

  const act = async (fn, okText) => {
    const el = $('#batchActMsg');
    try { await fn(); if (okText) msg(el, okText); } catch (err) { msg(el, esc(err.message), 'err'); }
    loadApiLog(); setTimeout(loadBatches, 300);
  };
  $('#otpReq')?.addEventListener('click', () => act(async () => { const r = await api(`/api/batches/${b.id}/request-otp`, { method: 'POST' }); msg($('#batchActMsg'), esc(r.message), 'info'); }));
  $('#connect')?.addEventListener('click', () => act(() => api(`/api/batches/${b.id}/connect`, { method: 'POST', body: { otp: $('#otp1').value } }), 'Connected to GSTN.'));
  $('#upload')?.addEventListener('click', () => act(() => api(`/api/batches/${b.id}/upload`, { method: 'POST' }), 'Upload started…'));
  $('#file')?.addEventListener('click', () => act(async () => { const r = await api(`/api/batches/${b.id}/file`, { method: 'POST', body: { otp: $('#otp2').value } }); msg($('#batchActMsg'), `✓ Filed. ARN ${r.arn}`); }));
  if (b.status === 'UPLOADING') pollTimer = setTimeout(async () => { if (currentBatch === b.id) { renderBatch(await api(`/api/batches/${b.id}`)); loadApiLog(); } }, 700);
}

// ---------------------------------------------------------------- ITC
async function loadItcSelectors() {
  const vendors = (await api('/api/vendors')).filter((v) => v.gstin);
  const cur = $('#itcVendor').value;
  $('#itcVendor').innerHTML = vendors.map((v) => `<option value="${v.gstin}">${esc(v.legalName)} (${v.gstin})</option>`).join('');
  if (cur) $('#itcVendor').value = cur;
  fillPeriods($('#itcPeriod'));
}
$('#itcForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const g = $('#itcVendor').value, p = $('#itcPeriod').value;
  if (!g) return;
  try {
    const r = (await api(`/api/gstr2b/${g}/${p}`)).data;
    const itc = r.itcsumm.itcavl.nonrevsup.b2b;
    const invs = r.docdata.b2b.flatMap((s) => s.inv.map((i) => ({ ...i, sup: s.ctin, fil: s.supfildt })));
    const total = itc.igst + itc.cgst + itc.sgst;
    $('#itcResult').innerHTML = `
      <div class="kpis small4">
        <div class="kpi"><div class="kl">ITC available</div><div class="kv">${inr(total)}</div><div class="ks">GSTR-2B ${periodLabel(p)}</div></div>
        <div class="kpi"><div class="kl">IGST</div><div class="kv">${inr(itc.igst)}</div></div>
        <div class="kpi"><div class="kl">CGST</div><div class="kv">${inr(itc.cgst)}</div></div>
        <div class="kpi"><div class="kl">SGST</div><div class="kv">${inr(itc.sgst)}</div></div>
      </div>
      ${invs.length ? '' : '<p class="msg warn">No invoices in GSTR-2B for this period yet — the supplier\'s GSTR-1 has not been filed.</p>'}
      <div class="tablewrap"><table><thead><tr><th>Supplier GSTIN</th><th>Invoice</th><th>Date</th><th>POS</th><th class="num">Taxable</th><th class="num">IGST</th><th class="num">CGST</th><th class="num">SGST</th><th>ITC avl</th><th>Supplier filed</th></tr></thead><tbody>
      ${invs.slice(0, 200).map((i) => `<tr><td class="mono small">${i.sup}</td><td class="mono">${i.inum}</td><td>${i.dt}</td><td>${i.pos}</td><td class="num">${inr(i.items[0].txval)}</td><td class="num">${inr(i.items[0].igst)}</td><td class="num">${inr(i.items[0].cgst)}</td><td class="num">${inr(i.items[0].sgst)}</td><td><span class="pill good">${i.itcavl}</span></td><td>${i.fil}</td></tr>`).join('')}
      </tbody></table></div>${invs.length > 200 ? `<p class="muted">Showing 200 of ${invs.length}.</p>` : ''}`;
  } catch (err) { $('#itcResult').innerHTML = `<p class="msg err">${esc(err.message)}</p>`; }
  loadApiLog();
});

// ---------------------------------------------------------------- API log
async function loadApiLog() {
  const log = await api('/api/api-log');
  $('#apiLog').innerHTML = log.map((l) => `<details class="call ${l.error ? 'bad' : ''}">
    <summary><span class="m ${l.method}">${l.method}</span> <span class="p">${esc(l.path.replace('/gst/compliance', '…'))}</span> <span class="s">${l.status} · ${l.ms}ms</span></summary>
    ${l.request ? `<div class="lbl">Request</div><pre>${esc(l.request)}</pre>` : ''}
    <div class="lbl">Response</div><pre>${esc(l.response || l.error)}</pre></details>`).join('') || '<p class="muted small">No calls yet. Register a vendor with GSTIN to see the first one.</p>';
}

$('#resetBtn').addEventListener('click', async () => {
  if (!confirm('Delete all demo vendors, invoices and filings?')) return;
  await api('/api/reset', { method: 'POST' }); currentBatch = null; show('dashboard');
});

show('dashboard');
loadApiLog();
setInterval(loadApiLog, 5000);
