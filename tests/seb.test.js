const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');

function setup(t) {
  const db = initDb(':memory:');
  const server = createApp(db, { enforceDefaultPasswordChange: false }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username, password) => {
    const r = await fetch(`${base}/api/staff/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password })
    }).then(r => r.json());
    return { Authorization: `Bearer ${r.staffToken}`, 'Content-Type': 'application/json' };
  };
  return { db, base, login };
}

// Format .seb resmi: gzip( "plnd" + gzip(plist XML) )
function readSeb(buf) {
  const outer = zlib.gunzipSync(buf);
  assert.equal(outer.subarray(0, 4).toString('latin1'), 'plnd');
  return zlib.gunzipSync(outer.subarray(4)).toString('utf8');
}

test('SEB: password keluar hanya bisa diatur operator, minimal 6 karakter', async (t) => {
  const { base, login } = setup(t);
  const set = (auth, quitPassword) => fetch(`${base}/api/operator/seb-settings`, { method: 'POST', headers: auth, body: JSON.stringify({ quitPassword }) });
  assert.equal((await set(await login('guru', 'guru123'), 'Rahasia#1')).status, 403);
  const op = await login('operator', 'admin123');
  assert.equal((await set(op, '123')).status, 400);
  assert.equal((await set(op, 'Keluar#2026')).status, 200);
});

test('SEB: file .seb belum tersedia sebelum password keluar diatur', async (t) => {
  const { base } = setup(t);
  const res = await fetch(`${base}/seb/ujian.seb`);
  assert.equal(res.status, 404);
});

test('SEB: file .seb berformat resmi, berisi alamat ujian & hash SHA-256 password keluar', async (t) => {
  const { base, login } = setup(t);
  const op = await login('operator', 'admin123');
  await fetch(`${base}/api/operator/public-url`, { method: 'POST', headers: op, body: JSON.stringify({ publicUrl: 'https://cbt.contoh.sch.id' }) });
  await fetch(`${base}/api/operator/seb-settings`, { method: 'POST', headers: op, body: JSON.stringify({ quitPassword: 'Keluar#2026' }) });

  const res = await fetch(`${base}/seb/ujian.seb`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /ujian\.seb/);
  const xml = readSeb(Buffer.from(await res.arrayBuffer()));
  assert.match(xml, /<key>startURL<\/key>\s*<string>https:\/\/cbt\.contoh\.sch\.id\/ujian\.html<\/string>/);
  const hash = crypto.createHash('sha256').update('Keluar#2026', 'utf8').digest('hex');
  assert.match(xml, new RegExp(`<key>hashedQuitPassword</key>\\s*<string>${hash}</string>`));
  assert.match(xml, /<key>sebConfigPurpose<\/key>\s*<integer>0<\/integer>/);
  assert.equal(xml.includes('Keluar#2026'), false, 'password asli tidak boleh ada di file');
});

test('SEB: QR SEB memakai tautan sebs:// untuk server https', async (t) => {
  const { base, login } = setup(t);
  const op = await login('operator', 'admin123');
  await fetch(`${base}/api/operator/public-url`, { method: 'POST', headers: op, body: JSON.stringify({ publicUrl: 'https://cbt.contoh.sch.id' }) });
  let ov = await fetch(`${base}/api/operator/overview`, { headers: op }).then(r => r.json());
  assert.equal(ov.sebReady, false);
  assert.equal(ov.sebQrDataUrl, null);

  await fetch(`${base}/api/operator/seb-settings`, { method: 'POST', headers: op, body: JSON.stringify({ quitPassword: 'Keluar#2026' }) });
  ov = await fetch(`${base}/api/operator/overview`, { headers: op }).then(r => r.json());
  assert.equal(ov.sebReady, true);
  assert.equal(ov.sebUrl, 'sebs://cbt.contoh.sch.id/seb/ujian.seb');
  assert.match(ov.sebQrDataUrl, /^data:image\/png;base64,/);
});

test('SEB: data kartu cetak ikut memuat QR SEB setelah diatur', async (t) => {
  const { base, login } = setup(t);
  const op = await login('operator', 'admin123');
  let pd = await fetch(`${base}/api/operator/print-data`, { headers: op }).then(r => r.json());
  assert.equal(pd.sebReady, false);
  await fetch(`${base}/api/operator/seb-settings`, { method: 'POST', headers: op, body: JSON.stringify({ quitPassword: 'Keluar#2026' }) });
  pd = await fetch(`${base}/api/operator/print-data`, { headers: op }).then(r => r.json());
  assert.equal(pd.sebReady, true);
  assert.match(pd.sebQrDataUrl, /^data:image\/png;base64,/);
  assert.match(pd.sebUrl, /\/seb\/ujian\.seb$/);
});
