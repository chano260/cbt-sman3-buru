const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');
const { formatBirthInfo } = require('../src/studentImport');

async function setup(t) {
  const db = initDb(':memory:');
  db.exec('DELETE FROM answers; DELETE FROM exam_sessions; DELETE FROM students;');
  const app = createApp(db, { enforceDefaultPasswordChange: false });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const op = await fetch(`${base}/api/staff/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 'admin123', role: 'operator' })
  }).then(r => r.json());
  const auth = { Authorization: `Bearer ${op.staffToken}` };
  const upload = async (aoa, prefix) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Siswa');
    const fd = new FormData();
    fd.append('file', new Blob([XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })]), 'siswa.xlsx');
    if (prefix !== undefined) fd.append('prefix', prefix);
    const res = await fetch(`${base}/api/operator/students/import-excel`, { method: 'POST', headers: auth, body: fd });
    return { status: res.status, body: await res.json() };
  };
  const all = () => db.prepare('SELECT * FROM students ORDER BY exam_number').all();
  return { db, base, auth, upload, all };
}

// Format ekspor Dapodik: beberapa baris judul sebelum header, tanggal lahir berupa tanggal Excel
const DAPODIK = [
  ['Daftar Peserta Didik'],
  ['SMA NEGERI 3 BURU'],
  [],
  ['No', 'Nama', 'NISN', 'Tempat Lahir', 'Tanggal Lahir', 'Rombel Saat Ini'],
  [1, 'Budi Santoso', '0081111111', 'Namlea', new Date(Date.UTC(2008, 0, 14)), 'X E 2'],
  [2, 'Ani Wijaya', '0082222222', 'Waeapo', '2008-03-22', 'X E 1'],
  [3, 'Citra Lestari', '0083333333', 'Namlea', '05/07/2008', 'X E 1'],
  [4, 'Dodi Pratama', '0084444444', 'Ambon', '', 'X E 2']
];

test('impor gaya Dapodik: header setelah baris judul, ruang = kelas, meja urut nama, nomor & password otomatis', async (t) => {
  const { upload, all } = await setup(t);
  const res = await upload(DAPODIK, '26-03-');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.importedCount, 4);
  assert.equal(res.body.createdCount, 4);

  const rows = all();
  // Nomor peserta berurutan per kelas lalu per nama
  assert.deepEqual(rows.map(r => [r.exam_number, r.full_name]), [
    ['26-03-001', 'Ani Wijaya'],
    ['26-03-002', 'Citra Lestari'],
    ['26-03-003', 'Budi Santoso'],
    ['26-03-004', 'Dodi Pratama']
  ]);
  const by = Object.fromEntries(rows.map(r => [r.full_name, r]));
  assert.equal(by['Ani Wijaya'].room, 'X E 1');
  assert.equal(by['Budi Santoso'].room, 'X E 2');
  assert.equal(by['Ani Wijaya'].seat_number, 1);
  assert.equal(by['Citra Lestari'].seat_number, 2);
  assert.equal(by['Budi Santoso'].seat_number, 1);
  assert.equal(by['Dodi Pratama'].seat_number, 2);
  assert.equal(by['Budi Santoso'].birth_info, 'Namlea, 14 Januari 2008');
  assert.equal(by['Ani Wijaya'].birth_info, 'Waeapo, 22 Maret 2008');
  assert.equal(by['Citra Lestari'].birth_info, 'Namlea, 5 Juli 2008');
  assert.equal(by['Dodi Pratama'].birth_info, 'Ambon');
  // Password acak 6 karakter, tanpa huruf/angka yang mudah tertukar, berbeda tiap siswa
  for (const r of rows) assert.match(r.password, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  assert.equal(new Set(rows.map(r => r.password)).size, rows.length);
});

test('impor ulang: dicocokkan lewat NISN, nomor peserta & password lama tetap, siswa baru melanjutkan nomor', async (t) => {
  const { upload, all } = await setup(t);
  await upload(DAPODIK, '26-03-');
  const before = Object.fromEntries(all().map(r => [r.nisn, r]));

  const next = DAPODIK.map(r => r.slice());
  next[4][5] = 'X E 1'; // Budi pindah ke X E 1
  next.push([5, 'Eka Putri', '0085555555', 'Namlea', '2008-12-01', 'X E 2']);
  const res = await upload(next, '26-03-');
  assert.equal(res.status, 200);
  assert.equal(res.body.createdCount, 1);
  assert.equal(res.body.updatedCount, 4);

  const after = Object.fromEntries(all().map(r => [r.nisn, r]));
  assert.equal(Object.keys(after).length, 5, 'tidak ada siswa ganda');
  for (const nisn of Object.keys(before)) {
    assert.equal(after[nisn].exam_number, before[nisn].exam_number);
    assert.equal(after[nisn].password, before[nisn].password);
  }
  assert.equal(after['0081111111'].class_name, 'X E 1');
  assert.equal(after['0081111111'].room, 'X E 1');
  assert.equal(after['0085555555'].exam_number, '26-03-005');
  // Meja X E 1 diurutkan ulang menurut nama: Ani, Budi, Citra
  assert.deepEqual(['0082222222', '0081111111', '0083333333'].map(n => after[n].seat_number), [1, 2, 3]);
});

test('kolom yang diisi sendiri di Excel tetap dipakai (nomor peserta, ruang, meja, password)', async (t) => {
  const { upload, all } = await setup(t);
  const res = await upload([
    ['Nomor Peserta', 'NISN', 'Nama Siswa', 'Kelas', 'Ruang', 'Nomor Meja', 'Password', 'Tempat Tanggal Lahir'],
    ['AS-777', '0089999999', 'Fajar Nur', 'XI F 3', 'Lab Komputer', 12, 'RAHASIA1', 'Namlea, 1 Mei 2007']
  ]);
  assert.equal(res.status, 200);
  const [r] = all();
  assert.equal(r.exam_number, 'AS-777');
  assert.equal(r.room, 'Lab Komputer');
  assert.equal(r.seat_number, 12);
  assert.equal(r.password, 'RAHASIA1');
  assert.equal(r.birth_info, 'Namlea, 1 Mei 2007');
});

test('impor menolak file tanpa kolom nama atau kelas, dengan pesan yang jelas', async (t) => {
  const { upload } = await setup(t);
  const res = await upload([['No', 'NISN'], [1, '0081']]);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Nama/);
  assert.match(res.body.error, /Kelas/);
});

test('formatBirthInfo menangani berbagai bentuk tanggal', () => {
  assert.equal(formatBirthInfo('Namlea', '14-01-2008'), 'Namlea, 14 Januari 2008');
  assert.equal(formatBirthInfo('', '2008-02-29'), '29 Februari 2008');
  assert.equal(formatBirthInfo('Namlea', '14 Januari 2008'), 'Namlea, 14 Januari 2008');
  assert.equal(formatBirthInfo('Namlea', 39461), 'Namlea, 14 Januari 2008', 'nomor seri tanggal Excel');
  assert.equal(formatBirthInfo('', ''), '-');
});

test('hapus semua siswa: menghapus siswa beserta sesi & jawaban; ditolak bila ada yang sedang ujian', async (t) => {
  const { db, base, auth, upload } = await setup(t);
  await upload(DAPODIK, '26-03-');
  const exam = db.prepare('SELECT * FROM exams WHERE is_active = 1 LIMIT 1').get();
  const st = db.prepare('SELECT * FROM students LIMIT 1').get();
  db.prepare("INSERT INTO exam_sessions (exam_id, student_id, status, started_at) VALUES (?, ?, 'WORKING', '2026-11-01T08:00:00Z')").run(exam.id, st.id);
  const del = (body) => fetch(`${base}/api/operator/students/delete-all`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  });

  assert.equal((await del({})).status, 400, 'wajib konfirmasi');
  const busy = await del({ confirm: 'HAPUS SEMUA' });
  assert.equal(busy.status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM students').get().c, 4);

  db.prepare("UPDATE exam_sessions SET status = 'FINISHED'").run();
  const ok = await del({ confirm: 'HAPUS SEMUA' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).deletedStudents, 4);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM students').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM exam_sessions').get().c, 0);
});

test('hapus semua siswa hanya untuk operator', async (t) => {
  const { base } = await setup(t);
  const guru = await fetch(`${base}/api/staff/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'guru', password: 'guru123', role: 'guru' })
  }).then(r => r.json());
  const res = await fetch(`${base}/api/operator/students/delete-all`, {
    method: 'POST', headers: { Authorization: `Bearer ${guru.staffToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: 'HAPUS SEMUA' })
  });
  assert.equal(res.status, 403);
});

test('panel operator: awalan nomor peserta ikut diunggah dan ada tombol hapus semua siswa', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'operator.html'), 'utf8');
  assert.match(html, /id="studentPrefixInput"/);
  assert.match(html, /fd\.append\('prefix'/);
  assert.match(html, /confirmDeleteAllStudents\(\)/);
  assert.match(html, /\/api\/operator\/students\/delete-all/);
});

test('file .xls berisi teks/HTML (mis. ekspor Dapodik): tanggal "05/07/2008" dibaca 5 Juli, bukan format Amerika', async (t) => {
  const { base, auth, all } = await setup(t);
  const html = '<table><tr><td>Daftar Peserta Didik</td></tr><tr><th>Nama</th><th>NISN</th><th>Tempat Lahir</th><th>Tanggal Lahir</th><th>Rombel Saat Ini</th></tr>'
    + '<tr><td>Citra Lestari</td><td>0083333333</td><td>Namlea</td><td>05/07/2008</td><td>X E 1</td></tr>'
    + '<tr><td>Dodi Pratama</td><td>0084444444</td><td>Ambon</td><td>01/12/2008</td><td>X E 1</td></tr></table>';
  const fd = new FormData();
  fd.append('file', new Blob([html]), 'dapodik.xls');
  const res = await fetch(`${base}/api/operator/students/import-excel`, { method: 'POST', headers: auth, body: fd });
  assert.equal(res.status, 200, await res.clone().text());
  const by = Object.fromEntries(all().map(r => [r.full_name, r]));
  assert.equal(by['Citra Lestari'].birth_info, 'Namlea, 5 Juli 2008');
  assert.equal(by['Dodi Pratama'].birth_info, 'Ambon, 1 Desember 2008');
  assert.equal(by['Citra Lestari'].nisn, '0083333333', 'nol di depan NISN tetap');
});
