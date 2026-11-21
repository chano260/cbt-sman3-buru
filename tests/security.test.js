const test = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');

function setup(t) {
  const db = initDb(':memory:');
  const server = createApp(db).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  const post = (url, body, headers) => call('POST', url, body, headers);
  const get = (url, headers) => call('GET', url, null, headers);
  return { db, base, post, get };
}

async function loginStudent(ctx, student) {
  const exam = ctx.db.prepare('SELECT * FROM exams WHERE is_active = 1').get();
  const r = await ctx.post('/api/ujian/login', { exam_number: student.exam_number, password: student.password, token: exam.token });
  assert.equal(r.status, 200);
  return r.body;
}

test('P0-1: token ujian tidak bocor ke publik tanpa login staf', async (t) => {
  const ctx = setup(t);
  const info = await ctx.get('/api/server-info');
  assert.equal(info.status, 200);
  assert.equal(info.body.activeExam.token, undefined);

  const tok = await ctx.get('/api/ujian/active-token?class_name=XII%20IPA%201');
  assert.equal(tok.status, 401);

  const op = await ctx.post('/api/staff/login', { username: 'pengawas', password: 'pengawas123' });
  const auth = { Authorization: `Bearer ${op.body.staffToken}` };
  const infoStaff = await ctx.get('/api/server-info', auth);
  assert.ok(infoStaff.body.activeExam.token);
  const tokStaff = await ctx.get('/api/ujian/active-token?class_name=XII%20IPA%201', auth);
  assert.equal(tokStaff.status, 200);
  assert.ok(tokStaff.body.token);

  // Fitur sekolah "Ambil Token": siswa yang sudah login boleh mengambil token sesinya sendiri
  const st = ctx.db.prepare('SELECT * FROM students LIMIT 1').get();
  const login = await ctx.post('/api/ujian/login', { exam_number: st.exam_number, password: st.password });
  const tokStudent = await ctx.get(`/api/ujian/active-token?sessionId=${login.body.sessionId}`, { 'X-Session-Token': login.body.sessionToken });
  assert.equal(tokStudent.status, 200);
  assert.ok(tokStudent.body.token);
  const tokForged = await ctx.get(`/api/ujian/active-token?sessionId=${login.body.sessionId}`, { 'X-Session-Token': 'palsu' });
  assert.equal(tokForged.status, 401);
});

test('P0-2: aktivasi akun wajib NISN lengkap + tanggal lahir yang tepat', async (t) => {
  const ctx = setup(t);
  const st = ctx.db.prepare('SELECT * FROM students LIMIT 1').get(); // Namlea, 14 Januari 2008

  assert.equal((await ctx.post('/api/ujian/activate-account', { nisn: st.nisn })).status, 400);
  assert.equal((await ctx.post('/api/ujian/activate-account', { nisn: st.nisn.slice(-4), birth_date: '2008-01-14' })).status, 404);
  assert.equal((await ctx.post('/api/ujian/activate-account', { nisn: st.nisn, birth_date: '2008-01-15' })).status, 401);
  assert.equal((await ctx.post('/api/ujian/activate-account', { nisn: st.nisn, birth_date: '2008-02-14' })).status, 401);

  const ok = await ctx.post('/api/ujian/activate-account', { nisn: st.nisn, birth_date: '2008-01-14' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.student.full_name, st.full_name);
});

test('P0-3: sesi baru tidak bisa menjawab sebelum token ujian diverifikasi', async (t) => {
  const ctx = setup(t);
  const st = ctx.db.prepare('SELECT * FROM students LIMIT 1').get();
  const start = await ctx.post('/api/ujian/start-direct', { studentId: st.id, nisnLast4: st.nisn.slice(-4) });
  assert.equal(start.status, 200);
  assert.ok(start.body.sessionToken);
  const h = { 'X-Session-Token': start.body.sessionToken };

  const sess = await ctx.get(`/api/ujian/session/${start.body.sessionId}`, h);
  assert.equal(sess.body.session.need_token_reverify, 1);
  const q = sess.body.questions.find(x => x.type === 'PG');
  const ans = await ctx.post('/api/ujian/answer', { sessionId: start.body.sessionId, questionId: q.id, chosenOption: 'A' }, h);
  assert.equal(ans.status, 428);

  const login = await ctx.post('/api/ujian/login', { exam_number: st.exam_number, password: st.password });
  assert.equal(login.status, 200);
  const sess2 = await ctx.get(`/api/ujian/session/${login.body.sessionId}`, { 'X-Session-Token': login.body.sessionToken });
  assert.equal(sess2.body.session.need_token_reverify, 1);
});

test('P0-4: lanjut-sendiri setelah terkunci hanya bisa oleh pemilik sesi; pelanggaran tetap tercatat', async (t) => {
  const ctx = setup(t);
  const [st, other] = ctx.db.prepare('SELECT * FROM students LIMIT 2').all();
  const exam = ctx.db.prepare('SELECT * FROM exams WHERE is_active = 1').get();
  const s = await loginStudent(ctx, st);
  const o = await loginStudent(ctx, other);
  const h = { 'X-Session-Token': s.sessionToken };

  assert.equal((await ctx.post('/api/ujian/violation', { sessionId: s.sessionId, reason: 'pindah tab' }, h)).status, 200);

  // Login ulang tidak diam-diam membuka kunci
  const relog = await ctx.post('/api/ujian/login', { exam_number: st.exam_number, password: st.password, token: exam.token });
  assert.equal(relog.body.status, 'LOCKED');
  const h2 = { 'X-Session-Token': relog.body.sessionToken };

  // Siswa lain / tanpa token sesi tidak bisa membuka kunci sesi ini
  assert.equal((await ctx.post('/api/ujian/self-resume', { sessionId: s.sessionId })).status, 401);
  assert.equal((await ctx.post('/api/ujian/self-resume', { sessionId: s.sessionId }, { 'X-Session-Token': o.sessionToken })).status, 401);

  // Fitur sekolah: pemilik sesi boleh melanjutkan sendiri, jumlah pelanggaran tetap tercatat
  const resumed = await ctx.post('/api/ujian/self-resume', { sessionId: s.sessionId }, h2);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.status, 'WORKING');
  const row = ctx.db.prepare('SELECT status, violation_count FROM exam_sessions WHERE id = ?').get(s.sessionId);
  assert.equal(row.status, 'WORKING');
  assert.equal(row.violation_count, 1);
});

test('P0-5: endpoint sesi siswa wajib token sesi milik sesi tersebut (anti-IDOR)', async (t) => {
  const ctx = setup(t);
  const [a, b] = ctx.db.prepare('SELECT * FROM students LIMIT 2').all();
  const sa = await loginStudent(ctx, a);
  const sb = await loginStudent(ctx, b);
  const q = ctx.db.prepare("SELECT id FROM questions WHERE exam_id = (SELECT exam_id FROM exam_sessions WHERE id = ?) AND type = 'PG' LIMIT 1").get(sb.sessionId);

  const noTok = { sessionId: sb.sessionId, questionId: q.id, chosenOption: 'A' };
  assert.equal((await ctx.post('/api/ujian/answer', noTok)).status, 401);
  assert.equal((await ctx.post('/api/ujian/answer', noTok, { 'X-Session-Token': sa.sessionToken })).status, 401);
  assert.equal((await ctx.get(`/api/ujian/session/${sb.sessionId}`)).status, 401);
  assert.equal((await ctx.post('/api/ujian/finish', { sessionId: sb.sessionId }, { 'X-Session-Token': sa.sessionToken })).status, 401);
  assert.equal((await ctx.post('/api/ujian/violation', { sessionId: sb.sessionId })).status, 401);
  assert.equal((await ctx.post('/api/ujian/heartbeat', { sessionId: sb.sessionId, currentQuestionNumber: 3 })).status, 401);

  assert.equal((await ctx.post('/api/ujian/answer', noTok, { 'X-Session-Token': sb.sessionToken })).status, 200);
});

test('P0-6: jawaban hanya diterima untuk soal PG milik ujian sesi tersebut', async (t) => {
  const ctx = setup(t);
  const st = ctx.db.prepare('SELECT * FROM students LIMIT 1').get();
  const s = await loginStudent(ctx, st);
  const h = { 'X-Session-Token': s.sessionToken };
  assert.equal((await ctx.post('/api/ujian/answer', { sessionId: s.sessionId, questionId: 999999, chosenOption: 'A' }, h)).status, 404);
  const esai = ctx.db.prepare("SELECT id FROM questions WHERE type = 'ESAI' LIMIT 1").get();
  assert.equal((await ctx.post('/api/ujian/answer', { sessionId: s.sessionId, questionId: esai.id, chosenOption: 'A' }, h)).status, 400);
});

test('P0-7: file SVG tidak boleh diunggah sebagai media soal (stored XSS)', async (t) => {
  const ctx = setup(t);
  const guru = await ctx.post('/api/staff/login', { username: 'operator', password: 'admin123' });
  const exam = ctx.db.prepare('SELECT id FROM exams LIMIT 1').get();
  const fd = new FormData();
  fd.append('question_text', 'Soal bergambar');
  fd.append('image', new Blob(['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'], { type: 'image/svg+xml' }), 'x.svg');
  const res = await fetch(`${ctx.base}/api/guru/exams/${exam.id}/questions`, {
    method: 'POST', headers: { Authorization: `Bearer ${guru.body.staffToken}` }, body: fd
  });
  assert.equal(res.status, 400);
});

test('P0-8: password staf disimpan ter-hash dan login dibatasi setelah 5x gagal', async (t) => {
  const ctx = setup(t);
  const op = ctx.db.prepare("SELECT password FROM users WHERE username = 'operator'").get();
  assert.notEqual(op.password, 'admin123');
  assert.match(op.password, /^scrypt\$/);

  for (let i = 0; i < 5; i++) {
    assert.equal((await ctx.post('/api/staff/login', { username: 'guru', password: 'salah' })).status, 401);
  }
  assert.equal((await ctx.post('/api/staff/login', { username: 'guru', password: 'guru123' })).status, 429);
  assert.equal((await ctx.post('/api/staff/login', { username: 'operator', password: 'admin123' })).status, 200);
});

test('P0-9: token staf tidak berlaku lagi setelah akun dihapus', async (t) => {
  const ctx = setup(t);
  const op = await ctx.post('/api/staff/login', { username: 'operator', password: 'admin123' });
  const gu = await ctx.post('/api/staff/login', { username: 'guru', password: 'guru123' });
  const res = await fetch(`${ctx.base}/api/operator/staff/${gu.body.user.id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${op.body.staffToken}` }
  });
  assert.equal(res.status, 200);
  assert.equal((await ctx.get('/api/guru/exams', { Authorization: `Bearer ${gu.body.staffToken}` })).status, 401);
});
