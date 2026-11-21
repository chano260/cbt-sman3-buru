const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const ujian = () => read('public/ujian.html');
const SRC = 'android-exambro/app/src/main/java/id/sch/sman3buru/exambro';

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

// ---------- Kamera di Exambro (WebView Android) ----------
test('Exambro menangani <input type=file> lewat onShowFileChooser dan membuka kamera', () => {
  const java = read(`${SRC}/MainActivity.java`);
  assert.match(java, /public boolean onShowFileChooser\(/, 'WebChromeClient harus override onShowFileChooser');
  assert.match(java, /MediaStore\.ACTION_IMAGE_CAPTURE/, 'harus membuka kamera (ACTION_IMAGE_CAPTURE)');
  assert.match(java, /MediaStore\.EXTRA_OUTPUT/, 'foto resolusi penuh disimpan lewat EXTRA_OUTPUT');
  assert.match(java, /onActivityResult\(/, 'hasil kamera harus dikembalikan ke WebView');
  assert.match(java, /onReceiveValue\(/, 'callback file chooser harus selalu dipanggil (juga saat batal)');
  assert.match(java, /FLAG_ACTIVITY_NO_USER_ACTION/, 'membuka kamera tidak boleh dianggap siswa meninggalkan aplikasi');
});

test('Foto kamera disimpan melalui ContentProvider milik aplikasi (tanpa androidx)', () => {
  const provider = read(`${SRC}/PhotoProvider.java`);
  assert.match(provider, /extends ContentProvider/);
  assert.match(provider, /openFile\(/);
  const manifest = read('android-exambro/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /<provider[\s\S]*android:name="\.PhotoProvider"[\s\S]*android:grantUriPermissions="true"/);
  assert.match(manifest, /android:exported="false"/);
});

test('Deteksi pelanggaran dari Android benar-benar diteruskan ke halaman ujian', () => {
  const html = ujian();
  assert.match(html, /window\.onExambroViolationDetected\s*=/, 'ujian.html harus mendefinisikan window.onExambroViolationDetected');
});

