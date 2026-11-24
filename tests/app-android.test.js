const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');

function setup(t) {
  const db = initDb(':memory:');
  const server = createApp(db, { enforceDefaultPasswordChange: false }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, body: json, headers: res.headers };
  };
  const staff = async (username, password) => {
    const r = await call('POST', '/api/staff/login', { username, password });
    return { Authorization: `Bearer ${r.body.staffToken}` };
  };
  const student = db.prepare('SELECT * FROM students LIMIT 1').get();
  const loginStudent = (headers) => call('POST', '/api/ujian/login', { exam_number: student.exam_number, password: student.password }, headers);
  return { db, call, staff, student, loginStudent };
}

test('app-settings: hanya operator, kode harus 4–8 digit angka', async (t) => {
  const { call, staff } = setup(t);
  assert.equal((await call('POST', '/api/operator/app-settings', { code: '123456' }, await staff('guru', 'guru123'))).status, 403);
  const op = await staff('operator', 'admin123');
  for (const bad of ['123', '123456789', '12ab56', '']) {
    assert.equal((await call('POST', '/api/operator/app-settings', { code: bad }, op)).status, 400, `kode "${bad}" harus ditolak`);
  }
  let r = await call('GET', '/api/operator/app-settings', null, op);
  assert.deepEqual(r.body, { codeSet: false, requireApp: false });
  r = await call('POST', '/api/operator/app-settings', { code: '246810' }, op);
  assert.equal(r.status, 200);
  assert.deepEqual({ codeSet: r.body.codeSet, requireApp: r.body.requireApp }, { codeSet: true, requireApp: false });
  r = await call('POST', '/api/operator/app-settings', { requireApp: true }, op);
  assert.equal(r.body.requireApp, true);
  assert.equal(r.body.codeSet, true, 'mengubah sakelar tidak menghapus kode');
});

test('verify-code: 404 sebelum diatur, 401 salah, 200 + tiket & cookie bila benar', async (t) => {
  const { call, staff } = setup(t);
  assert.equal((await call('POST', '/api/app/verify-code', { code: '246810' })).status, 404);
  await call('POST', '/api/operator/app-settings', { code: '246810' }, await staff('operator', 'admin123'));
  assert.equal((await call('POST', '/api/app/verify-code', { code: '111111' })).status, 401);
  const ok = await call('POST', '/api/app/verify-code', { code: '246810' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.match(ok.body.ticket, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(ok.body.expiresInSec, 43200);
  assert.match(ok.headers.get('set-cookie') || '', new RegExp(`cbt_app=${ok.body.ticket}`));
});

test('verify-code: 10 salah dalam 15 menit → 429 walau kode benar', async (t) => {
  const { call, staff } = setup(t);
  await call('POST', '/api/operator/app-settings', { code: '246810' }, await staff('operator', 'admin123'));
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/api/app/verify-code', { code: '000000' })).status, 401);
  assert.equal((await call('POST', '/api/app/verify-code', { code: '246810' })).status, 429);
});

test('wajib aplikasi: mati = login biasa jalan; aktif = perlu tiket aplikasi atau SEB', async (t) => {
  const { call, staff, loginStudent } = setup(t);
  const op = await staff('operator', 'admin123');
  await call('POST', '/api/operator/app-settings', { code: '246810' }, op);
  assert.equal((await loginStudent()).status, 200, 'sakelar mati: browser biasa boleh');

  await call('POST', '/api/operator/app-settings', { requireApp: true }, op);
  const denied = await loginStudent();
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /aplikasi ujian sekolah/);
  assert.equal((await call('POST', '/api/ujian/start-direct', { studentId: 1, nisnLast4: '0000' })).status, 403);

  const { body } = await call('POST', '/api/app/verify-code', { code: '246810' });
  assert.equal((await loginStudent({ Cookie: `cbt_app=${body.ticket}` })).status, 200, 'tiket lewat cookie');
  assert.equal((await loginStudent({ 'X-App-Ticket': body.ticket })).status, 200, 'tiket lewat header');
  assert.equal((await loginStudent({ Cookie: 'cbt_app=palsu' })).status, 403);
  assert.equal((await loginStudent({ 'User-Agent': 'Mozilla/5.0 (iPhone) AppleWebKit Version/17 Mobile SEB/3.6.2' })).status, 200, 'Safe Exam Browser');

  // Ganti kode: tiket lama tetap berlaku sampai kedaluwarsa
  await call('POST', '/api/operator/app-settings', { code: '135790' }, op);
  assert.equal((await loginStudent({ Cookie: `cbt_app=${body.ticket}` })).status, 200);
});

test('verify-quit: memakai password keluar SEB dan mengembalikan hash untuk cadangan offline', async (t) => {
  const { call, staff } = setup(t);
  assert.equal((await call('POST', '/api/app/verify-quit', { password: 'Keluar#2026' })).status, 404);
  await call('POST', '/api/operator/seb-settings', { quitPassword: 'Keluar#2026' }, await staff('operator', 'admin123'));
  assert.equal((await call('POST', '/api/app/verify-quit', { password: 'salah123' })).status, 401);
  const ok = await call('POST', '/api/app/verify-quit', { password: 'Keluar#2026' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.hash, crypto.createHash('sha256').update('Keluar#2026', 'utf8').digest('hex'));
});

test('keluar oleh pengawas: dicatat tanpa mengunci sesi & tanpa menambah pelanggaran', async (t) => {
  const { db, call, loginStudent } = setup(t);
  const login = await loginStudent();
  const h = { 'X-Session-Token': login.body.sessionToken };
  assert.equal((await call('POST', '/api/ujian/supervisor-exit', { sessionId: login.body.sessionId })).status, 401);
  const r = await call('POST', '/api/ujian/supervisor-exit', { sessionId: login.body.sessionId }, h);
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT status, violation_count, supervisor_exit_at FROM exam_sessions WHERE id = ?').get(login.body.sessionId);
  assert.notEqual(row.status, 'LOCKED');
  assert.equal(row.violation_count, 0);
  assert.ok(row.supervisor_exit_at);
});
