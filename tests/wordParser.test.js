const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQuestionsFromText, parseDocxBuffer, generateWordTemplateBuffer } = require('../src/wordParser');

test('parseQuestionsFromText parses PG with key and ESAI blocks tolerantly', () => {
  const sample = `
  [PG]
  1. Ibu kota Provinsi Maluku adalah...
  A. Tual
  B. Ambon
  C. Namlea
  D. Masohi
  E. Dobo
  kunci : b

  2) Hasil dari 5 + 5 adalah...
  a. 8
  b. 9
  c. 10
  d. 11
  e. 12
  KUNCI: C

  [ESAI]
  31. Jelaskan 3 faktor utama kesetimbangan kimia!
  `;
  const result = parseQuestionsFromText(sample);
  assert.equal(result.length, 3);
  assert.equal(result[0].type, 'PG');
  assert.equal(result[0].answer_key, 'B');
  assert.equal(result[1].answer_key, 'C');
  assert.equal(result[2].type, 'ESAI');
  assert.equal(result[2].answer_key, null);
});

test('generateWordTemplateBuffer produces a valid .docx buffer that parseDocxBuffer can parse back', async () => {
  const buf = await generateWordTemplateBuffer();
  const parsed = await parseDocxBuffer(buf);
  assert.ok(parsed.some(q => q.type === 'PG'));
  assert.ok(parsed.some(q => q.type === 'ESAI'));
});
