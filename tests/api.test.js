const test = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');

test('Student exam lifecycle: login, auto-save PG, no key/score leak, lock on violation, unlock by pengawas, accurate PG-only score for guru', async (t) => {
  const db = initDb(':memory:');
  const app = createApp(db);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const exam = db.prepare('SELECT * FROM exams LIMIT 1').get();
  const student = db.prepare('SELECT * FROM students LIMIT 1').get();

  // 1. Login siswa
  const loginRes = await fetch(`${base}/api/ujian/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exam_number: student.exam_number, password: student.password, token: exam.token })
  }).then(r => r.json());
  assert.ok(loginRes.sessionId);

  // 2. Ambil soal — pastikan tidak ada answer_key yang bocor ke siswa
  const sessionData = await fetch(`${base}/api/ujian/session/${loginRes.sessionId}`).then(r => r.json());
  assert.ok(sessionData.questions.length > 0);
  for (const q of sessionData.questions) {
    assert.equal(q.answer_key, undefined);
  }

  // 3. Auto-save jawaban PG pertama dengan benar
  const firstPg = db.prepare("SELECT * FROM questions WHERE exam_id = ? AND type = 'PG' ORDER BY number ASC LIMIT 1").get(exam.id);
  const ansRes = await fetch(`${base}/api/ujian/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: loginRes.sessionId, questionId: firstPg.id, chosenOption: firstPg.answer_key })
  });
  assert.equal(ansRes.status, 200);

  // 4. Pelanggaran keluar aplikasi -> mengunci sesi & menolak pengiriman jawaban baru
  await fetch(`${base}/api/ujian/violation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: loginRes.sessionId, reason: 'Keluar aplikasi / pindah layar' })
  });
  const blockedAns = await fetch(`${base}/api/ujian/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: loginRes.sessionId, questionId: firstPg.id, chosenOption: 'A' })
  });
  assert.equal(blockedAns.status, 423);

  // 5. Pengawas membuka kunci -> wajib menggunakan token otorisasi staf
  const unauthUnlock = await fetch(`${base}/api/pengawas/unlock/${loginRes.sessionId}`, { method: 'POST' });
  assert.equal(unauthUnlock.status, 401);

  const pengawasAuth = await fetch(`${base}/api/staff/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'pengawas', password: 'pengawas123', role: 'pengawas' })
  }).then(r => r.json());
  assert.ok(pengawasAuth.staffToken);

  await fetch(`${base}/api/pengawas/unlock/${loginRes.sessionId}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${pengawasAuth.staffToken}` }
  });
  const finishRes = await fetch(`${base}/api/ujian/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: loginRes.sessionId })
  }).then(r => r.json());
  assert.equal(finishRes.score, undefined);
  assert.equal(finishRes.status, 'FINISHED');

  // 6. Pastikan endpoint soal Guru menolak akses tanpa token staf (mencegah siswa mengintip kunci jawaban)
  const unauthGuruQuestions = await fetch(`${base}/api/guru/exams/${exam.id}/questions`);
  assert.equal(unauthGuruQuestions.status, 401);

  const guruAuth = await fetch(`${base}/api/staff/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'guru', password: 'guru123', role: 'guru' })
  }).then(r => r.json());
  assert.ok(guruAuth.staffToken);

  // 7. Guru melihat skor PG yang dihitung hanya dari total soal PG (bukan PG + Esai)
  const pgCount = db.prepare("SELECT COUNT(*) as c FROM questions WHERE exam_id = ? AND type = 'PG'").get(exam.id).c;
  const guruScores = await fetch(`${base}/api/guru/exams/${exam.id}/scores`, {
    headers: { 'Authorization': `Bearer ${guruAuth.staffToken}` }
  }).then(r => r.json());
  const studentScoreRow = guruScores.scores.find(s => s.student_id === student.id);
  assert.equal(studentScoreRow.score, Number(((1 / pgCount) * 100).toFixed(1)));
});

test('15-minute token rotation, Excel student bulk import, and live student work monitoring for Operator & Pengawas', async (t) => {
  const db = initDb(':memory:');
  const app = createApp(db);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  // Login Operator & Pengawas
  const opAuth = await fetch(`${base}/api/staff/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 'admin123', role: 'operator' })
  }).then(r => r.json());

  const pengawasAuth = await fetch(`${base}/api/staff/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'pengawas', password: 'pengawas123', role: 'pengawas' })
  }).then(r => r.json());

  // 1. Download Template Excel Siswa & Import kembali ke Server
  const tplRes = await fetch(`${base}/api/operator/template-students-excel?staffToken=${opAuth.staffToken}`);
  assert.equal(tplRes.status, 200);
  const tplBuf = Buffer.from(await tplRes.arrayBuffer());

  const form = new FormData();
  form.append('file', new Blob([tplBuf]), 'siswa.xlsx');
  const impRes = await fetch(`${base}/api/operator/students/import-excel`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${opAuth.staffToken}` },
    body: form
  }).then(r => r.json());
  assert.ok(impRes.importedCount >= 1);

  // 2. Simulasi Token sudah lewat 15 menit -> otomatis berputar ke token baru
  const examBefore = db.prepare('SELECT * FROM exams WHERE is_active = 1 LIMIT 1').get();
  const oldToken = examBefore.token;
  const sixteenMinsAgo = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  db.prepare('UPDATE exams SET token_updated_at = ? WHERE id = ?').run(sixteenMinsAgo, examBefore.id);

  const overviewAfter = await fetch(`${base}/api/operator/overview`, {
    headers: { 'Authorization': `Bearer ${opAuth.staffToken}` }
  }).then(r => r.json());
  assert.notEqual(overviewAfter.activeExam.token, oldToken);
  assert.ok(overviewAfter.activeExam.token_remaining_seconds > 800);

  // 3. Siswa login dengan token baru, kirim posisi soal aktif (heartbeat) + jawaban, lalu Pengawas memantau kerja siswa
  const currentToken = overviewAfter.activeExam.token;
  const student = db.prepare('SELECT * FROM students LIMIT 1').get();
  const stLogin = await fetch(`${base}/api/ujian/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exam_number: student.exam_number, password: student.password, token: currentToken })
  }).then(r => r.json());

  await fetch(`${base}/api/ujian/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: stLogin.sessionId, currentQuestionNumber: 3 })
  });

  const liveWork = await fetch(`${base}/api/pengawas/student-work/${stLogin.sessionId}`, {
    headers: { 'Authorization': `Bearer ${pengawasAuth.staffToken}` }
  }).then(r => r.json());
  assert.equal(liveWork.session.current_question_number, 3);
  assert.ok(Array.isArray(liveWork.workDetail));

  // 4. Jika siswa mengalami gangguan / terkunci, setelah dibuka pengawas pun wajib verifikasi token 15-menit terbaru
  await fetch(`${base}/api/ujian/violation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: stLogin.sessionId, reason: 'Gangguan / keluar aplikasi' })
  });
  await fetch(`${base}/api/pengawas/unlock/${stLogin.sessionId}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${pengawasAuth.staffToken}` }
  });

  // Siswa masih berstatus NEED_TOKEN sampai memasukkan token 15-menit yang aktif saat ini
  const wrongTokenCheck = await fetch(`${base}/api/ujian/verify-resume-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: stLogin.sessionId, token: 'SALAH' })
  });
  assert.equal(wrongTokenCheck.status, 403);

  const rightTokenCheck = await fetch(`${base}/api/ujian/verify-resume-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: stLogin.sessionId, token: currentToken })
  }).then(r => r.json());
  assert.equal(rightTokenCheck.status, 'WORKING');
});

test('VPS Public URL QR Code generation and 500 concurrent students load test', async (t) => {
  const db = initDb(':memory:');
  const app = createApp(db);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const opAuth = await fetch(`${base}/api/staff/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 'admin123', role: 'operator' })
  }).then(r => r.json());

  // 1. Set URL Publik VPS & verifikasi QR Code mengarah ke URL VPS tersebut
  const vpsUrl = 'https://cbt.sman3buru.sch.id';
  const setUrlRes = await fetch(`${base}/api/operator/public-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${opAuth.staffToken}`
    },
    body: JSON.stringify({ publicUrl: vpsUrl })
  }).then(r => r.json());
  assert.equal(setUrlRes.examUrl, 'https://cbt.sman3buru.sch.id/ujian.html');
  assert.ok(setUrlRes.qrDataUrl.startsWith('data:image/png;base64,'));

  // 2. Uji Beban 500 Siswa Serentak (450+ Siswa SMA N 3 Buru)
  const insertStudent = db.prepare(`
    INSERT OR IGNORE INTO students (exam_number, nisn, full_name, class_name, room, seat_number, password)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (let i = 1; i <= 500; i++) {
      const code = `26-99-${String(i).padStart(3, '0')}`;
      insertStudent.run(code, `0099${i}`, `Siswa Uji Beban ${i}`, 'XII IPA 1', `Ruang ${String((i % 15) + 1).padStart(2, '0')}`, (i % 32) + 1, 'PASS500');
    }
  })();

  const exam = db.prepare('SELECT * FROM exams WHERE is_active = 1 LIMIT 1').get();
  const firstPg = db.prepare("SELECT id FROM questions WHERE exam_id = ? AND type = 'PG' LIMIT 1").get(exam.id);

  // Jalankan 500 siswa (1.500 HTTP request: login + ambil soal + simpan jawaban) dalam gelombang 100 koneksi paralel
  const startMs = Date.now();
  for (let batchStart = 1; batchStart <= 500; batchStart += 100) {
    const tasks = [];
    for (let i = batchStart; i < batchStart + 100; i++) {
      const exam_number = `26-99-${String(i).padStart(3, '0')}`;
      tasks.push((async () => {
        const login = await fetch(`${base}/api/ujian/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ exam_number, password: 'PASS500', token: exam.token })
        }).then(r => r.json());
        assert.ok(login.sessionId);

        const sess = await fetch(`${base}/api/ujian/session/${login.sessionId}`).then(r => r.json());
        assert.ok(sess.questions.length > 0);

        const ans = await fetch(`${base}/api/ujian/answer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: login.sessionId, questionId: firstPg.id, chosenOption: 'B' })
        });
        assert.equal(ans.status, 200);
      })());
    }
    await Promise.all(tasks);
  }
  const elapsedMs = Date.now() - startMs;
  const totalSessions = db.prepare('SELECT COUNT(*) as c FROM exam_sessions WHERE exam_id = ?').get(exam.id).c;
  assert.ok(totalSessions >= 500);
  assert.ok(elapsedMs < 15000, `500 concurrent students finished in ${elapsedMs}ms`);
});



