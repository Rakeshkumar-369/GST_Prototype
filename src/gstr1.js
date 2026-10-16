'use strict';
// Builds the GSTR-1 payload in GSTN offline-tool / API JSON shape (b2b, b2cs, hsn, doc_issue)
// and splits it into parts that can be saved one-by-one through the mediator.
const config = require('./config');
const { r2 } = require('./invoice');

const ddmmyyyy = (iso) => {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
};

function toB2bInvoice(inv) {
  const t = inv.totals;
  return {
    inum: inv.number,
    idt: ddmmyyyy(inv.date),
    val: t.total,
    pos: inv.placeOfSupply.code,
    rchrg: inv.reverseCharge,
    inv_typ: 'R',
    itms: [{ num: 1801, itm_det: { txval: t.taxable, rt: t.rate, iamt: t.igst, camt: t.cgst, samt: t.sgst, csamt: 0 } }]
  };
}

function hsnRow(num, rows) {
  const sum = (k) => r2(rows.reduce((a, r) => a + r[k], 0));
  return {
    num,
    hsn_sc: config.gst.sac,
    desc: config.gst.description.slice(0, 30),
    uqc: 'NA',
    qty: 0,
    rt: config.gst.rate,
    txval: sum('taxable'),
    iamt: sum('igst'),
    camt: sum('cgst'),
    samt: sum('sgst'),
    csamt: 0
  };
}

function build(invoices, period) {
  const b2bInv = invoices.filter((i) => i.type === 'B2B');
  const b2cInv = invoices.filter((i) => i.type === 'B2C');

  // B2B grouped by counter-party GSTIN (ctin) — this is what lands in the vendor's GSTR-2B.
  const byCtin = new Map();
  for (const inv of b2bInv) {
    const ctin = inv.recipient.gstin;
    if (!byCtin.has(ctin)) byCtin.set(ctin, []);
    byCtin.get(ctin).push(toB2bInvoice(inv));
  }
  const b2b = [...byCtin.entries()].map(([ctin, inv]) => ({ ctin, inv }));

  // B2C small: consolidated by place of supply + rate (no invoice-level detail).
  const b2csMap = new Map();
  for (const inv of b2cInv) {
    const key = `${inv.placeOfSupply.code}|${inv.totals.rate}`;
    const cur = b2csMap.get(key) || {
      sply_ty: inv.totals.supplyType, pos: inv.placeOfSupply.code, typ: 'OE', rt: inv.totals.rate,
      txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0
    };
    cur.txval = r2(cur.txval + inv.totals.taxable);
    cur.iamt = r2(cur.iamt + inv.totals.igst);
    cur.camt = r2(cur.camt + inv.totals.cgst);
    cur.samt = r2(cur.samt + inv.totals.sgst);
    b2csMap.set(key, cur);
  }
  const b2cs = [...b2csMap.values()];

  // Table 12 HSN summary — reported separately for B2B and B2C.
  const hsn = {
    hsn_b2b: b2bInv.length ? [hsnRow(1, b2bInv.map((i) => i.totals))] : [],
    hsn_b2c: b2cInv.length ? [hsnRow(1, b2cInv.map((i) => i.totals))] : []
  };

  // Table 13 documents issued.
  const nums = invoices.map((i) => i.number).sort();
  const doc_issue = nums.length ? {
    doc_det: [{ doc_num: 1, docs: [{ num: 1, from: nums[0], to: nums[nums.length - 1], totnum: nums.length, cancel: 0, net_issue: nums.length }] }]
  } : undefined;

  const summary = {
    invoiceCount: invoices.length,
    b2bCount: b2bInv.length,
    b2cCount: b2cInv.length,
    recipients: b2b.length,
    taxable: r2(invoices.reduce((a, i) => a + i.totals.taxable, 0)),
    igst: r2(invoices.reduce((a, i) => a + i.totals.igst, 0)),
    cgst: r2(invoices.reduce((a, i) => a + i.totals.cgst, 0)),
    sgst: r2(invoices.reduce((a, i) => a + i.totals.sgst, 0))
  };
  summary.totalTax = r2(summary.igst + summary.cgst + summary.sgst);

  return { payload: { gstin: config.supplier.gstin, fp: period, b2b, b2cs, hsn, doc_issue }, summary };
}

/** Splits the B2B section into parts of ≤ chunkSize invoices; summary tables ride on the last part. */
function chunk(payload, chunkSize = config.gstr1ChunkSize) {
  const parts = [];
  let cur = [], count = 0;
  const flush = () => { if (cur.length) parts.push({ gstin: payload.gstin, fp: payload.fp, b2b: cur }); cur = []; count = 0; };
  for (const party of payload.b2b) {
    let remaining = party.inv;
    while (remaining.length) {
      const room = chunkSize - count;
      const take = remaining.slice(0, room);
      cur.push({ ctin: party.ctin, inv: take });
      count += take.length;
      remaining = remaining.slice(room);
      if (count >= chunkSize) flush();
    }
  }
  flush();
  const tail = { b2cs: payload.b2cs, hsn: payload.hsn, doc_issue: payload.doc_issue };
  if (parts.length) Object.assign(parts[parts.length - 1], tail);
  else parts.push({ gstin: payload.gstin, fp: payload.fp, ...tail });
  return parts;
}

module.exports = { build, chunk };
