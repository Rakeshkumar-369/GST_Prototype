'use strict';

// GSTIN structure: 2-digit state code + 10-char PAN + entity number + 'Z' + check character
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const STATES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
  '97': 'Other Territory', '99': 'Centre Jurisdiction'
};

/** Computes the GSTIN check character for the first 14 characters (mod-36 algorithm). */
function checkChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const val = CHARSET.indexOf(first14[i]);
    const prod = val * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(prod / 36) + (prod % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36];
}

/** Offline structural validation done before calling the mediator (saves API calls / cost). */
function validate(gstin) {
  const g = String(gstin || '').trim().toUpperCase();
  if (!GSTIN_REGEX.test(g)) return { ok: false, reason: 'Format invalid (expected 15 chars: SS + PAN + N + Z + C)' };
  if (!STATES[g.slice(0, 2)]) return { ok: false, reason: `Unknown state code ${g.slice(0, 2)}` };
  if (checkChar(g.slice(0, 14)) !== g[14]) return { ok: false, reason: 'Check digit mismatch (typo in GSTIN)' };
  return { ok: true, gstin: g, stateCode: g.slice(0, 2), stateName: STATES[g.slice(0, 2)], pan: g.slice(2, 12) };
}

function build(stateCode, pan, entity = '1') {
  const first14 = `${stateCode}${pan}${entity}Z`;
  return first14 + checkChar(first14);
}

module.exports = { validate, build, checkChar, STATES };
