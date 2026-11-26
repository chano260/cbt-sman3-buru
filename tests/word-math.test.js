const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');
const { ommlToText } = require('../src/ommlText');
const { parseDocxBuffer, generateWordTemplateBuffer } = require('../src/wordParser');

// Persamaan Word (equation editor) disimpan sebagai OMML <m:oMath>. Mammoth membuangnya, sehingga soal
// Matematika terbaca kosong. Contoh di bawah diambil dari bentuk asli bank soal Matematika guru.
const R = (t) => `<m:r><w:rPr><w:rFonts w:ascii="Cambria Math"/></w:rPr><m:t xml:space="preserve">${t}</m:t></m:r>`;
const SUP = (base, sup) => `<m:sSup><m:e>${R(base)}</m:e><m:sup>${R(sup)}</m:sup></m:sSup>`;

const POLY = `<m:oMath>${R('(2')}${SUP('x', '2')}${R(' + 4x - 3) + (')}${SUP('x', '3')}${R(' + 3')}${SUP('x', '2')}${R(' + 2)')}</m:oMath>`;
const FRACTION = `<m:oMath><m:f><m:num>${R('2')}${SUP('x', '3')}${R(' + 5x + 6')}</m:num><m:den>${R('x + 3')}</m:den></m:f></m:oMath>`;
const MATRIX = `<m:oMath>${R('A = ')}<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr><m:e><m:m>` +
  `<m:mr><m:e>${R('-x')}</m:e><m:e>${R('2')}</m:e></m:mr>` +
  `<m:mr><m:e>${R('-3y')}</m:e><m:e>${SUP('z', '2')}</m:e></m:mr>` +
  `</m:m></m:e></m:d></m:oMath>`;

test('ommlToText: pangkat jadi angka pangkat', () => {
  assert.strictEqual(ommlToText(POLY), '(2x² + 4x - 3) + (x³ + 3x² + 2)');
});

test('ommlToText: pecahan jadi (pembilang)/(penyebut)', () => {
  assert.strictEqual(ommlToText(FRACTION), '(2x³ + 5x + 6)/(x + 3)');
  assert.strictEqual(ommlToText(`<m:oMath><m:f><m:num>${R('1')}</m:num><m:den>${R('2')}</m:den></m:f></m:oMath>`), '1/2');
});

test('ommlToText: matriks dalam kurung siku, elemen dipisah koma, baris dipisah titik koma', () => {
  assert.strictEqual(ommlToText(MATRIX), 'A = [-x, 2; -3y, z²]');
});

test('ommlToText: akar, indeks bawah, pangkat yang tidak punya huruf pangkat', () => {
  assert.strictEqual(ommlToText(`<m:oMath><m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${R('x + 1')}</m:e></m:rad></m:oMath>`), '√(x + 1)');
  assert.strictEqual(ommlToText(`<m:oMath><m:sSub><m:e>${R('U')}</m:e><m:sub>${R('n')}</m:sub></m:sSub></m:oMath>`), 'Uₙ');
  assert.strictEqual(ommlToText(`<m:oMath>${SUP('2', 'x+q')}</m:oMath>`), '2^(x+q)');
  assert.strictEqual(ommlToText(`<m:oMath>${R('a &lt; b')}</m:oMath>`), 'a < b');
});

async function docxWithBody(paragraphsXml) {
  const zip = await JSZip.loadAsync(await generateWordTemplateBuffer());
  const xml = await zip.file('word/document.xml').async('string');
  const nsM = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
  const withNs = xml.includes('xmlns:m=') ? xml : xml.replace('<w:document ', `<w:document ${nsM} `);
  const body = withNs.replace(/(<w:body>)[\s\S]*?(<w:sectPr)/, `$1${paragraphsXml}$2`);
  zip.file('word/document.xml', body);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const P = (inner) => `<w:p><w:r><w:t xml:space="preserve">${inner}</w:t></w:r></w:p>`;
const PM = (lead, math) => `<w:p><w:r><w:t xml:space="preserve">${lead}</w:t></w:r>${math}</w:p>`;

test('parseDocxBuffer: soal & opsi berisi persamaan Word tidak lagi kosong', async () => {
  const buf = await docxWithBody([
    P('[PG]'),
    PM('1. Selesaikanlah bentuk operasi polinomial dari ', POLY),
    PM('A. ', FRACTION),
    PM('B. ', MATRIX),
    PM('C. ', `<m:oMath>${R('x + 1')}</m:oMath>`),
    PM('D. ', `<m:oMath>${R('x - 1')}</m:oMath>`),
    PM('E. ', `<m:oMath>${R('2x')}</m:oMath>`),
    P('KUNCI: B')
  ].join(''));
  const qs = await parseDocxBuffer(buf);
  assert.strictEqual(qs.length, 1);
  assert.strictEqual(qs[0].question_text, 'Selesaikanlah bentuk operasi polinomial dari (2x² + 4x - 3) + (x³ + 3x² + 2)');
  assert.strictEqual(qs[0].option_a, '(2x³ + 5x + 6)/(x + 3)');
  assert.strictEqual(qs[0].option_b, 'A = [-x, 2; -3y, z²]');
  assert.strictEqual(qs[0].option_e, '2x');
  assert.strictEqual(qs[0].answer_key, 'B');
});
