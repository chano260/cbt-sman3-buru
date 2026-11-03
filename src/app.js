const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const multer = require('multer');
const XLSX = require('xlsx');
const QRCode = require('qrcode');
const { parseDocxBuffer, parseQuestionsFromText, generateWordTemplateBuffer } = require('./wordParser');

const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // Maks 25 MB per file audio/gambar
});

function saveUploadedMediaFile(fileObj, prefix = 'media') {
  if (!fileObj || !fileObj.buffer) return null;
  const orig = String(fileObj.originalname || '').toLowerCase();
  const extMatch = orig.match(/\.(png|jpg|jpeg|gif|webp|svg|mp3|wav|ogg|m4a|aac)$/);
  const ext = extMatch ? extMatch[0] : (String(fileObj.mimetype || '').startsWith('audio/') ? '.mp3' : '.png');
  const filename = `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(uploadsDir, filename), fileObj.buffer);
  return `/uploads/${filename}`;
}
const TOKEN_ROTATION_SECONDS = 15 * 60; // 15 Menit (900 detik)

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

function generateRandomToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let token = '';
  for (let i = 0; i < 5; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

// Otomatis putar token jika sudah lewat 15 menit
function ensureFresh15MinToken(db, exam) {
  if (!exam) return null;
  const nowMs = Date.now();
  const updatedMs = exam.token_updated_at ? new Date(exam.token_updated_at).getTime() : 0;
  const elapsedSec = updatedMs ? Math.floor((nowMs - updatedMs) / 1000) : TOKEN_ROTATION_SECONDS + 1;

  if (!exam.token_updated_at || elapsedSec >= TOKEN_ROTATION_SECONDS) {
    let nextToken = generateRandomToken();
    while (nextToken === exam.token) {
      nextToken = generateRandomToken();
    }
    const nowIso = new Date(nowMs).toISOString();
    db.prepare('UPDATE exams SET token = ?, token_updated_at = ? WHERE id = ?').run(nextToken, nowIso, exam.id);
    exam.token = nextToken;
    exam.token_updated_at = nowIso;
    return { ...exam, token_remaining_seconds: TOKEN_ROTATION_SECONDS };
  }

  return {
    ...exam,
    token_remaining_seconds: Math.max(0, TOKEN_ROTATION_SECONDS - elapsedSec)
  };
}

// Pengacak urutan soal PG deterministik per siswa (anti-contek antar meja sebelahan)
function seededShufflePgQuestions(questions, seedNumber) {
  const pgList = questions.filter(q => q.type === 'PG');
  const esaiList = questions.filter(q => q.type === 'ESAI');
  const arr = [...pgList];
  let seed = Number(seedNumber) || 1;
  for (let i = arr.length - 1; i > 0; i--) {
    seed = (seed * 9301 + 49297) % 233280;
    const j = seed % (i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return [...arr, ...esaiList];
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
        need_token_reverify: 0,
        current_question_number: null,
        last_activity_at: null,
        violation_count: 0,
        last_violation_reason: null,
        answered_pg: 0,
        correct_pg: 0,
        wrong_pg: 0,
        total_pg: pgCount,
        recent_choices: [],
        score: 0
      };
    }

    const ansRows = db.prepare(`
      SELECT a.question_id, a.chosen_option, a.updated_at, q.number
      FROM answers a
      JOIN questions q ON q.id = a.question_id
      WHERE a.session_id = ?
      ORDER BY q.number ASC
    `).all(sess.id);

    let correct = 0;
    let answeredPg = 0;
    const recentChoices = [];
    for (const ans of ansRows) {
      if (keyMap.has(ans.question_id)) {
        answeredPg++;
        const chosen = (ans.chosen_option || '').toUpperCase();
        if (chosen === keyMap.get(ans.question_id)) {
          correct++;
        }
        recentChoices.push({ number: ans.number, chosen, updated_at: ans.updated_at });
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
      need_token_reverify: sess.need_token_reverify || 0,
      current_question_number: sess.current_question_number || 1,
      last_activity_at: sess.last_activity_at || sess.started_at,
      violation_count: sess.violation_count,
      last_violation_reason: sess.last_violation_reason,
      started_at: sess.started_at,
      finished_at: sess.finished_at,
      answered_pg: answeredPg,
      correct_pg: correct,
      wrong_pg: wrong,
      total_pg: pgCount,
      recent_choices: recentChoices,
      score: rawScore
    };
  });

  return { exam, pgCount, esaiCount, scores };
}

function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const staffTokens = new Map();
  // RAM Cache Soal Ujian untuk mendukung 500+ siswa serentak tanpa beban disk
  const questionsCache = new Map();

  function getCachedExamQuestions(examId) {
    if (questionsCache.has(examId)) return questionsCache.get(examId);
    const qs = db.prepare(`
      SELECT id, exam_id, number, type, question_text, image_data, audio_data, option_a, option_b, option_c, option_d, option_e
      FROM questions
      WHERE exam_id = ?
      ORDER BY CASE WHEN type = 'PG' THEN 0 ELSE 1 END, number ASC, id ASC
    `).all(examId);
    questionsCache.set(examId, qs);
    return qs;
  }

  function invalidateQuestionsCache(examId) {
    if (examId) questionsCache.delete(Number(examId));
    else questionsCache.clear();
  }

  function normalizeUrlInput(raw) {
    let val = String(raw || '').trim().replace(/\/+$/, '');
    if (!val) return '';
    // Bersihkan jika operator tidak sengaja menyalin /operator.html, /guru.html, /pengawas.html, /index.html, atau /ujian.html
    val = val.replace(/\/(operator|guru|pengawas|index|ujian)(\.html)?$/i, '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(val)) {
      // Jika berupa angka IP atau ada :port, gunakan http://, selain itu https://
      const isIpOrPort = /^(\d{1,3}\.){3}\d{1,3}/.test(val) || val.includes(':') || val.startsWith('localhost');
      val = (isIpOrPort ? 'http://' : 'https://') + val;
    }
    return val;
  }

  function getEffectiveBaseUrl(req) {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'public_url'").get();
    if (row && row.value && row.value.trim()) {
      return normalizeUrlInput(row.value);
    }
    const hostHeader = req && req.headers && req.headers.host ? String(req.headers.host).trim() : '';
    if (hostHeader && !hostHeader.startsWith('localhost') && !hostHeader.startsWith('127.0.0.1')) {
      const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
      return `${proto}://${hostHeader}`;
    }
    const portPart = hostHeader.includes(':') ? ':' + hostHeader.split(':')[1] : ':8080';
    return `http://${getLocalLanIp()}${portPart}`;
  }

  async function buildQrBundle(req) {
    const baseUrl = getEffectiveBaseUrl(req);
    const examUrl = baseUrl.endsWith('/ujian.html') ? baseUrl : `${baseUrl}/ujian.html`;
    const rowUrl = db.prepare("SELECT value FROM settings WHERE key = 'public_url'").get();
    const rowMode = db.prepare("SELECT value FROM settings WHERE key = 'qr_mode'").get();
    const rowCustomImg = db.prepare("SELECT value FROM settings WHERE key = 'custom_qr_image'").get();
    const qrMode = (rowMode && rowMode.value) ? rowMode.value : 'url_ujian';

    let qrPayload = examUrl;
    if (qrMode === 'url_root') {
      qrPayload = baseUrl;
    } else if (qrMode === 'no_scheme') {
      qrPayload = examUrl.replace(/^https?:\/\//i, '');
    } else if (qrMode === 'base64') {
      qrPayload = Buffer.from(examUrl, 'utf8').toString('base64');
    }

    let qrDataUrl;
    if (qrMode === 'custom_image' && rowCustomImg && rowCustomImg.value) {
      qrDataUrl = rowCustomImg.value;
    } else {
      qrDataUrl = await QRCode.toDataURL(qrPayload, { width: 240, margin: 1 });
    }

    return {
      publicUrl: rowUrl ? rowUrl.value : '',
      qrMode,
      qrPayload,
      baseUrl,
      examUrl,
      qrDataUrl
    };
  }

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

  app.get('/api/server-info', (req, res) => {
    const rawExam = db.prepare('SELECT id, title, subject, class_target, exam_date, start_time, session_name, duration_minutes, token, token_updated_at FROM exams WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
    const activeExam = ensureFresh15MinToken(db, rawExam);
    res.json({
      school: 'SMA NEGERI 3 BURU',
      lanIp: getLocalLanIp(),
      activeExam: activeExam ? {
        id: activeExam.id,
        title: activeExam.title,
        subject: activeExam.subject,
        class_target: activeExam.class_target,
        exam_date: activeExam.exam_date,
        start_time: activeExam.start_time,
        session_name: activeExam.session_name,
        duration_minutes: activeExam.duration_minutes
      } : null
    });
  });

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
  app.get('/api/operator/overview', requireStaffAuth(['operator']), async (req, res) => {
    const exams = db.prepare('SELECT * FROM exams ORDER BY id DESC').all();
    const rawActive = exams.find(e => e.is_active === 1) || exams[0];
    const activeExam = ensureFresh15MinToken(db, rawActive);
    const students = db.prepare('SELECT * FROM students ORDER BY room ASC, seat_number ASC, full_name ASC').all();
    const staff = db.prepare('SELECT id, username, full_name, role, subject, room FROM users ORDER BY role ASC, id ASC').all();
    const scoreData = activeExam ? calculateExamScores(db, activeExam.id) : { scores: [], pgCount: 0, esaiCount: 0 };
    const qrBundle = await buildQrBundle(req);

    res.json({
      lanIp: getLocalLanIp(),
      ...qrBundle,
      activeExam,
      exams,
      students,
      staff,
      monitoring: scoreData.scores,
      pgCount: scoreData.pgCount,
      esaiCount: scoreData.esaiCount
    });
  });

  app.post('/api/operator/public-url', requireStaffAuth(['operator']), async (req, res) => {
    let { publicUrl, qrMode, customQrImage } = req.body || {};
    if (publicUrl !== undefined) {
      publicUrl = normalizeUrlInput(publicUrl);
      db.prepare(`
        INSERT INTO settings (key, value) VALUES ('public_url', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(publicUrl);
    }
    if (qrMode) {
      db.prepare(`
        INSERT INTO settings (key, value) VALUES ('qr_mode', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(qrMode));
    }
    if (customQrImage) {
      db.prepare(`
        INSERT INTO settings (key, value) VALUES ('custom_qr_image', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(customQrImage));
    }
    const qrBundle = await buildQrBundle(req);
    res.json(qrBundle);
  });

  app.post('/api/operator/token', requireStaffAuth(['operator']), (req, res) => {
    const { examId, customToken } = req.body || {};
    const newToken = customToken ? String(customToken).toUpperCase().trim() : generateRandomToken();
    const targetExam = examId
      ? db.prepare('SELECT id FROM exams WHERE id = ?').get(examId)
      : db.prepare('SELECT id FROM exams WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
    if (!targetExam) return res.status(404).json({ error: 'Ujian tidak ditemukan' });

    const nowIso = new Date().toISOString();
    db.prepare('UPDATE exams SET token = ?, token_updated_at = ? WHERE id = ?').run(newToken, nowIso, targetExam.id);
    res.json({ examId: targetExam.id, token: newToken, token_remaining_seconds: TOKEN_ROTATION_SECONDS });
  });

  app.post('/api/operator/exams', requireStaffAuth(['operator']), (req, res) => {
    const { title, subject, class_target, exam_date, start_time, session_name, duration_minutes, shuffle_questions } = req.body || {};
    if (!title || !subject) return res.status(400).json({ error: 'Nama ujian dan mata pelajaran wajib diisi' });
    const token = generateRandomToken();
    const nowIso = new Date().toISOString();
    db.prepare('UPDATE exams SET is_active = 0').run();
    const info = db.prepare(`
      INSERT INTO exams (title, subject, class_target, exam_date, start_time, session_name, duration_minutes, token, token_updated_at, shuffle_questions, is_active, teacher_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 2)
    `).run(
      title,
      subject,
      class_target || 'XII IPA 1',
      exam_date || '2026-11-02',
      start_time || '08:00 WIT',
      session_name || 'Sesi 1',
      Number(duration_minutes) || 90,
      token,
      nowIso,
      shuffle_questions !== undefined ? (shuffle_questions ? 1 : 0) : 1
    );
    res.json({ id: Number(info.lastInsertRowid), token });
  });

  app.post('/api/operator/exams/:id/activate', requireStaffAuth(['operator']), (req, res) => {
    const examId = Number(req.params.id);
    db.prepare('UPDATE exams SET is_active = 0').run();
    db.prepare('UPDATE exams SET is_active = 1, token_updated_at = ? WHERE id = ?').run(new Date().toISOString(), examId);
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

  // Template Excel Import Peserta Ujian
  app.get('/api/operator/template-students-excel', requireStaffAuth(['operator']), (req, res) => {
    const sampleRows = [
      {
        'Nomor Peserta': '26-03-009',
        'NISN': '0081234509',
        'Nama Siswa': 'Dewi Sartika Wabula',
        'Kelas': 'XII IPA 1',
        'Ruang': 'Ruang 01',
        'Nomor Meja': 7,
        'Password': 'BURU09'
      },
      {
        'Nomor Peserta': '26-03-010',
        'NISN': '0081234510',
        'Nama Siswa': 'Hendra Saputra Namlea',
        'Kelas': 'XII IPA 1',
        'Ruang': 'Ruang 01',
        'Nomor Meja': 8,
        'Password': 'BURU10'
      }
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(sampleRows);
    XLSX.utils.book_append_sheet(wb, ws, 'Template Peserta CBT');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Template-Import-Siswa-SMAN3-Buru.xlsx"');
    res.send(buf);
  });

  // Import Data Peserta Sekaligus dari Excel (.xlsx)
  app.post('/api/operator/students/import-excel', requireStaffAuth(['operator']), upload.single('file'), (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: 'File Excel (.xlsx) tidak ditemukan' });
      }
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);
      if (!rows || rows.length === 0) {
        return res.status(400).json({ error: 'File Excel kosong' });
      }

      const upsertStudent = db.prepare(`
        INSERT INTO students (exam_number, nisn, full_name, class_name, room, seat_number, password)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(exam_number) DO UPDATE SET
          nisn = excluded.nisn,
          full_name = excluded.full_name,
          class_name = excluded.class_name,
          room = excluded.room,
          seat_number = excluded.seat_number,
          password = excluded.password
      `);

      let importedCount = 0;
      rows.forEach((r, idx) => {
        const examNo = String(r['Nomor Peserta'] || r['No Peserta'] || r['exam_number'] || '').trim();
        const fullName = String(r['Nama Siswa'] || r['Nama Lengkap'] || r['Nama'] || r['full_name'] || '').trim();
        if (!examNo || !fullName) return;
        const nisn = String(r['NISN'] || r['nisn'] || '-').trim();
        const className = String(r['Kelas'] || r['class_name'] || 'XII IPA 1').trim();
        const room = String(r['Ruang'] || r['room'] || 'Ruang 01').trim();
        const seatNo = Number(r['Nomor Meja'] || r['Meja'] || r['seat_number'] || idx + 1);
        const pass = String(r['Password'] || r['password'] || `BURU${String(idx + 1).padStart(2, '0')}`).trim();

        upsertStudent.run(examNo, nisn, fullName, className, room, seatNo, pass);
        importedCount++;
      });

      res.json({ importedCount });
    } catch (err) {
      res.status(500).json({ error: 'Gagal mengimpor file Excel: ' + err.message });
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

  app.get('/api/operator/print-data', requireStaffAuth(['operator']), async (req, res) => {
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
    const qrBundle = await buildQrBundle(req);
    res.json({
      schoolHeader: {
        gov: 'PEMERINTAH PROVINSI MALUKU',
        dept: 'DINAS PENDIDIKAN DAN KEBUDAYAAN',
        school: 'SMA NEGERI 3 BURU',
        address: 'Kabupaten Buru, Provinsi Maluku'
      },
      lanIp: getLocalLanIp(),
      ...qrBundle,
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

  const mediaFieldsUpload = upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'audio', maxCount: 1 }
  ]);

  app.post('/api/guru/exams/:id/questions', requireStaffAuth(['guru', 'operator']), mediaFieldsUpload, (req, res) => {
    const examId = Number(req.params.id);
    const { number, type, question_text, option_a, option_b, option_c, option_d, option_e, answer_key, image_data, audio_data } = req.body || {};
    if (!question_text) return res.status(400).json({ error: 'Teks soal wajib diisi' });
    const qType = type === 'ESAI' ? 'ESAI' : 'PG';

    const imgFile = req.files && req.files.image ? req.files.image[0] : null;
    const audFile = req.files && req.files.audio ? req.files.audio[0] : null;
    const savedImg = imgFile ? saveUploadedMediaFile(imgFile, 'img') : (image_data || null);
    const savedAud = audFile ? saveUploadedMediaFile(audFile, 'audio') : (audio_data || null);

    const info = db.prepare(`
      INSERT INTO questions (exam_id, number, type, question_text, image_data, audio_data, option_a, option_b, option_c, option_d, option_e, answer_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      examId,
      Number(number) || 1,
      qType,
      question_text,
      savedImg,
      savedAud,
      qType === 'PG' ? (option_a || '') : null,
      qType === 'PG' ? (option_b || '') : null,
      qType === 'PG' ? (option_c || '') : null,
      qType === 'PG' ? (option_d || '') : null,
      qType === 'PG' ? (option_e || '') : null,
      qType === 'PG' ? String(answer_key || 'A').toUpperCase() : null
    );
    invalidateQuestionsCache(examId);
    res.json({ id: Number(info.lastInsertRowid), image_data: savedImg, audio_data: savedAud });
  });

  // Upload atau Ganti Gambar & Audio Listening (.mp3/.wav) pada Soal Tertentu
  app.post('/api/guru/questions/:questionId/media', requireStaffAuth(['guru', 'operator']), mediaFieldsUpload, (req, res) => {
    const questionId = Number(req.params.questionId);
    const existing = db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId);
    if (!existing) return res.status(404).json({ error: 'Soal tidak ditemukan' });

    const imgFile = req.files && req.files.image ? req.files.image[0] : null;
    const audFile = req.files && req.files.audio ? req.files.audio[0] : null;

    let nextImg = existing.image_data;
    let nextAud = existing.audio_data;

    if (imgFile) nextImg = saveUploadedMediaFile(imgFile, `q${questionId}-img`);
    if (audFile) nextAud = saveUploadedMediaFile(audFile, `q${questionId}-audio`);
    if (req.body && String(req.body.clearImage) === 'true') nextImg = null;
    if (req.body && String(req.body.clearAudio) === 'true') nextAud = null;

    db.prepare('UPDATE questions SET image_data = ?, audio_data = ? WHERE id = ?').run(nextImg, nextAud, questionId);
    invalidateQuestionsCache(existing.exam_id);
    res.json({ id: questionId, image_data: nextImg, audio_data: nextAud });
  });

  app.delete('/api/guru/questions/:questionId', requireStaffAuth(['guru', 'operator']), (req, res) => {
    db.prepare('DELETE FROM questions WHERE id = ?').run(Number(req.params.questionId));
    invalidateQuestionsCache();
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

      invalidateQuestionsCache(examId);

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

  // ==================== PANEL PENGAWAS RUANGAN & PANTAU KERJA SISWA ====================
  app.get('/api/pengawas/room', requireStaffAuth(['pengawas', 'operator']), async (req, res) => {
    const room = req.query.room || 'ALL';
    const rawExam = db.prepare('SELECT * FROM exams WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
    const activeExam = ensureFresh15MinToken(db, rawExam);
    const qrBundle = await buildQrBundle(req);
    if (!activeExam) return res.json({ activeExam: null, ...qrBundle, students: [], reports: [] });

    const scoreData = calculateExamScores(db, activeExam.id);
    const filtered = scoreData.scores
      .filter(s => room === 'ALL' || s.room === room)
      .map(({ score, correct_pg, wrong_pg, ...rest }) => rest);

    const reports = db.prepare('SELECT * FROM room_reports WHERE exam_id = ? ORDER BY id DESC').all(activeExam.id);
    res.json({
      ...qrBundle,
      activeExam: {
        id: activeExam.id,
        title: activeExam.title,
        subject: activeExam.subject,
        session_name: activeExam.session_name,
        token: activeExam.token,
        token_remaining_seconds: activeExam.token_remaining_seconds,
        duration_minutes: activeExam.duration_minutes
      },
      pgCount: scoreData.pgCount,
      esaiCount: scoreData.esaiCount,
      students: filtered,
      reports
    });
  });

  // Endpoint Intip / Pantau Kerja Siswa Secara Langsung untuk Operator & Pengawas (Anti-Contek)
  app.get('/api/pengawas/student-work/:sessionId', requireStaffAuth(['pengawas', 'operator']), (req, res) => {
    const sessionId = Number(req.params.sessionId);
    const session = db.prepare('SELECT * FROM exam_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ error: 'Sesi siswa tidak ditemukan' });

    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(session.student_id);
    const questions = db.prepare('SELECT id, number, type, question_text, option_a, option_b, option_c, option_d, option_e FROM questions WHERE exam_id = ? ORDER BY number ASC').all(session.exam_id);
    const answers = db.prepare('SELECT question_id, chosen_option, updated_at FROM answers WHERE session_id = ?').all(sessionId);
    const ansMap = new Map(answers.map(a => [a.question_id, a]));

    const workDetail = questions.map(q => {
      const a = ansMap.get(q.id);
      return {
        question_id: q.id,
        number: q.number,
        type: q.type,
        question_snippet: q.question_text.slice(0, 95) + (q.question_text.length > 95 ? '...' : ''),
        chosen_option: a ? a.chosen_option : null,
        updated_at: a ? a.updated_at : null,
        is_current: (session.current_question_number || 1) === q.number
      };
    });

    res.json({
      student,
      session,
      workDetail
    });
  });

  app.post('/api/pengawas/unlock/:sessionId', requireStaffAuth(['pengawas', 'operator']), (req, res) => {
    const sessionId = Number(req.params.sessionId);
    // Saat dibuka kuncinya oleh pengawas, siswa berstatus WORKING tetapi wajib memasukkan Token 15-menit terbaru (need_token_reverify = 1)
    db.prepare("UPDATE exam_sessions SET status = 'WORKING', need_token_reverify = 1 WHERE id = ?").run(sessionId);
    res.json({ ok: true, sessionId, status: 'WORKING', need_token_reverify: 1 });
  });

  app.post('/api/pengawas/reset-login/:sessionId', requireStaffAuth(['pengawas', 'operator']), (req, res) => {
    const sessionId = Number(req.params.sessionId);
    db.prepare("UPDATE exam_sessions SET status = 'WORKING', need_token_reverify = 1, device_info = NULL WHERE id = ?").run(sessionId);
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
  app.post('/api/ujian/login', (req, res) => {
    const { exam_number, password, token, device_info } = req.body || {};
    const student = db.prepare('SELECT * FROM students WHERE exam_number = ? AND password = ?').get(
      String(exam_number || '').trim(),
      String(password || '').trim()
    );
    if (!student) {
      return res.status(401).json({ error: 'Nomor Peserta atau Password salah!' });
    }

    const rawExam = db.prepare('SELECT * FROM exams WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
    const activeExam = ensureFresh15MinToken(db, rawExam);
    if (!activeExam) {
      return res.status(404).json({ error: 'Belum ada jadwal ujian yang diaktifkan oleh Operator.' });
    }

    if (String(token || '').toUpperCase().trim() !== String(activeExam.token).toUpperCase().trim()) {
      return res.status(403).json({ error: 'Token Ujian tidak sesuai atau sudah berganti (Token berganti otomatis tiap 15 menit)! Tanyakan Token terbaru ke Pengawas Ruangan.' });
    }

    let session = db.prepare('SELECT * FROM exam_sessions WHERE exam_id = ? AND student_id = ?').get(activeExam.id, student.id);
    const nowIso = new Date().toISOString();
    if (!session) {
      const info = db.prepare(`
        INSERT INTO exam_sessions (exam_id, student_id, status, need_token_reverify, current_question_number, last_activity_at, violation_count, started_at, device_info)
        VALUES (?, ?, 'WORKING', 0, 1, ?, 0, ?, ?)
      `).run(activeExam.id, student.id, nowIso, nowIso, device_info || 'Exambro Android');
      session = db.prepare('SELECT * FROM exam_sessions WHERE id = ?').get(Number(info.lastInsertRowid));
    } else {
      // Karena siswa baru saja memasukkan Token 15-menit terbaru saat login, matikan flag need_token_reverify
      db.prepare('UPDATE exam_sessions SET need_token_reverify = 0, last_activity_at = ? WHERE id = ?').run(nowIso, session.id);
      session.need_token_reverify = 0;
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

  // Verifikasi Token 15-Menit Terbaru saat siswa selesai gangguan / dibuka kuncinya di tengah ujian
  app.post('/api/ujian/verify-resume-token', (req, res) => {
    const { sessionId, token } = req.body || {};
    const session = db.prepare('SELECT * FROM exam_sessions WHERE id = ?').get(Number(sessionId));
    if (!session) return res.status(404).json({ error: 'Sesi tidak ditemukan' });
    if (session.status === 'LOCKED') {
      return res.status(423).json({ error: 'Pengawas Ruangan belum menekan tombol Buka Kunci untuk Anda.' });
    }

    const rawExam = db.prepare('SELECT * FROM exams WHERE id = ?').get(session.exam_id);
    const activeExam = ensureFresh15MinToken(db, rawExam);
    if (String(token || '').toUpperCase().trim() !== String(activeExam.token).toUpperCase().trim()) {
      return res.status(403).json({ error: 'Token 15-Menit tidak sesuai! Minta Token terbaru dari Pengawas Ruangan.' });
    }

    db.prepare('UPDATE exam_sessions SET need_token_reverify = 0, last_activity_at = ? WHERE id = ?').run(new Date().toISOString(), session.id);
    res.json({ status: 'WORKING', need_token_reverify: 0 });
  });

  // Heartbeat posisi soal yang sedang dikerjakan siswa
  app.post('/api/ujian/heartbeat', (req, res) => {
    const { sessionId, currentQuestionNumber } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId wajib' });
    db.prepare('UPDATE exam_sessions SET current_question_number = ?, last_activity_at = ? WHERE id = ?').run(
      Number(currentQuestionNumber) || 1,
      new Date().toISOString(),
      Number(sessionId)
    );
    res.json({ ok: true });
  });

  app.get('/api/ujian/session/:sessionId', (req, res) => {
    const sessionId = Number(req.params.sessionId);
    const session = db.prepare('SELECT * FROM exam_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ error: 'Sesi ujian tidak ditemukan' });

    const student = db.prepare('SELECT id, exam_number, full_name, class_name, room, seat_number FROM students WHERE id = ?').get(session.student_id);
    const exam = db.prepare('SELECT id, title, subject, class_target, session_name, duration_minutes, shuffle_questions FROM exams WHERE id = ?').get(session.exam_id);

    let questions = getCachedExamQuestions(session.exam_id);

    // Acak urutan soal PG secara deterministik per siswa agar siswa bersebelahan tidak bisa saling contek nomor
    if (exam && exam.shuffle_questions) {
      questions = seededShufflePgQuestions(questions, student.id * 17 + session.id);
    }

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
        need_token_reverify: session.need_token_reverify || 0,
        current_question_number: session.current_question_number || 1,
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
    const { sessionId, questionId, chosenOption, currentQuestionNumber } = req.body || {};
    const session = db.prepare('SELECT * FROM exam_sessions WHERE id = ?').get(Number(sessionId));
    if (!session) return res.status(404).json({ error: 'Sesi tidak ditemukan' });

    if (session.status === 'LOCKED') {
      return res.status(423).json({
        error: 'Layar ujian Anda sedang TERKUNCI karena terdeteksi keluar aplikasi. Hubungi Pengawas Ruangan untuk membuka kunci.',
        status: 'LOCKED'
      });
    }
    if (session.need_token_reverify) {
      return res.status(428).json({
        error: 'Silakan masukkan Token 15-Menit terbaru dari Pengawas untuk melanjutkan ujian setelah gangguan.',
        status: 'NEED_TOKEN'
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

    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO answers (session_id, question_id, chosen_option, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, question_id) DO UPDATE SET
        chosen_option = excluded.chosen_option,
        updated_at = excluded.updated_at
    `).run(session.id, Number(questionId), validOption, nowIso);

    if (currentQuestionNumber) {
      db.prepare('UPDATE exam_sessions SET current_question_number = ?, last_activity_at = ? WHERE id = ?').run(Number(currentQuestionNumber), nowIso, session.id);
    } else {
      db.prepare('UPDATE exam_sessions SET last_activity_at = ? WHERE id = ?').run(nowIso, session.id);
    }

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
      SET status = 'LOCKED', need_token_reverify = 1, violation_count = ?, last_violation_reason = ?, last_activity_at = ?
      WHERE id = ?
    `).run(newCount, violationReason, new Date().toISOString(), session.id);

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

  // Fallback anti-404 untuk semua variasi path dari aplikasi Exambro Scan QR (/ujian, /ujian.html/, /operator.html/ujian.html, /login, dll.)
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      return res.sendFile(path.join(__dirname, '..', 'public', 'ujian.html'));
    }
    next();
  });

  return app;
}

module.exports = { createApp, getLocalLanIp, calculateExamScores };
