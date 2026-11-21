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

// ---------- Halaman diagnosa kamera untuk aplikasi ujian pihak lain (mis. SMANTRI CBT) ----------
test('Halaman /cek-kamera.html tersedia, offline, dan menguji ketiga cara mengambil foto', async (t) => {
  const { initDb } = require('../src/db');
  const { createApp } = require('../src/app');
  const server = createApp(initDb(':memory:')).listen(0);
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${server.address().port}/cek-kamera.html`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Cek Kamera untuk Foto Esai'));
  assert.ok(!/https?:\/\/(cdn|fonts)\./.test(html), 'tidak boleh bergantung CDN');
  assert.match(html, /capture="environment"/, 'tes 1: tombol foto kamera');
  assert.match(html, /id="inpGallery" accept="image\/\*" hidden/, 'tes 2: pilih dari galeri');
  assert.match(html, /getUserMedia/, 'tes 3: kamera langsung di halaman');
});

// ---------- Kamera langsung di halaman (getUserMedia) dengan cadangan tombol foto ----------
test('Tombol foto esai membuka kamera langsung di halaman, dengan cadangan tombol foto biasa', () => {
  const html = ujian();
  assert.match(html, /onclick="openLiveCamera\(\$\{q\.id\}\)"/, 'tombol foto esai harus memanggil openLiveCamera()');
  const open = functionBody(html, 'openLiveCamera');
  assert.match(open, /getUserMedia\(/, 'kamera langsung memakai getUserMedia');
  assert.match(open, /facingMode/, 'memakai kamera belakang (facingMode environment)');
  assert.match(open, /isSecureContext/, 'cek https dulu (kamera langsung hanya jalan di https)');
  assert.match(html, /Pakai Tombol Foto Biasa/, 'harus ada cadangan bila kamera langsung ditolak aplikasi');
  assert.match(html, /startPhotoCapture\(questionId\)/, 'cadangan memakai tombol foto (input file) yang lama');
  assert.match(html, /getTracks\(\)\.forEach\([^)]*\.stop\(\)/, 'kamera harus dimatikan setelah dipakai');
});

test('Foto dari kamera langsung dan dari tombol foto diunggah lewat fungsi yang sama', () => {
  const html = ujian();
  assert.match(html, /async function uploadEssayPhoto\(questionId, file\)/);
  assert.match(functionBody(html, 'handleEssayPhotoChosen'), /uploadEssayPhoto\(questionId, /);
  assert.match(html, /toBlob\(/, 'hasil kamera langsung diubah ke JPEG');
  const uploadCalls = (html.match(/uploadEssayPhoto\(/g) || []).length;
  assert.ok(uploadCalls >= 3, 'definisi + dipanggil dari tombol foto + dari kamera langsung');
});

// ---------- Jeda deteksi keluar-aplikasi saat memotret ----------
test('Membuka kamera untuk foto esai tidak memicu kunci "keluar aplikasi"', () => {
  const html = ujian();
  for (const fn of ['handleVisibilityChange', 'handleWindowBlur']) {
    assert.match(functionBody(html, fn), /isPhotoCaptureActive\(\)/, `${fn}() harus melewati deteksi saat siswa sedang memotret`);
  }
  assert.match(html, /function startPhotoCapture\(/, 'harus ada startPhotoCapture() yang dipanggil saat tombol kamera ditekan');
  assert.match(functionBody(html, 'openLiveCamera'), /photoCaptureUntil|startPhotoCapture/, 'kamera langsung juga menjeda deteksi selama dipakai');
  // Jeda dibatasi waktu, tidak berlaku selamanya
  assert.match(html, /PHOTO_CAPTURE_MAX_MS\s*=\s*\d+/);
});
