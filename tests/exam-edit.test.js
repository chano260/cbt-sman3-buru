const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');

async function setup(t) {
  const db = initDb(':memory:');
  const app = createApp(db, { enforceDefaultPasswordChange: false });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const guru = await fetch(`${base}/api/staff/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'guru', password: 'guru123', role: 'guru' })
  }).then(r => r.json());
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${guru.staffToken}` };
  const put = (id, body, headers = auth) => fetch(`${base}/api/guru/exams/${id}`, { method: 'PUT', headers, body: JSON.stringify(body) });
  const exam = db.prepare('SELECT * FROM exams WHERE is_active = 1 LIMIT 1').get();
  return { db, base, auth, put, exam };
}

function insertExam(db, { subject = 'Kimia', classTarget, active = 0 }) {
  return Number(db.prepare(`INSERT INTO exams (subject, title, class_target, exam_date, start_time, session_name, token, duration_minutes, is_active)
    VALUES (?, 'Paket lain', ?, '2026-12-01', '07:30', 'Sesi 1', 'TKN123', 90, ?)`).run(subject, classTarget, active).lastInsertRowid);
}

test('ubah paket: guru mengganti kelas, nama paket, dan durasi; mapel dan token tidak berubah', async (t) => {
  const { db, put, exam } = await setup(t);
  const res = await put(exam.id, { title: 'PAS Ganjil Kimia', class_target: 'XII IPA 1, XII IPA 2', duration_minutes: 120 });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT * FROM exams WHERE id = ?').get(exam.id);
  assert.equal(row.class_target, 'XII IPA 1, XII IPA 2');
  assert.equal(row.title, 'PAS Ganjil Kimia');
  assert.equal(row.duration_minutes, 120);
  assert.equal(row.subject, exam.subject);
  assert.equal(row.token, exam.token);
  assert.equal(row.is_active, exam.is_active);
});

test('ubah paket: kelas kosong menjadi Semua Kelas; nama kosong dan durasi tidak wajar ditolak', async (t) => {
  const { db, put, exam } = await setup(t);
  assert.equal((await put(exam.id, { title: exam.title, class_target: '  ', duration_minutes: 90 })).status, 200);
  assert.equal(db.prepare('SELECT class_target FROM exams WHERE id = ?').get(exam.id).class_target, 'Semua Kelas');
  assert.equal((await put(exam.id, { title: '  ', class_target: 'X 1', duration_minutes: 90 })).status, 400);
  assert.equal((await put(exam.id, { title: 'A', class_target: 'X 1', duration_minutes: 0 })).status, 400);
  assert.equal((await put(exam.id, { title: 'A', class_target: 'X 1', duration_minutes: 601 })).status, 400);
});

test('ubah paket: ujian aktif tidak boleh dipindah ke kelas yang sedang memakai ujian aktif lain', async (t) => {
  const { db, put } = await setup(t);
  db.prepare('UPDATE exams SET is_active = 0').run();
  const a = insertExam(db, { classTarget: 'X 1', active: 1 });
  insertExam(db, { classTarget: 'X 2', active: 1 });
  const res = await put(a, { title: 'Paket lain', class_target: 'X 1, X 2', duration_minutes: 90 });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /X 2|aktif/);
  assert.equal(db.prepare('SELECT class_target FROM exams WHERE id = ?').get(a).class_target, 'X 1');
  // Paket yang belum aktif bebas diubah (bentrok diurus operator saat mengaktifkan)
  const b = insertExam(db, { classTarget: 'X 3', active: 0 });
  assert.equal((await put(b, { title: 'Paket lain', class_target: 'X 2', duration_minutes: 90 })).status, 200);
});

test('ubah paket: guru mapel lain 403, paket tak dikenal 404, tanpa login 401', async (t) => {
  const { db, put, exam } = await setup(t);
  const mtk = insertExam(db, { subject: 'Matematika', classTarget: 'X 1' });
  assert.equal((await put(mtk, { title: 'Diretas', class_target: 'X 9', duration_minutes: 90 })).status, 403);
  assert.equal(db.prepare('SELECT class_target FROM exams WHERE id = ?').get(mtk).class_target, 'X 1');
  assert.equal((await put(999999, { title: 'A', class_target: 'X 1', duration_minutes: 90 })).status, 404);
  assert.equal((await put(exam.id, { title: 'A', class_target: 'X 1', duration_minutes: 90 }, { 'Content-Type': 'application/json' })).status, 401);
});

test('panel guru: tombol Ubah paket memakai PUT /api/guru/exams/:id', () => {
  const guru = fs.readFileSync(path.join(__dirname, '..', 'public', 'guru.html'), 'utf8');
  assert.match(guru, /openEditBankSoalModal\(\)/);
  assert.match(guru, /fetch\(`\/api\/guru\/exams\/\$\{editingExamId\}`, \{\s*method: 'PUT'/);
});
