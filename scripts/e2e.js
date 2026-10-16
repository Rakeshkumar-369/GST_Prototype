'use strict';
// End-to-end check of the full flow against a running server (npm start, then npm test).
const BASE = process.env.BASE || 'http://localhost:4000';
const OTP = '575757';
const call = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${d.message}`);
  return d;
};
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); console.log('  ok -', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const count = Number(process.argv[2] || 3000);
  await call('POST', '/api/reset');
  const d = new Date(); const period = String(d.getMonth() + 1).padStart(2, '0') + d.getFullYear();

  console.log('1. Vendors');
  const bad = await fetch(BASE + '/api/vendors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ legalName: 'X', gstin: '37AAECK1234F1Z0' }) });
  assert(bad.status === 422, 'GSTIN with wrong check digit is rejected offline');
  const samples = await call('GET', '/api/sample-gstins');
  const cancelled = samples.find((s) => s.status !== 'Active');
  const c = await fetch(BASE + '/api/vendors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ legalName: 'X', gstin: cancelled.gstin }) });
  assert(c.status === 422, 'Cancelled GSTIN is rejected after GSTN search');
  await call('POST', '/api/vendors/load-samples');
  const vendors = await call('GET', '/api/vendors');
  assert(vendors.length >= 10, `${vendors.length} vendors registered`);

  console.log('2. Payment + instant invoice');
  const ap = vendors.find((v) => v.gstin && v.gstin.startsWith('37'));
  const ts = vendors.find((v) => v.gstin && v.gstin.startsWith('36'));
  const r1 = await call('POST', '/api/payments', { vendorId: ap.id, transactionFee: 5000, documentationFee: 1000, processFee: 500 });
  assert(r1.invoice.type === 'B2B' && r1.invoice.totals.cgst === 450 && r1.invoice.totals.sgst === 450, 'AP vendor: CGST 450 + SGST 450');
  assert(r1.payment.grandTotal === 7400, 'Grand total 5000 + 900 + 1000 + 500 = 7400');
  const r2 = await call('POST', '/api/payments', { vendorId: ts.id, transactionFee: 10000 });
  assert(r2.invoice.totals.igst === 1800 && r2.invoice.totals.cgst === 0, 'Telangana vendor: IGST 1800');
  assert(r2.invoice.number.length <= 16, `Invoice number ${r2.invoice.number} <= 16 chars`);

  console.log(`3. Simulate ${count} payments`);
  const sim = await call('POST', '/api/simulate', { period, count });
  assert(sim.created === count, `created ${count} in ${sim.ms} ms`);

  console.log('4. Batch + filing');
  const b = await call('POST', '/api/batches', { period });
  assert(b.summary.invoiceCount === count + 2, `batch has ${b.summary.invoiceCount} invoices in ${b.partCount} part(s)`);
  await call('POST', `/api/batches/${b.id}/request-otp`);
  await call('POST', `/api/batches/${b.id}/connect`, { otp: OTP });
  await call('POST', `/api/batches/${b.id}/upload`);
  let st;
  do { await sleep(500); st = await call('GET', `/api/batches/${b.id}`); } while (st.status === 'UPLOADING');
  assert(st.status === 'READY_TO_FILE', `upload finished: ${st.status}`);
  assert(Math.abs(st.gstnSummary.summary.total_liability - st.summary.totalTax) < 1, 'GSTN summary reconciles with portal');
  const f = await call('POST', `/api/batches/${b.id}/file`, { otp: OTP });
  assert(/^AA37/.test(f.arn), `filed, ARN ${f.arn}`);

  console.log('5. Vendor GSTR-2B');
  const g2b = (await call('GET', `/api/gstr2b/${ap.gstin}/${period}`)).data;
  const itc = g2b.itcsumm.itcavl.nonrevsup.b2b;
  assert(itc.cgst > 0 && g2b.docdata.b2b[0].inv.some((i) => i.inum === r1.invoice.number), `vendor sees invoice ${r1.invoice.number}; ITC CGST ${itc.cgst}`);
  const stats = await call('GET', '/api/stats');
  assert(stats.pendingFiling === 0, 'no invoices pending after filing');
  console.log('\nALL CHECKS PASSED');
})().catch((e) => { console.error(e.message); process.exit(1); });
