const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');
require('./helpers/studentSessionFetch');

async function setup(t) {
  const db = initDb(':memory:');
  const app = createApp(db, { enforceDefaultPasswordChange: false });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const guru = await fetch(`${base}/api/staff/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'guru', password: 'guru123', role: 'guru' })
  }).then(r => r.json());
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${guru.staffToken}` };
  const exam = db.prepare('SELECT * FROM exams WHERE is_active = 1 LIMIT 1').get();
  const pg = db.prepare("SELECT * FROM questions WHERE exam_id = ? AND type = 'PG' ORDER BY number ASC LIMIT 1").get(exam.id);
  const put = (id, body, headers = auth) => fetch(`${base}/api/guru/questions/${id}`, { method: 'PUT', headers, body: JSON.stringify(body) });
  return { db, base, auth, exam, pg, put };
}

const fullPg = (q, over = {}) => ({
  number: q.number, type: 'PG', question_text: q.question_text,
  option_a: q.option_a, option_b: q.option_b, option_c: q.option_c, option_d: q.option_d, option_e: q.option_e,
  answer_key: q.answer_key, ...over
});

test('edit soal: guru mengubah teks, opsi, dan kunci; gambar tetap; siswa langsung melihat teks baru', async (t) => {
  const { db, base, exam, pg, put } = await setup(t);
  db.prepare('UPDATE questions SET image_data = ? WHERE id = ?').run('/uploads/gambar.png', pg.id);

  const student = db.prepare('SELECT * FROM students LIMIT 1').get();
  const login = await fetch(`${base}/api/ujian/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exam_number: student.exam_number, password: student.password, token: exam.token })
  }).then(r => r.json());
  // Soal sudah masuk cache RAM sebelum diedit
  await fetch(`${base}/api/ujian/session/${login.sessionId}`).then(r => r.json());

  const newKey = pg.answer_key === 'A' ? 'B' : 'A';
  const res = await put(pg.id, fullPg(pg, { question_text: 'Teks soal sudah dibetulkan', option_a: 'Opsi A baru', answer_key: newKey }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.question.question_text, 'Teks soal sudah dibetulkan');

  const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(pg.id);
  assert.equal(row.question_text, 'Teks soal sudah dibetulkan');
  assert.equal(row.option_a, 'Opsi A baru');
  assert.equal(row.answer_key, newKey);
  assert.equal(row.image_data, '/uploads/gambar.png', 'gambar tidak ikut terhapus saat teks diedit');

  const after = await fetch(`${base}/api/ujian/session/${login.sessionId}`).then(r => r.json());
  const seen = after.questions.find(q => q.id === pg.id);
  assert.equal(seen.question_text, 'Teks soal sudah dibetulkan');
  assert.equal(seen.answer_key, undefined, 'kunci tetap tidak bocor ke siswa');
});

test('edit kunci setelah siswa menjawab: diizinkan dan nilai dihitung ulang', async (t) => {
  const { db, base, exam, pg, put, auth } = await setup(t);
  const student = db.prepare('SELECT * FROM students LIMIT 1').get();
  const login = await fetch(`${base}/api/ujian/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exam_number: student.exam_number, password: student.password, token: exam.token })
  }).then(r => r.json());
  const wrong = pg.answer_key === 'A' ? 'B' : 'A';
  await fetch(`${base}/api/ujian/answer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: login.sessionId, questionId: pg.id, chosenOption: wrong })
  });
  const scoreOf = async () => (await fetch(`${base}/api/guru/exams/${exam.id}/scores`, { headers: auth }).then(r => r.json()))
    .scores.find(s => s.student_id === student.id).correct_pg;
  assert.equal(await scoreOf(), 0);

  const res = await put(pg.id, fullPg(pg, { answer_key: wrong }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).answeredCount, 1, 'panel guru diberi tahu ada jawaban siswa');
  assert.equal(await scoreOf(), 1, 'jawaban siswa sekarang benar menurut kunci baru');
});

test('edit soal: jenis PG/esai tidak boleh diganti setelah ada jawaban siswa', async (t) => {
  const { db, base, exam, pg, put } = await setup(t);
  // Belum ada jawaban: boleh diganti
  const ok = await put(pg.id, { number: pg.number, type: 'ESAI', question_text: 'Jelaskan!' });
  assert.equal(ok.status, 200);
  const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(pg.id);
  assert.equal(row.type, 'ESAI');
  assert.equal(row.answer_key, null);
  assert.equal(row.option_a, null);

  // Kembalikan jadi PG lalu siswa menjawab
  assert.equal((await put(pg.id, fullPg(pg))).status, 200);
  const student = db.prepare('SELECT * FROM students LIMIT 1').get();
  const login = await fetch(`${base}/api/ujian/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exam_number: student.exam_number, password: student.password, token: exam.token })
  }).then(r => r.json());
  await fetch(`${base}/api/ujian/answer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: login.sessionId, questionId: pg.id, chosenOption: 'A' })
  });
  const blocked = await put(pg.id, { number: pg.number, type: 'ESAI', question_text: 'Jelaskan!' });
  assert.equal(blocked.status, 409);
  assert.equal(db.prepare('SELECT type FROM questions WHERE id = ?').get(pg.id).type, 'PG');
});

test('edit soal: data tidak lengkap ditolak', async (t) => {
  const { pg, put } = await setup(t);
  assert.equal((await put(pg.id, fullPg(pg, { question_text: '   ' }))).status, 400, 'teks kosong tanpa gambar');
  assert.equal((await put(pg.id, fullPg(pg, { answer_key: 'F' }))).status, 400, 'kunci di luar A-E');
  assert.equal((await put(pg.id, fullPg(pg, { answer_key: 'E', option_e: '' }))).status, 400, 'kunci menunjuk opsi kosong');
  assert.equal((await put(pg.id, fullPg(pg, { number: 0 }))).status, 400, 'nomor soal harus angka positif');
});

test('edit soal: guru mapel lain ditolak, soal tak dikenal 404, tanpa login 401', async (t) => {
  const { db, pg, put } = await setup(t);
  const otherExam = db.prepare("INSERT INTO exams (subject, title, class_target, exam_date, start_time, session_name, token, duration_minutes, is_active) VALUES ('Matematika', 'PAS Matematika', 'XII IPA', '2026-12-01', '07:30', 'Sesi 1', 'MTK123', 90, 0)").run();
  const otherQ = db.prepare("INSERT INTO questions (exam_id, number, type, question_text, option_a, option_b, answer_key) VALUES (?, 1, 'PG', 'Soal MTK', '1', '2', 'A')").run(otherExam.lastInsertRowid);
  const res = await put(otherQ.lastInsertRowid, { number: 1, type: 'PG', question_text: 'Diretas', option_a: '1', answer_key: 'A' });
  assert.equal(res.status, 403);
  assert.equal(db.prepare('SELECT question_text FROM questions WHERE id = ?').get(otherQ.lastInsertRowid).question_text, 'Soal MTK');
  assert.equal((await put(999999, fullPg(pg))).status, 404);
  assert.equal((await put(pg.id, fullPg(pg), { 'Content-Type': 'application/json' })).status, 401);
});

test('panel guru: tombol Edit soal dan Pratinjau ujian; ujian.html punya mode pratinjau yang tidak mengirim data siswa', () => {
  const guru = fs.readFileSync(path.join(__dirname, '..', 'public', 'guru.html'), 'utf8');
  assert.match(guru, /openEditQuestion\(/);
  assert.match(guru, /method: 'PUT'/);
  assert.match(guru, /ujian\.html\?pratinjau=/);
  const ujian = fs.readFileSync(path.join(__dirname, '..', 'public', 'ujian.html'), 'utf8');
  assert.match(ujian, /const PREVIEW_EXAM_ID/);
  assert.match(ujian, /\/api\/guru\/exams\/\$\{PREVIEW_EXAM_ID\}\/questions/);
  // Di mode pratinjau, panggilan /api/ujian/* tidak dikirim ke server
  assert.match(ujian, /if \(PREVIEW_EXAM_ID && typeof url === 'string' && url\.startsWith\('\/api\/ujian\/'\)\)/);
});

test('edit soal: kunci boleh opsi bergambar tanpa teks, gambar opsi tetap tersimpan', async (t) => {
  const { db, pg, put } = await setup(t);
  const imgs = JSON.stringify({ C: 'data:image/png;base64,QUJD' });
  db.prepare("UPDATE questions SET option_c = '', option_images = ? WHERE id = ?").run(imgs, pg.id);
  const res = await put(pg.id, fullPg(pg, { option_c: '', answer_key: 'C', question_text: 'Teks baru' }));
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.deepEqual(body.question.option_images, { C: 'data:image/png;base64,QUJD' });
  assert.equal(db.prepare('SELECT option_images FROM questions WHERE id = ?').get(pg.id).option_images, imgs);
});
