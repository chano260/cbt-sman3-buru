// Mengubah persamaan Word (OMML, <m:oMath>) menjadi teks biasa yang terbaca di layar ujian.
// Mammoth membuang elemen persamaan, sehingga soal Matematika yang diketik dengan equation editor
// terbaca kosong. Teks dipilih (bukan gambar/LaTeX) karena tampil di semua HP tanpa pustaka tambahan:
// x² , (2x + 1)/(x − 3), √(x + 1), Uₙ, A = [a, b; c, d].

const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ', x: 'ˣ', y: 'ʸ', a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', k: 'ᵏ', m: 'ᵐ', t: 'ᵗ' };
const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎', n: 'ₙ', i: 'ᵢ', x: 'ₓ', a: 'ₐ', e: 'ₑ', o: 'ₒ', k: 'ₖ', m: 'ₘ', t: 'ₜ', r: 'ᵣ', j: 'ⱼ' };

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENTITIES[e] ?? all;
});

// Pengurai XML kecil: cukup untuk potongan OMML yang selalu well-formed dari Word.
function parseXml(xml) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) { top.children.push({ text: decode(m[5]) }); continue; }
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    const attrs = {};
    m[3].replace(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_, k, a, b) => { attrs[k] = decode(a ?? b); });
    const node = { name: m[2], attrs, children: [] };
    top.children.push(node);
    if (!m[4]) stack.push(node);
  }
  return root;
}

const local = (n) => (n.name || '').replace(/^\w+:/, '');
const child = (n, name) => n.children && n.children.find(c => local(c) === name);
const kids = (n, name) => (n.children || []).filter(c => local(c) === name);
const prop = (n, prName, valName) => {
  const pr = child(n, prName);
  const el = pr && child(pr, valName);
  return el ? (el.attrs['m:val'] ?? el.attrs.val ?? '') : undefined;
};

const isSimple = (s) => /^[\p{L}\p{N}.,]+$/u.test(s) || /^-?\d+([.,]\d+)?$/.test(s);
const wrap = (s) => (isSimple(s) ? s : `(${s})`);

function script(text, map, mark) {
  if (!text) return '';
  const chars = [...text];
  if (chars.every(ch => map[ch])) return chars.map(ch => map[ch]).join('');
  return `${mark}${chars.length === 1 ? text : `(${text})`}`;
}

function render(node) {
  if (node.text !== undefined) return '';
  const name = local(node);
  if (name.endsWith('Pr') || name === 'ctrlPr') return '';
  const part = (n) => (n ? renderChildren(n) : '');
  switch (name) {
    case 'r': return kids(node, 't').map(t => t.children.map(c => c.text || '').join('')).join('');
    case 'sSup': return part(child(node, 'e')) + script(part(child(node, 'sup')), SUP, '^');
    case 'sSub': return part(child(node, 'e')) + script(part(child(node, 'sub')), SUB, '_');
    case 'sSubSup': return part(child(node, 'e')) + script(part(child(node, 'sub')), SUB, '_') + script(part(child(node, 'sup')), SUP, '^');
    case 'sPre': return script(part(child(node, 'sub')), SUB, '_') + script(part(child(node, 'sup')), SUP, '^') + part(child(node, 'e'));
    case 'f': return `${wrap(part(child(node, 'num')))}/${wrap(part(child(node, 'den')))}`;
    case 'd': {
      const beg = prop(node, 'dPr', 'begChr');
      const end = prop(node, 'dPr', 'endChr');
      const sep = prop(node, 'dPr', 'sepChr');
      const inner = kids(node, 'e').map(renderChildren).join(sep ?? '|');
      return `${beg ?? '('}${inner}${end ?? ')'}`;
    }
    case 'm': return kids(node, 'mr').map(row => kids(row, 'e').map(renderChildren).join(', ')).join('; ');
    case 'eqArr': return kids(node, 'e').map(renderChildren).join('; ');
    case 'rad': {
      const inner = wrap(part(child(node, 'e')));
      const deg = part(child(node, 'deg'));
      if (!deg) return `√${inner}`;
      if (deg === '3') return `∛${inner}`;
      if (deg === '4') return `∜${inner}`;
      return `${script(deg, SUP, '^')}√${inner}`;
    }
    case 'nary': {
      const chr = prop(node, 'naryPr', 'chr') || '∫';
      return chr + script(part(child(node, 'sub')), SUB, '_') + script(part(child(node, 'sup')), SUP, '^') + ' ' + part(child(node, 'e'));
    }
    case 'func': return `${part(child(node, 'fName'))} ${part(child(node, 'e'))}`.replace(/\s+$/, '');
    case 'limLow': return `${part(child(node, 'e'))} ${wrap(part(child(node, 'lim')))} `;
    case 'limUpp': return `${part(child(node, 'e'))}^${wrap(part(child(node, 'lim')))}`;
    case 'bar': return `${part(child(node, 'e'))}̅`;
    case 'acc': return part(child(node, 'e')) + (prop(node, 'accPr', 'chr') || '̂');
    default: return renderChildren(node);
  }
}

function renderChildren(node) {
  return (node.children || []).map(render).join('');
}

function ommlToText(xml) {
  return renderChildren(parseXml(String(xml || ''))).replace(/[ \t]+/g, ' ').trim();
}

const escXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Ganti setiap persamaan di document.xml dengan run teks biasa, supaya mammoth membacanya.
function replaceMathInDocumentXml(xml) {
  const toRun = (math) => `<w:r><w:t xml:space="preserve">${escXml(ommlToText(math))}</w:t></w:r>`;
  return String(xml)
    .replace(/<m:oMathPara\b[^>]*>[\s\S]*?<\/m:oMathPara>/g, toRun)
    .replace(/<m:oMath\b[^>]*>[\s\S]*?<\/m:oMath>/g, toRun)
    .replace(/<m:oMath\b[^>]*\/>/g, '');
}

module.exports = { ommlToText, replaceMathInDocumentXml };
