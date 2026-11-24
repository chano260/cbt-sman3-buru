const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const ujian = () => read('public/ujian.html');

function functionBody(src, name) {
  const start = src.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
  assert.ok(start >= 0, `fungsi ${name} harus ada`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(open, j + 1);
  }
  throw new Error(`body ${name} tidak lengkap`);
}

// ---------- Penomoran soal ----------
test('Nomor soal yang tampil ke siswa mengikuti urutan tampil (1, 2, 3...), bukan nomor asli di bank soal', () => {
  const html = ujian();
  for (const fn of ['renderDrawerNumbers', 'renderCurrentQuestion']) {
    const body = functionBody(html, fn);
    assert.ok(!/\$\{q\.number\}/.test(body), `${fn}() tidak boleh menampilkan q.number (nomor asli yang ikut teracak)`);
    assert.ok(/displayNumber\(/.test(body), `${fn}() harus memakai displayNumber()`);
  }
  const fin = html.slice(html.indexOf('missingEsai'), html.indexOf('missingEsai') + 1500);
  assert.ok(!/No\. \$\{q\.number\}/.test(fin), 'pesan esai belum difoto harus memakai nomor tampil');
});

// Foto kamera esai sudah dihapus: aplikasi ujian Android baru tidak membuka kamera.
test('Deteksi pelanggaran dari Android benar-benar diteruskan ke halaman ujian', () => {
  const html = ujian();
  assert.match(html, /window\.onExambroViolationDetected\s*=/, 'ujian.html harus mendefinisikan window.onExambroViolationDetected');
});

