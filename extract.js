// Pulls name, phone and business out of a customer's message.
// Rule-based (no AI key needed). Handles English + Roman Urdu phrasing.

const STOP = new Set(`a an the and or but from at with for to of in on is am are was here there interested looking
fine good ok okay not just also very really sure glad happy thanks thank hi hello salam aoa assalam need want
available waiting new sorry ready doing trying planning going asking writing calling messaging contacting
student owner manager ceo founder developer customer client your you we our my me ji jee sir madam bhai
hun hoon hu hai tha aap ap main mein ka ki ke`.split(/\s+/));

const BIZ_KINDS = 'business|company|shop|store|brand|firm|agency|clinic|restaurant|school|academy|factory|mill|startup|organi[sz]ation|dukan|karobar|showroom|pharmacy|hospital|salon|boutique';

const clean = (s) => s.replace(/\s+/g, ' ').replace(/^[\s:,'"-]+|[\s:,.'"!?-]+$/g, '').trim();
const titleCase = (s) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());

export function extractPhone(text) {
  const t = text.replace(/[()]/g, ' ');
  // Pakistani mobile: 03xx-xxxxxxx / +92 3xx xxxxxxx / 923xxxxxxxxx
  const pk = t.match(/(?:\+?92[\s-]?|0)3\d{2}[\s-]?\d{3}[\s-]?\d{4}/);
  if (pk) {
    let d = pk[0].replace(/\D/g, '');
    if (d.startsWith('92')) d = '0' + d.slice(2);
    return `${d.slice(0, 4)}-${d.slice(4)}`;
  }
  // Pakistani landline e.g. 041-1234567
  const land = t.match(/\b0[1-9]\d{1,3}[\s-]\d{6,8}\b/);
  if (land) return land[0].replace(/\s/g, '-');
  // International with +
  const intl = t.match(/\+\d[\d\s-]{8,16}\d/);
  if (intl) {
    const d = intl[0].replace(/[^\d+]/g, '');
    if (d.length >= 10 && d.length <= 16) return d;
  }
  return null;
}

function nameFromWords(raw, { requireCaps }) {
  const words = [];
  for (const w of raw.split(/\s+/)) {
    const bare = w.replace(/[^A-Za-z.'-]/g, '');
    if (!bare || STOP.has(bare.toLowerCase())) break;
    if (requireCaps && !/^[A-Z]/.test(bare)) break;
    const word = bare.replace(/[.]+$/, '');
    if (!word) break;
    words.push(word);
    if (/\.$/.test(w)) { if (words.length) break; }
    if (words.length === 3) break;
  }
  if (!words.length || words.join('').length < 2) return null;
  return titleCase(words.join(' ').toLowerCase());
}

export function extractName(text) {
  const t = ' ' + text.replace(/\n/g, ' . ') + ' ';
  // strong cues: any case
  let m = t.match(new RegExp(`\\b(?:my name is|my name's|(?<!(?:${BIZ_KINDS})(?:'s)?\\s*)name\\s*[:\\-]|naam\\s*[:\\-]|mera naam|mera nam|i am called)\\s+([A-Za-z][A-Za-z .'-]{1,40})`, 'i'));
  if (m) { const n = nameFromWords(clean(m[1]), { requireCaps: false }); if (n) return n; }
  // weaker cues: must look like a proper name (Capitalised)
  m = t.match(/\b(?:[Ii] am|[Ii]'m|[Ii]’m|[Ii]m|[Tt]his is|[Ii]t's|[Hh]ere is)\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})/);
  if (m) { const n = nameFromWords(clean(m[1]), { requireCaps: true }); if (n) return n; }
  return null;
}

export function extractBusiness(text) {
  const t = text.replace(/\n/g, ' . ');
  const cut = (s) => {
    let v = clean(s.split(/\b(?:and|but|i want|i need|we need|we want|looking|my number|number|contact|phone|whatsapp|hai|he|h|ka|ki)\b/i)[0]);
    v = v.replace(/^(?:a|an|the|my|our)\s+/i, '');
    if (v.length < 2 || v.length > 60 || STOP.has(v.toLowerCase())) return null;
    return v;
  };
  const patterns = [
    // "business name is X", "company: X", "shop name - X"
    new RegExp(`\\b(?:${BIZ_KINDS})(?:'s)?\\s*(?:name)?\\s*(?:is|:|-|=)\\s*([^.,!?\\n]{2,60})`, 'i'),
    // Roman Urdu: "meri company ka naam X hai", "dukan ka naam X"
    new RegExp(`\\b(?:${BIZ_KINDS})\\s+ka\\s+(?:naam|nam)\\s+([^.,!?\\n]{2,60}?)(?:\\s+(?:hai|he|h)\\b|[.,!?]|$)`, 'i'),
    // "company Desert Ventures" (capitalised name right after the word)
    new RegExp(`\\b(?:${BIZ_KINDS})\\s+([A-Z][\\w&'.-]*(?:\\s+[A-Z][\\w&'.-]*){0,4})`),
    // "I run / own / have a X"
    /\b(?:i|we)\s+(?:run|own|have|manage|operate)\s+(?:a|an|the|my|our)?\s*([^.,!?\n]{3,60})/i,
    // "from Ali Textiles", "at Gul Ahmed" (capitalised names only)
    /\b(?:from|at|with|representing)\s+([A-Z][\w&'.-]*(?:\s+(?:[A-Z][\w&'.-]*|&|and|of)){0,5})/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const v = cut(m[1]);
      // skip "from Faisalabad"-style places and "from Facebook/Instagram"
      if (v && !/^(?:facebook|instagram|insta|fb|google|pakistan|lahore|karachi|islamabad|faisalabad|rawalpindi|multan|home|here|there)$/i.test(v)) return v;
    }
  }
  return null;
}

export function extractAll(text) {
  if (!text || text.startsWith('[')) return {};
  return { name: extractName(text), phone: extractPhone(text), business: extractBusiness(text) };
}
