const test = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');

function setup(t) {
  const db = initDb(':memory:');
  const server = createApp(db).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  const login = (username, password) => call('POST', '/api/staff/login', { username, password });
  return { db, call, login };
}

test('password bawaan: login ditandai dan semua menu staf dikunci', async (t) => {
  const { call, login } = setup(t);
  const op = await login('operator', 'admin123');
  assert.equal(op.status, 200);
  assert.equal(op.body.mustChangePassword, true);
  const tok = op.body.staffToken;

  const ov = await call('GET', '/api/operator/overview', null, tok);
  assert.equal(ov.status, 403);
  assert.equal(ov.body.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await call('GET', '/api/guru/exams', null, tok)).status, 403);

  // Token ujian tidak boleh terlihat selama password belum diganti
  const info = await call('GET', '/api/server-info', null, tok);
  assert.equal(info.body.activeExam.token, undefined);
  assert.equal((await call('GET', '/api/ujian/active-token?class_name=XII%20IPA%201', null, tok)).status, 401);
});

test('password bawaan: ganti password membuka panel; login ulang tidak ditandai', async (t) => {
  const { call, login } = setup(t);
  const tok = (await login('pengawas', 'pengawas123')).body.staffToken;

  const ok = await call('POST', '/api/staff/change-password', { old_password: 'pengawas123', new_password: 'RuangSatu#2026' }, tok);
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/pengawas/room?room=Ruang%2001', null, tok)).status, 200);

  assert.equal((await login('pengawas', 'pengawas123')).status, 401);
  const again = await login('pengawas', 'RuangSatu#2026');
  assert.equal(again.status, 200);
  assert.equal(again.body.mustChangePassword, false);
});

test('password baru ditolak bila lemah; password lama salah ditolak', async (t) => {
  const { call, login } = setup(t);
  const tok = (await login('guru', 'guru123')).body.staffToken;
  const change = (old_password, new_password) => call('POST', '/api/staff/change-password', { old_password, new_password }, tok);

  assert.equal((await change('salah', 'PasswordKuat1')).status, 401);
  assert.equal((await change('guru123', 'pendek')).status, 400);
  assert.equal((await change('guru123', 'admin123')).status, 400);
  assert.equal((await change('guru123', 'pengawas123')).status, 400);
  // masih terkunci karena belum berhasil ganti
  assert.equal((await call('GET', '/api/guru/exams', null, tok)).status, 403);
  assert.equal((await change('guru123', 'GuruKimia2026')).status, 200);
  assert.equal((await call('GET', '/api/guru/exams', null, tok)).status, 200);
});

test('password baru tidak boleh sama dengan username', async (t) => {
  const { call, login } = setup(t);
  const tok = (await login('pengawas2', 'pengawas123')).body.staffToken;
  assert.equal((await call('POST', '/api/staff/change-password', { old_password: 'pengawas123', new_password: 'Pengawas2' }, tok)).status, 400);
});

test('akun buatan operator tidak ditandai; reset ke password bawaan ditandai lagi', async (t) => {
  const { call, login } = setup(t);
  const opTok = (await login('operator', 'admin123')).body.staffToken;
  await call('POST', '/api/staff/change-password', { old_password: 'admin123', new_password: 'OperatorBaru2026' }, opTok);

  const made = await call('POST', '/api/operator/staff', { username: 'bu_ani', password: 'ani12345', full_name: 'Bu Ani', role: 'guru', subject: 'Kimia' }, opTok);
  assert.equal(made.status, 200);
  const ani = await login('bu_ani', 'ani12345');
  assert.equal(ani.body.mustChangePassword, false);
  assert.equal((await call('GET', '/api/guru/exams', null, ani.body.staffToken)).status, 200);

  assert.equal((await call('PUT', `/api/operator/staff/${made.body.id}`, { password: 'guru123', role: 'guru', subject: 'Kimia' }, opTok)).status, 200);
  assert.equal((await login('bu_ani', 'guru123')).body.mustChangePassword, true);
});
