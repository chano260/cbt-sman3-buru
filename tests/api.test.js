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

  // Unggah foto lembar jawaban kertas untuk soal esai sebelum menyelesaikan subtes
  const esaiQuestions = db.prepare("SELECT * FROM questions WHERE exam_id = ? AND type = 'ESAI'").all(exam.id);
  for (const eq of esaiQuestions) {
    const form = new FormData();
    form.append('sessionId', String(loginRes.sessionId));
    form.append('questionId', String(eq.id));
    form.append('photo', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' }), 'esai.jpg');
    await fetch(`${base}/api/ujian/upload-essay-photo`, { method: 'POST', body: form });
  }

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

test('Guru can attach Image and Audio (Listening MP3) to any question and students receive media URLs', async (t) => {
  const db = initDb(':memory:');
  const app = createApp(db);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const guruAuth = await fetch(`${base}/api/staff/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'guru', password: 'guru123', role: 'guru' })
  }).then(r => r.json());

  const exam = db.prepare('SELECT * FROM exams WHERE is_active = 1 LIMIT 1').get();
  const firstQ = db.prepare('SELECT * FROM questions WHERE exam_id = ? ORDER BY id ASC LIMIT 1').get(exam.id);

  const fd = new FormData();
  fd.append('image', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'diagram-sel.png');
  fd.append('audio', new Blob([Buffer.from('4944330300000000', 'hex')], { type: 'audio/mpeg' }), 'listening-part1.mp3');

  const mediaRes = await fetch(`${base}/api/guru/questions/${firstQ.id}/media`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${guruAuth.staffToken}` },
    body: fd
  }).then(r => r.json());

  assert.ok(mediaRes.image_data && mediaRes.image_data.startsWith('/uploads/'));
  assert.ok(mediaRes.audio_data && mediaRes.audio_data.startsWith('/uploads/'));

  // Pastikan siswa yang login menerima image_data dan audio_data tersebut
  const stLogin = await fetch(`${base}/api/ujian/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exam_number: '26-03-001', password: 'BURU01', token: exam.token })
  }).then(r => r.json());

  const sessData = await fetch(`${base}/api/ujian/session/${stLogin.sessionId}`).then(r => r.json());
  const qWithMedia = sessData.questions.find(q => q.id === firstQ.id);
  assert.equal(qWithMedia.image_data, mediaRes.image_data);
  assert.equal(qWithMedia.audio_data, mediaRes.audio_data);
});

test('Direct student name search, confirmation with TTL & NISN, direct exam start without proctor token, and self-resume', async (t) => {
  const db = initDb(':memory:');
  const app = createApp(db);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  // 1. Cek list nama siswa untuk autocomplete (pastikan NISN tidak bocor di endpoint publik ini)
  const listRes = await fetch(`${base}/api/ujian/students-list`).then(r => r.json());
  assert.ok(listRes.students.length >= 8);
  assert.ok(listRes.students.some(s => s.full_name === 'Ahmad Fauzi'));
  assert.equal(listRes.students[0].nisn, undefined);

  // 2a. Jika teman iseng cari nama "ahmad fauzi" dengan 4 digit NISN salah -> ditolak (401)
  const wrongPinRes = await fetch(`${base}/api/ujian/find-student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ahmad fauzi', nisnLast4: '9999' })
  });
  assert.equal(wrongPinRes.status, 401);

  // 2b. Cari nama siswa "ahmad fauzi" + 4 digit terakhir NISN benar ("4501")
  const findRes = await fetch(`${base}/api/ujian/find-student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ahmad fauzi', nisnLast4: '4501' })
  }).then(r => r.json());

  assert.ok(findRes.student, 'Student should be found');
  assert.equal(findRes.student.full_name, 'Ahmad Fauzi');
  assert.equal(findRes.student.nisn, '0081234501');
  assert.equal(findRes.student.class_name, 'XII IPA 1');
  assert.ok(findRes.student.birth_info.includes('Namlea'));

  // 3. Masuk langsung ke soal ("Siap Mengikuti Ujian") dengan verifikasi 4 digit NISN
  const startRes = await fetch(`${base}/api/ujian/start-direct`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentId: findRes.student.id, nisnLast4: '4501' })
  }).then(r => r.json());

  assert.ok(startRes.sessionId);
  assert.equal(startRes.status, 'WORKING');
  assert.equal(startRes.student.full_name, 'Ahmad Fauzi');

  // 4. Pastikan bisa langsung load paket soal ujian
  const sess = await fetch(`${base}/api/ujian/session/${startRes.sessionId}`).then(r => r.json());
  assert.ok(sess.questions.length > 0);
  assert.equal(sess.student.birth_info, 'Namlea, 14 Januari 2008');

  // 5. Bisa simpan jawaban PG
  const q1 = sess.questions[0];
  const ansRes = await fetch(`${base}/api/ujian/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: startRes.sessionId, questionId: q1.id, chosenOption: 'B' })
  });
  assert.equal(ansRes.status, 200);

  // 6. Uji self-resume jika terdeteksi keluar aplikasi (tanpa perlu web pengawas/teknisi)
  await fetch(`${base}/api/ujian/violation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: startRes.sessionId, reason: 'Pindah tab browser' })
  });
  const resumeRes = await fetch(`${base}/api/ujian/self-resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: startRes.sessionId })
  }).then(r => r.json());
  assert.equal(resumeRes.status, 'WORKING');

  // 7. Selesaikan ujian -> setelah selesai, tidak bisa masuk lagi dan tidak bisa ubah jawaban
  const test5Esais = db.prepare("SELECT * FROM questions WHERE exam_id = ? AND type = 'ESAI'").all(findRes.exam.id);
  for (const eq of test5Esais) {
    const form = new FormData();
    form.append('sessionId', String(startRes.sessionId));
    form.append('questionId', String(eq.id));
    form.append('photo', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' }), 'esai.jpg');
    await fetch(`${base}/api/ujian/upload-essay-photo`, { method: 'POST', body: form });
  }

  const finRes = await fetch(`${base}/api/ujian/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: startRes.sessionId })
  });
  assert.equal(finRes.status, 200);

  const reFindRes = await fetch(`${base}/api/ujian/find-student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ahmad fauzi', nisnLast4: '4501' })
  });
  assert.equal(reFindRes.status, 403);

  const reStartRes = await fetch(`${base}/api/ujian/start-direct`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentId: findRes.student.id, nisnLast4: '4501' })
  });
  assert.equal(reStartRes.status, 403);

  const lateAnsRes = await fetch(`${base}/api/ujian/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: startRes.sessionId, questionId: q1.id, chosenOption: 'A' })
  });
  assert.equal(lateAnsRes.status, 400);
});

test('ExamBPPP flow: student account activation via NISN + NPSN + Tanggal Lahir, login with credentials, and subtest token entry', async (t) => {
  const db = initDb(':memory:');
  const app = createApp(db);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const exam = db.prepare('SELECT * FROM exams WHERE is_active = 1 LIMIT 1').get();
  const student = db.prepare("SELECT * FROM students WHERE nisn = '0081234502' LIMIT 1").get();
  assert.ok(student);

  // 1. Aktivasi dengan tanggal lahir salah -> ditolak 401
  const badAct = await fetch(`${base}/api/ujian/activate-account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nisn: student.nisn, npsn: '60101015', birth_date: '2008-12-31' })
  });
  assert.equal(badAct.status, 401);

  // 2. Aktivasi dengan data valid (Waprea, 22 Maret 2008) -> berhasil
  const okAct = await fetch(`${base}/api/ujian/activate-account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nisn: student.nisn, npsn: '60101015', birth_date: '2008-03-22' })
  }).then(r => r.json());
  assert.equal(okAct.ok, true);
  assert.equal(okAct.student.username, student.exam_number);
  assert.equal(okAct.student.password, student.password);

  // 3. Login akun menggunakan credentials dari aktivasi (tanpa token saat login awal)
  const loginRes = await fetch(`${base}/api/ujian/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exam_number: okAct.student.username, password: okAct.student.password })
  }).then(r => r.json());
  assert.ok(loginRes.sessionId);
  assert.equal(loginRes.student.full_name, student.full_name);

  // 4. Input token saat masuk subtes ujian (PDF Hal 9)
  // Token salah -> ditolak 403
  const badTokenRes = await fetch(`${base}/api/ujian/verify-subtest-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: loginRes.sessionId, token: 'WRONG1' })
  });
  assert.equal(badTokenRes.status, 403);

  // Token benar -> berhasil dan status WORKING
  const okTokenRes = await fetch(`${base}/api/ujian/verify-subtest-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: loginRes.sessionId, token: exam.token })
  }).then(r => r.json());
  assert.equal(okTokenRes.ok, true);
  assert.equal(okTokenRes.status, 'WORKING');
});

test('Multi-teacher class targeting, active token retrieval modal, and operator quick class transfer', async (t) => {
  const db = initDb(':memory:');
  const app = createApp(db);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  // 1. Buat 2 ujian Matematika aktif untuk 2 kelompok kelas berbeda:
  // Guru A: XII IPA 1, XII IPA 2 (Token: TOKNA1)
  // Guru B: XII IPA 3, XII IPA 4 (Token: TOKNB2)
  db.prepare('UPDATE exams SET is_active = 0').run();
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO exams (title, subject, class_target, exam_date, start_time, session_name, duration_minutes, token, token_updated_at, is_active)
    VALUES ('Matematika Paket A (Guru 1)', 'Matematika', 'XII IPA 1, XII IPA 2', '2026-11-20', '08:00 WIT', 'Sesi 1', 90, 'TOKNA1', ?, 1)
  `).run(nowIso);
  const examAId = db.prepare('SELECT last_insert_rowid() as id').get().id;

  db.prepare(`
    INSERT INTO exams (title, subject, class_target, exam_date, start_time, session_name, duration_minutes, token, token_updated_at, is_active)
    VALUES ('Matematika Paket B (Guru 2)', 'Matematika', 'XII IPA 3, XII IPA 4', '2026-11-20', '08:00 WIT', 'Sesi 1', 90, 'TOKNB2', ?, 1)
  `).run(nowIso);
  const examBId = db.prepare('SELECT last_insert_rowid() as id').get().id;

  // 2. Ambil token aktif via /api/ujian/active-token berdasarkan kelas siswa
  const tokenARes = await fetch(`${base}/api/ujian/active-token?class_name=${encodeURIComponent('XII IPA 1')}`).then(r => r.json());
  assert.equal(tokenARes.token, 'TOKNA1');
  assert.equal(tokenARes.subject, 'Matematika');

  const tokenBRes = await fetch(`${base}/api/ujian/active-token?class_name=${encodeURIComponent('XII IPA 3')}`).then(r => r.json());
  assert.equal(tokenBRes.token, 'TOKNB2');

  // 3. Siswa XII IPA 1 login -> harus mendapat ujian Guru A
  const student = db.prepare("SELECT * FROM students WHERE class_name = 'XII IPA 1' LIMIT 1").get();
  assert.ok(student);

  const startRes = await fetch(`${base}/api/ujian/start-direct`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentId: student.id, nisnLast4: student.nisn.slice(-4) })
  }).then(r => r.json());
  assert.equal(startRes.exam.id, examAId);
  assert.equal(startRes.exam.title, 'Matematika Paket A (Guru 1)');

  // 4. Pengawas / Operator memindahkan siswa ini ke XII IPA 3 (karena siswa pindah kelas di lapangan tanpa update Dapodik)
  const opAuth = await fetch(`${base}/api/staff/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 'admin123', role: 'operator' })
  }).then(r => r.json());

  const moveRes = await fetch(`${base}/api/operator/student-change-class`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${opAuth.staffToken}` },
    body: JSON.stringify({ student_id: student.id, new_class_name: 'XII IPA 3', reset_active_exam: true })
  }).then(r => r.json());
  assert.equal(moveRes.ok, true);
  assert.equal(moveRes.new_class_name, 'XII IPA 3');
  assert.equal(moveRes.reset_done, true);

  // 5. Cek di database siswa sekarang berkelas XII IPA 3 dan sesi ujian lama tereset
  const updatedStudent = db.prepare('SELECT * FROM students WHERE id = ?').get(student.id);
  assert.equal(updatedStudent.class_name, 'XII IPA 3');

  // 6. Siswa login ulang -> sekarang langsung menerima ujian Guru B
  const restartRes = await fetch(`${base}/api/ujian/start-direct`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentId: student.id, nisnLast4: student.nisn.slice(-4) })
  }).then(r => r.json());
  assert.equal(restartRes.exam.id, examBId);
  assert.equal(restartRes.exam.title, 'Matematika Paket B (Guru 2)');
});

test('Mandatory essay answer paper photo upload before finishing exam, and teacher/proctor inspection', async (t) => {
  const db = initDb(':memory:');
  const app = createApp(db);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const student = db.prepare('SELECT * FROM students LIMIT 1').get();
  const exam = db.prepare('SELECT * FROM exams WHERE is_active = 1 LIMIT 1').get();

  // Pastikan ada soal ESAI pada ujian ini
  const esaiQ = db.prepare("SELECT * FROM questions WHERE exam_id = ? AND type = 'ESAI' LIMIT 1").get(exam.id);
  assert.ok(esaiQ, 'Harus ada minimal 1 soal ESAI');

  // Mulai sesi ujian siswa
  const startRes = await fetch(`${base}/api/ujian/start-direct`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentId: student.id, nisnLast4: student.nisn.slice(-4) })
  }).then(r => r.json());
  assert.ok(startRes.sessionId);

  // 1. Coba selesaikan ujian saat lembar esai belum difoto -> HARUS DITOLAK 400
  const earlyFinishRes = await fetch(`${base}/api/ujian/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: startRes.sessionId })
  });
  assert.equal(earlyFinishRes.status, 400);
  const earlyFinishData = await earlyFinishRes.json();
  assert.ok(earlyFinishData.error.includes('belum difoto'));

  // 2. Unggah foto lembar jawaban kertas untuk semua soal esai pada ujian
  const allEsaiQs = db.prepare("SELECT * FROM questions WHERE exam_id = ? AND type = 'ESAI'").all(exam.id);
  const fakePhoto = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]); // JPEG header
  let firstUpload = null;
  for (const eq of allEsaiQs) {
    const form = new FormData();
    form.append('sessionId', String(startRes.sessionId));
    form.append('questionId', String(eq.id));
    form.append('currentQuestionNumber', String(eq.number));
    form.append('photo', new Blob([fakePhoto], { type: 'image/jpeg' }), `lembar_esai_${eq.number}.jpg`);

    const uploadRes = await fetch(`${base}/api/ujian/upload-essay-photo`, {
      method: 'POST',
      body: form
    }).then(r => r.json());
    assert.equal(uploadRes.ok, true);
    assert.ok(uploadRes.essayPhoto.startsWith('/uploads/essay-'));
    if (!firstUpload) firstUpload = uploadRes;
  }

  // 3. Sesi sekarang mengembalikan essayPhotos
  const sessRes = await fetch(`${base}/api/ujian/session/${startRes.sessionId}`).then(r => r.json());
  assert.equal(sessRes.essayPhotos[esaiQ.id], firstUpload.essayPhoto);

  // 4. Guru & Pengawas dapat memeriksa foto lembar jawaban kertas siswa
  const guruAuth = await fetch(`${base}/api/staff/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'guru', password: 'guru123', role: 'guru' })
  }).then(r => r.json());

  const workRes = await fetch(`${base}/api/pengawas/student-work/${startRes.sessionId}`, {
    headers: { 'Authorization': `Bearer ${guruAuth.staffToken}` }
  }).then(r => r.json());
  const esaiWork = workRes.workDetail.find(w => w.question_id === esaiQ.id);
  assert.ok(esaiWork);
  assert.equal(esaiWork.essay_photo, firstUpload.essayPhoto);

  // 5. Setelah seluruh lembar esai difoto, ujian BERHASIL diselesaikan
  const finishRes = await fetch(`${base}/api/ujian/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: startRes.sessionId })
  }).then(r => r.json());
  assert.equal(finishRes.status, 'FINISHED');
});





