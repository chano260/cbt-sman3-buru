const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');

// Akun siswa sudah aktif (kartu peserta berisi nomor peserta & kata sandi),
// jadi fitur "Aktivasi Akun" dihapus; siswa langsung "Masuk Akun".

const ujian = () => fs.readFileSync(path.join(__dirname, '..', 'public', 'ujian.html'), 'utf8');

test('Endpoint aktivasi akun sudah dihapus (tidak lagi bisa mengambil kata sandi dari NISN + tanggal lahir)', async (t) => {
  const db = initDb(':memory:');
  const server = createApp(db).listen(0);
  t.after(() => server.close());
  const st = db.prepare('SELECT * FROM students LIMIT 1').get(); // Namlea, 14 Januari 2008
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/ujian/activate-account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nisn: st.nisn, birth_date: '2008-01-14' })
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.student, undefined, 'tidak boleh mengembalikan data/kata sandi siswa');
});

test('Halaman ujian langsung menampilkan form Masuk Akun, tanpa tab & layar Aktivasi', () => {
  const html = ujian();
  for (const gone of ['viewActivate', 'tabBtnActivate', 'submitActivateAccount', 'screenStudentInfo', 'activate-account', 'switchAuthTab', 'Aktivasi Akun', 'actNisn', 'infoPassword']) {
    assert.ok(!html.includes(gone), `ujian.html tidak boleh lagi memuat "${gone}"`);
  }
  const loginView = html.match(/<div id="viewLogin"([^>]*)>/);
  assert.ok(loginView, 'form Masuk Akun harus ada');
  assert.ok(!/display:\s*none/.test(loginView[1]), 'form Masuk Akun harus langsung tampil');
  assert.match(html, /onclick="submitLoginAccount\(\)"/, 'tombol masuk tetap ada');
});
