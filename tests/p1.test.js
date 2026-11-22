const test = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');

function setup(t) {
  const db = initDb(':memory:');
  const server = createApp(db, { enforceDefaultPasswordChange: false }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const isForm = body instanceof FormData;
    const res = await fetch(base + url, {
      method,
      headers: isForm ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  const ctx = {
    db, base,
    post: (u, b, h) => call('POST', u, b, h),
    get: (u, h) => call('GET', u, null, h),
    del: (u, h) => call('DELETE', u, null, h)
  };
  ctx.staff = async (username, password) => {
    const r = await ctx.post('/api/staff/login', { username, password });
    assert.equal(r.status, 200, `login ${username}`);
    return { Authorization: `Bearer ${r.body.staffToken}` };
  };
  ctx.addStaff = async (op, data) => {
    const r = await ctx.post('/api/operator/staff', data, op);
    assert.equal(r.status, 200);
    return r.body.id;
  };
  return ctx;
}

const activeIds = (db) => db.prepare('SELECT id FROM exams WHERE is_active = 1 ORDER BY id').all().map(r => r.id);

test('P1-1: ujian untuk kelas berbeda bisa aktif bersamaan; hanya target kelas yang bentrok yang dinonaktifkan', async (t) => {
  const ctx = setup(t);
  const op = await ctx.staff('operator', 'admin123');
  const x = await ctx.post('/api/operator/exams', { title: 'Kimia IPA 1', subject: 'Kimia', class_target: 'XII IPA 1' }, op);
  const y = await ctx.post('/api/operator/exams', { title: 'Fisika IPA 2', subject: 'Fisika', class_target: 'XII IPA 2' }, op);
  assert.deepEqual(activeIds(ctx.db), [x.body.id, y.body.id]);

  // Target "Semua Kelas" bentrok dengan semua kelas
  const z = await ctx.post('/api/operator/exams', { title: 'Umum', subject: 'Kimia', class_target: 'Semua Kelas' }, op);
  assert.deepEqual(activeIds(ctx.db), [z.body.id]);

  // Aktivasi lewat tombol "Aktifkan" juga paralel per kelas
  await ctx.post(`/api/operator/exams/${x.body.id}/activate`, {}, op);
  await ctx.post(`/api/operator/exams/${y.body.id}/activate`, {}, op);
  assert.deepEqual(activeIds(ctx.db), [x.body.id, y.body.id]);

  // Siswa XII IPA 2 mendapat ujian Fisika, siswa XII IPA 1 mendapat Kimia
  const st2 = ctx.db.prepare("SELECT * FROM students WHERE class_name = 'XII IPA 2' LIMIT 1").get();
  const st1 = ctx.db.prepare("SELECT * FROM students WHERE class_name = 'XII IPA 1' LIMIT 1").get();
  assert.equal((await ctx.post('/api/ujian/login', { exam_number: st2.exam_number, password: st2.password })).body.exam.id, y.body.id);
  assert.equal((await ctx.post('/api/ujian/login', { exam_number: st1.exam_number, password: st1.password })).body.exam.id, x.body.id);
});

test('P1-2: kelas "XII IPA 1" tidak ikut cocok dengan target "XII IPA 10"', async (t) => {
  const ctx = setup(t);
  ctx.db.prepare("UPDATE exams SET class_target = 'XII IPA 10, XII IPA 11'").run();
  const st = ctx.db.prepare("SELECT * FROM students WHERE class_name = 'XII IPA 1' LIMIT 1").get();
  const r = await ctx.post('/api/ujian/login', { exam_number: st.exam_number, password: st.password });
  assert.equal(r.status, 404);
});

test('P1-3: akses guru memakai nama mapel yang sama persis', async (t) => {
  const ctx = setup(t);
  const op = await ctx.staff('operator', 'admin123');
  await ctx.addStaff(op, { username: 'g_bahasa', password: 'b123', full_name: 'Guru Bahasa', role: 'guru', subject: 'Bahasa' });
  await ctx.addStaff(op, { username: 'g_kosong', password: 'k123', full_name: 'Guru Tanpa Mapel', role: 'guru' });
  const ing = await ctx.post('/api/operator/exams', { title: 'PAS Inggris', subject: 'Bahasa Inggris', class_target: 'XII IPA 2' }, op);

  const bahasa = await ctx.staff('g_bahasa', 'b123');
  const list = await ctx.get('/api/guru/exams', bahasa);
  assert.ok(!list.body.exams.some(e => e.id === ing.body.id));
  assert.equal((await ctx.get(`/api/guru/exams/${ing.body.id}/questions`, bahasa)).status, 403);

  const kosong = await ctx.staff('g_kosong', 'k123');
  assert.equal((await ctx.get('/api/guru/exams', kosong)).body.exams.length, 0);

  // Guru "Kimia & Pengetahuan Umum" boleh membuat ujian Kimia, tetapi tidak "Kimia Dasar" atau mapel lain
  const kimia = await ctx.staff('guru', 'guru123');
  assert.equal((await ctx.post('/api/guru/exams', { subject: 'Kimia', title: 'UH Kimia' }, kimia)).status, 200);
  assert.equal((await ctx.post('/api/guru/exams', { subject: 'Kimia Dasar', title: 'UH' }, kimia)).status, 403);
  assert.equal((await ctx.post('/api/guru/exams', { subject: 'Fisika', title: 'UH' }, kimia)).status, 403);
});

test('P1-4: salin soal otomatis hanya dari mapel sama persis dan guru yang sama', async (t) => {
  const ctx = setup(t);
  const op = await ctx.staff('operator', 'admin123');
  const tA = await ctx.addStaff(op, { username: 'mtk_a', password: 'a123', full_name: 'Guru A', role: 'guru', subject: 'Matematika' });
  const tB = await ctx.addStaff(op, { username: 'mtk_b', password: 'b123', full_name: 'Guru B', role: 'guru', subject: 'Matematika' });

  const gA = await ctx.staff('mtk_a', 'a123');
  const bank = await ctx.post('/api/guru/exams', { subject: 'Matematika', title: 'Bank A' }, gA);
  await ctx.post(`/api/guru/exams/${bank.body.id}/questions`, { number: 1, question_text: '1+1?', option_a: '2', answer_key: 'A' }, gA);

  const forB = await ctx.post('/api/operator/exams', { title: 'Jadwal B', subject: 'Matematika', class_target: 'XII IPA 2', teacher_id: tB }, op);
  assert.equal(forB.body.autoCopiedQuestions, 0);
  const forA = await ctx.post('/api/operator/exams', { title: 'Jadwal A', subject: 'Matematika', class_target: 'XII IPA 1', teacher_id: tA }, op);
  assert.equal(forA.body.autoCopiedQuestions, 1);

  // Mapel mirip (Biokimia) tidak dipakai sebagai sumber untuk Kimia
  ctx.db.prepare("UPDATE exams SET subject = 'Biokimia' WHERE subject = 'Kimia'").run();
  const kim = await ctx.post('/api/operator/exams', { title: 'Jadwal Kimia', subject: 'Kimia', class_target: 'XII IPA 1', teacher_id: 2 }, op);
  assert.equal(kim.body.autoCopiedQuestions, 0);
});

test('P1-5: pengawas hanya bisa melihat dan mengelola siswa di ruangnya sendiri', async (t) => {
  const ctx = setup(t);
  const exam = ctx.db.prepare('SELECT * FROM exams WHERE is_active = 1').get();
  ctx.db.prepare("UPDATE exams SET class_target = 'Semua Kelas' WHERE id = ?").run(exam.id);
  const r1 = ctx.db.prepare("SELECT * FROM students WHERE room = 'Ruang 01' LIMIT 1").get();
  const r2 = ctx.db.prepare("SELECT * FROM students WHERE room = 'Ruang 02' LIMIT 1").get();
  const s1 = (await ctx.post('/api/ujian/login', { exam_number: r1.exam_number, password: r1.password })).body;
  const s2 = (await ctx.post('/api/ujian/login', { exam_number: r2.exam_number, password: r2.password })).body;

  const pw = await ctx.staff('pengawas', 'pengawas123'); // Ruang 01
  const room = await ctx.get('/api/pengawas/room?room=Ruang%2002', pw);
  assert.ok(room.body.students.length > 0);
  assert.ok(room.body.students.every(s => s.room === 'Ruang 01'));
  const all = await ctx.get('/api/pengawas/room?room=ALL', pw);
  assert.ok(all.body.students.every(s => s.room === 'Ruang 01'));

  assert.equal((await ctx.post(`/api/pengawas/unlock/${s2.sessionId}`, {}, pw)).status, 403);
  assert.equal((await ctx.post(`/api/pengawas/reset-login/${s2.sessionId}`, {}, pw)).status, 403);
  assert.equal((await ctx.get(`/api/pengawas/student-work/${s2.sessionId}`, pw)).status, 403);
  assert.equal((await ctx.post('/api/operator/student-change-class', { student_id: r2.id, new_class_name: 'XII IPA 3' }, pw)).status, 403);

  assert.equal((await ctx.post(`/api/pengawas/unlock/${s1.sessionId}`, {}, pw)).status, 200);
  assert.equal((await ctx.get(`/api/pengawas/student-work/${s1.sessionId}`, pw)).status, 200);

  // Operator tetap bisa semua ruang
  const op = await ctx.staff('operator', 'admin123');
  assert.equal((await ctx.post(`/api/pengawas/unlock/${s2.sessionId}`, {}, op)).status, 200);
});

test('P1-6: tanda esai ditolak setelah waktu habis; tombol selesai tetap bisa', async (t) => {
  const ctx = setup(t);
  const exam = ctx.db.prepare('SELECT * FROM exams WHERE is_active = 1').get();
  const st = ctx.db.prepare('SELECT * FROM students LIMIT 1').get();
  const s = (await ctx.post('/api/ujian/login', { exam_number: st.exam_number, password: st.password, token: exam.token })).body;
  const h = { 'X-Session-Token': s.sessionToken };
  const esai = ctx.db.prepare("SELECT id FROM questions WHERE exam_id = ? AND type = 'ESAI' ORDER BY id").all(exam.id);
  const mark = (qid) => ctx.post('/api/ujian/essay-answered', { sessionId: s.sessionId, questionId: qid, answered: true }, h);

  for (const q of esai) assert.equal((await mark(q.id)).status, 200);

  ctx.db.prepare('UPDATE exam_sessions SET started_at = ? WHERE id = ?').run(new Date(Date.now() - (exam.duration_minutes + 1) * 60000).toISOString(), s.sessionId);
  assert.equal((await mark(esai[0].id)).status, 400);

  assert.equal((await ctx.post('/api/ujian/finish', { sessionId: s.sessionId }, h)).status, 200);
});

test('P1-7: impor Word mode "ganti" ditolak jika siswa sudah menjawab', async (t) => {
  const ctx = setup(t);
  const exam = ctx.db.prepare('SELECT * FROM exams WHERE is_active = 1').get();
  const st = ctx.db.prepare('SELECT * FROM students LIMIT 1').get();
  const s = (await ctx.post('/api/ujian/login', { exam_number: st.exam_number, password: st.password, token: exam.token })).body;
  const q = ctx.db.prepare("SELECT id FROM questions WHERE exam_id = ? AND type = 'PG' LIMIT 1").get(exam.id);
  await ctx.post('/api/ujian/answer', { sessionId: s.sessionId, questionId: q.id, chosenOption: 'A' }, { 'X-Session-Token': s.sessionToken });

  const op = await ctx.staff('operator', 'admin123');
  const before = ctx.db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(exam.id).c;
  const fd = new FormData();
  fd.append('replace', 'true');
  fd.append('rawText', '1. Soal baru?\nA. a\nB. b\nC. c\nD. d\nE. e\nKUNCI: A');
  const r = await ctx.post(`/api/guru/exams/${exam.id}/import-word`, fd, op);
  assert.equal(r.status, 409);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(exam.id).c, before);
});

test('P1-8: menghapus ujian aktif tidak mengaktifkan ujian lain secara diam-diam', async (t) => {
  const ctx = setup(t);
  const op = await ctx.staff('operator', 'admin123');
  const draft = await ctx.post('/api/guru/exams', { subject: 'Kimia', title: 'Draf' }, await ctx.staff('guru', 'guru123'));
  const active = ctx.db.prepare('SELECT id FROM exams WHERE is_active = 1').get();
  assert.equal((await ctx.del(`/api/operator/exams/${active.id}`, op)).status, 200);
  assert.equal(ctx.db.prepare('SELECT is_active FROM exams WHERE id = ?').get(draft.body.id).is_active, 0);
});

test('P1-9: token lama masih diterima 2 menit setelah pergantian otomatis', async (t) => {
  const ctx = setup(t);
  const exam = ctx.db.prepare('SELECT * FROM exams WHERE is_active = 1').get();
  const st = ctx.db.prepare('SELECT * FROM students LIMIT 1').get();
  const s = (await ctx.post('/api/ujian/login', { exam_number: st.exam_number, password: st.password })).body;
  const h = { 'X-Session-Token': s.sessionToken };
  const oldToken = exam.token;

  // Paksa token kedaluwarsa -> request berikut memicu pergantian token
  ctx.db.prepare('UPDATE exams SET token_updated_at = ? WHERE id = ?').run(new Date(Date.now() - 16 * 60000).toISOString(), exam.id);
  const pw = await ctx.staff('pengawas', 'pengawas123');
  const fresh = await ctx.get('/api/ujian/active-token?class_name=XII%20IPA%201', pw);
  assert.notEqual(fresh.body.token, oldToken);

  assert.equal((await ctx.post('/api/ujian/verify-subtest-token', { sessionId: s.sessionId, token: oldToken }, h)).status, 200);

  // Setelah masa tenggang lewat, token lama ditolak
  ctx.db.prepare('UPDATE exams SET token_updated_at = ? WHERE id = ?').run(new Date(Date.now() - 3 * 60000).toISOString(), exam.id);
  ctx.db.prepare('UPDATE exam_sessions SET need_token_reverify = 1 WHERE id = ?').run(s.sessionId);
  assert.equal((await ctx.post('/api/ujian/verify-resume-token', { sessionId: s.sessionId, token: oldToken }, h)).status, 403);
});

test('P1-11: overview operator mengirim semua ujian aktif paralel beserta token & jumlah soal', async (t) => {
  const ctx = setup(t);
  const op = await ctx.staff('operator', 'admin123');
  const fis = await ctx.post('/api/operator/exams', { title: 'PAS Fisika', subject: 'Fisika', class_target: 'XII IPA 2' }, op);
  const ov = await ctx.get('/api/operator/overview', op);
  assert.equal(ov.status, 200);
  assert.ok(Array.isArray(ov.body.activeExams), 'activeExams harus ada');
  assert.equal(ov.body.activeExams.length, 2);
  for (const e of ov.body.activeExams) {
    assert.ok(e.token, `token ujian ${e.subject}`);
    assert.equal(typeof e.total_questions, 'number');
  }
  const fisRow = ov.body.activeExams.find(e => e.id === fis.body.id);
  assert.equal(fisRow.class_target, 'XII IPA 2');
  assert.equal(fisRow.total_questions, 0);
  // activeExam (lama) tetap ada untuk kompatibilitas
  assert.ok(ov.body.activeExam && ov.body.activeExam.token);
});

test('P1-10: panel pengawas menampilkan semua ujian aktif untuk siswa di ruangnya', async (t) => {
  const ctx = setup(t);
  const op = await ctx.staff('operator', 'admin123');
  // Ruang 01 berisi XII IPA 1; tambahkan satu siswa XII IPA 2 ke Ruang 01
  const st = ctx.db.prepare("SELECT * FROM students WHERE class_name = 'XII IPA 2' LIMIT 1").get();
  ctx.db.prepare("UPDATE students SET room = 'Ruang 01' WHERE id = ?").run(st.id);
  await ctx.post('/api/operator/exams', { title: 'Fisika IPA 2', subject: 'Fisika', class_target: 'XII IPA 2' }, op);

  const pw = await ctx.staff('pengawas', 'pengawas123');
  const room = await ctx.get('/api/pengawas/room', pw);
  assert.equal(room.body.activeExams.length, 2);
  assert.ok(room.body.activeExams.every(e => e.token));
  const row = room.body.students.find(s => s.student_id === st.id);
  assert.equal(row.exam_subject, 'Fisika');
});
