'use strict';
// e-Procurement GST Integration — demo server (zero dependencies, Node 18+).
//   node server.js   ->  http://localhost:4000
const http = require('http');
const fs = require('fs');
const path = require('path');

const config = require('./src/config');
const db = require('./src/db');
const gstinUtil = require('./src/gstin');
const { createTaxInvoice, periodOf, inWords, r2 } = require('./src/invoice');
const gstr1 = require('./src/gstr1');
const mediator = require('./src/mediatorClient');
const mock = require('./mock/quickoMock');

const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

const json = (res, code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
const fail = (res, code, message, extra = {}) => json(res, code, { message, ...extra });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 200 * 1024 * 1024) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

// ------------------------------------------------------------------ vendors
async function registerVendor(body) {
  const s = db.get();
  const vendor = {
    id: `V${String(++s.counters.vendor).padStart(5, '0')}`,
    legalName: (body.legalName || '').trim(),
    tradeName: '',
    email: (body.email || '').trim(),
    mobile: (body.mobile || '').trim(),
    address: (body.address || '').trim(),
    stateCode: body.stateCode || config.supplier.stateCode,
    gstin: null,
    gstinStatus: 'NOT_PROVIDED',
    verification: null,
    createdAt: new Date().toISOString()
  };
  if (!vendor.legalName) throw Object.assign(new Error('Vendor name is required'), { status: 400 });

  if (body.gstin) {
    const v = gstinUtil.validate(body.gstin);
    if (!v.ok) throw Object.assign(new Error(`GSTIN rejected before API call: ${v.reason}`), { status: 422 });
    if (s.vendors.some((x) => x.gstin === v.gstin)) throw Object.assign(new Error('A vendor with this GSTIN is already registered'), { status: 409 });
    const res = await mediator.searchGstin(v.gstin);
    const d = res.data;
    vendor.gstin = v.gstin;
    vendor.gstinStatus = d.sts;
    vendor.legalName = d.lgnm || vendor.legalName; // GSTN legal name is the source of truth on the invoice
    vendor.tradeName = d.tradeNam || '';
    vendor.address = vendor.address || d.pradr?.adr || '';
    vendor.stateCode = v.stateCode;
    vendor.verification = { at: new Date().toISOString(), via: config.mediator.name, transactionId: res.transaction_id, constitution: d.ctb, registeredOn: d.rgdt, taxpayerType: d.dty, mockGenerated: !!d.mock_generated };
    if (d.sts !== 'Active') {
      throw Object.assign(new Error(`GSTIN ${v.gstin} is ${d.sts} on GSTN (cancelled on ${d.cxdt || 'n/a'}). Register without GSTIN or provide an active GSTIN.`), { status: 422, data: d });
    }
  }
  s.vendors.push(vendor);
  db.save();
  return vendor;
}

// ------------------------------------------------------------------ payments + invoices
function recordPayment(body, when) {
  const s = db.get();
  const vendor = s.vendors.find((v) => v.id === body.vendorId);
  if (!vendor) throw Object.assign(new Error('Vendor not found'), { status: 404 });
  const comp = {
    transactionFee: r2(Number(body.transactionFee || 0)),
    corpusFund: r2(Number(body.corpusFund || 0)),
    documentationFee: r2(Number(body.documentationFee || 0)),
    processFee: r2(Number(body.processFee || 0))
  };
  if (comp.transactionFee <= 0) throw Object.assign(new Error('Transaction fee must be > 0'), { status: 400 });
  const payment = {
    id: `P${String(++s.counters.payment).padStart(7, '0')}`,
    vendorId: vendor.id,
    tenderId: body.tenderId || `AP-TND-${Math.floor(100000 + Math.random() * 899999)}`,
    tenderTitle: body.tenderTitle || 'Supply / Works tender',
    components: comp,
    paidAt: when || new Date().toISOString(),
    gatewayRef: `PG${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 1000)}`
  };
  // Generated synchronously at payment success — the "instant invoice" pattern (Uber/Zomato style).
  const invoice = createTaxInvoice(s, { vendor, payment });
  payment.invoiceId = invoice.id;
  payment.gst = invoice.totals;
  payment.grandTotal = r2(invoice.totals.total + comp.corpusFund + comp.documentationFee + comp.processFee);
  s.payments.push(payment);
  return { payment, invoice };
}

function simulate(body) {
  const s = db.get();
  const count = Math.min(Math.max(Number(body.count) || 1000, 1), 200000);
  const [mm, yyyy] = [Number(body.period.slice(0, 2)), Number(body.period.slice(2))];
  const days = new Date(yyyy, mm, 0).getDate();
  const active = s.vendors.filter((v) => v.gstinStatus === 'Active');
  const unregistered = s.vendors.filter((v) => !v.gstin);
  if (!active.length) throw Object.assign(new Error('Register at least one vendor with GSTIN first (or use "Load sample vendors")'), { status: 400 });
  const fees = [500, 1000, 2500, 5000, 10000, 25000];
  const started = Date.now();
  for (let i = 0; i < count; i++) {
    const pool = unregistered.length && Math.random() < 0.08 ? unregistered : active;
    const vendor = pool[Math.floor(Math.random() * pool.length)];
    const when = new Date(yyyy, mm - 1, 1 + Math.floor(Math.random() * days), 9 + Math.floor(Math.random() * 9), Math.floor(Math.random() * 60)).toISOString();
    recordPayment({ vendorId: vendor.id, transactionFee: fees[Math.floor(Math.random() * fees.length)], documentationFee: 1000, processFee: 500, corpusFund: 0 }, when);
  }
  // keep invoice numbers in date order is not required by GST (only unique & consecutive per series)
  db.save();
  return { created: count, ms: Date.now() - started };
}

// ------------------------------------------------------------------ GSTR-1 batch + filing workflow
function createBatch(period) {
  const s = db.get();
  if (!/^\d{6}$/.test(period)) throw Object.assign(new Error('Period must be MMYYYY'), { status: 400 });
  if (s.batches.some((b) => b.period === period && b.status === 'FILED')) throw Object.assign(new Error(`GSTR-1 for ${period} already filed`), { status: 409 });
  const invoices = s.invoices.filter((i) => i.period === period && i.gstr1.status !== 'FILED');
  if (!invoices.length) throw Object.assign(new Error(`No pending invoices for ${period}`), { status: 400 });
  s.batches = s.batches.filter((b) => !(b.period === period && b.status !== 'FILED')); // rebuild draft
  const { payload, summary } = gstr1.build(invoices, period);
  const parts = gstr1.chunk(payload);
  const batch = {
    id: `B${String(++s.counters.batch).padStart(4, '0')}`,
    period,
    createdAt: new Date().toISOString(),
    status: 'DRAFT',
    summary,
    partCount: parts.length,
    parts: parts.map((p, i) => ({ no: i + 1, invoices: (p.b2b || []).reduce((a, x) => a + x.inv.length, 0), status: 'PENDING', referenceId: null, errors: [] })),
    invoiceIds: invoices.map((i) => i.id),
    session: null,
    gstnSummary: null,
    arn: null,
    events: [{ at: new Date().toISOString(), msg: `Batch created: ${summary.invoiceCount} invoices (${summary.b2bCount} B2B / ${summary.b2cCount} B2C), ${parts.length} part(s)` }]
  };
  for (const inv of invoices) { inv.gstr1.batchId = batch.id; inv.gstr1.status = 'IN_BATCH'; }
  s.batches.push(batch);
  db.save();
  batchPayloads.set(batch.id, parts);
  return batch;
}

const batchPayloads = new Map();
function partsFor(batch) {
  if (!batchPayloads.has(batch.id)) {
    const s = db.get();
    const ids = new Set(batch.invoiceIds);
    batchPayloads.set(batch.id, gstr1.chunk(gstr1.build(s.invoices.filter((i) => ids.has(i.id)), batch.period).payload));
  }
  return batchPayloads.get(batch.id);
}
const ev = (b, msg) => { b.events.push({ at: new Date().toISOString(), msg }); db.save(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function uploadBatch(batch) {
  batch.status = 'UPLOADING';
  ev(batch, 'Upload started');
  const parts = partsFor(batch);
  for (let i = 0; i < parts.length; i++) {
    const meta = batch.parts[i];
    if (meta.status === 'PROCESSED') continue; // idempotent resume
    try {
      meta.status = 'SAVING';
      const r = await mediator.saveGstr1(batch.session, batch.period, parts[i]);
      meta.referenceId = r.data.reference_id;
      let st;
      do { await sleep(250); st = (await mediator.gstr1Status(batch.session, batch.period, meta.referenceId)).data; } while (st.status_cd === 'IP');
      meta.status = st.status_cd === 'P' ? 'PROCESSED' : 'PROCESSED_WITH_ERRORS';
      meta.errors = st.error_report || [];
      ev(batch, `Part ${i + 1}/${parts.length}: ${st.status_cd === 'P' ? 'saved' : `saved with ${st.error_count} error(s)`} (ref ${meta.referenceId})`);
    } catch (e) {
      meta.status = 'FAILED'; meta.errors = [{ error: e.message }];
      batch.status = 'UPLOAD_FAILED';
      ev(batch, `Part ${i + 1} failed: ${e.message}. Fix and click "Upload" again — processed parts are skipped.`);
      return;
    }
  }
  const sum = await mediator.gstr1Summary(batch.session, batch.period);
  batch.gstnSummary = sum.data;
  batch.status = batch.parts.some((p) => p.errors.length) ? 'SAVED_WITH_ERRORS' : 'READY_TO_FILE';
  ev(batch, `GSTN summary generated. Liability ₹${sum.data.summary.total_liability.toLocaleString('en-IN')} — compare with portal ₹${batch.summary.totalTax.toLocaleString('en-IN')}`);
}

// ------------------------------------------------------------------ static + routing
function serveStatic(req, res, url) {
  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (p === '/' || p === '\\') p = '/index.html';
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC)) return fail(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return fail(res, 404, 'Not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function stats() {
  const s = db.get();
  const sum = (arr, f) => r2(arr.reduce((a, x) => a + f(x), 0));
  return {
    supplier: config.supplier,
    mediator: { name: config.mediator.name, baseUrl: config.mediator.baseUrl || '(built-in mock)' },
    vendors: s.vendors.length,
    vendorsWithGstin: s.vendors.filter((v) => v.gstinStatus === 'Active').length,
    payments: s.payments.length,
    invoices: s.invoices.length,
    b2b: s.invoices.filter((i) => i.type === 'B2B').length,
    gstCollected: sum(s.invoices, (i) => i.totals.totalTax),
    itcPassedOn: sum(s.invoices.filter((i) => i.type === 'B2B' && i.gstr1.status === 'FILED'), (i) => i.totals.totalTax),
    pendingFiling: s.invoices.filter((i) => i.gstr1.status !== 'FILED').length,
    periods: [...new Set(s.invoices.map((i) => i.period))].sort((a, b) => (a.slice(2) + a.slice(0, 2)).localeCompare(b.slice(2) + b.slice(0, 2)))
  };
}

async function api(req, res, url, body) {
  const s = db.get();
  const p = url.pathname;
  const m = req.method;
  let mt;

  if (m === 'GET' && p === '/api/stats') return json(res, 200, stats());
  if (m === 'GET' && p === '/api/api-log') return json(res, 200, mediator.log.slice(0, 60));

  if (m === 'POST' && p === '/api/gstin/validate') return json(res, 200, gstinUtil.validate(body.gstin));
  if (m === 'GET' && p === '/api/sample-gstins') return json(res, 200, [...mock.registry.values()].map((r) => ({ gstin: r.gstin, name: r.lgnm, status: r.sts })));

  if (m === 'GET' && p === '/api/vendors') return json(res, 200, s.vendors);
  if (m === 'POST' && p === '/api/vendors') return json(res, 201, await registerVendor(body));
  if (m === 'POST' && p === '/api/vendors/load-samples') {
    const added = [];
    for (const r of mock.registry.values()) {
      if (r.sts !== 'Active' || s.vendors.some((v) => v.gstin === r.gstin)) continue;
      added.push(await registerVendor({ legalName: r.lgnm, gstin: r.gstin, email: `accounts@${r.tradeNam.toLowerCase().replace(/[^a-z]/g, '')}.example.com` }));
    }
    if (!s.vendors.some((v) => !v.gstin)) added.push(await registerVendor({ legalName: 'Unregistered Small Contractor (no GSTIN)', address: 'Ongole, Andhra Pradesh', stateCode: '37' }));
    return json(res, 200, { added: added.length });
  }

  if (m === 'GET' && p === '/api/payments') return json(res, 200, s.payments.slice(-50).reverse());
  if (m === 'POST' && p === '/api/payments') { const r = recordPayment(body); db.save(); return json(res, 201, r); }
  if (m === 'POST' && p === '/api/simulate') return json(res, 200, simulate({ period: body.period || periodOf(new Date()), count: body.count }));

  if (m === 'GET' && p === '/api/invoices') {
    const q = (url.searchParams.get('q') || '').toUpperCase();
    const period = url.searchParams.get('period');
    let list = s.invoices;
    if (period) list = list.filter((i) => i.period === period);
    if (q) list = list.filter((i) => i.number.includes(q) || (i.recipient.gstin || '').includes(q) || i.recipient.legalName.toUpperCase().includes(q));
    return json(res, 200, { total: list.length, items: list.slice(-100).reverse() });
  }
  if (m === 'GET' && (mt = p.match(/^\/api\/invoices\/([A-Z0-9]+)$/))) {
    const inv = s.invoices.find((i) => i.id === mt[1]);
    if (!inv) return fail(res, 404, 'Invoice not found');
    const payment = s.payments.find((x) => x.id === inv.paymentId);
    return json(res, 200, { ...inv, amountInWords: inWords(inv.totals.total), payment });
  }

  if (m === 'GET' && p === '/api/batches') return json(res, 200, s.batches.map(({ invoiceIds, ...b }) => b).reverse());
  if (m === 'POST' && p === '/api/batches') { const b = createBatch(body.period); const { invoiceIds, ...rest } = b; return json(res, 201, rest); }

  if ((mt = p.match(/^\/api\/batches\/(B\d+)(\/[a-z0-9-]+)?$/))) {
    const batch = s.batches.find((b) => b.id === mt[1]);
    if (!batch) return fail(res, 404, 'Batch not found');
    const action = mt[2];
    if (m === 'GET' && action === '/gstr1.json') {
      const parts = partsFor(batch);
      const ids = new Set(batch.invoiceIds);
      const merged = gstr1.build(s.invoices.filter((i) => ids.has(i.id)), batch.period).payload;
      return json(res, 200, url.searchParams.get('part') ? parts[Number(url.searchParams.get('part')) - 1] : merged,
        { 'content-disposition': `attachment; filename="GSTR1_${config.supplier.gstin}_${batch.period}.json"` });
    }
    if (m === 'POST' && action === '/request-otp') {
      const r = await mediator.requestOtp(config.supplier.gstin, config.supplier.gstUsername);
      ev(batch, 'OTP requested for GSTN taxpayer session');
      return json(res, 200, r);
    }
    if (m === 'POST' && action === '/connect') {
      const r = await mediator.verifyOtp(config.supplier.gstin, config.supplier.gstUsername, String(body.otp || ''));
      batch.session = r.data.taxpayer_token;
      batch.status = batch.status === 'DRAFT' ? 'CONNECTED' : batch.status;
      ev(batch, 'GSTN session established (valid 6 hours)');
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && action === '/upload') {
      if (!batch.session) return fail(res, 400, 'Connect to GSTN first (OTP)');
      if (batch.status === 'UPLOADING') return fail(res, 409, 'Upload already running');
      uploadBatch(batch).catch((e) => { batch.status = 'UPLOAD_FAILED'; ev(batch, `Upload error: ${e.message}`); });
      return json(res, 202, { started: true });
    }
    if (m === 'POST' && action === '/file') {
      if (!['READY_TO_FILE', 'SAVED_WITH_ERRORS'].includes(batch.status)) return fail(res, 400, `Batch is ${batch.status}; upload must complete first`);
      const r = await mediator.fileGstr1(batch.session, batch.period, String(body.otp || ''), batch.gstnSummary.summary_hash);
      batch.status = 'FILED';
      batch.arn = r.data.arn;
      batch.filedAt = r.data.filed_on;
      const failed = new Set(batch.parts.flatMap((pt) => pt.errors).map((e) => e.inum).filter(Boolean));
      for (const inv of s.invoices) {
        if (inv.gstr1.batchId === batch.id) inv.gstr1 = { status: failed.has(inv.number) ? 'REJECTED' : 'FILED', batchId: batch.id, arn: batch.arn, filedAt: batch.filedAt };
      }
      ev(batch, `GSTR-1 filed with EVC. ARN ${batch.arn}. ITC will appear in recipients' GSTR-2B for ${batch.period}.`);
      return json(res, 200, { arn: batch.arn });
    }
    if (m === 'GET' && !action) { const { invoiceIds, ...rest } = batch; return json(res, 200, rest); }
  }

  if (m === 'GET' && (mt = p.match(/^\/api\/gstr2b\/([0-9A-Z]{15})\/(\d{6})$/))) return json(res, 200, await mediator.gstr2b(mt[1], mt[2]));

  if (m === 'POST' && p === '/api/reset') { db.reset(); mock.reset(); batchPayloads.clear(); return json(res, 200, { ok: true }); }

  return fail(res, 404, `No route ${m} ${p}`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
    if (mock.handle(req, res, url, body)) return;
    if (url.pathname.startsWith('/api/')) return await api(req, res, url, body);
    return serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) fail(res, e.status && e.status >= 400 ? e.status : 500, e.message, e.data ? { data: e.data } : {});
  }
});

server.listen(config.port, () => {
  console.log(`e-Procurement GST integration demo running at http://localhost:${config.port}`);
  console.log(`Supplier GSTIN ${config.supplier.gstin} | Mediator: ${config.mediator.name} ${config.mediator.baseUrl || '(built-in mock)'}`);
});
