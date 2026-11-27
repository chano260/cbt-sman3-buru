// Sebagian siswa ujian lewat SMANTRI CBT (Google Form), jadi tidak pernah login di aplikasi ini.
// Rekap nilai guru dan Pantauan langsung operator hanya memuat siswa yang sudah login,
// dan Pantauan menampilkan statistik login per sesi (donat).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');

async function setup(t) {
  const db = initDb(':memory:');
  db.prepare('UPDATE exams SET is_active = 0, is_scheduled = 0').run();
  const app = createApp(db, { enforceDefaultPasswordChange: false });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/staff/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 'admin123', role: 'operator' })
  }).then(r => r.json());
  const op = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.staffToken}` };
  const get = (url) => fetch(base + url, { headers: op });
  const schedule = (subject, cls, session_name, exam_date = '2026-12-07') => fetch(`${base}/api/operator/exams`, {
    method: 'POST', headers: op,
    body: JSON.stringify({ subject, title: `ASAS ${subject}`, class_target: cls, exam_date, session_name })
  }).then(r => r.json()).then(j => j.id);
  const startSession = (examId, studentId, status) => db.prepare(`
    INSERT INTO exam_sessions (exam_id, student_id, status, current_question_number, last_activity_at, violation_count, started_at)
    VALUES (?, ?, ?, 1, datetime('now'), 0, datetime('now'))`).run(examId, studentId, status);
  const classStudents = (cls) => db.prepare('SELECT * FROM students WHERE class_name = ? ORDER BY id').all(cls);
  return { db, base, op, get, schedule, startSession, classStudents };
}

test('rekap nilai guru & ekspor Excel hanya memuat siswa yang sudah login', async (t) => {
  const { get, schedule, startSession, classStudents } = await setup(t);
  const ipa1 = classStudents('XII IPA 1');
  assert.ok(ipa1.length >= 3, 'data contoh punya minimal 3 siswa XII IPA 1');
  const mtk = await schedule('Matematika', 'XII IPA 1', 'Sesi 1');
  startSession(mtk, ipa1[0].id, 'FINISHED');
  startSession(mtk, ipa1[1].id, 'WORKING');

  const data = await get(`/api/guru/exams/${mtk}/scores`).then(r => r.json());
  assert.deepEqual(data.scores.map(s => s.student_id).sort(), [ipa1[0].id, ipa1[1].id].sort());
  assert.ok(data.scores.every(s => s.status !== 'NOT_STARTED'));

  const xlsx = Buffer.from(await get(`/api/guru/exams/${mtk}/export-excel`).then(r => r.arrayBuffer()));
  const rows = XLSX.utils.sheet_to_json(XLSX.read(xlsx).Sheets[XLSX.read(xlsx).SheetNames[0]]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r['Status Ujian'] !== 'Belum Login'));
});

test('Pantauan langsung operator hanya memuat siswa yang sudah login (semua ujian & per ujian)', async (t) => {
  const { get, schedule, startSession, classStudents } = await setup(t);
  const ipa1 = classStudents('XII IPA 1');
  const mtk = await schedule('Matematika', 'XII IPA 1', 'Sesi 1');
  startSession(mtk, ipa1[0].id, 'LOCKED');

  const all = await get('/api/operator/overview').then(r => r.json());
  assert.deepEqual(all.monitoring.map(m => m.student_id), [ipa1[0].id]);
  assert.ok(all.students.length > 1, 'data siswa (tab Siswa) tetap lengkap');

  const one = await get(`/api/operator/overview?exam_id=${mtk}`).then(r => r.json());
  assert.deepEqual(one.monitoring.map(m => m.student_id), [ipa1[0].id]);
});

test('statistik login per sesi: sudah login dari jumlah peserta, dirinci status & mapel', async (t) => {
  const { get, schedule, startSession, classStudents } = await setup(t);
  const ipa1 = classStudents('XII IPA 1');
  const ipa2 = classStudents('XII IPA 2');
  assert.ok(ipa2.length >= 1, 'data contoh punya siswa XII IPA 2');
  const mtk = await schedule('Matematika', 'XII IPA 1', 'Sesi 1');
  const eko = await schedule('Ekonomi', 'XII IPA 2', 'Sesi 1');
  const fis = await schedule('Fisika', 'XII IPA 1', 'Sesi 2');
  await schedule('Sejarah', 'XII IPA 1', 'Sesi 1', '2026-12-08');
  startSession(mtk, ipa1[0].id, 'WORKING');
  startSession(mtk, ipa1[1].id, 'FINISHED');
  startSession(eko, ipa2[0].id, 'LOCKED');
  startSession(fis, ipa1[0].id, 'FINISHED');

  const stats = (await get('/api/operator/overview?stats_date=2026-12-07').then(r => r.json())).loginStats;
  assert.equal(stats.date, '2026-12-07');
  assert.deepEqual(stats.dates, ['2026-12-07', '2026-12-08']);
  assert.deepEqual(stats.sessions.map(s => s.session_name), ['Sesi 1', 'Sesi 2']);

  const s1 = stats.sessions[0];
  assert.equal(s1.total, ipa1.length + ipa2.length);
  assert.equal(s1.logged_in, 3);
  assert.equal(s1.working, 1);
  assert.equal(s1.finished, 1);
  assert.equal(s1.locked, 1);
  assert.deepEqual(s1.exams.map(e => [e.subject, e.logged_in, e.total]), [
    ['Ekonomi', 1, ipa2.length],
    ['Matematika', 2, ipa1.length]
  ]);

  const s2 = stats.sessions[1];
  assert.equal(s2.total, ipa1.length);
  assert.equal(s2.logged_in, 1);
  assert.equal(s2.finished, 1);
});

test('statistik login: tanpa stats_date memakai tanggal ujian yang aktif', async (t) => {
  const { db, get, schedule } = await setup(t);
  await schedule('Matematika', 'XII IPA 1', 'Sesi 1', '2026-12-07');
  const sej = await schedule('Sejarah', 'XII IPA 1', 'Sesi 1', '2026-12-08');
  db.prepare('UPDATE exams SET is_active = 1 WHERE id = ?').run(sej);
  const stats = (await get('/api/operator/overview').then(r => r.json())).loginStats;
  assert.equal(stats.date, '2026-12-08');
});

const operatorHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'operator.html'), 'utf8');
const guruHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'guru.html'), 'utf8');

test('Pantauan punya donat login per sesi dengan pilihan tanggal', () => {
  assert.match(operatorHtml, /id="loginStatsGrid"/);
  assert.match(operatorHtml, /id="loginStatsDate"/);
  assert.match(operatorHtml, /function renderLoginStats\(/);
  assert.match(operatorHtml, /function loginDonutSvg\(/);
  assert.match(operatorHtml, /params\.set\('stats_date'/, 'tanggal yang dipilih dikirim ke overview');
});

test('tabel kosong memberi tahu bahwa belum ada siswa yang login', () => {
  assert.match(operatorHtml, /Belum ada siswa yang login/);
  assert.match(guruHtml, /Belum ada siswa yang login/);
});
