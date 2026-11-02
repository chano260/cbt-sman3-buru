const express = require('express');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const multer = require('multer');
const XLSX = require('xlsx');
const { parseDocxBuffer, parseQuestionsFromText, generateWordTemplateBuffer } = require('./wordParser');

const upload = multer({ storage: multer.memoryStorage() });

function getLocalLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function calculateExamScores(db, examId) {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  if (!exam) return { exam: null, pgCount: 0, esaiCount: 0, scores: [] };

  const pgQuestions = db.prepare("SELECT id, number, answer_key FROM questions WHERE exam_id = ? AND type = 'PG'").all(examId);
  const esaiCount = db.prepare("SELECT COUNT(*) as c FROM questions WHERE exam_id = ? AND type = 'ESAI'").get(examId).c;
  const pgCount = pgQuestions.length;
  const keyMap = new Map(pgQuestions.map(q => [q.id, (q.answer_key || '').toUpperCase()]));

  const students = db.prepare('SELECT * FROM students ORDER BY room ASC, seat_number ASC, full_name ASC').all();
  const sessions = db.prepare('SELECT * FROM exam_sessions WHERE exam_id = ?').all(examId);
  const sessionMap = new Map(sessions.map(s => [s.student_id, s]));

  const scores = students.map(student => {
    const sess = sessionMap.get(student.id);
    if (!sess) {
      return {
        student_id: student.id,
        session_id: null,
        exam_number: student.exam_number,
        nisn: student.nisn,
        full_name: student.full_name,
        class_name: student.class_name,
        room: student.room,
        seat_number: student.seat_number,
        status: 'NOT_STARTED',
        violation_count: 0,
        last_violation_reason: null,
        answered_pg: 0,
        correct_pg: 0,
        wrong_pg: 0,
        total_pg: pgCount,
        score: 0
      };
    }

    const ansRows = db.prepare('SELECT question_id, chosen_option FROM answers WHERE session_id = ?').all(sess.id);
    let correct = 0;
    let answeredPg = 0;
    for (const ans of ansRows) {
      if (keyMap.has(ans.question_id)) {
        answeredPg++;
        if ((ans.chosen_option || '').toUpperCase() === keyMap.get(ans.question_id)) {
          correct++;
        }
      }
    }
    const wrong = Math.max(0, answeredPg - correct);
    const rawScore = pgCount > 0 ? Number(((correct / pgCount) * 100).toFixed(1)) : 0;

    return {
      student_id: student.id,
      session_id: sess.id,
      exam_number: student.exam_number,
      nisn: student.nisn,
      full_name: student.full_name,
      class_name: student.class_name,
      room: student.room,
      seat_number: student.seat_number,
      status: sess.status,
      violation_count: sess.violation_count,
      last_violation_reason: sess.last_violation_reason,
      started_at: sess.started_at,
      finished_at: sess.finished_at,
      answered_pg: answeredPg,
      correct_pg: correct,
      wrong_pg: wrong,
      total_pg: pgCount,
      score: rawScore
    };
  });

  return { exam, pgCount, esaiCount, scores };
}

function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Penyimpanan token sesi login staf (Operator, Guru, Pengawas)
  const staffTokens = new Map();

  function requireStaffAuth(allowedRoles) {
    return (req, res, next) => {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : (req.query.staffToken || '');
      const staffUser = staffTokens.get(token);
      if (!staffUser) {
        return res.status(401).json({ error: 'Akses ditolak: Silakan login staf terlebih dahulu.' });
      }
      if (allowedRoles && !allowedRoles.includes(staffUser.role) && staffUser.role !== 'operator') {
        return res.status(403).json({ error: 'Peran akun tidak memiliki akses ke menu ini.' });
      }
      req.staffUser = staffUser;
      next();
    };
  }

  // Info jaringan server lokal (tanpa membocorkan token ujian ke publik/siswa)
  app.get('/api/server-info', (req, res) => {
    const activeExam = db.prepare('SELECT id, title, subject, class_target, exam_date, start_time, session_name, duration_minutes FROM exams WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
    res.json({
      school: 'SMA NEGERI 3 BURU',
      lanIp: getLocalLanIp(),
      activeExam
    });
  });

  // Login staf (Operator, Guru, Pengawas)
  app.post('/api/staff/login', (req, res) => {
    const { username, password, role } = req.body || {};
    const user = db.prepare('SELECT id, username, full_name, role, subject, room FROM users WHERE username = ? AND password = ?').get(
      String(username || '').trim(),
      String(password || '').trim()
    );
    if (!user) {
      return res.status(401).json({ error: 'Username atau password salah' });
    }
    if (role && user.role !== role && user.role !== 'operator') {
      return res.status(403).json({ error: `Akun ini bukan untuk panel ${role.toUpperCase()}` });
    }
    const staffToken = crypto.randomBytes(24).toString('hex');
    staffTokens.set(staffToken, user);
    res.json({ user, staffToken });
  });

  // ==================== PANEL OPERATOR ====================
  app.get('/api/operator/overview', requireStaffAuth(['operator']), (req, res) => {
    const exams = db.prepare('SELECT * FROM exams ORDER BY id DESC').all();
    const activeExam = exams.find(e => e.is_active === 1) || exams[0];
    const students = db.prepare('SELECT * FROM students ORDER BY room ASC, seat_number ASC, full_name ASC').all();
    const staff = db.prepare('SELECT id, username, full_name, role, subject, room FROM users ORDER BY role ASC, id ASC').all();
    const scoreData = activeExam ? calculateExamScores(db, activeExam.id) : { scores: [], pgCount: 0, esaiCount: 0 };

    res.json({
      lanIp: getLocalLanIp(),
      activeExam,
      exams,
      students,
      staff,
      monitoring: scoreData.scores,
      pgCount: scoreData.pgCount,
      esaiCount: scoreData.esaiCount
    });
  });

  app.post('/api/operator/token', requireStaffAuth(['operator']), (req, res) => {
    const { examId, customToken } = req.body || {};
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let newToken = customToken ? String(customToken).toUpperCase().trim() : '';
    if (!newToken) {
      for (let i = 0; i < 5; i++) {
        newToken += chars[Math.floor(Math.random() * chars.length)];
      }
    }
    const targetExam = examId
      ? db.prepare('SELECT id FROM exams WHERE id = ?').get(examId)
      : db.prepare('SELECT id FROM exams WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
    if (!targetExam) return res.status(404).json({ error: 'Ujian tidak ditemukan' });

    db.prepare('UPDATE exams SET token = ? WHERE id = ?').run(newToken, targetExam.id);
    res.json({ examId: targetExam.id, token: newToken });
  });

  app.post('/api/operator/exams', requireStaffAuth(['operator']), (req, res) => {
    const { title, subject, class_target, exam_date, start_time, session_name, duration_minutes } = req.body || {};
    if (!title || !subject) return res.status(400).json({ error: 'Nama ujian dan mata pelajaran wajib diisi' });
    const token = 'SMAN3';
    db.prepare('UPDATE exams SET is_active = 0').run();
    const info = db.prepare(`
      INSERT INTO exams (title, subject, class_target, exam_date, start_time, session_name, duration_minutes, token, shuffle_questions, is_active, teacher_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 2)
    `).run(
      title,
      subject,
      class_target || 'XII IPA 1',
      exam_date || '2026-11-02',
      start_time || '08:00 WIT',
      session_name || 'Sesi 1',
      Number(duration_minutes) || 90,
      token
    );
    res.json({ id: Number(info.lastInsertRowid), token });
  });

  app.post('/api/operator/exams/:id/activate', requireStaffAuth(['operator']), (req, res) => {
    const examId = Number(req.params.id);
    db.prepare('UPDATE exams SET is_active = 0').run();
    db.prepare('UPDATE exams SET is_active = 1 WHERE id = ?').run(examId);
    res.json({ activated: examId });
  });

  app.post('/api/operator/students', requireStaffAuth(['operator']), (req, res) => {
    const { exam_number, nisn, full_name, class_name, room, seat_number, password } = req.body || {};
    if (!exam_number || !full_name) {
      return res.status(400).json({ error: 'Nomor peserta dan nama siswa wajib diisi' });
    }
    try {
      const info = db.prepare(`
        INSERT INTO students (exam_number, nisn, full_name, class_name, room, seat_number, password)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(exam_number).trim(),
        String(nisn || '-').trim(),
        String(full_name).trim(),
        String(class_name || 'XII IPA 1').trim(),
        String(room || 'Ruang 01').trim(),
        Number(seat_number) || 1,
        String(password || 'BURU123').trim()
      );
      res.json({ id: Number(info.lastInsertRowid) });
    } catch {
      res.status(400).json({ error: 'Nomor peserta sudah terdaftar' });
    }
  });

  app.delete('/api/operator/students/:id', requireStaffAuth(['operator']), (req, res) => {
    db.prepare('DELETE FROM students WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  app.post('/api/operator/staff', requireStaffAuth(['operator']), (req, res) => {
    const { username, password, full_name, role, subject, room } = req.body || {};
    if (!username || !password || !full_name || !role) {
      return res.status(400).json({ error: 'Data akun staf belum lengkap' });
    }
    try {
      const info = db.prepare(`
        INSERT INTO users (username, password, full_name, role, subject, room)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(username.trim(), password.trim(), full_name.trim(), role, subject || null, room || null);
      res.json({ id: Number(info.lastInsertRowid) });
    } catch {
      res.status(400).json({ error: 'Username sudah digunakan' });
    }
  });

  app.get('/api/operator/print-data', requireStaffAuth(['operator']), (req, res) => {
    const { room, class_name } = req.query;
    let sql = 'SELECT * FROM students WHERE 1=1';
    const params = [];
    if (room && room !== 'ALL') {
      sql += ' AND room = ?';
      params.push(room);
    }
    if (class_name && class_name !== 'ALL') {
      sql += ' AND class_name = ?';
      params.push(class_name);
    }
    sql += ' ORDER BY room ASC, seat_number ASC, full_name ASC';
    const students = db.prepare(sql).all(...params);
    const activeExam = db.prepare('SELECT * FROM exams WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
    res.json({
      schoolHeader: {
        gov: 'PEMERINTAH PROVINSI MALUKU',
        dept: 'DINAS PENDIDIKAN DAN KEBUDAYAAN',
        school: 'SMA NEGERI 3 BURU',
        address: 'Kabupaten Buru, Provinsi Maluku'
      },
      lanIp: getLocalLanIp(),
      activeExam,
      students
    });
  });

  // ==================== PANEL GURU MAPEL ====================
  app.get('/api/guru/exams', requireStaffAuth(['guru', 'operator']), (req, res) => {
    const exams = db.prepare('SELECT * FROM exams ORDER BY id DESC').all();
    const enriched = exams.map(ex => {
      const pgCount = db.prepare("SELECT COUNT(*) as c FROM questions WHERE exam_id = ? AND type = 'PG'").get(ex.id).c;
      const esaiCount = db.prepare("SELECT COUNT(*) as c FROM questions WHERE exam_id = ? AND type = 'ESAI'").get(ex.id).c;
      return { ...ex, pgCount, esaiCount };
    });
    res.json({ exams: enriched });
  });

  app.get('/api/guru/exams/:id/questions', requireStaffAuth(['guru', 'operator']), (req, res) => {
    const examId = Number(req.params.id);
    const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
    const questions = db.prepare('SELECT * FROM questions WHERE exam_id = ? ORDER BY number ASC, id ASC').all(examId);
    res.json({ exam, questions });
  });

  app.post('/api/guru/exams/:id/questions', requireStaffAuth(['guru', 'operator']), (req, res) => {
    const examId = Number(req.params.id);
    const { number, type, question_text, option_a, option_b, option_c, option_d, option_e, answer_key } = req.body || {};
    if (!question_text) return res.status(400).json({ error: 'Teks soal wajib diisi' });
    const qType = type === 'ESAI' ? 'ESAI' : 'PG';
    const info = db.prepare(`
      INSERT INTO questions (exam_id, number, type, question_text, option_a, option_b, option_c, option_d, option_e, answer_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      examId,
      Number(number) || 1,
      qType,
      question_text,
      qType === 'PG' ? (option_a || '') : null,
      qType === 'PG' ? (option_b || '') : null,
      qType === 'PG' ? (option_c || '') : null,
      qType === 'PG' ? (option_d || '') : null,
      qType === 'PG' ? (option_e || '') : null,
      qType === 'PG' ? String(answer_key || 'A').toUpperCase() : null
    );
    res.json({ id: Number(info.lastInsertRowid) });
  });

  app.delete('/api/guru/questions/:questionId', requireStaffAuth(['guru', 'operator']), (req, res) => {
    db.prepare('DELETE FROM questions WHERE id = ?').run(Number(req.params.questionId));
    res.json({ ok: true });
  });

  app.get('/api/guru/template-word', async (req, res) => {
    const buf = await generateWordTemplateBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="Template-Soal-CBT-SMAN3-Buru.docx"');
    res.send(buf);
  });

  app.post('/api/guru/exams/:id/import-word', requireStaffAuth(['guru', 'operator']), upload.single('file'), async (req, res) => {
    try {
      const examId = Number(req.params.id);
      const replaceExisting = req.body && String(req.body.replace) === 'true';
      let parsed = [];

      if (req.file && req.file.buffer) {
        parsed = await parseDocxBuffer(req.file.buffer);
      } else if (req.body && req.body.rawText) {
        parsed = parseQuestionsFromText(req.body.rawText);
      } else {
        return res.status(400).json({ error: 'File Word (.docx) atau teks soal tidak ditemukan' });
      }

      if (parsed.length === 0) {
        return res.status(400).json({ error: 'Tidak ada soal yang terbaca dari file. Pastikan memakai format penomoran 1. A. B. C. D. E. KUNCI: X' });
      }

      if (replaceExisting) {
        db.prepare('DELETE FROM questions WHERE exam_id = ?').run(examId);
      }

      const insertQ = db.prepare(`
        INSERT INTO questions (exam_id, number, type, question_text, image_data, option_a, option_b, option_c, option_d, option_e, answer_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const q of parsed) {
        insertQ.run(
          examId,
          q.number,
          q.type,
          q.question_text,
          q.image_data || null,
          q.option_a || null,
          q.option_b || null,
          q.option_c || null,
          q.option_d || null,
          q.option_e || null,
          q.answer_key || null
        );
      }

      res.json({
        importedCount: parsed.length,
        pgCount: parsed.filter(q => q.type === 'PG').length,
        esaiCount: parsed.filter(q => q.type === 'ESAI').length
      });
    } catch (err) {
      res.status(500).json({ error: 'Gagal membaca file Word: ' + err.message });
    }
  });

  app.get('/api/guru/exams/:id/scores', requireStaffAuth(['guru', 'operator']), (req, res) => {
    const examId = Number(req.params.id);
    const data = calculateExamScores(db, examId);
    res.json(data);
  });

  app.get('/api/guru/exams/:id/export-excel', requireStaffAuth(['guru', 'operator']), (req, res) => {
    const examId = Number(req.params.id);
    const data = calculateExamScores(db, examId);
    if (!data.exam) return res.status(404).send('Ujian tidak ditemukan');

    const rows = data.scores.map((s, idx) => ({
      'No': idx + 1,
      'Nomor Peserta': s.exam_number,
      'NISN': s.nisn,
      'Nama Siswa': s.full_name,
      'Kelas': s.class_name,
      'Ruang': s.room,
      'Status Ujian': s.status === 'FINISHED' ? 'Selesai' : s.status === 'LOCKED' ? 'Terkunci' : s.status === 'WORKING' ? 'Mengerjakan' : 'Belum Login',
      'Jumlah Soal PG': s.total_pg,
      'PG Dijawab': s.answered_pg,
      'PG Benar': s.correct_pg,
      'PG Salah': s.wrong_pg,
      'Nilai Pilihan Ganda (0-100)': s.score,
      'Nilai Esai (Kertas)': '',
      'Pelanggaran Exambro': s.violation_count
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Nilai PG SMAN 3 Buru');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Rekap-Nilai-PG-${data.exam.subject.replace(/\s+/g, '-')}-SMAN3Buru.xlsx"`);
    res.send(buf);
  });

  // ==================== PANEL PENGAWAS RUANGAN ====================
  app.get('/api/pengawas/room', requireStaffAuth(['pengawas', 'operator']), (req, res) => {
    const room = req.query.room || 'ALL';
    const activeExam = db.prepare('SELECT * FROM exams WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
    if (!activeExam) return res.json({ activeExam: null, students: [], reports: [] });

    const scoreData = calculateExamScores(db, activeExam.id);
    const filtered = scoreData.scores
      .filter(s => room === 'ALL' || s.room === room)
      .map(({ score, correct_pg, wrong_pg, ...rest }) => rest);

    const reports = db.prepare('SELECT * FROM room_reports WHERE exam_id = ? ORDER BY id DESC').all(activeExam.id);
    res.json({
      activeExam: {
        id: activeExam.id,
        title: activeExam.title,
        subject: activeExam.subject,
        session_name: activeExam.session_name,
        token: activeExam.token,
        duration_minutes: activeExam.duration_minutes
      },
      pgCount: scoreData.pgCount,
      esaiCount: scoreData.esaiCount,
      students: filtered,
      reports
    });
  });

  app.post('/api/pengawas/unlock/:sessionId', requireStaffAuth(['pengawas', 'operator']), (req, res) => {
    const sessionId = Number(req.params.sessionId);
    db.prepare("UPDATE exam_sessions SET status = 'WORKING' WHERE id = ?").run(sessionId);
    res.json({ ok: true, sessionId, status: 'WORKING' });
  });

  app.post('/api/pengawas/reset-login/:sessionId', requireStaffAuth(['pengawas', 'operator']), (req, res) => {
    const sessionId = Number(req.params.sessionId);
    db.prepare("UPDATE exam_sessions SET status = 'WORKING', device_info = NULL WHERE id = ?").run(sessionId);
    res.json({ ok: true, sessionId });
  });

  app.post('/api/pengawas/report', requireStaffAuth(['pengawas', 'operator']), (req, res) => {
    const { exam_id, room, pengawas_name, notes, absent_students } = req.body || {};
    const activeExam = exam_id
      ? { id: exam_id }
      : db.prepare('SELECT id FROM exams WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
    if (!activeExam) return res.status(400).json({ error: 'Tidak ada ujian aktif' });

    const info = db.prepare(`
      INSERT INTO room_reports (exam_id, room, pengawas_name, notes, absent_students, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      activeExam.id,
      room || 'Ruang 01',
      pengawas_name || 'Pengawas Ruangan',
      notes || 'Ujian berjalan tertib dan lancar.',
      absent_students || '-',
      new Date().toISOString()
    );
    res.json({ id: Number(info.lastInsertRowid) });
  });

  // ==================== PORTAL UJIAN SISWA (EXAMBRO) ====================
  // Catatan Keamanan: Endpoint /api/ujian/* TIDAK PERNAH mengirimkan answer_key ataupun score!
  app.post('/api/ujian/login', (req, res) => {
    const { exam_number, password, token, device_info } = req.body || {};
    const student = db.prepare('SELECT * FROM students WHERE exam_number = ? AND password = ?').get(
      String(exam_number || '').trim(),
      String(password || '').trim()
    );
    if (!student) {
      return res.status(401).json({ error: 'Nomor Peserta atau Password salah!' });
    }

    const activeExam = db.prepare('SELECT * FROM exams WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
    if (!activeExam) {
      return res.status(404).json({ error: 'Belum ada jadwal ujian yang diaktifkan oleh Operator.' });
    }

    if (String(token || '').toUpperCase().trim() !== String(activeExam.token).toUpperCase().trim()) {
      return res.status(403).json({ error: 'Token Ujian tidak sesuai! Silakan tanyakan Token ke Pengawas Ruangan.' });
    }

    let session = db.prepare('SELECT * FROM exam_sessions WHERE exam_id = ? AND student_id = ?').get(activeExam.id, student.id);
    if (!session) {
      const now = new Date().toISOString();
      const info = db.prepare(`
        INSERT INTO exam_sessions (exam_id, student_id, status, violation_count, started_at, device_info)
        VALUES (?, ?, 'WORKING', 0, ?, ?)
      `).run(activeExam.id, student.id, now, device_info || 'Exambro Android');
      session = db.prepare('SELECT * FROM exam_sessions WHERE id = ?').get(Number(info.lastInsertRowid));
    }

    res.json({
      sessionId: session.id,
      status: session.status,
      student: {
        id: student.id,
        exam_number: student.exam_number,
        full_name: student.full_name,
        class_name: student.class_name,
        room: student.room,
        seat_number: student.seat_number
      }
    });
  });

  app.get('/api/ujian/session/:sessionId', (req, res) => {
    const sessionId = Number(req.params.sessionId);
    const session = db.prepare('SELECT * FROM exam_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ error: 'Sesi ujian tidak ditemukan' });

    const student = db.prepare('SELECT id, exam_number, full_name, class_name, room, seat_number FROM students WHERE id = ?').get(session.student_id);
    const exam = db.prepare('SELECT id, title, subject, class_target, session_name, duration_minutes FROM exams WHERE id = ?').get(session.exam_id);

    const questions = db.prepare(`
      SELECT id, exam_id, number, type, question_text, image_data, option_a, option_b, option_c, option_d, option_e
      FROM questions
      WHERE exam_id = ?
      ORDER BY CASE WHEN type = 'PG' THEN 0 ELSE 1 END, number ASC, id ASC
    `).all(session.exam_id);

    const savedAnswers = db.prepare('SELECT question_id, chosen_option FROM answers WHERE session_id = ?').all(sessionId);
    const answersMap = {};
    for (const a of savedAnswers) {
      answersMap[a.question_id] = a.chosen_option;
    }

    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(session.started_at).getTime()) / 1000));
    const totalSeconds = (exam.duration_minutes || 90) * 60;
    const remainingSeconds = Math.max(0, totalSeconds - elapsedSeconds);

    res.json({
      session: {
        id: session.id,
        status: session.status,
        violation_count: session.violation_count,
        last_violation_reason: session.last_violation_reason,
        started_at: session.started_at,
        finished_at: session.finished_at,
        remaining_seconds: remainingSeconds
      },
      student,
      exam,
      questions,
      answers: answersMap
    });
  });

  app.post('/api/ujian/answer', (req, res) => {
    const { sessionId, questionId, chosenOption } = req.body || {};
    const session = db.prepare('SELECT * FROM exam_sessions WHERE id = ?').get(Number(sessionId));
    if (!session) return res.status(404).json({ error: 'Sesi tidak ditemukan' });

    if (session.status === 'LOCKED') {
      return res.status(423).json({
        error: 'Layar ujian Anda sedang TERKUNCI karena terdeteksi keluar aplikasi. Hubungi Pengawas Ruangan untuk membuka kunci.',
        status: 'LOCKED'
      });
    }
    if (session.status === 'FINISHED') {
      return res.status(400).json({ error: 'Ujian sudah selesai dikumpulkan', status: 'FINISHED' });
    }

    const exam = db.prepare('SELECT duration_minutes FROM exams WHERE id = ?').get(session.exam_id);
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(session.started_at).getTime()) / 1000));
    if (exam && elapsedSeconds > (exam.duration_minutes || 90) * 60) {
      db.prepare("UPDATE exam_sessions SET status = 'FINISHED', finished_at = ? WHERE id = ?").run(new Date().toISOString(), session.id);
      return res.status(400).json({ error: 'Waktu ujian telah habis', status: 'FINISHED' });
    }

    const validOption = String(chosenOption || '').toUpperCase().trim();
    if (!['A', 'B', 'C', 'D', 'E'].includes(validOption)) {
      return res.status(400).json({ error: 'Pilihan jawaban harus A, B, C, D, atau E' });
    }

    db.prepare(`
      INSERT INTO answers (session_id, question_id, chosen_option, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, question_id) DO UPDATE SET
        chosen_option = excluded.chosen_option,
        updated_at = excluded.updated_at
    `).run(session.id, Number(questionId), validOption, new Date().toISOString());

    res.json({ saved: true, questionId: Number(questionId), chosenOption: validOption });
  });

  app.post('/api/ujian/violation', (req, res) => {
    const { sessionId, reason } = req.body || {};
    const session = db.prepare('SELECT * FROM exam_sessions WHERE id = ?').get(Number(sessionId));
    if (!session) return res.status(404).json({ error: 'Sesi tidak ditemukan' });
    if (session.status === 'FINISHED') return res.json({ status: 'FINISHED' });

    const newCount = (session.violation_count || 0) + 1;
    const violationReason = reason || 'Terdeteksi keluar dari mode kunci Exambro / pindah aplikasi';
    db.prepare(`
      UPDATE exam_sessions
      SET status = 'LOCKED', violation_count = ?, last_violation_reason = ?
      WHERE id = ?
    `).run(newCount, violationReason, session.id);

    res.json({ status: 'LOCKED', violation_count: newCount, reason: violationReason });
  });

  app.post('/api/ujian/finish', (req, res) => {
    const { sessionId } = req.body || {};
    const session = db.prepare('SELECT * FROM exam_sessions WHERE id = ?').get(Number(sessionId));
    if (!session) return res.status(404).json({ error: 'Sesi tidak ditemukan' });
    if (session.status === 'LOCKED') {
      return res.status(423).json({ error: 'Sesi sedang terkunci. Minta pengawas membuka kunci terlebih dahulu.' });
    }

    const finishedAt = new Date().toISOString();
    db.prepare("UPDATE exam_sessions SET status = 'FINISHED', finished_at = ? WHERE id = ?").run(finishedAt, session.id);

    res.json({
      status: 'FINISHED',
      finished_at: finishedAt,
      message: 'Alhamdulillah, seluruh jawaban Pilihan Ganda Anda telah berhasil disimpan di Server CBT SMA Negeri 3 Buru. Pastikan Lembar Jawaban Kertas untuk Soal Esai telah diserahkan kepada Pengawas Ruangan.'
    });
  });

  return app;
}

module.exports = { createApp, getLocalLanIp, calculateExamScores };
