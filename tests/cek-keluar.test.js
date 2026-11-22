const test = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');

// Halaman diagnosa: sinyal apa yang dikirim aplikasi ujian (mis. SMANTRI CBT) saat siswa keluar aplikasi.
test('Halaman /cek-keluar.html tersedia, offline, dan mencatat semua sinyal keluar-aplikasi', async (t) => {
  const server = createApp(initDb(':memory:')).listen(0);
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${server.address().port}/cek-keluar.html`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Cek Deteksi Keluar Aplikasi'));
  assert.ok(!/https?:\/\/(cdn|fonts)\./.test(html), 'tidak boleh bergantung CDN');
  for (const ev of ['visibilitychange', "'blur'", "'focus'", "'pagehide'", "'freeze'"]) {
    assert.ok(html.includes(ev), `harus mendengarkan sinyal ${ev}`);
  }
  assert.match(html, /setInterval\(/, 'harus memantau lompatan waktu (halaman dibekukan)');
  assert.match(html, /sessionStorage/, 'catatan bertahan bila halaman dimuat ulang oleh aplikasi');
  // Muat ulang halaman sendiri bukan "keluar aplikasi" (pagehide + hidden saat unload tidak dihitung)
  assert.match(html, /var unloading = false/);
  assert.match(html, /if \(unloading\) return;/);
  // Teks catatan tidak boleh disisipkan sebagai HTML
  assert.ok(!/\.innerHTML\s*=/.test(html.replace(/innerHTML\s*=\s*''/g, '')), 'catatan ditampilkan dengan textContent');
});
