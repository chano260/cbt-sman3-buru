const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { initDb } = require('../src/db');
const { createApp, calculateExamScores } = require('../src/app');


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
  const ctx = { db, base, post: (u, b, h) => call('POST', u, b, h), get: (u, h) => call('GET', u, null, h) };
  ctx.staff = async (username, password) => {
    const r = await ctx.post('/api/staff/login', { username, password });
    return { Authorization: `Bearer ${r.body.staffToken}` };
  };
  ctx.student = async () => {
    const exam = db.prepare('SELECT * FROM exams WHERE is_active = 1').get();
    const st = db.prepare('SELECT * FROM students LIMIT 1').get();
    const s = (await ctx.post('/api/ujian/login', { exam_number: st.exam_number, password: st.password, token: exam.token })).body;
    return { exam, st, s, h: { 'X-Session-Token': s.sessionToken } };
  };
  return ctx;
}

test('P2-1: rekap nilai tidak menjalankan query per siswa (siap 500+ siswa)', (t) => {
  const db = initDb(':memory:');
  const exam = db.prepare('SELECT * FROM exams WHERE is_active = 1').get();
  const ins = db.prepare("INSERT INTO students (exam_number, nisn, full_name, class_name, room, seat_number, password) VALUES (?, ?, ?, 'XII IPA 1', 'Ruang 05', ?, 'x')");
  const sess = db.prepare("INSERT INTO exam_sessions (exam_id, student_id, status, started_at) VALUES (?, ?, 'WORKING', ?)");
  for (let i = 0; i < 60; i++) {
    const id = Number(ins.run(`P-${i}`, `99${i}`, `Siswa ${i}`, i + 1).lastInsertRowid);
    sess.run(exam.id, id, new Date().toISOString());
  }
  let prepares = 0;
  const counting = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql) => { prepares++; return target.prepare(sql); };
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    }
  });
  const data = calculateExamScores(counting, exam.id);
  assert.ok(data.scores.length >= 60);
  assert.ok(prepares <= 10, `jumlah query harus tetap, bukan per siswa (terjadi ${prepares})`);
});

test('P2-2: rekap nilai hanya memuat siswa kelas target (atau yang sudah punya sesi)', (t) => {
  const db = initDb(':memory:');
  const exam = db.prepare('SELECT * FROM exams WHERE is_active = 1').get(); // target XII IPA 1
  const data = calculateExamScores(db, exam.id);
  assert.ok(data.scores.length > 0);
  assert.ok(data.scores.every(s => s.class_name === 'XII IPA 1'));
});

function xlsxBuffer(rows, extraCells) {
  const ws = XLSX.utils.json_to_sheet(rows);
  if (extraCells) extraCells(ws);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Peserta');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('P2-5: impor Excel tetap membaca hasil rumus, menolak file non-Excel dan file > 2 MB', async (t) => {
  const ctx = setup(t);
  const op = await ctx.staff('operator', 'admin123');
  const buf = xlsxBuffer(
    [{ 'Nomor Peserta': '26-09-001', 'NISN': '0081239001', 'Nama Siswa': 'Rumus Test', 'Kelas': 'XII IPA 1', 'Ruang': 'Ruang 01', 'Nomor Meja': 1, 'Password': 'X' }],
    (ws) => {
      // Kolom Nomor Meja (F2) dan Password (G2) diisi rumus beserta hasil tersimpannya, seperti file dari Excel
      ws.F2 = { t: 'n', f: '3+4', v: 7 };
      ws.G2 = { t: 's', f: 'CONCATENATE("BURU","77")', v: 'BURU77' };
    }
  );
  const fd = new FormData();
  fd.append('file', new Blob([buf]), 'peserta.xlsx');
  const ok = await ctx.post('/api/operator/students/import-excel', fd, op);
  assert.equal(ok.status, 200);
  const row = ctx.db.prepare("SELECT * FROM students WHERE exam_number = '26-09-001'").get();
  assert.equal(row.seat_number, 7);
  assert.equal(row.password, 'BURU77');

  const csv = new FormData();
  csv.append('file', new Blob(['a,b\n1,2']), 'peserta.csv');
  assert.equal((await ctx.post('/api/operator/students/import-excel', csv, op)).status, 400);

  const huge = new FormData();
  huge.append('file', new Blob([Buffer.alloc(3 * 1024 * 1024)]), 'besar.xlsx');
  const hr = await ctx.post('/api/operator/students/import-excel', huge, op);
  assert.ok(hr.status === 400 || hr.status === 413, `status ${hr.status}`);
});

test('P2-6: token custom operator divalidasi (4-8 huruf/angka) dan pesan error tidak menyebut "6-digit"', async (t) => {
  const ctx = setup(t);
  const op = await ctx.staff('operator', 'admin123');
  assert.equal((await ctx.post('/api/operator/token', { customToken: 'AB' }, op)).status, 400);
  assert.equal((await ctx.post('/api/operator/token', { customToken: 'TOK NA!' }, op)).status, 400);
  assert.equal((await ctx.post('/api/operator/token', { customToken: 'toknb2' }, op)).body.token, 'TOKNB2');

  const { s, h } = await ctx.student();
  const bad = await ctx.post('/api/ujian/verify-subtest-token', { sessionId: s.sessionId, token: 'ZZZZZ' }, h);
  assert.equal(bad.status, 403);
  assert.ok(!/6-digit/i.test(bad.body.error));
});

test('P2-7: proyek Android hanya punya satu MainActivity (Java, yang dirilis) dengan proteksi lengkap', () => {
  const srcDir = path.join(__dirname, '..', 'android-exambro', 'app', 'src', 'main', 'java', 'id', 'sch', 'sman3buru', 'exambro');
  const files = fs.readdirSync(srcDir).filter(f => /^MainActivity\.(java|kt)$/.test(f));
  assert.deepEqual(files, ['MainActivity.java']);
  const java = fs.readFileSync(path.join(srcDir, 'MainActivity.java'), 'utf8');
  for (const needle of ['FLAG_SECURE', 'startLockTask()', 'X-Exambro-App', 'AndroidExambro']) {
    assert.ok(java.includes(needle), `MainActivity.java harus memuat ${needle}`);
  }
});

test('P2-8: file build Android & kunci tanda tangan APK tidak ikut ter-commit', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.match(gi, /android-exambro\/build-out/);
  assert.match(gi, /\*\.jks/);
});
