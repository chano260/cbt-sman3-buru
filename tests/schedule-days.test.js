// Jadwal & sesi ujian: satu blok per tanggal berisi semua sesinya. Tanggal yang sudah lewat
// disembunyikan (bisa dibuka) dan ujiannya dinonaktifkan otomatis saat tanggal berganti.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { schoolToday, deactivatePastExams } = require('../src/schoolDate');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');

test('tanggal sekolah memakai zona waktu WIT, bukan UTC', () => {
  // 16:00 UTC tanggal 6 = 01:00 WIT tanggal 7
  assert.equal(schoolToday(new Date('2026-12-06T16:00:00Z')), '2026-12-07');
  assert.equal(schoolToday(new Date('2026-12-06T14:00:00Z')), '2026-12-06');
});

test('ujian tanggal lewat dimatikan; hari ini dan yang akan datang tetap', () => {
  const db = initDb(':memory:');
  const ins = db.prepare("INSERT INTO exams (title, subject, class_target, exam_date, start_time, session_name, duration_minutes, token, is_active, is_scheduled) VALUES (?, ?, 'XII IPA 1', ?, '08:00', 'Sesi 1', 90, ?, 1, 1)");
  const past = ins.run('A', 'Fisika', '2026-12-06', 'TKA01').lastInsertRowid;
  const today = ins.run('B', 'Kimia', '2026-12-07', 'TKA02').lastInsertRowid;
  const future = ins.run('C', 'Biologi', '2026-12-08', 'TKA03').lastInsertRowid;
  const noDate = ins.run('D', 'Sejarah', '', 'TKA04').lastInsertRowid;
  const expected = db.prepare("SELECT COUNT(*) c FROM exams WHERE is_active = 1 AND exam_date != '' AND exam_date < '2026-12-07'").get().c;
  assert.equal(deactivatePastExams(db, '2026-12-07'), expected);
  const active = (id) => db.prepare('SELECT is_active FROM exams WHERE id = ?').get(id).is_active;
  assert.equal(active(past), 0);
  assert.equal(active(today), 1);
  assert.equal(active(future), 1);
  assert.equal(active(noDate), 1, 'jadwal tanpa tanggal tidak disentuh');
});

async function setup(t) {
  const db = initDb(':memory:');
  const app = createApp(db, { enforceDefaultPasswordChange: false });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/staff/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 'admin123', role: 'operator' })
  }).then(r => r.json());
  const op = { Authorization: `Bearer ${login.staffToken}` };
  return { db, base, op };
}

test('data contoh: ujian aktif bertanggal hari ini (tidak langsung mati)', async (t) => {
  const { db } = await setup(t);
  const active = db.prepare('SELECT * FROM exams WHERE is_active = 1').all();
  assert.ok(active.length >= 1);
  assert.ok(active.every(e => e.exam_date === schoolToday()));
});

test('Pantauan operator mematikan ujian tanggal lewat dan mengirim tanggal hari ini', async (t) => {
  const { db, base, op } = await setup(t);
  const exam = db.prepare('SELECT * FROM exams WHERE is_active = 1 LIMIT 1').get();
  db.prepare("UPDATE exams SET exam_date = '2020-01-01' WHERE id = ?").run(exam.id);
  const data = await fetch(`${base}/api/operator/overview`, { headers: op }).then(r => r.json());
  assert.equal(data.today, schoolToday());
  assert.equal(db.prepare('SELECT is_active FROM exams WHERE id = ?').get(exam.id).is_active, 0);
  assert.equal(data.exams.find(e => e.id === exam.id).is_active, 0);
});

test('siswa tidak bisa masuk ke ujian yang tanggalnya sudah lewat', async (t) => {
  const { db, base } = await setup(t);
  const exam = db.prepare('SELECT * FROM exams WHERE is_active = 1 LIMIT 1').get();
  db.prepare("UPDATE exams SET exam_date = '2020-01-01' WHERE id = ?").run(exam.id);
  const student = db.prepare('SELECT * FROM students WHERE class_name = ? LIMIT 1').get(exam.class_target);
  const res = await fetch(`${base}/api/ujian/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exam_number: student.exam_number, password: student.password, token: exam.token })
  });
  assert.equal(res.status, 404);
  assert.equal(db.prepare('SELECT is_active FROM exams WHERE id = ?').get(exam.id).is_active, 0);
});

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'operator.html'), 'utf8');

function loadGrouping() {
  const a = html.indexOf('function groupSchedulesBySession(');
  const b = html.indexOf('function groupSchedulesByDate(');
  const end = html.indexOf('\n    }\n', b) + 6;
  assert.ok(a > 0 && b > 0, 'kedua fungsi pengelompokan ada');
  return new Function(`${html.slice(a, html.indexOf('\n    }\n', a) + 6)}\n${html.slice(b, end)}; return { groupSchedulesBySession, groupSchedulesByDate };`)();
}

test('pengelompokan: satu tanggal berisi semua sesinya, tanggal lewat dipisah', () => {
  const { groupSchedulesBySession, groupSchedulesByDate } = loadGrouping();
  const e = (id, date, session, active = 0) => ({ id, exam_date: date, session_name: session, is_active: active, subject: `M${id}` });
  const groups = groupSchedulesBySession([
    e(1, '2026-12-07', 'Sesi 2'), e(2, '2026-12-07', 'Sesi 1', 1), e(3, '2026-12-07', 'Sesi 3'),
    e(4, '2026-12-08', 'Sesi 1'), e(5, '2026-12-05', 'Sesi 1'), e(6, '2026-12-04', 'Sesi 2')
  ]);
  const { upcoming, past } = groupSchedulesByDate(groups, '2026-12-07');
  assert.deepEqual(upcoming.map(d => d.date), ['2026-12-07', '2026-12-08']);
  assert.deepEqual(upcoming[0].sessions.map(s => s.session), ['Sesi 1', 'Sesi 2', 'Sesi 3']);
  assert.equal(upcoming[0].total, 3);
  assert.equal(upcoming[0].active, 1);
  assert.equal(upcoming[0].isToday, true);
  assert.deepEqual(past.map(d => d.date), ['2026-12-05', '2026-12-04'], 'tanggal lewat: terbaru dulu');
});

test('tampilan: blok per tanggal dan bagian tanggal sebelumnya tertutup', () => {
  assert.match(html, /class="day-block/);
  assert.match(html, /<details class="past-days"/);
  assert.match(html, /Tanggal sebelumnya/);
  assert.match(html, /groupSchedulesByDate\(scheduleGroups, data\.today/);
});
