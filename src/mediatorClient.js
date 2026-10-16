'use strict';
// HTTP client for the GST mediator (GSP/ASP — e.g. Quicko Sandbox, ClearTax, Masters India...).
// The portal never talks to GSTN directly; it only calls these endpoints.
// Every call is logged so the demo UI can show the exact request/response exchanged.
const config = require('./config');

const log = [];
const MAX_LOG = 200;
let accessToken = null;

const baseUrl = () => config.mediator.baseUrl || `http://127.0.0.1:${config.port}/mock-quicko`;

const preview = (obj) => {
  if (obj == null) return null;
  const s = JSON.stringify(obj);
  return s.length > 1200 ? `${s.slice(0, 1200)}… (${(s.length / 1024).toFixed(1)} KB total)` : s;
};

async function call(method, path, body, extraHeaders = {}) {
  const started = Date.now();
  const headers = { 'content-type': 'application/json', 'x-api-key': config.mediator.apiKey, ...extraHeaders };
  if (accessToken) headers.authorization = accessToken;
  let status = 0, data = null, error = null;
  try {
    const res = await fetch(baseUrl() + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    status = res.status;
    data = await res.json().catch(() => null);
    if (!res.ok) error = (data && data.message) || `HTTP ${status}`;
  } catch (e) {
    error = e.message;
  }
  log.unshift({ at: new Date().toISOString(), method, path, status, ms: Date.now() - started, request: preview(body), response: preview(data), error });
  if (log.length > MAX_LOG) log.length = MAX_LOG;
  if (error) {
    const err = new Error(error);
    err.status = status; err.data = data;
    throw err;
  }
  return data;
}

async function authenticate() {
  const res = await call('POST', '/authenticate', null, { 'x-api-secret': config.mediator.apiSecret });
  accessToken = res.access_token;
  return res;
}
const ensureAuth = async () => { if (!accessToken) await authenticate(); };

module.exports = {
  log,
  authenticate,
  // Public API — no taxpayer session needed.
  async searchGstin(gstin) { await ensureAuth(); return call('POST', '/gst/compliance/public/gstin/search', { gstin }); },
  // Taxpayer API — requires GST portal "API access" enabled + OTP to the authorised signatory.
  async requestOtp(gstin, username) { await ensureAuth(); return call('POST', '/gst/compliance/tax-payer/otp', { gstin, username }); },
  async verifyOtp(gstin, username, otp) { await ensureAuth(); return call('POST', '/gst/compliance/tax-payer/session', { gstin, username, otp }); },
  async saveGstr1(session, period, part) {
    return call('PUT', `/gst/compliance/tax-payer/gstrs/gstr-1/${period}`, part, { 'x-taxpayer-token': session });
  },
  async gstr1Status(session, period, referenceId) {
    return call('GET', `/gst/compliance/tax-payer/gstrs/gstr-1/${period}/status?reference_id=${encodeURIComponent(referenceId)}`, null, { 'x-taxpayer-token': session });
  },
  async gstr1Summary(session, period) {
    return call('GET', `/gst/compliance/tax-payer/gstrs/gstr-1/${period}/summary`, null, { 'x-taxpayer-token': session });
  },
  async fileGstr1(session, period, evcOtp, summaryHash) {
    return call('POST', `/gst/compliance/tax-payer/gstrs/gstr-1/${period}/file`, { otp: evcOtp, summary_hash: summaryHash }, { 'x-taxpayer-token': session });
  },
  // Demo-only: what the recipient vendor would see in their own GSTR-2B.
  async gstr2b(recipientGstin, period) { await ensureAuth(); return call('GET', `/gst/compliance/demo/gstr-2b/${period}?gstin=${recipientGstin}`); }
};
