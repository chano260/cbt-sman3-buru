// Mapel pilihan: dalam satu kelas sebagian siswa ujian Fisika, sebagian Biologi, di sesi yang sama
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');
require('./helpers/studentSessionFetch');

async function setup(t) {
  const db = initDb(':memory:');
  db.prepare('UPDATE exams SET is_active = 0').run();
  const app = createApp(db, { enforceDefaultPasswordChange: false });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const staff = (username, password, role) => fetch(`${base}/api/staff/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, role })
  }).then(r => r.json()).then(j => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${j.staffToken}` }));
  const op = await staff('operator', 'admin123', 'operator');
  const send = (method, url, headers, body) => fetch(base + url, { method, headers, body: JSON.stringify(body || {}) });
  const post = (url, headers, body) => send('POST', url, headers, body);
  const json = (r) => r.then(x => x.json());
  const schedule = (subject, cls, is_elective, session_name = 'Sesi 1') => json(post('/api/operator/exams', op, {
    subject, title: `ASAS ${subject}`, class_target: cls, exam_date: '2026-12-07', session_name, is_elective
  })).then(j => j.id);
  const studentLogin = (st) => post('/api/ujian/login', { 'Content-Type': 'application/json' }, { exam_number: st.exam_number, password: st.password });
  const active = (id) => db.prepare('SELECT is_active FROM exams WHERE id = ?').get(id).is_active;
  const ipa1 = db.prepare("SELECT * FROM students WHERE class_name = 'XII IPA 1' ORDER BY id").all();
  return { db, base, op, staff, send, post, json, schedule, studentLogin, active, ipa1 };
}

test('mapel pilihan: dua jadwal pilihan untuk kelas yang sama aktif bersamaan, siswa masuk ke mapel pilihannya', async (t) => {
  const { db, op, post, json, schedule, studentLogin, active, ipa1 } = await setup(t);
  const [a, b, c] = ipa1;
  const setEl = db.prepare('UPDATE students SET elective_subjects = ? WHERE id = ?');
  setEl.run('Fisika, Kimia', a.id);
  setEl.run('biologi', b.id);

  const fis = await schedule('Fisika', 'XII IPA 1', true);
  const bio = await schedule('Biologi', 'XII IPA 1', true);
  assert.equal(db.prepare('SELECT is_elective FROM exams WHERE id = ?').get(fis).is_elective, 1);

  const res = await post('/api/operator/exams/activate-session', op, { exam_date: '2026-12-07', session_name: 'Sesi 1' });
  assert.equal(res.status, 200, 'dua mapel pilihan di kelas yang sama tidak dianggap bentrok');
  assert.equal(active(fis), 1);
  assert.equal(active(bio), 1);

  assert.equal((await json(studentLogin(a))).exam.subject, 'Fisika');
  assert.equal((await json(studentLogin(b))).exam.subject, 'Biologi', 'huruf besar-kecil tidak masalah');

  // Siswa tanpa mapel pilihan yang cocok tidak ditebak
  const r = await studentLogin(c);
  assert.equal(r.status, 404);
  assert.match((await r.json()).error, /Mapel pilihan/);
});

test('mapel pilihan vs mapel wajib di kelas yang sama tetap saling menggantikan; aktifkan semua menolak campuran', async (t) => {
  const { op, post, schedule, active } = await setup(t);
  const fis = await schedule('Fisika', 'XII IPA 1', true);
  const bio = await schedule('Biologi', 'XII IPA 1', true);
  await post(`/api/operator/exams/${fis}/activate`, op);
  await post(`/api/operator/exams/${bio}/activate`, op);
  assert.equal(active(fis), 1);
  assert.equal(active(bio), 1);

  const mtk = await schedule('Matematika', 'XII IPA 1', false, 'Sesi 2');
  await post(`/api/operator/exams/${mtk}/activate`, op);
  assert.equal(active(mtk), 1);
  assert.equal(active(fis), 0, 'mapel wajib menghentikan mapel pilihan kelas itu');
  assert.equal(active(bio), 0);

  await post(`/api/operator/exams/${fis}/activate`, op);
  assert.equal(active(mtk), 0, 'mapel pilihan menghentikan mapel wajib kelas itu');

  await schedule('Sejarah', 'XII IPA 1', false);
  const mixed = await post('/api/operator/exams/activate-session', op, { exam_date: '2026-12-07', session_name: 'Sesi 1' });
  assert.equal(mixed.status, 409);
  assert.match((await mixed.json()).error, /Sejarah/);
});

test('pemantauan & nilai mapel pilihan hanya memuat siswa yang mengambil mapel itu', async (t) => {
  const { db, op, staff, base, post, json, schedule, ipa1 } = await setup(t);
  const [a, b] = ipa1;
  db.prepare("UPDATE students SET elective_subjects = 'Fisika' WHERE id = ?").run(a.id);
  db.prepare("UPDATE students SET elective_subjects = 'Biologi' WHERE id = ?").run(b.id);
  const fis = await schedule('Fisika', 'XII IPA 1', true);
  const bio = await schedule('Biologi', 'XII IPA 1', true);
  await post('/api/operator/exams/activate-session', op, { exam_date: '2026-12-07', session_name: 'Sesi 1' });
  // Pantauan hanya memuat siswa yang sudah login: keduanya mulai mengerjakan mapel pilihannya
  const begin = db.prepare(`INSERT INTO exam_sessions (exam_id, student_id, status, current_question_number, last_activity_at, violation_count, started_at)
    VALUES (?, ?, 'WORKING', 1, datetime('now'), 0, datetime('now'))`);
  begin.run(fis, a.id);
  begin.run(bio, b.id);

  const ov = await json(fetch(`${base}/api/operator/overview?exam_id=${fis}`, { headers: op }));
  const ids = ov.monitoring.map(m => m.student_id);
  assert.ok(ids.includes(a.id));
  assert.ok(!ids.includes(b.id), 'siswa Biologi tidak muncul di pantauan Fisika');

  const all = await json(fetch(`${base}/api/operator/overview`, { headers: op }));
  assert.equal(all.monitoring.find(m => m.student_id === b.id).exam_subject, 'Biologi');
  assert.equal(all.monitoring.find(m => m.student_id === a.id).exam_subject, 'Fisika');

  const pw = await staff('pengawas', 'pengawas123', 'pengawas');
  const room = await json(fetch(`${base}/api/pengawas/room`, { headers: pw }));
  const rowB = room.students.find(s => s.student_id === b.id);
  if (rowB) assert.equal(rowB.exam_subject, 'Biologi');
  const rowA = room.students.find(s => s.student_id === a.id);
  if (rowA) assert.equal(rowA.exam_subject, 'Fisika');
  assert.ok(rowA || rowB, 'siswa XII IPA 1 ada di ruang pengawas contoh');
  assert.ok(bio);
});

test('mapel pilihan diisi lewat impor (kolom "Mapel pilihan"); impor ulang tanpa kolom itu tidak menghapusnya', async (t) => {
  const { db, op, base } = await setup(t);
  const upload = async (aoa) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Peserta');
    const fd = new FormData();
    fd.append('file', new Blob([XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })]), 'siswa.xlsx');
    const r = await fetch(`${base}/api/operator/students/import-excel`, { method: 'POST', headers: { Authorization: op.Authorization }, body: fd });
    assert.equal(r.status, 200);
  };
  await upload([
    ['NISN', 'Nama Siswa', 'Kelas', 'Mapel pilihan'],
    ['0090000001', 'Ani Pilihan', 'XII F 1', 'Fisika, Kimia'],
    ['0090000002', 'Budi Pilihan', 'XII F 1', 'Biologi']
  ]);
  const el = (nisn) => db.prepare('SELECT elective_subjects FROM students WHERE nisn = ?').get(nisn).elective_subjects;
  assert.equal(el('0090000001'), 'Fisika, Kimia');
  assert.equal(el('0090000002'), 'Biologi');

  await upload([
    ['NISN', 'Nama Siswa', 'Kelas'],
    ['0090000001', 'Ani Pilihan', 'XII F 1']
  ]);
  assert.equal(el('0090000001'), 'Fisika, Kimia');

  const tpl = await fetch(`${base}/api/operator/template-students-excel`, { headers: op });
  const wb = XLSX.read(Buffer.from(await tpl.arrayBuffer()), { type: 'buffer' });
  const header = XLSX.utils.sheet_to_json(wb.Sheets.Peserta, { header: 1 })[0];
  assert.ok(header.includes('Mapel Pilihan'), 'template memuat kolom Mapel Pilihan');
});

test('operator bisa mengubah mapel pilihan satu siswa', async (t) => {
  const { db, op, send, ipa1 } = await setup(t);
  const st = ipa1[0];
  const r = await send('PUT', `/api/operator/students/${st.id}/electives`, op, { elective_subjects: '  Fisika ,  Biologi ' });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT elective_subjects FROM students WHERE id = ?').get(st.id).elective_subjects, 'Fisika, Biologi');
  assert.equal((await send('PUT', '/api/operator/students/999999/electives', op, { elective_subjects: 'X' })).status, 404);
});

test('panel operator: centang mapel pilihan di jadwal dan tombol mapel pilihan per siswa', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'operator.html'), 'utf8');
  assert.match(html, /id="exElective"/);
  assert.match(html, /is_elective: document\.getElementById\('exElective'\)\.checked/);
  assert.match(html, /async function editElectives\(/);
  assert.match(html, /\/electives`/);
  assert.match(html, /e\.is_elective \?/);
});
