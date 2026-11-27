// Rekap nilai di portal guru bisa langsung dicetak (A4 / simpan PDF) dengan kop sekolah.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'guru.html'), 'utf8');

test('rekap nilai punya tombol cetak dan pilihan kelas', () => {
  const tab = html.slice(html.indexOf('id="tab-scores"'), html.indexOf('</section>', html.indexOf('id="tab-scores"')));
  assert.match(tab, /onclick="printScores\(\)"/);
  assert.match(tab, /Cetak rekap/);
  assert.match(tab, /id="scoreClassFilter"/);
});

test('lembar cetak: kop sekolah, keterangan ujian, ringkasan nilai, tanda tangan guru', () => {
  assert.match(html, /id="scorePrintSheet"/);
  const fn = html.slice(html.indexOf('function renderScorePrint('), html.indexOf('function printScores('));
  assert.ok(fn.length > 0, 'renderScorePrint ada sebelum printScores');
  assert.match(fn, /SMA NEGERI 3 BURU/);
  assert.match(fn, /REKAP NILAI/);
  for (const label of ['Mata pelajaran', 'Kelas', 'Tanggal', 'Sesi']) assert.match(fn, new RegExp(label));
  assert.match(fn, /Rata-rata/);
  assert.match(fn, /Tertinggi/);
  assert.match(fn, /Terendah/);
  assert.match(fn, /Guru Mata Pelajaran/);
  assert.match(fn, /Nilai esai/, 'kolom nilai esai kosong untuk diisi tangan');
});

test('cetak hanya menampilkan lembar rekap, bukan seluruh halaman', () => {
  assert.match(html, /@media print\s*\{[^]*?body\.print-scores > \*:not\(#scorePrintSheet\)\s*\{\s*display:\s*none/);
  assert.match(html, /@page\s*\{\s*size:\s*A4/);
  const fn = html.slice(html.indexOf('function printScores('), html.indexOf('function printScores(') + 600);
  assert.match(fn, /classList\.add\('print-scores'\)/);
  assert.match(fn, /window\.print\(\)/);
  assert.match(html, /afterprint/);
});

test('ringkasan nilai: rata-rata dibulatkan, tertinggi, terendah', () => {
  const src = html.slice(html.indexOf('function scoreSummary('), html.indexOf('function renderScorePrint('));
  const scoreSummary = new Function(`${src}; return scoreSummary;`)();
  assert.deepEqual(scoreSummary([{ score: 80 }, { score: 65 }, { score: 90 }]), { count: 3, avg: 78.3, max: 90, min: 65 });
  assert.deepEqual(scoreSummary([]), { count: 0, avg: 0, max: 0, min: 0 });
});
