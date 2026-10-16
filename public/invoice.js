'use strict';
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ddmmyyyy = (iso) => new Date(iso).toLocaleDateString('en-GB').replace(/\//g, '-');

(async () => {
  const id = new URLSearchParams(location.search).get('id');
  const res = await fetch(`/api/invoices/${encodeURIComponent(id)}`);
  const sheet = document.getElementById('sheet');
  if (!res.ok) { sheet.innerHTML = '<p>Invoice not found.</p>'; return; }
  const inv = await res.json();
  document.title = `Tax Invoice ${inv.number}`;
  const t = inv.totals, s = inv.supplier, r = inv.recipient, p = inv.payment;
  const intra = t.supplyType === 'INTRA';
  const l = inv.lines[0];
  const g1 = inv.gstr1;
  const periodText = new Date(Number(inv.period.slice(2)), Number(inv.period.slice(0, 2)) - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' });

  sheet.innerHTML = `
  <div class="head">
    <div class="sup">
      <div class="name">${esc(s.legalName)}</div>
      <div class="muted">${esc(s.tradeName)}</div>
      <div>${esc(s.address)}</div>
      <div>GSTIN: <b class="mono">${esc(s.gstin)}</b> · PAN: <span class="mono">${esc(s.pan)}</span></div>
      <div class="muted">${esc(s.email)}</div>
    </div>
    <div style="text-align:right">
      <h1>TAX INVOICE</h1>
      <div class="orig">ORIGINAL FOR RECIPIENT</div>
      <div style="margin-top:6px"><span class="stamp">${inv.type === 'B2B' ? 'B2B · ITC eligible' : 'B2C'}</span></div>
    </div>
  </div>

  <div class="grid">
    <div>
      <div class="lbl">Bill to (Recipient)</div>
      <div style="font-weight:700;font-size:14px">${esc(r.legalName)}</div>
      ${r.tradeName ? `<div class="muted">${esc(r.tradeName)}</div>` : ''}
      <div>${esc(r.address || '')}</div>
      <div>GSTIN: <b class="mono">${r.gstin ? esc(r.gstin) : 'Unregistered'}</b></div>
      <div>State: ${esc(inv.placeOfSupply.name)} (${inv.placeOfSupply.code})</div>
      ${r.email ? `<div class="muted">${esc(r.email)}</div>` : ''}
    </div>
    <div class="kv">
      <span class="lbl">Invoice No.</span><b class="mono">${esc(inv.number)}</b>
      <span class="lbl">Invoice Date</span><span>${ddmmyyyy(inv.date)}</span>
      <span class="lbl">Place of Supply</span><span>${inv.placeOfSupply.code} – ${esc(inv.placeOfSupply.name)}</span>
      <span class="lbl">Reverse Charge</span><span>${inv.reverseCharge === 'Y' ? 'Yes' : 'No'}</span>
      <span class="lbl">Tender Ref.</span><span class="mono">${esc(inv.tenderId)}</span>
      <span class="lbl">Payment Ref.</span><span class="mono">${esc(inv.paymentRef)}</span>
      <span class="lbl">Paid On</span><span>${new Date(inv.date).toLocaleString('en-IN')}</span>
    </div>
  </div>

  <table>
    <thead><tr><th>#</th><th>Description of Service</th><th>SAC</th><th class="num">Qty</th><th class="num">Taxable Value</th>
      ${intra ? '<th class="num">CGST</th><th class="num">SGST</th>' : '<th class="num">IGST</th>'}<th class="num">Total</th></tr></thead>
    <tbody><tr>
      <td>1</td>
      <td>${esc(l.description)}<div class="muted">${esc(l.reference)}${p ? ' – ' + esc(p.tenderTitle) : ''}</div></td>
      <td class="mono">${esc(l.sac)}</td><td class="num">1</td><td class="num">${inr(l.taxable)}</td>
      ${intra ? `<td class="num">${inr(l.cgst)}<div class="muted">@9%</div></td><td class="num">${inr(l.sgst)}<div class="muted">@9%</div></td>` : `<td class="num">${inr(l.igst)}<div class="muted">@18%</div></td>`}
      <td class="num"><b>${inr(l.total)}</b></td>
    </tr></tbody>
  </table>

  <div class="totals">
    <div>
      <div class="qrbox">
        <div id="qr">QR code</div>
        <div class="muted" style="font-size:11px;max-width:260px">Scan to verify supplier GSTIN, invoice number, date and value.
        ${inv.type === 'B2B' ? 'If the supplier is notified for e-invoicing, the IRN and IRP-signed QR replace this QR.' : ''}</div>
      </div>
      <div class="words">${esc(inv.amountInWords)}</div>
    </div>
    <table>
      <tr><td>Taxable value</td><td class="num">${inr(t.taxable)}</td></tr>
      ${intra ? `<tr><td>CGST @ 9%</td><td class="num">${inr(t.cgst)}</td></tr><tr><td>SGST @ 9%</td><td class="num">${inr(t.sgst)}</td></tr>` : `<tr><td>IGST @ 18%</td><td class="num">${inr(t.igst)}</td></tr>`}
      <tr><td>Total tax</td><td class="num">${inr(t.totalTax)}</td></tr>
      <tr class="grand"><td>Invoice total</td><td class="num">${inr(t.total)}</td></tr>
    </table>
  </div>

  <div class="itc ${inv.type === 'B2B' ? '' : 'b2c'}">
    ${inv.type === 'B2B'
      ? `<b>Input Tax Credit:</b> This invoice is reported in the supplier's GSTR-1 for <b>${periodText}</b> under B2B against GSTIN ${esc(r.gstin)} and will reflect in your GSTR-2B.
         GSTR-1 status: <b>${g1.status}</b>${g1.arn ? ` · ARN <span class="mono">${esc(g1.arn)}</span>` : ''}.`
      : '<b>No ITC:</b> Recipient GSTIN not provided at the time of payment. Update your GSTIN in your vendor profile to receive B2B invoices for future payments.'}
  </div>

  ${p ? `<div class="fees"><b>Payment breakup (for reference)</b>
    <table>
      <tr><th>Component</th><th>GST treatment</th><th class="num">Amount</th></tr>
      <tr><td>Transaction fee (this invoice, incl. GST)</td><td>Taxable @18%</td><td class="num">${inr(t.total)}</td></tr>
      ${p.components.corpusFund ? `<tr><td>Corpus fund</td><td>Not a supply – receipt only</td><td class="num">${inr(p.components.corpusFund)}</td></tr>` : ''}
      ${p.components.documentationFee ? `<tr><td>Documentation fee</td><td>Not taxed (per current treatment)</td><td class="num">${inr(p.components.documentationFee)}</td></tr>` : ''}
      ${p.components.processFee ? `<tr><td>Process fee</td><td>Not taxed (per current treatment)</td><td class="num">${inr(p.components.processFee)}</td></tr>` : ''}
      <tr><td colspan="2"><b>Total paid</b></td><td class="num"><b>${inr(p.grandTotal)}</b></td></tr>
    </table></div>` : ''}

  <div class="foot">
    <div>This is a computer-generated invoice issued under Section 31 of the CGST Act, 2017 read with Rule 46 of the CGST Rules, 2017.<br>
    Whether tax is payable on reverse charge: No · Subject to Vijayawada jurisdiction · E. &amp; O.E.</div>
    <div class="sign"><div class="box">Digitally signed<br>${esc(s.legalName)}<br>${new Date(inv.date).toLocaleString('en-IN')}</div><div>Authorised Signatory</div></div>
  </div>`;

  const qrText = [`SellerGstin:${s.gstin}`, `BuyerGstin:${r.gstin || 'URP'}`, `DocNo:${inv.number}`, 'DocTyp:INV', `DocDt:${ddmmyyyy(inv.date)}`,
    `TotInvVal:${t.total}`, 'ItemCnt:1', `MainHsnCode:${l.sac}`, `TaxAmt:${t.totalTax}`].join('|');
  const qrEl = document.getElementById('qr');
  if (window.qrcode) {
    const qr = qrcode(0, 'M');
    qr.addData(qrText);
    qr.make();
    qrEl.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
  }
})();
