'use strict';
const config = require('./config');
const { STATES } = require('./gstin');

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Financial year label, e.g. 2026-10-16 -> "2627" (FY 2026-27). */
function fyOf(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  const start = d.getMonth() >= 3 ? y : y - 1;
  return `${String(start).slice(2)}${String(start + 1).slice(2)}`;
}

/** Return period in GSTN format MMYYYY. */
function periodOf(date) {
  const d = new Date(date);
  return `${String(d.getMonth() + 1).padStart(2, '0')}${d.getFullYear()}`;
}

/** Rule 46(b): consecutive serial number, unique per FY, max 16 chars. Format EP/2627/0000001 (15 chars). */
function nextInvoiceNumber(db, date) {
  const fy = fyOf(date);
  const c = db.counters.invoiceByFy;
  c[fy] = (c[fy] || 0) + 1;
  return `${config.invoicePrefix}/${fy}/${String(c[fy]).padStart(7, '0')}`;
}

/**
 * Place of supply for B2B services = location of the registered recipient (Sec 12(2)(a) IGST Act),
 * i.e. state code of the recipient GSTIN. For unregistered recipients, address on record.
 * Same state as supplier => CGST + SGST, otherwise IGST.
 */
function computeTax(taxable, posState) {
  const rate = config.gst.rate;
  const intra = posState === config.supplier.stateCode;
  const tax = r2((taxable * rate) / 100);
  const cgst = intra ? r2(tax / 2) : 0;
  const sgst = intra ? r2(tax - cgst) : 0;
  const igst = intra ? 0 : tax;
  return { rate, taxable: r2(taxable), cgst, sgst, igst, cess: 0, totalTax: tax, total: r2(taxable + tax), supplyType: intra ? 'INTRA' : 'INTER' };
}

function createTaxInvoice(db, { vendor, payment }) {
  const isB2B = Boolean(vendor.gstin && vendor.gstinStatus === 'Active');
  const posState = isB2B ? vendor.gstin.slice(0, 2) : (vendor.stateCode || config.supplier.stateCode);
  const tax = computeTax(payment.components.transactionFee, posState);
  const date = payment.paidAt;
  const inv = {
    id: `INV${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase(),
    number: nextInvoiceNumber(db, date),
    date,
    period: periodOf(date),
    type: isB2B ? 'B2B' : 'B2C',
    supplier: { ...config.supplier },
    recipient: {
      vendorId: vendor.id,
      legalName: vendor.legalName,
      tradeName: vendor.tradeName,
      gstin: isB2B ? vendor.gstin : null,
      address: vendor.address,
      email: vendor.email,
      stateCode: posState
    },
    placeOfSupply: { code: posState, name: STATES[posState] },
    reverseCharge: 'N',
    lines: [{
      sno: 1,
      sac: config.gst.sac,
      description: config.gst.description,
      reference: `Tender ${payment.tenderId}`,
      qty: 1,
      unit: 'NA',
      ...tax
    }],
    totals: tax,
    paymentRef: payment.gatewayRef,
    paymentId: payment.id,
    tenderId: payment.tenderId,
    gstr1: { status: 'PENDING', batchId: null, arn: null }
  };
  db.invoices.push(inv);
  return inv;
}

// Indian-system amount in words (lakh / crore) for the invoice footer.
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function twoDigits(n) { return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`; }
function threeDigits(n) {
  const h = Math.floor(n / 100), rest = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', rest ? twoDigits(rest) : ''].filter(Boolean).join(' ');
}
function inWords(amount) {
  let rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);
  if (rupees === 0 && paise === 0) return 'Rupees Zero Only';
  const parts = [];
  const crore = Math.floor(rupees / 1e7); rupees %= 1e7;
  const lakh = Math.floor(rupees / 1e5); rupees %= 1e5;
  const thousand = Math.floor(rupees / 1e3); rupees %= 1e3;
  if (crore) parts.push(`${threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rupees) parts.push(threeDigits(rupees));
  let s = `Rupees ${parts.join(' ') || 'Zero'}`;
  if (paise) s += ` and ${twoDigits(paise)} Paise`;
  return `${s} Only`;
}

module.exports = { createTaxInvoice, computeTax, periodOf, fyOf, inWords, r2 };
