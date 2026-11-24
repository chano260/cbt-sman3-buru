const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('panel guru: pratinjau di samping daftar soal (layar lebar), mengikuti soal yang diklik dan hasil edit', () => {
  const guru = read('public/guru.html');
  assert.match(guru, /<iframe[^>]*id="sidePreviewFrame"/, 'ada kolom pratinjau berisi halaman ujian');
  assert.match(guru, /@media \(min-width: 1200px\)[\s\S]*\.bank-layout/, 'dua kolom hanya di layar lebar');
  assert.match(guru, /matchMedia\('\(min-width: 1200px\)'\)/, 'pratinjau samping tidak dimuat di HP');
  assert.match(guru, /\/ujian\.html\?pratinjau=\$\{currentExamId\}&samping=1/);
  assert.match(guru, /onclick="previewQuestion\(\$\{q\.id\}\)"/, 'klik soal memindah pratinjau');
  assert.match(guru, /function saveEditQuestion[\s\S]*refreshSidePreview\(/, 'setelah edit, pratinjau dimuat ulang');
});

test('ujian.html: mode pratinjau bisa diarahkan ke soal tertentu dan dimuat ulang dari panel guru', () => {
  const ujian = read('public/ujian.html');
  assert.match(ujian, /window\.previewJumpTo = function/);
  assert.match(ujian, /window\.previewReload = function/);
  // Hanya aktif di mode pratinjau
  assert.match(ujian, /if \(!PREVIEW_EXAM_ID\) return;/);
});
