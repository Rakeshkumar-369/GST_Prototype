'use strict';
// ---------------------------------------------------------------------------------------------
// MOCK MEDIATOR (GSP / ASP, e.g. Quicko) + MOCK GSTN
// Simulates what the real mediator does on our behalf: GSTIN search, taxpayer OTP session,
// GSTR-1 save (async, with reference id + status), summary, filing with EVC, and the resulting
// GSTR-2B on the recipient side. Replace by setting MEDIATOR_BASE_URL to the real provider.
// All taxpayer data here is fictitious.
// ---------------------------------------------------------------------------------------------
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const gstin = require('../src/gstin');

const DEMO_OTP = '575757';
const FILE = path.join(__dirname, '..', 'data', 'mock-gstn.json');

// Fictitious taxpayer registry (what GSTN public search would return).
const SEED = [
  ['37', 'AAECK1234F', 'Krishna Valley Infra Projects Pvt Ltd', 'KV Infra', 'Vijayawada, NTR District, Andhra Pradesh', 'Private Limited Company'],
  ['37', 'AAFFG5678K', 'Godavari Delta Engineering Works', 'GD Engineering', 'Rajahmundry, East Godavari, Andhra Pradesh', 'Partnership'],
  ['37', 'ABCPV4321M', 'Venkata Ramana Contractors', 'VR Contractors', 'Tirupati, Andhra Pradesh', 'Proprietorship'],
  ['37', 'AADCS9087Q', 'Simhachalam Medical Supplies Pvt Ltd', 'SimMed', 'Visakhapatnam, Andhra Pradesh', 'Private Limited Company'],
  ['37', 'AAHFN2468R', 'Nellore Agro Implements', 'NAI', 'Nellore, Andhra Pradesh', 'Partnership'],
  ['37', 'AAICA1357T', 'Amaravati Smart Systems Ltd', 'ASSL', 'Guntur, Andhra Pradesh', 'Public Limited Company'],
  ['36', 'AAJCD8642H', 'Deccan Roadways Infratech Pvt Ltd', 'Deccan Roadways', 'Hyderabad, Telangana', 'Private Limited Company'],
  ['33', 'AAKCT7531L', 'Tamira Water Solutions Pvt Ltd', 'Tamira Water', 'Chennai, Tamil Nadu', 'Private Limited Company'],
  ['29', 'AALCB3698N', 'Bengaluru Digital Tenders Pvt Ltd', 'BDT', 'Bengaluru, Karnataka', 'Private Limited Company'],
  ['27', 'AAMCS1470P', 'Sahyadri Power Equipments Ltd', 'Sahyadri Power', 'Pune, Maharashtra', 'Public Limited Company'],
  ['37', 'AANFR2580S', 'Rayalaseema Civil Works', 'RCW', 'Kurnool, Andhra Pradesh', 'Partnership', 'Cancelled']
];

const registry = new Map(SEED.map(([st, pan, lgnm, trd, addr, ctb, sts]) => {
  const g = gstin.build(st, pan);
  return [g, { gstin: g, lgnm, tradeNam: trd, sts: sts || 'Active', ctb, rgdt: '01-07-2017', dty: 'Regular', stj: `State - ${gstin.STATES[st]}`, pradr: { adr: addr }, cxdt: sts ? '31-03-2025' : '' }];
}));

let store = { returns: {} }; // key "gstin|fp" -> { b2b: {inum: {ctin, inv}}, b2cs, hsn, doc_issue, status, arn, filedAt }
try { if (fs.existsSync(FILE)) store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* fresh */ }
let saveTimer;
const persist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => fs.writeFile(FILE, JSON.stringify(store), () => {}), 300); };

const tokens = new Set();
const sessions = new Map(); // taxpayer token -> { gstin, expires }
const refs = new Map(); // reference id -> { status, readyAt, report }

const id = (p) => `${p}${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function retKey(g, fp) { return `${g}|${fp}`; }
function getReturn(g, fp) {
  const k = retKey(g, fp);
  if (!store.returns[k]) store.returns[k] = { b2b: {}, b2cs: [], hsn: null, doc_issue: null, status: 'NOT_FILED' };
  return store.returns[k];
}

function summarise(ret) {
  const s = { b2b: { count: 0, txval: 0, iamt: 0, camt: 0, samt: 0 }, b2cs: { txval: 0, iamt: 0, camt: 0, samt: 0 } };
  for (const { inv } of Object.values(ret.b2b)) {
    const d = inv.itms[0].itm_det;
    s.b2b.count++; s.b2b.txval += d.txval; s.b2b.iamt += d.iamt; s.b2b.camt += d.camt; s.b2b.samt += d.samt;
  }
  for (const row of ret.b2cs) { s.b2cs.txval += row.txval; s.b2cs.iamt += row.iamt; s.b2cs.camt += row.camt; s.b2cs.samt += row.samt; }
  for (const sec of [s.b2b, s.b2cs]) for (const k of ['txval', 'iamt', 'camt', 'samt']) sec[k] = r2(sec[k]);
  s.total_liability = r2(s.b2b.iamt + s.b2b.camt + s.b2b.samt + s.b2cs.iamt + s.b2cs.camt + s.b2cs.samt);
  return s;
}

function validateInvoice(supplierState, ctin, inv) {
  const errs = [];
  const v = gstin.validate(ctin);
  if (!v.ok) errs.push(`ctin ${ctin}: ${v.reason}`);
  const reg = registry.get(ctin);
  if (reg && reg.sts !== 'Active') errs.push(`ctin ${ctin}: registration ${reg.sts}`);
  if (!inv.inum || inv.inum.length > 16) errs.push(`${inv.inum}: invoice number must be 1-16 chars`);
  if (inv.pos !== ctin.slice(0, 2)) errs.push(`${inv.inum}: POS ${inv.pos} != recipient state ${ctin.slice(0, 2)}`);
  const d = inv.itms[0].itm_det;
  const intra = inv.pos === supplierState;
  if (intra && d.iamt) errs.push(`${inv.inum}: IGST charged on intra-state supply`);
  if (!intra && (d.camt || d.samt)) errs.push(`${inv.inum}: CGST/SGST charged on inter-state supply`);
  if (Math.abs(r2(d.txval * d.rt / 100) - (d.iamt + d.camt + d.samt)) > 1) errs.push(`${inv.inum}: tax amount mismatch`);
  return errs;
}

const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

function requireSession(req, res) {
  const s = sessions.get(req.headers['x-taxpayer-token']);
  if (!s || s.expires < Date.now()) { send(res, 401, { message: 'Taxpayer session expired / invalid. Request OTP again.' }); return null; }
  return s;
}

/** Returns true when the request was handled by the mock. */
function handle(req, res, url, body) {
  if (!url.pathname.startsWith('/mock-quicko/')) return false;
  const p = url.pathname.replace('/mock-quicko', '');
  const m = req.method;

  if (m === 'POST' && p === '/authenticate') {
    if (!req.headers['x-api-key'] || !req.headers['x-api-secret']) return send(res, 401, { message: 'Missing API credentials' }), true;
    const t = id('eyJhbGciOi.');
    tokens.add(t);
    return send(res, 200, { access_token: t, token_type: 'JWT', expires_in: 86400 }), true;
  }
  if (!tokens.has(req.headers.authorization)) return send(res, 401, { message: 'Invalid or missing access token' }), true;

  // ---- Public: GSTIN search ----
  if (m === 'POST' && p === '/gst/compliance/public/gstin/search') {
    const v = gstin.validate(body.gstin);
    if (!v.ok) return send(res, 422, { code: 422, message: v.reason }), true;
    const rec = registry.get(v.gstin) || {
      gstin: v.gstin, lgnm: `Taxpayer ${v.pan} (mock record)`, tradeNam: '', sts: 'Active', ctb: 'Unknown',
      rgdt: '01-04-2020', dty: 'Regular', stj: `State - ${v.stateName}`, pradr: { adr: v.stateName }, mock_generated: true
    };
    return send(res, 200, { code: 200, timestamp: Date.now(), transaction_id: id('TXN'), data: rec }), true;
  }

  // ---- Taxpayer session (OTP) ----
  if (m === 'POST' && p === '/gst/compliance/tax-payer/otp') {
    return send(res, 200, { code: 200, message: `OTP sent to authorised signatory of ${body.gstin} (demo OTP: ${DEMO_OTP})` }), true;
  }
  if (m === 'POST' && p === '/gst/compliance/tax-payer/session') {
    if (body.otp !== DEMO_OTP) return send(res, 400, { message: 'Invalid OTP' }), true;
    const t = id('TP');
    sessions.set(t, { gstin: body.gstin, expires: Date.now() + 6 * 3600 * 1000 });
    return send(res, 200, { code: 200, data: { taxpayer_token: t, expires_in: 21600 } }), true;
  }

  // ---- GSTR-1 ----
  const g1 = p.match(/^\/gst\/compliance\/tax-payer\/gstrs\/gstr-1\/(\d{6})(\/status|\/summary|\/file)?$/);
  if (g1) {
    const s = requireSession(req, res); if (!s) return true;
    const fp = g1[1];
    const ret = getReturn(s.gstin, fp);
    if (m === 'PUT' && !g1[2]) {
      if (ret.status === 'FILED') return send(res, 409, { message: `GSTR-1 for ${fp} already filed` }), true;
      const ref = id('REF');
      const report = [];
      let accepted = 0;
      const supState = s.gstin.slice(0, 2);
      for (const party of body.b2b || []) {
        for (const inv of party.inv) {
          const errs = validateInvoice(supState, party.ctin, inv);
          if (errs.length) report.push(...errs.map((error) => ({ inum: inv.inum, ctin: party.ctin, error })));
          else { ret.b2b[inv.inum] = { ctin: party.ctin, inv }; accepted++; }
        }
      }
      if (body.b2cs) ret.b2cs = body.b2cs;
      if (body.hsn) ret.hsn = body.hsn;
      if (body.doc_issue) ret.doc_issue = body.doc_issue;
      ret.status = 'SAVED';
      persist();
      // GSTN processes saves asynchronously: status is "IP" (in progress) for a short while.
      refs.set(ref, { readyAt: Date.now() + 400, status: report.length ? 'PE' : 'P', accepted, report, errorCount: report.length });
      return send(res, 200, { code: 200, data: { reference_id: ref } }), true;
    }
    if (m === 'GET' && g1[2] === '/status') {
      const r = refs.get(url.searchParams.get('reference_id'));
      if (!r) return send(res, 404, { message: 'Unknown reference id' }), true;
      if (Date.now() < r.readyAt) return send(res, 200, { code: 200, data: { status_cd: 'IP' } }), true;
      return send(res, 200, { code: 200, data: { status_cd: r.status, processed_invoices: r.accepted, error_count: r.errorCount, error_report: r.report } }), true;
    }
    if (m === 'GET' && g1[2] === '/summary') {
      const sum = summarise(ret);
      const hash = crypto.createHash('sha256').update(JSON.stringify(sum)).digest('hex');
      return send(res, 200, { code: 200, data: { gstin: s.gstin, ret_period: fp, summary: sum, summary_hash: hash, status: ret.status } }), true;
    }
    if (m === 'POST' && g1[2] === '/file') {
      if (ret.status === 'FILED') return send(res, 409, { message: 'Already filed', arn: ret.arn }), true;
      if (body.otp !== DEMO_OTP) return send(res, 400, { message: 'Invalid EVC OTP' }), true;
      const hash = crypto.createHash('sha256').update(JSON.stringify(summarise(ret))).digest('hex');
      if (hash !== body.summary_hash) return send(res, 409, { message: 'Summary changed since it was generated. Regenerate summary and retry.' }), true;
      ret.status = 'FILED';
      ret.filedAt = new Date().toISOString();
      ret.arn = `AA${s.gstin.slice(0, 2)}${fp.slice(0, 2)}${fp.slice(4)}${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
      persist();
      return send(res, 200, { code: 200, data: { arn: ret.arn, filed_on: ret.filedAt, status: 'Filed' } }), true;
    }
  }

  // ---- Demo: recipient GSTR-2B (normally visible only in the vendor's own GST login) ----
  const g2b = p.match(/^\/gst\/compliance\/demo\/gstr-2b\/(\d{6})$/);
  if (m === 'GET' && g2b) {
    const ctin = url.searchParams.get('gstin');
    const fp = g2b[1];
    const suppliers = [];
    const itc = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
    for (const [k, ret] of Object.entries(store.returns)) {
      const [supGstin, retFp] = k.split('|');
      if (retFp !== fp || ret.status !== 'FILED') continue;
      const inv = Object.values(ret.b2b).filter((x) => x.ctin === ctin).map(({ inv: i }) => {
        const d = i.itms[0].itm_det;
        itc.igst += d.iamt; itc.cgst += d.camt; itc.sgst += d.samt;
        return { inum: i.inum, dt: i.idt, val: i.val, pos: i.pos, rev: i.rchrg, typ: i.inv_typ, itcavl: 'Y', rsn: '', items: [{ rt: d.rt, txval: d.txval, igst: d.iamt, cgst: d.camt, sgst: d.samt, cess: 0 }] };
      });
      if (inv.length) suppliers.push({ ctin: supGstin, trdnm: 'e-Procurement Platform Operator (DEMO)', supfildt: ret.filedAt.slice(0, 10), supprd: fp, inv });
    }
    for (const k of Object.keys(itc)) itc[k] = r2(itc[k]);
    return send(res, 200, {
      code: 200,
      data: { gstin: ctin, rtnprd: fp, gendt: new Date().toISOString().slice(0, 10), itcsumm: { itcavl: { nonrevsup: { b2b: itc } } }, docdata: { b2b: suppliers } }
    }), true;
  }

  send(res, 404, { message: `Mock mediator: no route ${m} ${p}` });
  return true;
}

function reset() { store = { returns: {} }; refs.clear(); persist(); }

module.exports = { handle, reset, registry, DEMO_OTP };
