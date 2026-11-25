const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');
require('./helpers/studentSessionFetch');

async function setup(t) {
  const db = initDb(':memory:');
  const app = createApp(db, { enforceDefaultPasswordChange: false });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = (username, password, role) => fetch(`${base}/api/staff/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, role })
  }).then(r => r.json()).then(j => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${j.staffToken}` }));
  const op = await login('operator', 'admin123', 'operator');
  const guru = await login('guru', 'guru123', 'guru');
  const post = (url, headers, body) => fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  const flag = (id) => db.prepare('SELECT is_scheduled, is_active FROM exams WHERE id = ?').get(id);
  return { db, base, op, guru, post, flag };
}

test('bank soal buatan guru belum terjadwal; operator menjadwalkan dari bank soal itu', async (t) => {
  const { op, guru, post, flag } = await setup(t);
  const bank = await post('/api/guru/exams', guru, { subject: 'Kimia', title: 'PAS Kimia', class_target: 'X 1' }).then(r => r.json());
  assert.deepEqual(flag(bank.id), { is_scheduled: 0, is_active: 0 });

  const res = await post('/api/operator/exams', op, { exam_id: bank.id, subject: 'Kimia', title: 'PAS Kimia', class_target: 'X 1', exam_date: '2026-12-01', session_name: 'Sesi 1' });
  assert.equal(res.status, 200);
  assert.equal(flag(bank.id).is_scheduled, 1);
});

test('jadwal baru tanpa bank soal dan aktivasi paket menandai terjadwal', async (t) => {
  const { db, op, guru, post, flag } = await setup(t);
  const created = await post('/api/operator/exams', op, { subject: 'Biologi', title: 'PAS Biologi', class_target: 'X 2' }).then(r => r.json());
  assert.equal(flag(created.id).is_scheduled, 1);

  const bank = await post('/api/guru/exams', guru, { subject: 'Kimia', title: 'UH Kimia', class_target: 'X 3' }).then(r => r.json());
  await post(`/api/operator/exams/${bank.id}/activate`, op);
  assert.deepEqual(flag(bank.id), { is_scheduled: 1, is_active: 1 });
  assert.ok(db.prepare('SELECT COUNT(*) c FROM exams').get().c >= 3);
});

test('batalkan jadwal: paket kembali ke bank soal (soal tetap), ditolak bila ada siswa yang belum selesai', async (t) => {
  const { db, op, post, flag, base } = await setup(t);
  const exam = db.prepare('SELECT * FROM exams WHERE is_active = 1 LIMIT 1').get();
  const qBefore = db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(exam.id).c;
  assert.equal(flag(exam.id).is_scheduled, 1, 'ujian contoh yang aktif dianggap terjadwal');

  // Siswa sedang mengerjakan -> ditolak
  const student = db.prepare('SELECT * FROM students LIMIT 1').get();
  await fetch(`${base}/api/ujian/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exam_number: student.exam_number, password: student.password, token: exam.token })
  });
  const blocked = await post(`/api/operator/exams/${exam.id}/unschedule`, op);
  assert.equal(blocked.status, 409);
  assert.equal(flag(exam.id).is_scheduled, 1);

  db.prepare("UPDATE exam_sessions SET status = 'FINISHED' WHERE exam_id = ?").run(exam.id);
  const ok = await post(`/api/operator/exams/${exam.id}/unschedule`, op);
  assert.equal(ok.status, 200);
  assert.deepEqual(flag(exam.id), { is_scheduled: 0, is_active: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id = ?').get(exam.id).c, qBefore, 'soal tidak ikut terhapus');

  assert.equal((await post('/api/operator/exams/999999/unschedule', op)).status, 404);
});

test('guru tidak bisa membatalkan jadwal', async (t) => {
  const { db, guru, post } = await setup(t);
  const exam = db.prepare('SELECT * FROM exams WHERE is_active = 1 LIMIT 1').get();
  assert.equal((await post(`/api/operator/exams/${exam.id}/unschedule`, guru)).status, 403);
});

test('migrasi database lama: paket aktif atau yang sudah punya sesi siswa dianggap terjadwal', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cbt-jadwal-')), 'lama.db');
  const first = initDb(file);
  const ex = (title, active) => Number(first.prepare(`INSERT INTO exams (title, subject, class_target, exam_date, start_time, session_name, token, is_active)
    VALUES (?, 'Kimia', 'X 1', '2026-11-01', '08:00', 'Sesi 1', 'ABCDE', ?)`).run(title, active).lastInsertRowid);
  const aktif = ex('aktif', 1);
  const pernahDipakai = ex('pernah dipakai', 0);
  const bankSaja = ex('bank saja', 0);
  const st = first.prepare('SELECT id FROM students LIMIT 1').get();
  first.prepare("INSERT INTO exam_sessions (student_id, exam_id, status, started_at) VALUES (?, ?, 'FINISHED', '2026-11-01T08:00:00Z')").run(st.id, pernahDipakai);
  first.close();

  // Simulasikan database versi lama: kolom is_scheduled belum ada
  const raw = new Database(file);
  raw.exec('ALTER TABLE exams DROP COLUMN is_scheduled');
  raw.close();

  const db = initDb(file);
  const f = (id) => db.prepare('SELECT is_scheduled FROM exams WHERE id = ?').get(id).is_scheduled;
  assert.equal(f(aktif), 1);
  assert.equal(f(pernahDipakai), 1);
  assert.equal(f(bankSaja), 0);
  db.close();
});

test('panel operator: daftar jadwal hanya paket terjadwal; Jadwalkan & Hapus paket ada di Bank soal masuk', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'operator.html'), 'utf8');
  const renderJadwal = html.slice(html.indexOf('// Render tabel jadwal ujian'), html.indexOf("getElementById('banksTableBody').innerHTML"));
  assert.match(renderJadwal, /\.filter\(e => e\.is_scheduled\)/);
  assert.match(renderJadwal, /unscheduleExam\(/);
  assert.doesNotMatch(renderJadwal, /confirmDeleteExam\(/, 'hapus paket (beserta soal) tidak ada di daftar jadwal');
  const renderBanks = html.slice(html.indexOf("getElementById('banksTableBody').innerHTML"));
  assert.match(renderBanks, /scheduleBank\(/);
  assert.match(renderBanks, /confirmDeleteExam\(/);
});

test('batalkan jadwal saat masih ada siswa: daftar siswa ditampilkan, lalu bisa diselesaikan paksa', async (t) => {
  const { db, op, post, flag, base } = await setup(t);
  const exam = db.prepare('SELECT * FROM exams WHERE is_active = 1 LIMIT 1').get();
  const [s1, s2] = db.prepare('SELECT * FROM students LIMIT 2').all();
  const login = (st) => fetch(`${base}/api/ujian/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exam_number: st.exam_number, password: st.password, token: exam.token })
  }).then(r => r.json());
  const a = await login(s1);
  // Jawaban siswa 1 yang sudah tersimpan
  const pg = db.prepare("SELECT * FROM questions WHERE exam_id = ? AND type = 'PG' ORDER BY number LIMIT 1").get(exam.id);
  const saved = await fetch(`${base}/api/ujian/answer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: a.sessionId, questionId: pg.id, chosenOption: pg.answer_key })
  });
  assert.equal(saved.status, 200);
  await login(s2);
  db.prepare("UPDATE exam_sessions SET status = 'LOCKED' WHERE student_id = ? AND exam_id = ?").run(s2.id, exam.id);

  const blocked = await post(`/api/operator/exams/${exam.id}/unschedule`, op);
  assert.equal(blocked.status, 409);
  const info = await blocked.json();
  assert.equal(info.code, 'UNFINISHED_SESSIONS');
  assert.equal(info.unfinished.length, 2);
  const names = info.unfinished.map(u => u.full_name).sort();
  assert.deepEqual(names, [s1.full_name, s2.full_name].sort());
  assert.ok(info.unfinished.every(u => u.class_name && u.status), 'kelas & status siswa ikut dikirim');

  const forced = await post(`/api/operator/exams/${exam.id}/unschedule`, op, { finishUnfinished: true });
  assert.equal(forced.status, 200);
  assert.equal((await forced.json()).finishedSessions, 2);
  assert.deepEqual(flag(exam.id), { is_scheduled: 0, is_active: 0 });
  const rows = db.prepare('SELECT status, finished_at FROM exam_sessions WHERE exam_id = ?').all(exam.id);
  assert.ok(rows.every(r => r.status === 'FINISHED' && r.finished_at), 'semua sesi ditutup sebagai selesai');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM answers WHERE session_id = ?').get(a.sessionId).c, 1, 'jawaban tetap tersimpan untuk dinilai');
});

test('panel operator: penolakan batalkan jadwal menampilkan daftar siswa dan tombol selesaikan', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'operator.html'), 'utf8');
  const fn = html.slice(html.indexOf('async function unscheduleExam'), html.indexOf('function scheduleBank'));
  assert.match(fn, /UNFINISHED_SESSIONS/);
  assert.match(fn, /finishUnfinished: true/);
});

test('kartu token operator kosong bila belum ada ujian aktif (tidak mengambil bank soal terbaru)', async (t) => {
  const { db, op, guru, post, base } = await setup(t);
  db.prepare('UPDATE exams SET is_active = 0').run();
  await post('/api/guru/exams', guru, { subject: 'Kimia', title: 'Bank baru', class_target: 'XII F 1' });
  const overview = () => fetch(`${base}/api/operator/overview`, { headers: op }).then(r => r.json());
  let data = await overview();
  assert.equal(data.activeExam, null, 'tidak ada token yang berjalan tanpa ujian aktif');
  assert.deepEqual(data.activeExams, []);

  const exam = db.prepare('SELECT id FROM exams ORDER BY id LIMIT 1').get();
  await post(`/api/operator/exams/${exam.id}/activate`, op);
  data = await overview();
  assert.equal(data.activeExam.id, exam.id);
  assert.equal(data.activeExams.length, 1);
});

test('panel operator: kartu token menampilkan "belum ada ujian aktif" dan tombol acak dinonaktifkan', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'operator.html'), 'utf8');
  assert.match(html, /id="btnRefreshToken"/);
  assert.match(html, /Belum ada ujian aktif/);
  assert.match(html, /getElementById\('btnRefreshToken'\)\.disabled = !data\.activeExam/);
});

test('menjadwalkan tidak langsung mengaktifkan: banyak mapel untuk kelas yang sama tetap terjadwal semua', async (t) => {
  const { db, op, post, flag } = await setup(t);
  db.prepare('UPDATE exams SET is_active = 0').run();
  const ids = [];
  for (const subject of ['Kimia', 'Fisika', 'Biologi', 'Matematika', 'Sejarah']) {
    const r = await post('/api/operator/exams', op, { subject, title: `ASAS ${subject}`, class_target: 'X E 1', exam_date: '2026-12-01' }).then(r => r.json());
    ids.push(r.id);
  }
  for (const id of ids) assert.deepEqual(flag(id), { is_scheduled: 1, is_active: 0 }, 'jadwal tersimpan tanpa aktif');

  // Hari ujian: operator menekan Aktifkan -> hanya ujian kelas itu yang bentrok yang berhenti, jadwal lain tetap ada
  await post(`/api/operator/exams/${ids[0]}/activate`, op);
  await post(`/api/operator/exams/${ids[1]}/activate`, op);
  assert.deepEqual(flag(ids[0]), { is_scheduled: 1, is_active: 0 });
  assert.deepEqual(flag(ids[1]), { is_scheduled: 1, is_active: 1 });
  for (const id of ids.slice(2)) assert.equal(flag(id).is_scheduled, 1);
});

test('menjadwalkan ulang paket yang sedang aktif tidak mengganti tokennya', async (t) => {
  const { db, op, post, flag } = await setup(t);
  const exam = db.prepare('SELECT * FROM exams WHERE is_active = 1 LIMIT 1').get();
  await post('/api/operator/exams', op, { exam_id: exam.id, subject: exam.subject, session_name: 'Sesi 2' });
  assert.equal(flag(exam.id).is_active, 1, 'ujian yang sedang berjalan tidak dimatikan');
  assert.equal(db.prepare('SELECT token FROM exams WHERE id = ?').get(exam.id).token, exam.token);
});

test('panel operator: jadwal yang belum aktif tidak menampilkan token dan berstatus Terjadwal', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'operator.html'), 'utf8');
  const renderJadwal = html.slice(html.indexOf('// Render tabel jadwal ujian'), html.indexOf("getElementById('banksTableBody').innerHTML"));
  assert.match(renderJadwal, /e\.is_active \? `<span class="tag-mono">\$\{esc\(e\.token\)\}<\/span>` : /);
  assert.match(renderJadwal, />Terjadwal</);
  assert.match(html, /Jadwal tersimpan/);
});

test('aktifkan sekaligus per tanggal + sesi: semua jadwal sesi itu aktif, sesi lain tetap terjadwal', async (t) => {
  const { db, op, post, flag } = await setup(t);
  db.prepare('UPDATE exams SET is_active = 0').run();
  const make = (subject, cls, date, sesi) => post('/api/operator/exams', op, { subject, title: `ASAS ${subject}`, class_target: cls, exam_date: date, session_name: sesi }).then(r => r.json()).then(j => j.id);
  const kimia1 = await make('Kimia', 'X E 1', '2026-12-07', 'Sesi 1');
  const fisika2 = await make('Fisika', 'X E 2', '2026-12-07', 'Sesi 1');
  const bio1 = await make('Biologi', 'X E 1', '2026-12-07', 'Sesi 2');
  const selasa = await make('Sejarah', 'X E 1', '2026-12-08', 'Sesi 1');

  const r1 = await post('/api/operator/exams/activate-session', op, { exam_date: '2026-12-07', session_name: 'Sesi 1' });
  assert.equal(r1.status, 200);
  assert.deepEqual((await r1.json()).activated.sort(), [kimia1, fisika2].sort());
  assert.equal(flag(kimia1).is_active, 1);
  assert.equal(flag(fisika2).is_active, 1);
  assert.equal(flag(bio1).is_active, 0);
  assert.equal(flag(selasa).is_active, 0);
  const tokens = db.prepare('SELECT token FROM exams WHERE id IN (?, ?)').all(kimia1, fisika2);
  assert.ok(tokens.every(x => /^[A-Z0-9]{5}$/.test(x.token)), 'setiap jadwal punya token');

  // Sesi 2: Biologi X E 1 aktif, Kimia X E 1 (sesi 1) berhenti, Fisika X E 2 tidak terganggu
  await post('/api/operator/exams/activate-session', op, { exam_date: '2026-12-07', session_name: 'Sesi 2' });
  assert.equal(flag(bio1).is_active, 1);
  assert.equal(flag(kimia1).is_active, 0);
  assert.equal(flag(kimia1).is_scheduled, 1);
  assert.equal(flag(fisika2).is_active, 1);
});

test('aktifkan sekaligus ditolak bila dua jadwal di sesi yang sama untuk kelas yang sama', async (t) => {
  const { db, op, post, flag } = await setup(t);
  db.prepare('UPDATE exams SET is_active = 0').run();
  const a = await post('/api/operator/exams', op, { subject: 'Kimia', title: 'A', class_target: 'X E 1', exam_date: '2026-12-07', session_name: 'Sesi 1' }).then(r => r.json());
  const b = await post('/api/operator/exams', op, { subject: 'Fisika', title: 'B', class_target: 'X E 1, X E 2', exam_date: '2026-12-07', session_name: 'Sesi 1' }).then(r => r.json());
  const r = await post('/api/operator/exams/activate-session', op, { exam_date: '2026-12-07', session_name: 'Sesi 1' });
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.code, 'CLASS_CONFLICT');
  assert.match(body.error, /Kimia/);
  assert.match(body.error, /Fisika/);
  assert.equal(flag(a.id).is_active, 0);
  assert.equal(flag(b.id).is_active, 0);
  assert.equal((await post('/api/operator/exams/activate-session', op, { exam_date: '2030-01-01', session_name: 'Sesi 9' })).status, 404);
});

test('panel operator: daftar jadwal dikelompokkan per tanggal & sesi, tombol aktifkan semua di kepala kelompok', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'operator.html'), 'utf8');
  assert.doesNotMatch(html, /id="sessionActivateBar"/, 'kotak sesi terpisah di atas tabel tidak dipakai lagi');
  const renderJadwal = html.slice(html.indexOf('// Render tabel jadwal ujian'), html.indexOf("getElementById('banksTableBody').innerHTML"));
  assert.match(renderJadwal, /groupSchedulesBySession\(/);
  assert.match(renderJadwal, /class="session-group-row"/);
  assert.match(renderJadwal, /activateSession\(/);
  // Pencarian: kepala kelompok ikut tersembunyi bila tidak ada jadwal yang cocok
  assert.match(html, /tr\.session-group-row/);
  assert.match(html, /async function activateSession\(/);
  assert.match(html, /\/api\/operator\/exams\/activate-session/);
});

test('aktifkan sekaligus tidak mengganti token jadwal yang sudah aktif', async (t) => {
  const { db, op, post } = await setup(t);
  db.prepare('UPDATE exams SET is_active = 0').run();
  const a = await post('/api/operator/exams', op, { subject: 'Kimia', title: 'A', class_target: 'X E 1', exam_date: '2026-12-07', session_name: 'Sesi 1' }).then(r => r.json());
  await post(`/api/operator/exams/${a.id}/activate`, op);
  const before = db.prepare('SELECT token FROM exams WHERE id = ?').get(a.id).token;
  await post('/api/operator/exams', op, { subject: 'Fisika', title: 'B', class_target: 'X E 2', exam_date: '2026-12-07', session_name: 'Sesi 1' });
  assert.equal((await post('/api/operator/exams/activate-session', op, { exam_date: '2026-12-07', session_name: 'Sesi 1' })).status, 200);
  assert.equal(db.prepare('SELECT token FROM exams WHERE id = ?').get(a.id).token, before);
});

test('kartu token: beberapa ujian aktif tampil sebagai daftar ringkas per mapel, bukan token besar digabung "/"', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'operator.html'), 'utf8');
  assert.doesNotMatch(html, /statToken'\)\.textContent = actives\.map\(e => e\.token\)\.join\(' \/ '\)/);
  assert.match(html, /class="token-item"/);
  assert.match(html, /classList\.toggle\('token-list', multi\)/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'theme.css'), 'utf8');
  assert.match(css, /\.token-value\.token-list/);
  assert.match(css, /\.token-item-code/);
});
