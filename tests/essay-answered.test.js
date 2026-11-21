const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');

// Esai dikerjakan di kertas. Tidak ada foto: siswa menandai tiap soal esai "sudah menjawab".

function setup(t) {
  const db = initDb(':memory:');
  const server = createApp(db).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json, res };
  };
  const ctx = { db, base, post: (u, b, h) => call('POST', u, b, h), get: (u, h) => call('GET', u, null, h) };
  ctx.student = async (idx = 0) => {
    const exam = db.prepare('SELECT * FROM exams WHERE is_active = 1').get();
    const st = db.prepare('SELECT * FROM students ORDER BY id LIMIT 1 OFFSET ?').get(idx);
    const s = (await ctx.post('/api/ujian/login', { exam_number: st.exam_number, password: st.password, token: exam.token })).body;
    const esai = db.prepare("SELECT id, number FROM questions WHERE exam_id = ? AND type = 'ESAI' ORDER BY number").all(exam.id);
    return { exam, st, s, h: { 'X-Session-Token': s.sessionToken }, esai };
  };
  ctx.staff = async (u, p) => ({ Authorization: `Bearer ${(await ctx.post('/api/staff/login', { username: u, password: p })).body.staffToken}` });
  return ctx;
}

test('Siswa bisa menandai & membatalkan tanda "sudah menjawab" per soal esai', async (t) => {
  const ctx = setup(t);
  const { s, h, esai } = await ctx.student();
  const mark = (qid, answered) => ctx.post('/api/ujian/essay-answered', { sessionId: s.sessionId, questionId: qid, answered }, h);

  assert.equal((await mark(esai[0].id, true)).status, 200);
  let sess = (await ctx.get(`/api/ujian/session/${s.sessionId}`, h)).body;
  assert.equal(sess.essayAnswered[esai[0].id], true);

  assert.equal((await mark(esai[0].id, false)).status, 200);
  sess = (await ctx.get(`/api/ujian/session/${s.sessionId}`, h)).body;
  assert.ok(!sess.essayAnswered[esai[0].id]);
  assert.equal(sess.essayPhotos, undefined, 'data foto esai tidak lagi dikirim');
});

test('Selesai ujian ditolak sampai semua soal esai ditandai sudah dijawab', async (t) => {
  const ctx = setup(t);
  const { s, h, esai } = await ctx.student();
  const early = await ctx.post('/api/ujian/finish', { sessionId: s.sessionId }, h);
  assert.equal(early.status, 400);
  assert.match(early.body.error, /belum ditandai/i);
  assert.doesNotMatch(early.body.error, /foto/i);

  for (const q of esai) await ctx.post('/api/ujian/essay-answered', { sessionId: s.sessionId, questionId: q.id, answered: true }, h);
  assert.equal((await ctx.post('/api/ujian/finish', { sessionId: s.sessionId }, h)).status, 200);

  // Setelah selesai tanda tidak bisa diubah lagi
  assert.equal((await ctx.post('/api/ujian/essay-answered', { sessionId: s.sessionId, questionId: esai[0].id, answered: false }, h)).status, 400);
});

test('Tanda esai hanya untuk soal esai milik sesi, butuh token sesi, dan ditolak saat terkunci', async (t) => {
  const ctx = setup(t);
  const { exam, s, h, esai } = await ctx.student();
  const pg = ctx.db.prepare("SELECT id FROM questions WHERE exam_id = ? AND type = 'PG' LIMIT 1").get(exam.id);
  assert.equal((await ctx.post('/api/ujian/essay-answered', { sessionId: s.sessionId, questionId: pg.id, answered: true }, h)).status, 400);
  assert.equal((await ctx.post('/api/ujian/essay-answered', { sessionId: s.sessionId, questionId: 999999, answered: true }, h)).status, 404);
  assert.equal((await ctx.post('/api/ujian/essay-answered', { sessionId: s.sessionId, questionId: esai[0].id, answered: true })).status, 401);
  await ctx.post('/api/ujian/violation', { sessionId: s.sessionId, reason: 'uji' }, h);
  assert.equal((await ctx.post('/api/ujian/essay-answered', { sessionId: s.sessionId, questionId: esai[0].id, answered: true }, h)).status, 423);
});

test('Fitur unggah foto esai sudah dihapus dari server', async (t) => {
  const ctx = setup(t);
  const { s, h, esai } = await ctx.student();
  const fd = new FormData();
  fd.append('sessionId', String(s.sessionId));
  fd.append('questionId', String(esai[0].id));
  fd.append('photo', new Blob([Buffer.from([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), 'a.jpg');
  const r = await fetch(`${ctx.base}/api/ujian/upload-essay-photo`, { method: 'POST', headers: h, body: fd });
  assert.equal(r.status, 404);
});

test('Pengawas, guru, dan Excel nilai menampilkan status esai yang sudah ditandai', async (t) => {
  const ctx = setup(t);
  const { exam, s, h, esai, st } = await ctx.student();
  await ctx.post('/api/ujian/essay-answered', { sessionId: s.sessionId, questionId: esai[0].id, answered: true }, h);

  const pw = await ctx.staff('pengawas', 'pengawas123');
  const work = (await ctx.get(`/api/pengawas/student-work/${s.sessionId}`, pw)).body;
  const rows = work.workDetail.filter(w => w.type === 'ESAI');
  assert.equal(rows.find(w => w.question_id === esai[0].id).essay_answered, true);
  assert.equal(rows.find(w => w.question_id === esai[1].id).essay_answered, false);
  assert.ok(rows.every(w => !('essay_photo' in w)), 'tidak ada lagi data foto');

  const guru = await ctx.staff('guru', 'guru123');
  const scores = (await ctx.get(`/api/guru/exams/${exam.id}/scores`, guru)).body;
  const row = scores.scores.find(x => x.student_id === st.id);
  assert.equal(row.esai_answered, 1);
  assert.equal(row.total_esai, esai.length);

  const xres = await fetch(`${ctx.base}/api/guru/exams/${exam.id}/export-excel`, { headers: guru });
  const wb = XLSX.read(Buffer.from(await xres.arrayBuffer()), { type: 'buffer' });
  const sheet = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  const xrow = sheet.find(r => r['Nomor Peserta'] === st.exam_number);
  assert.equal(xrow['Esai Ditandai Dijawab'], `1/${esai.length}`);
});

test('Halaman ujian memakai tombol "sudah menjawab" per esai, tanpa kamera/foto', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'ujian.html'), 'utf8');
  assert.match(html, /onclick="toggleEssayAnswered\(\$\{q\.id\}\)"/, 'tombol per soal esai');
  assert.match(html, /Saya sudah menjawab soal ini di kertas/);
  for (const gone of ['type="file"', 'getUserMedia', 'openLiveCamera', 'upload-essay-photo', 'capture="environment"']) {
    assert.ok(!html.includes(gone), `ujian.html tidak boleh lagi memuat ${gone}`);
  }
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'public', 'cek-kamera.html')), 'halaman cek-kamera dihapus');
});
