'use strict';
const gstin = require('./gstin');

// Supplier = the e-Procurement platform operator that collects the transaction fee.
// Replace with real values (or load from appsettings / environment) in production.
const SUPPLIER_STATE = '37';
const SUPPLIER_GSTIN = process.env.SUPPLIER_GSTIN || gstin.build(SUPPLIER_STATE, 'AAAGE0001P');

module.exports = {
  port: Number(process.env.PORT || 4000),
  supplier: {
    legalName: process.env.SUPPLIER_NAME || 'e-Procurement Platform Operator (DEMO)',
    tradeName: 'AP e-Procurement Portal (Demo)',
    gstin: SUPPLIER_GSTIN,
    stateCode: SUPPLIER_STATE,
    address: 'Demo Address, Vijayawada, Andhra Pradesh - 520001',
    email: 'gst-helpdesk@example.gov.in',
    gstUsername: process.env.GST_USERNAME || 'eproc_demo_user',
    pan: SUPPLIER_GSTIN.slice(2, 12)
  },
  // Only the transaction fee is a taxable supply. Other components are pass-through / non-taxable.
  feeComponents: {
    transactionFee: { label: 'Transaction Fee', taxable: true },
    corpusFund: { label: 'Corpus Fund', taxable: false },
    documentationFee: { label: 'Documentation Fee', taxable: false },
    processFee: { label: 'Process Fee', taxable: false }
  },
  gst: {
    rate: 18,
    // SAC to be confirmed by the tax advisor. 998319 = Other IT services n.e.c. (placeholder).
    sac: process.env.SAC_CODE || '998319',
    description: 'e-Procurement transaction fee (online tender participation service)'
  },
  invoicePrefix: 'EP',
  // Mediator (GSP / ASP such as Quicko Sandbox). Point to the real base URL + keys to go live.
  mediator: {
    name: process.env.MEDIATOR_NAME || 'Quicko (Mock GSP)',
    baseUrl: process.env.MEDIATOR_BASE_URL || null, // null => use built-in mock on same server
    apiKey: process.env.MEDIATOR_API_KEY || 'demo_key',
    apiSecret: process.env.MEDIATOR_API_SECRET || 'demo_secret'
  },
  // Invoices per save call. GSPs report ~30,000 invoices per GSTN save request as an upper bound;
  // smaller parts give faster retries and clearer error reports.
  gstr1ChunkSize: Number(process.env.GSTR1_CHUNK_SIZE || 5000)
};
