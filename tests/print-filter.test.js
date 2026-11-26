const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');

async function setup(t) {
  const db = initDb(':memory:');
  db.exec('DELETE FROM answers; DELETE FROM exam_sessions; DELETE FROM students;');
  const ins = db.prepare("INSERT INTO students (exam_number, nisn, full_name, class_name, room, seat_number, password) VALUES (?, '-', ?, ?, ?, ?, 'X')");
  ins.run('26-03-001', 'Ani', 'X E 1', 'X E 1', 1);
  ins.run('26-03-002', 'Budi', 'X E 1', 'X E 1', 2);
  ins.run('26-03-003', 'Citra', 'X E 2', 'X E 2', 1);
  ins.run('26-03-004', 'Dodi', 'X E 10', 'X E 10', 1);
  ins.run('26-03-005', 'Eka', 'X E 2', 'Lab Komputer', 2);
  const app = createApp(db, { enforceDefaultPasswordChange: false });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const op = await fetch(`${base}/api/staff/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 'admin123', role: 'operator' })
  }).then(r => r.json());
  const get = (q) => fetch(`${base}/api/operator/print-data${q}`, { headers: { Authorization: `Bearer ${op.staffToken}` } }).then(r => r.json());
  return { get };
}

test('cetak dokumen: daftar ruang & kelas diambil dari data siswa (urut alami X E 2 sebelum X E 10)', async (t) => {
  const { get } = await setup(t);
  const all = await get('');
  assert.deepEqual(all.rooms, ['Lab Komputer', 'X E 1', 'X E 2', 'X E 10']);
  assert.deepEqual(all.classes, ['X E 1', 'X E 2', 'X E 10']);
  assert.equal(all.students.length, 5);
  // Urutan cetak: ruang (urut alami) lalu nomor meja
  assert.deepEqual(all.students.map(s => s.full_name), ['Eka', 'Ani', 'Budi', 'Citra', 'Dodi']);
});

test('cetak dokumen: filter per ruang, per kelas, dan keduanya', async (t) => {
  const { get } = await setup(t);
  assert.deepEqual((await get('?room=X%20E%201')).students.map(s => s.full_name), ['Ani', 'Budi']);
  assert.deepEqual((await get('?class_name=X%20E%202')).students.map(s => s.full_name), ['Eka', 'Citra']);
  assert.deepEqual((await get('?room=X%20E%202&class_name=X%20E%202')).students.map(s => s.full_name), ['Citra']);
  const filtered = await get('?room=X%20E%201');
  assert.equal(filtered.rooms.length, 4, 'daftar pilihan tetap lengkap walau sedang difilter');
});

test('panel operator: pilihan ruang tidak ditulis tetap, ada filter kelas, dan keduanya dikirim', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'operator.html'), 'utf8');
  const tab = html.slice(html.indexOf('<section id="tab-print"'), html.indexOf('</section>', html.indexOf('<section id="tab-print"')));
  assert.doesNotMatch(tab, /<option value="Ruang 01">/, 'ruang tidak lagi ditulis tetap');
  assert.match(tab, /id="printClassFilter"/);
  assert.match(html, /print-data\?room=\$\{encodeURIComponent\(room\)\}&class_name=\$\{encodeURIComponent\(cls\)\}/);
  assert.match(html, /currentPrintData\.rooms/);
  assert.match(html, /currentPrintData\.classes/);
});

test('cetak dokumen: bisa memilih siswa tertentu (cari nama lalu centang) untuk dicetak', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'operator.html'), 'utf8');
  const tab = html.slice(html.indexOf('<section id="tab-print"'), html.indexOf('</section>', html.indexOf('<section id="tab-print"')));
  assert.match(tab, /id="printPickMode"/);
  assert.match(tab, /<option value="PICK">/);
  assert.match(tab, /id="printPickSearch"/);
  assert.match(tab, /id="printPickList"/);
  assert.match(html, /function renderPrintPickList\(/);
  assert.match(html, /function togglePrintPick\(/);
  // Pratinjau & cetak hanya memakai siswa yang dicentang saat mode "Pilih siswa"
  const preview = html.slice(html.indexOf('function renderPrintPreview()'));
  assert.match(preview, /const students = studentsForPrint\(\)/);
  assert.match(html, /function studentsForPrint\(\)[\s\S]*?printPicked\.has\(/);
  // Pilihan diingat di browser (aman bila penyimpanan diblokir)
  assert.match(html, /localStorage\.setItem\(PRINT_PICK_STORE/);
});
