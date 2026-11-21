const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const multer = require('multer');
const XLSX = require('xlsx');
const QRCode = require('qrcode');
const { parseDocxBuffer, parseQuestionsFromText, generateWordTemplateBuffer } = require('./wordParser');
const { hashPassword, verifyPassword, safeEqual, randomToken } = require('./security');

const STAFF_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // Token login staf berlaku 12 jam
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // Maks 25 MB per file audio/gambar
});

// SVG sengaja tidak diizinkan: file SVG dapat memuat skrip (stored XSS) karena disajikan dari domain yang sama
const ALLOWED_MEDIA_EXT = {
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp'],
  audio: ['.mp3', '.wav', '.ogg', '.m4a', '.aac']
};

function isAllowedMediaFile(fileObj, kind) {
  if (!fileObj) return true;
  const orig = String(fileObj.originalname || '').toLowerCase();
  const ext = path.extname(orig);
  const mime = String(fileObj.mimetype || '').toLowerCase();
  if (!ALLOWED_MEDIA_EXT[kind].includes(ext)) return false;
  if (mime.includes('svg') || mime.includes('html') || mime.includes('xml')) return false;
  return true;
}

function saveUploadedMediaFile(fileObj, prefix = 'media') {
  if (!fileObj || !fileObj.buffer) return null;
  const orig = String(fileObj.originalname || '').toLowerCase();
  const extMatch = orig.match(/\.(png|jpg|jpeg|gif|webp|mp3|wav|ogg|m4a|aac)$/);
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

// Pencocokan ujian aktif sesuai kelas siswa (multi-guru per mapel, anti-tertukar)
function getActiveExamForStudent(db, className) {
  if (className && className !== '-' && className !== 'ALL' && className !== 'Semua Kelas') {
    const cleanClass = String(className).trim();
    const specific = db.prepare(`
      SELECT * FROM exams 
      WHERE is_active = 1 
        AND (class_target = 'ALL' OR class_target = 'Semua Kelas' OR class_target LIKE '%' || ? || '%')
      ORDER BY id DESC LIMIT 1
    `).get(cleanClass);
    if (specific) return ensureFresh15MinToken(db, specific);
  }
  const fallback = db.prepare('SELECT * FROM exams WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
  return ensureFresh15MinToken(db, fallback);
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

function copyQuestions(db, sourceExamId, targetExamId) {
  const sourceQuestions = db.prepare('SELECT * FROM questions WHERE exam_id = ? ORDER BY number ASC, id ASC').all(Number(sourceExamId));
  if (!sourceQuestions || sourceQuestions.length === 0) return 0;

  const insert = db.prepare(`
    INSERT INTO questions (exam_id, number, type, question_text, image_data, audio_data, option_a, option_b, option_c, option_d, option_e, answer_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction((qs) => {
    for (const q of qs) {
      insert.run(
        Number(targetExamId),
        q.number,
        q.type,
        q.question_text,
        q.image_data,
        q.audio_data,
        q.option_a,
        q.option_b,
        q.option_c,
        q.option_d,
        q.option_e,
        q.answer_key
      );
    }
  });
  tx(sourceQuestions);
  return sourceQuestions.length;
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
        exam_id: exam.id,
        exam_subject: exam.subject,
        exam_title: exam.title,
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
      exam_id: exam.id,
      exam_subject: exam.subject,
      exam_title: exam.title,
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

  function subjectMatches(teacherSubjectStr, examSubjectStr) {
    if (!teacherSubjectStr || !examSubjectStr) return false;
    const teacherSubjs = teacherSubjectStr
      .split(/[,;&/]+/)
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    const examSubj = String(examSubjectStr || '').trim().toLowerCase();

    return teacherSubjs.some(ts => {
      if (ts === examSubj) return true;
      if (examSubj.includes(ts) || ts.includes(examSubj)) return true;
      return false;
    });
  }

  function teacherCanAccessExam(staffUser, examOrObj) {
    if (!examOrObj || !staffUser) return false;
    if (staffUser.role === 'operator') return true;
    if (staffUser.role !== 'guru') return false;

    // 1. Akun guru WAJIB mengampu mata pelajaran ini!
    if (staffUser.subject && !subjectMatches(staffUser.subject, examOrObj.subject)) {
      return false;
    }

    // 2. Jika mapel cocok:
    const teacherId = Number(staffUser.id);
    if (examOrObj.teacher_id !== null && examOrObj.teacher_id !== undefined) {
      if (Number(examOrObj.teacher_id) === teacherId) return true;

      // Cek apakah guru yang tersimpan di teacher_id mapelnya tidak cocok dengan exam (sisa bug lama)
      const assigned = db.prepare('SELECT id, subject FROM users WHERE id = ?').get(examOrObj.teacher_id);
      if (!assigned || (assigned.subject && !subjectMatches(assigned.subject, examOrObj.subject))) {
        return true;
      }

      return false;
    }

    return true;
  }

  // Ambil akun staf dari token. Data akun selalu dibaca ulang dari DB, sehingga akun yang
  // dihapus / diubah perannya langsung kehilangan akses. Token query string hanya untuk unduhan GET.
  function getStaffFromReq(req) {
    const authHeader = req.headers.authorization || '';
    let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token && req.method === 'GET') token = String(req.query.staffToken || '');
    if (!token) return null;
    const entry = staffTokens.get(token);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      staffTokens.delete(token);
      return null;
    }
    const user = db.prepare('SELECT id, username, full_name, role, subject, room FROM users WHERE id = ?').get(entry.userId);
    if (!user) {
      staffTokens.delete(token);
      return null;
    }
    return user;
  }

  // Verifikasi bahwa request siswa membawa token sesi milik sesi ujian yang dimaksud (anti-IDOR)
  function requireStudentSession(req, res, next) {
    const rawId = (req.params && req.params.sessionId) || (req.body && req.body.sessionId) || (req.query && req.query.sessionId);
    const sessionId = Number(rawId);
    if (!sessionId) return res.status(400).json({ error: 'sessionId wajib diisi.' });
    const session = db.prepare('SELECT * FROM exam_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ error: 'Sesi ujian tidak ditemukan.' });
    const provided = req.headers['x-session-token'];
    if (!session.session_token || !safeEqual(provided, session.session_token)) {
      return res.status(401).json({ error: 'Sesi login tidak valid atau sudah dipakai di perangkat lain. Silakan login ulang.', status: 'UNAUTHORIZED' });
    }
    req.examSession = session;
    next();
  }

  const loginFailures = new Map();
  function loginKey(req, username) {
    return `${req.ip}|${String(username || '').trim().toLowerCase()}`;
  }

  function requireStaffAuth(allowedRoles) {
    return (req, res, next) => {
      const staffUser = getStaffFromReq(req);
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
    const activeExam = getActiveExamForStudent(db, req.query.class_name);
    // Token ujian hanya ditampilkan untuk staf yang login (papan token ruang ujian)
    const showToken = !!getStaffFromReq(req);
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
        duration_minutes: activeExam.duration_minutes,
        token: showToken ? activeExam.token : undefined,
        token_remaining_seconds: showToken ? activeExam.token_remaining_seconds : undefined
      } : null
    });
  });

  app.post('/api/staff/login', (req, res) => {
    const { username, password, role } = req.body || {};
    const key = loginKey(req, username);
    const fail = loginFailures.get(key);
    if (fail && fail.count >= LOGIN_MAX_FAILS && Date.now() - fail.firstAt < LOGIN_LOCK_MS) {
      const waitMin = Math.ceil((LOGIN_LOCK_MS - (Date.now() - fail.firstAt)) / 60000);
      return res.status(429).json({ error: `Terlalu banyak percobaan login gagal. Coba lagi dalam ${waitMin} menit.` });
    }

    const row = db.prepare('SELECT id, username, password, full_name, role, subject, room FROM users WHERE username = ?').get(String(username || '').trim());
    if (!row || !verifyPassword(String(password || '').trim(), row.password)) {
      const cur = (fail && Date.now() - fail.firstAt < LOGIN_LOCK_MS) ? fail : { count: 0, firstAt: Date.now() };
      cur.count++;
      loginFailures.set(key, cur);
      return res.status(401).json({ error: 'Username atau password salah' });
    }
    loginFailures.delete(key);
    const { password: _pw, ...user } = row;
    if (role && user.role !== role && user.role !== 'operator') {
      return res.status(403).json({ error: `Akun ini bukan untuk panel ${role.toUpperCase()}` });
    }
    const staffToken = randomToken(24);
    staffTokens.set(staffToken, { userId: user.id, expiresAt: Date.now() + STAFF_TOKEN_TTL_MS });
    res.json({ user, staffToken });
  });

  app.post('/api/staff/logout', (req, res) => {
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) staffTokens.delete(authHeader.slice(7).trim());
    res.json({ ok: true });
  });

  // ==================== PANEL OPERATOR ====================
  app.get('/api/operator/overview', requireStaffAuth(['operator']), async (req, res) => {
    const exams = db.prepare(`
      SELECT e.*,
        u.full_name AS teacher_name,
        u.username AS teacher_username,
        (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.id AND q.type = 'PG') AS pg_count,
        (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.id AND q.type = 'ESAI') AS esai_count,
        (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.id) AS total_questions
      FROM exams e
      LEFT JOIN users u ON e.teacher_id = u.id
      ORDER BY e.id DESC
    `).all();
    const rawActive = exams.find(e => e.is_active === 1) || exams[0];
    const activeExam = ensureFresh15MinToken(db, rawActive);
    const students = db.prepare('SELECT * FROM students ORDER BY room ASC, seat_number ASC, full_name ASC').all();
    const staff = db.prepare('SELECT id, username, full_name, role, subject, room FROM users ORDER BY role ASC, id ASC').all();

    const requestedExamId = req.query.exam_id;
    let monitoring = [];
    let pgCount = activeExam?.pg_count || 0;
    let esaiCount = activeExam?.esai_count || 0;

    if (requestedExamId && requestedExamId !== 'ALL') {
      const targetExamId = Number(requestedExamId);
      const scoreData = calculateExamScores(db, targetExamId);
      monitoring = scoreData.scores;
      pgCount = scoreData.pgCount;
      esaiCount = scoreData.esaiCount;
    } else {
      // Pantauan live menyeluruh: tampilkan semua siswa beserta status sesi ujian terbarunya
      const allSessions = db.prepare(`
        SELECT s.*, e.subject AS exam_subject, e.title AS exam_title
        FROM exam_sessions s
        JOIN exams e ON e.id = s.exam_id
        ORDER BY s.last_activity_at DESC, s.id DESC
      `).all();

      const latestSessionByStudent = new Map();
      for (const s of allSessions) {
        if (!latestSessionByStudent.has(s.student_id)) {
          latestSessionByStudent.set(s.student_id, s);
        } else if (activeExam && s.exam_id === activeExam.id) {
          latestSessionByStudent.set(s.student_id, s);
        }
      }

      const examIdsInSessions = [...new Set(allSessions.map(s => s.exam_id))];
      const examDataCache = new Map();
      for (const exId of examIdsInSessions) {
        const pgs = db.prepare("SELECT id, number, answer_key FROM questions WHERE exam_id = ? AND type = 'PG'").all(exId);
        examDataCache.set(exId, {
          pgCount: pgs.length,
          keyMap: new Map(pgs.map(q => [q.id, (q.answer_key || '').toUpperCase()]))
        });
      }

      monitoring = students.map(st => {
        const sess = latestSessionByStudent.get(st.id);
        if (!sess) {
          return {
            student_id: st.id,
            session_id: null,
            exam_id: activeExam?.id || null,
            exam_subject: activeExam?.subject || '-',
            exam_title: activeExam?.title || '-',
            exam_number: st.exam_number,
            nisn: st.nisn,
            full_name: st.full_name,
            class_name: st.class_name,
            room: st.room,
            seat_number: st.seat_number,
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

        const cache = examDataCache.get(sess.exam_id) || { pgCount: 0, keyMap: new Map() };
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
          if (cache.keyMap.has(ans.question_id)) {
            answeredPg++;
            const chosen = (ans.chosen_option || '').toUpperCase();
            if (chosen === cache.keyMap.get(ans.question_id)) correct++;
            recentChoices.push({ number: ans.number, chosen, updated_at: ans.updated_at });
          }
        }
        const wrong = Math.max(0, answeredPg - correct);
        const score = cache.pgCount > 0 ? Number(((correct / cache.pgCount) * 100).toFixed(1)) : 0;

        return {
          student_id: st.id,
          session_id: sess.id,
          exam_id: sess.exam_id,
          exam_subject: sess.exam_subject,
          exam_title: sess.exam_title,
          exam_number: st.exam_number,
          nisn: st.nisn,
          full_name: st.full_name,
          class_name: st.class_name,
          room: st.room,
          seat_number: st.seat_number,
          status: sess.status,
          need_token_reverify: sess.need_token_reverify || 0,
          current_question_number: sess.current_question_number || 1,
          last_activity_at: sess.last_activity_at || sess.started_at,
          violation_count: sess.violation_count,
          last_violation_reason: sess.last_violation_reason,
          answered_pg: answeredPg,
          correct_pg: correct,
          wrong_pg: wrong,
          total_pg: cache.pgCount,
          recent_choices: recentChoices,
          score
        };
      });
    }

    const qrBundle = await buildQrBundle(req);
    const classes = db.prepare("SELECT DISTINCT class_name FROM students WHERE class_name IS NOT NULL AND class_name != '' ORDER BY class_name ASC").all().map(r => r.class_name);
    const teachers = db.prepare("SELECT id, username, full_name, subject FROM users WHERE role = 'guru' ORDER BY full_name ASC").all();

    res.json({
      lanIp: getLocalLanIp(),
      ...qrBundle,
      activeExam,
      exams,
      students,
      staff,
      classes,
      teachers,
      monitoring,
      pgCount,
      esaiCount
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
    const { exam_id, title, subject, class_target, exam_date, start_time, session_name, duration_minutes, shuffle_questions } = req.body || {};
    if (!subject) return res.status(400).json({ error: 'Mata pelajaran wajib diisi' });
    const nowIso = new Date().toISOString();

    if (exam_id) {
      const existing = db.prepare('SELECT * FROM exams WHERE id = ?').get(Number(exam_id));
      if (existing) {
        const token = generateRandomToken();
        db.prepare('UPDATE exams SET is_active = 0').run();
        db.prepare(`
          UPDATE exams
          SET title = COALESCE(NULLIF(?, ''), title),
              subject = COALESCE(NULLIF(?, ''), subject),
              class_target = COALESCE(NULLIF(?, ''), class_target),
              exam_date = COALESCE(NULLIF(?, ''), exam_date),
              start_time = COALESCE(NULLIF(?, ''), start_time),
              session_name = COALESCE(NULLIF(?, ''), session_name),
              duration_minutes = COALESCE(?, duration_minutes),
              token = ?,
              token_updated_at = ?,
              is_active = 1
          WHERE id = ?
        `).run(
          title,
          subject,
          class_target || existing.class_target,
          exam_date || existing.exam_date,
          start_time || existing.start_time,
          session_name || existing.session_name,
          Number(duration_minutes) || existing.duration_minutes || 90,
          token,
          nowIso,
          existing.id
        );
        return res.json({ id: existing.id, token, updated: true });
      }
    }

    if (!title) return res.status(400).json({ error: 'Nama ujian wajib diisi' });
    const token = generateRandomToken();
    db.prepare('UPDATE exams SET is_active = 0').run();

    let targetTeacherId = null;
    if (req.body && req.body.teacher_id) {
      targetTeacherId = Number(req.body.teacher_id);
    } else {
      const teachers = db.prepare("SELECT id, subject FROM users WHERE role = 'guru'").all();
      const cleanSubj = String(subject || '').trim().toLowerCase();
      const match = teachers.find(t => {
        if (!t.subject) return false;
        const subjs = t.subject.split(/[,;&/]+/).map(s => s.trim().toLowerCase());
        return subjs.some(s => s === cleanSubj || cleanSubj.includes(s) || s.includes(cleanSubj));
      });
      if (match) targetTeacherId = match.id;
    }

    const info = db.prepare(`
      INSERT INTO exams (title, subject, class_target, exam_date, start_time, session_name, duration_minutes, token, token_updated_at, shuffle_questions, is_active, teacher_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      title,
      subject,
      class_target || 'Semua Kelas',
      exam_date || new Date().toISOString().slice(0, 10),
      start_time || '08:00 WIT',
      session_name || 'Sesi 1',
      Number(duration_minutes) || 90,
      token,
      nowIso,
      shuffle_questions !== undefined ? (shuffle_questions ? 1 : 0) : 1,
      targetTeacherId
    );
    const newExamId = Number(info.lastInsertRowid);
    let autoCopied = 0;
    const donor = db.prepare(`
      SELECT id FROM exams
      WHERE id != ?
        AND (LOWER(TRIM(subject)) = LOWER(TRIM(?)) OR LOWER(subject) LIKE '%' || LOWER(?) || '%')
        AND (SELECT COUNT(*) FROM questions WHERE exam_id = exams.id) > 0
      ORDER BY id DESC LIMIT 1
    `).get(newExamId, subject, subject);
    if (donor) {
      autoCopied = copyQuestions(db, donor.id, newExamId);
      invalidateQuestionsCache(newExamId);
    }
    res.json({ id: newExamId, token, autoCopiedQuestions: autoCopied });
  });

  app.post('/api/operator/exams/:id/activate', requireStaffAuth(['operator']), (req, res) => {
    const examId = Number(req.params.id);
    const targetExam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
    if (!targetExam) return res.status(404).json({ error: 'Ujian tidak ditemukan' });

    let autoCopied = 0;
    const qCount = db.prepare('SELECT COUNT(*) as c FROM questions WHERE exam_id = ?').get(examId).c;
    if (qCount === 0) {
      const donor = db.prepare(`
        SELECT id FROM exams
        WHERE id != ?
          AND (LOWER(TRIM(subject)) = LOWER(TRIM(?)) OR LOWER(subject) LIKE '%' || LOWER(?) || '%')
          AND (SELECT COUNT(*) FROM questions WHERE exam_id = exams.id) > 0
        ORDER BY id DESC LIMIT 1
      `).get(examId, targetExam.subject, targetExam.subject);
      if (donor) {
        autoCopied = copyQuestions(db, donor.id, examId);
        invalidateQuestionsCache(examId);
      }
    }

    db.prepare('UPDATE exams SET is_active = 0').run();
    db.prepare('UPDATE exams SET is_active = 1, token_updated_at = ? WHERE id = ?').run(new Date().toISOString(), examId);
    res.json({ activated: examId, total_questions: qCount + autoCopied, autoCopiedQuestions: autoCopied });
  });

  app.post('/api/operator/exams/:targetId/copy-questions-from/:sourceId', requireStaffAuth(['operator']), (req, res) => {
    const targetId = Number(req.params.targetId);
    const sourceId = Number(req.params.sourceId);
    const targetExam = db.prepare('SELECT id, subject FROM exams WHERE id = ?').get(targetId);
    const sourceExam = db.prepare('SELECT id, subject FROM exams WHERE id = ?').get(sourceId);
    if (!targetExam || !sourceExam) return res.status(404).json({ error: 'Paket ujian tidak ditemukan' });

    const count = copyQuestions(db, sourceId, targetId);
    invalidateQuestionsCache(targetId);
    res.json({ message: `Berhasil menyalin ${count} butir soal ke ${targetExam.subject}`, copiedCount: count });
  });

  app.delete('/api/operator/exams/:id', requireStaffAuth(['operator']), (req, res) => {
    const examId = Number(req.params.id);
    const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
    if (!exam) return res.status(404).json({ error: 'Jadwal ujian tidak ditemukan' });

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM answers WHERE session_id IN (SELECT id FROM exam_sessions WHERE exam_id = ?)').run(examId);
      db.prepare('DELETE FROM exam_sessions WHERE exam_id = ?').run(examId);
      db.prepare('DELETE FROM questions WHERE exam_id = ?').run(examId);
      db.prepare('DELETE FROM room_reports WHERE exam_id = ?').run(examId);
      db.prepare('DELETE FROM exams WHERE id = ?').run(examId);

      if (exam.is_active === 1) {
        const nextActive = db.prepare('SELECT id FROM exams ORDER BY id DESC LIMIT 1').get();
        if (nextActive) {
          db.prepare('UPDATE exams SET is_active = 1 WHERE id = ?').run(nextActive.id);
        }
      }
    });
    tx();
    invalidateQuestionsCache(examId);
    res.json({ ok: true, deleted: examId, subject: exam.subject });
  });

  app.post('/api/operator/students', requireStaffAuth(['operator']), (req, res) => {
    const { exam_number, nisn, full_name, class_name, room, seat_number, password, birth_info } = req.body || {};
    if (!exam_number || !full_name) {
      return res.status(400).json({ error: 'Nomor peserta dan nama siswa wajib diisi' });
    }
    try {
      const info = db.prepare(`
        INSERT INTO students (exam_number, nisn, full_name, class_name, room, seat_number, password, birth_info)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(exam_number).trim(),
        String(nisn || '-').trim(),
        String(full_name).trim(),
        String(class_name || 'XII IPA 1').trim(),
        String(room || 'Ruang 01').trim(),
        Number(seat_number) || 1,
        String(password || 'BURU123').trim(),
        String(birth_info || '-').trim()
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
        'Tempat Tanggal Lahir': 'Namlea, 14 Januari 2008',
        'Kelas': 'XII IPA 1',
        'Ruang': 'Ruang 01',
        'Nomor Meja': 7,
        'Password': 'BURU09'
      },
      {
        'Nomor Peserta': '26-03-010',
        'NISN': '0081234510',
        'Nama Siswa': 'Hendra Saputra Namlea',
        'Tempat Tanggal Lahir': 'Waprea, 22 Maret 2008',
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
        INSERT INTO students (exam_number, nisn, full_name, class_name, room, seat_number, password, birth_info)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(exam_number) DO UPDATE SET
          nisn = excluded.nisn,
          full_name = excluded.full_name,
          class_name = excluded.class_name,
          room = excluded.room,
          seat_number = excluded.seat_number,
          password = excluded.password,
          birth_info = excluded.birth_info
      `);

      let importedCount = 0;
      rows.forEach((r, idx) => {
        const examNo = String(r['Nomor Peserta'] || r['No Peserta'] || r['exam_number'] || '').trim();
        const fullName = String(r['Nama Siswa'] || r['Nama Lengkap'] || r['Nama'] || r['full_name'] || '').trim();
        if (!examNo || !fullName) return;
        const nisn = String(r['NISN'] || r['nisn'] || '-').trim();
        const birthInfo = String(r['Tempat Tanggal Lahir'] || r['Tempat, Tanggal Lahir'] || r['TTL'] || r['birth_info'] || '-').trim();
        const className = String(r['Kelas'] || r['class_name'] || 'XII IPA 1').trim();
        const room = String(r['Ruang'] || r['room'] || 'Ruang 01').trim();
        const seatNo = Number(r['Nomor Meja'] || r['Meja'] || r['seat_number'] || idx + 1);
        const pass = String(r['Password'] || r['password'] || `BURU${String(idx + 1).padStart(2, '0')}`).trim();

        upsertStudent.run(examNo, nisn, fullName, className, room, seatNo, pass, birthInfo);
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

  // Fitur Cepat Pindah Kelas Siswa (Solusi perbedaan data Dapodik di lapangan)
  app.post('/api/operator/student-change-class', requireStaffAuth(['operator', 'pengawas']), (req, res) => {
    const { student_id, new_class_name, reset_active_exam } = req.body || {};
    const studentId = Number(student_id);
    const targetClass = String(new_class_name || '').trim();
    if (!studentId || !targetClass) {
      return res.status(400).json({ error: 'ID Siswa dan Kelas Baru wajib diisi.' });
    }

    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
    if (!student) return res.status(404).json({ error: 'Siswa tidak ditemukan.' });

    const oldClass = student.class_name;
    db.prepare('UPDATE students SET class_name = ? WHERE id = ?').run(targetClass, studentId);

    let resetDone = false;
    if (reset_active_exam) {
      const sessions = db.prepare('SELECT id FROM exam_sessions WHERE student_id = ?').all(studentId);
      for (const s of sessions) {
        db.prepare('DELETE FROM answers WHERE session_id = ?').run(s.id);
      }
      db.prepare('DELETE FROM exam_sessions WHERE student_id = ?').run(studentId);
      resetDone = true;
    }

    const operatorName = req.staffUser ? req.staffUser.full_name : 'Operator Server';
    const logNote = `Perpindahan kelas siswa ${student.full_name} (${student.nisn}) dari ${oldClass} ke ${targetClass} oleh ${operatorName}${resetDone ? ' (Ujian di-reset)' : ''}`;
    try {
      db.prepare(`
        INSERT INTO room_reports (exam_id, room, pengawas_name, notes, absent_students, created_at)
        VALUES (0, ?, ?, ?, '-', ?)
      `).run(student.room || 'Semua Ruang', operatorName, logNote, new Date().toISOString());
    } catch {}

    res.json({
      ok: true,
      student_id: studentId,
      old_class: oldClass,
      new_class_name: targetClass,
      reset_done: resetDone,
      message: `Berhasil memindahkan kelas ${student.full_name} ke ${targetClass}.`
    });
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
      `).run(username.trim(), hashPassword(password.trim()), full_name.trim(), role, subject || null, room || null);
      res.json({ id: Number(info.lastInsertRowid) });
    } catch {
      res.status(400).json({ error: 'Username sudah digunakan' });
    }
  });

  app.delete('/api/operator/staff/:id', requireStaffAuth(['operator']), (req, res) => {
    const staffId = Number(req.params.id);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(staffId);
    if (!target) return res.status(404).json({ error: 'Akun staf tidak ditemukan' });
    if (target.id === req.staffUser.id) {
      return res.status(400).json({ error: 'Tidak dapat menghapus akun operator yang sedang aktif digunakan' });
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(staffId);
    res.json({ ok: true, deleted: staffId });
  });

  app.put('/api/operator/staff/:id', requireStaffAuth(['operator']), (req, res) => {
    const staffId = Number(req.params.id);
    const { full_name, username, password, role, subject, room } = req.body || {};
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(staffId);
    if (!existing) return res.status(404).json({ error: 'Akun staf tidak ditemukan' });

    try {
      db.prepare(`
        UPDATE users
        SET full_name = COALESCE(NULLIF(?, ''), full_name),
            username = COALESCE(NULLIF(?, ''), username),
            password = COALESCE(NULLIF(?, ''), password),
            role = COALESCE(NULLIF(?, ''), role),
            subject = ?,
            room = ?
        WHERE id = ?
      `).run(
        full_name,
        username,
        password && String(password).trim() ? hashPassword(String(password).trim()) : '',
        role,
        role === 'guru' ? (subject || null) : null,
        role === 'pengawas' ? (room || null) : null,
        staffId
      );
      res.json({ ok: true, id: staffId });
    } catch {
      res.status(400).json({ error: 'Username sudah digunakan oleh akun lain' });
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
    const isOperator = req.staffUser && req.staffUser.role === 'operator';
    const allExams = db.prepare(`
      SELECT e.*,
        u.full_name AS teacher_name,
        u.subject AS teacher_subject,
        (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.id AND q.type = 'PG') AS pg_count,
        (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.id AND q.type = 'ESAI') AS esai_count,
        (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.id) AS total_questions
      FROM exams e
      LEFT JOIN users u ON e.teacher_id = u.id
      ORDER BY e.id DESC
    `).all();

    let filteredExams = allExams;
    if (!isOperator) {
      const staffUser = req.staffUser;
      filteredExams = allExams.filter(exam => {
        // 1. Mata pelajaran ujian WAJIB cocok dengan mapel yang diampu oleh akun guru ini!
        if (staffUser.subject) {
          const matchSubj = subjectMatches(staffUser.subject, exam.subject);
          if (!matchSubj) return false;
        }

        // 2. Jika mapel cocok:
        if (exam.teacher_id !== null && exam.teacher_id !== undefined) {
          // Jika teacher_id adalah akun ini -> TAMPILKAN
          if (Number(exam.teacher_id) === Number(staffUser.id)) return true;

          // Jika teacher_id diisi guru lain, tapi guru lain tersebut mapelnya BUKAN mapel ujian ini (sisa bug lama) -> TAMPILKAN
          if (exam.teacher_subject && !subjectMatches(exam.teacher_subject, exam.subject)) {
            return true;
          }

          // Jika teacher_id adalah guru lain yang memang mengampu mapel yang sama -> Sembunyikan milik guru lain
          return false;
        }

        return true;
      });
    }

    const enriched = filteredExams.map(ex => ({
      ...ex,
      pgCount: ex.pg_count,
      esaiCount: ex.esai_count,
      totalCount: ex.total_questions
    }));

    const userSubjects = (req.staffUser.subject || '')
      .split(/[,;&/]+/)
      .map(s => s.trim())
      .filter(Boolean);

    res.json({
      exams: enriched,
      teacher: {
        id: req.staffUser.id,
        full_name: req.staffUser.full_name,
        username: req.staffUser.username,
        role: req.staffUser.role,
        subject: req.staffUser.subject,
        subjects: userSubjects
      }
    });
  });

  app.post('/api/guru/exams', requireStaffAuth(['guru', 'operator']), (req, res) => {
    const { title, subject, class_target, duration_minutes, shuffle_questions } = req.body || {};
    if (!subject) return res.status(400).json({ error: 'Mata pelajaran wajib diisi' });
    const finalTitle = title || `Ujian ${subject}`;
    const token = generateRandomToken();
    const nowIso = new Date().toISOString();
    const teacherId = req.staffUser ? req.staffUser.id : null;
    const info = db.prepare(`
      INSERT INTO exams (title, subject, class_target, exam_date, start_time, session_name, duration_minutes, token, token_updated_at, shuffle_questions, is_active, teacher_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      finalTitle,
      subject,
      class_target || 'Semua Kelas',
      new Date().toISOString().slice(0, 10),
      '08:00 WIT',
      'Sesi 1',
      Number(duration_minutes) || 90,
      token,
      nowIso,
      shuffle_questions !== undefined ? (shuffle_questions ? 1 : 0) : 1,
      teacherId
    );
    res.json({ ok: true, id: Number(info.lastInsertRowid), title: finalTitle, subject, token });
  });

  app.delete('/api/guru/exams/:id', requireStaffAuth(['guru', 'operator']), (req, res) => {
    const examId = Number(req.params.id);
    const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
    if (!exam) return res.status(404).json({ error: 'Paket ujian tidak ditemukan' });
    if (!teacherCanAccessExam(req.staffUser, exam)) {
      return res.status(403).json({ error: 'Akses ditolak: Anda tidak memiliki akses untuk menghapus paket ujian ini.' });
    }

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM answers WHERE session_id IN (SELECT id FROM exam_sessions WHERE exam_id = ?)').run(examId);
      db.prepare('DELETE FROM exam_sessions WHERE exam_id = ?').run(examId);
      db.prepare('DELETE FROM questions WHERE exam_id = ?').run(examId);
      db.prepare('DELETE FROM room_reports WHERE exam_id = ?').run(examId);
      db.prepare('DELETE FROM exams WHERE id = ?').run(examId);

      if (exam.is_active === 1) {
        const nextActive = db.prepare('SELECT id FROM exams ORDER BY id DESC LIMIT 1').get();
        if (nextActive) {
          db.prepare('UPDATE exams SET is_active = 1 WHERE id = ?').run(nextActive.id);
        }
      }
    });
    tx();
    invalidateQuestionsCache(examId);
    res.json({ ok: true, deleted: examId, subject: exam.subject });
  });

  app.get('/api/guru/exams/:id/questions', requireStaffAuth(['guru', 'operator']), (req, res) => {
    const examId = Number(req.params.id);
    const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
    if (!exam) return res.status(404).json({ error: 'Ujian tidak ditemukan' });
    if (!teacherCanAccessExam(req.staffUser, exam)) {
      return res.status(403).json({ error: 'Akses ditolak: Anda tidak memiliki akses ke paket ujian ini.' });
    }
    const questions = db.prepare('SELECT * FROM questions WHERE exam_id = ? ORDER BY number ASC, id ASC').all(examId);
    res.json({ exam, questions });
  });

  const mediaFieldsUpload = upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'audio', maxCount: 1 }
  ]);

  app.post('/api/guru/exams/:id/questions', requireStaffAuth(['guru', 'operator']), mediaFieldsUpload, (req, res) => {
    const examId = Number(req.params.id);
    const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
    if (!exam) return res.status(404).json({ error: 'Ujian tidak ditemukan' });
    if (!teacherCanAccessExam(req.staffUser, exam)) {
      return res.status(403).json({ error: 'Akses ditolak: Anda tidak memiliki akses ke paket ujian ini.' });
    }
    const { number, type, question_text, option_a, option_b, option_c, option_d, option_e, answer_key, image_data, audio_data } = req.body || {};
    if (!question_text) return res.status(400).json({ error: 'Teks soal wajib diisi' });
    const qType = type === 'ESAI' ? 'ESAI' : 'PG';

    const imgFile = req.files && req.files.image ? req.files.image[0] : null;
    const audFile = req.files && req.files.audio ? req.files.audio[0] : null;
    if (!isAllowedMediaFile(imgFile, 'image') || !isAllowedMediaFile(audFile, 'audio')) {
      return res.status(400).json({ error: 'Format file tidak diizinkan. Gambar: PNG/JPG/GIF/WEBP, Audio: MP3/WAV/OGG/M4A/AAC.' });
    }
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
    const existing = db.prepare('SELECT q.*, e.teacher_id, e.subject FROM questions q JOIN exams e ON q.exam_id = e.id WHERE q.id = ?').get(questionId);
    if (!existing) return res.status(404).json({ error: 'Soal tidak ditemukan' });
    if (!teacherCanAccessExam(req.staffUser, existing)) {
      return res.status(403).json({ error: 'Akses ditolak: Anda tidak memiliki akses ke butir soal ini.' });
    }

    const imgFile = req.files && req.files.image ? req.files.image[0] : null;
    const audFile = req.files && req.files.audio ? req.files.audio[0] : null;

    if (!isAllowedMediaFile(imgFile, 'image') || !isAllowedMediaFile(audFile, 'audio')) {
      return res.status(400).json({ error: 'Format file tidak diizinkan. Gambar: PNG/JPG/GIF/WEBP, Audio: MP3/WAV/OGG/M4A/AAC.' });
    }

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
    const questionId = Number(req.params.questionId);
    const existing = db.prepare('SELECT q.*, e.teacher_id, e.subject FROM questions q JOIN exams e ON q.exam_id = e.id WHERE q.id = ?').get(questionId);
    if (!existing) return res.status(404).json({ error: 'Soal tidak ditemukan' });
    if (!teacherCanAccessExam(req.staffUser, existing)) {
      return res.status(403).json({ error: 'Akses ditolak: Anda tidak memiliki akses ke butir soal ini.' });
    }
    db.prepare('DELETE FROM questions WHERE id = ?').run(questionId);
    invalidateQuestionsCache(existing.exam_id);
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
      const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
      if (!exam) return res.status(404).json({ error: 'Ujian tidak ditemukan' });
      if (!teacherCanAccessExam(req.staffUser, exam)) {
        return res.status(403).json({ error: 'Akses ditolak: Anda tidak memiliki akses ke paket ujian ini.' });
      }

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
    const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
    if (!exam) return res.status(404).json({ error: 'Ujian tidak ditemukan' });
    if (!teacherCanAccessExam(req.staffUser, exam)) {
      return res.status(403).json({ error: 'Akses ditolak: Anda tidak memiliki akses ke nilai paket ujian ini.' });
    }
    const data = calculateExamScores(db, examId);
    res.json(data);
  });

  app.get('/api/guru/exams/:id/export-excel', requireStaffAuth(['guru', 'operator']), (req, res) => {
    const examId = Number(req.params.id);
    const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
    if (!exam) return res.status(404).send('Ujian tidak ditemukan');
    if (!teacherCanAccessExam(req.staffUser, exam)) {
      return res.status(403).send('Akses ditolak: Anda tidak memiliki akses ke nilai ujian ini.');
    }
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
  app.get('/api/pengawas/student-work/:sessionId', requireStaffAuth(['pengawas', 'operator', 'guru']), (req, res) => {
    const sessionId = Number(req.params.sessionId);
    const session = db.prepare('SELECT * FROM exam_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ error: 'Sesi siswa tidak ditemukan' });

    if (req.staffUser && req.staffUser.role === 'guru') {
      const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(session.exam_id);
      if (!teacherCanAccessExam(req.staffUser, exam)) {
        return res.status(403).json({ error: 'Akses ditolak: Anda tidak memiliki akses ke lembar kerja ini.' });
      }
    }

    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(session.student_id);
    const questions = db.prepare('SELECT id, number, type, question_text, option_a, option_b, option_c, option_d, option_e FROM questions WHERE exam_id = ? ORDER BY number ASC').all(session.exam_id);
    const answers = db.prepare('SELECT question_id, chosen_option, essay_photo, updated_at FROM answers WHERE session_id = ?').all(sessionId);
    const ansMap = new Map(answers.map(a => [a.question_id, a]));

    const workDetail = questions.map(q => {
      const a = ansMap.get(q.id);
      return {
        question_id: q.id,
        number: q.number,
        type: q.type,
        question_snippet: q.question_text.slice(0, 95) + (q.question_text.length > 95 ? '...' : ''),
        chosen_option: a ? a.chosen_option : null,
        essay_photo: a ? a.essay_photo : null,
        updated_at: a ? a.updated_at : null,
        is_current: (session.current_question_number || 1) === q.number
      };
    });

    const { session_token: _st, ...safeSession } = session;
    res.json({
      student,
      session: safeSession,
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

  // ==================== PORTAL UJIAN SISWA (EXAMBRO & DIRECT ENTRY) ====================
  const indoMonths = ['januari', 'februari', 'maret', 'april', 'mei', 'juni', 'juli', 'agustus', 'september', 'oktober', 'november', 'desember'];
  const monthAliases = { pebruari: 2, nopember: 11, agust: 8, okt: 10, des: 12, jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, agu: 8, sep: 9, nov: 11 };

  // Ubah "YYYY-MM-DD" / "DD-MM-YYYY" / "Namlea, 14 Januari 2008" menjadi {y, m, d}
  function parseDateParts(raw) {
    const str = String(raw || '').toLowerCase().trim();
    if (!str || str === '-') return null;
    let mt = str.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (mt) return { y: +mt[1], m: +mt[2], d: +mt[3] };
    mt = str.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
    if (mt) return { y: +mt[3], m: +mt[2], d: +mt[1] };
    mt = str.match(/(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})/);
    if (mt) {
      const idx = indoMonths.indexOf(mt[2]);
      const m = idx >= 0 ? idx + 1 : monthAliases[mt[2]];
      if (m) return { y: +mt[3], m, d: +mt[1] };
    }
    return null;
  }

  // Pencocokan tanggal lahir secara ketat (hari, bulan, dan tahun harus sama persis)
  function matchBirthDate(inputDate, birthInfo) {
    const a = parseDateParts(inputDate);
    const b = parseDateParts(birthInfo);
    if (!a || !b) return false;
    return a.y === b.y && a.m === b.m && a.d === b.d;
  }

  // Aktivasi / Verifikasi Akun Siswa (Sesuai PDF ABM Hal 7: NISN + NPSN + Tanggal Lahir)
  app.post('/api/ujian/activate-account', (req, res) => {
    const { nisn, npsn, birth_date } = req.body || {};
    const cleanNisn = String(nisn || '').trim();
    if (!cleanNisn) {
      return res.status(400).json({ error: 'NISN siswa wajib diisi.' });
    }
    if (!birth_date || !parseDateParts(birth_date)) {
      return res.status(400).json({ error: 'Tanggal lahir wajib diisi dengan benar.' });
    }
    const cleanNpsn = String(npsn || '').trim();
    const defaultNpsn = '60101015'; // NPSN Resmi SMA Negeri 3 Buru
    if (cleanNpsn && cleanNpsn.length < 8) {
      return res.status(400).json({ error: 'NPSN Sekolah harus berupa 8 digit angka.' });
    }

    // NISN harus cocok persis (tidak lagi menerima potongan / akhiran NISN)
    const student = db.prepare('SELECT * FROM students WHERE nisn = ?').get(cleanNisn);
    if (!student) {
      return res.status(404).json({
        error: `Data siswa dengan NISN "${cleanNisn}" tidak ditemukan di database sekolah. Pastikan NISN sudah terdaftar.`
      });
    }

    if (!student.birth_info || student.birth_info === '-' || !parseDateParts(student.birth_info)) {
      return res.status(409).json({
        error: 'Data tanggal lahir Anda belum lengkap di server. Silakan login memakai Nomor Peserta & Kata Sandi pada kartu ujian, atau hubungi operator.'
      });
    }
    if (!matchBirthDate(birth_date, student.birth_info)) {
      return res.status(401).json({
        error: 'Tanggal lahir tidak sesuai dengan data siswa di database. Silakan periksa kembali.'
      });
    }

    res.json({
      ok: true,
      student: {
        id: student.id,
        exam_number: student.exam_number,
        username: student.exam_number,
        password: student.password,
        full_name: student.full_name,
        nisn: student.nisn,
        class_name: student.class_name,
        room: student.room,
        seat_number: student.seat_number,
        birth_info: student.birth_info || '-',
        school_name: 'SMA NEGERI 3 BURU',
        npsn: defaultNpsn
      }
    });
  });
  // Ambil daftar nama siswa aktif & info ujian untuk autocomplete pencarian nama (tanpa membocorkan NISN)
  app.get('/api/ujian/students-list', (req, res) => {
    const rawExam = db.prepare('SELECT id, title, subject, class_target, duration_minutes FROM exams WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
    const students = db.prepare('SELECT id, full_name, class_name FROM students ORDER BY full_name ASC').all();
    res.json({
      exam: rawExam || null,
      students: students.map(s => ({
        id: s.id,
        full_name: s.full_name,
        class_name: s.class_name
      }))
    });
  });

  // Pencarian nama siswa + verifikasi 4 digit terakhir NISN untuk menampilkan konfirmasi identitas (Nama, NISN, TTL, Kelas)
  app.post('/api/ujian/find-student', (req, res) => {
    const { name, nisnLast4 } = req.body || {};
    const query = String(name || '').trim();
    const pin = String(nisnLast4 || '').trim();
    if (!query) {
      return res.status(400).json({ error: 'Silakan ketik nama lengkap Anda terlebih dahulu.' });
    }
    if (!pin || pin.length < 4) {
      return res.status(400).json({ error: 'Masukkan 4 digit terakhir NISN Anda.' });
    }

    const rawExam = db.prepare('SELECT id, title, subject, class_target, duration_minutes FROM exams WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
    if (!rawExam) {
      return res.status(404).json({ error: 'Belum ada jadwal ujian yang diaktifkan oleh sekolah.' });
    }

    // 1. Cari kandidat berdasarkan nama (exact match lalu LIKE)
    let matches = db.prepare('SELECT id, exam_number, nisn, full_name, class_name, room, seat_number, birth_info FROM students WHERE LOWER(TRIM(full_name)) = LOWER(TRIM(?))').all(query);
    if (matches.length === 0) {
      matches = db.prepare('SELECT id, exam_number, nisn, full_name, class_name, room, seat_number, birth_info FROM students WHERE LOWER(full_name) LIKE LOWER(?) LIMIT 10').all(`%${query}%`);
    }

    if (matches.length === 0) {
      return res.status(404).json({
        error: `Nama "${query}" tidak ditemukan dalam daftar peserta ujian. Pastikan ejaan nama Anda sesuai.`
      });
    }

    // 2. Cocokkan dengan 4 digit terakhir NISN
    const student = matches.find(s => String(s.nisn || '').trim().slice(-4) === pin);
    if (!student) {
      return res.status(401).json({
        error: '4 digit terakhir NISN tidak sesuai dengan nama tersebut. Pastikan Anda memasukkan NISN milik Anda sendiri.'
      });
    }

    const studentExam = getActiveExamForStudent(db, student.class_name);
    if (!studentExam) {
      return res.status(404).json({ error: `Belum ada jadwal ujian yang aktif untuk kelas ${student.class_name}.` });
    }

    // 3. Cek apakah siswa sudah menyelesaikan ujian (FINISHED) -> blokir agar tidak bisa masuk lagi
    const existingSession = db.prepare('SELECT id, status, finished_at FROM exam_sessions WHERE exam_id = ? AND student_id = ?').get(studentExam.id, student.id);
    if (existingSession && existingSession.status === 'FINISHED') {
      return res.status(403).json({
        error: `Ujian atas nama ${student.full_name} sudah selesai dikumpulkan dan tidak dapat dibuka atau diubah kembali.`,
        status: 'FINISHED'
      });
    }

    res.json({
      student: {
        id: student.id,
        exam_number: student.exam_number,
        full_name: student.full_name,
        nisn: student.nisn,
        birth_info: student.birth_info || '-',
        class_name: student.class_name,
        room: student.room,
        seat_number: student.seat_number
      },
      exam: studentExam
    });
  });

  // Membuka / melanjutkan sesi ujian siswa. Setiap login menerbitkan token sesi baru (login di perangkat
  // lain otomatis memutus perangkat lama). Tanpa token ujian yang valid, sesi wajib verifikasi token dulu.
  // Status LOCKED tidak pernah dibuka oleh login ulang: hanya pengawas yang dapat membuka kunci.
  function openStudentSession(student, activeExam, examToken, deviceInfo, defaultDevice) {
    const tokenValid = !!examToken && String(examToken).toUpperCase().trim() === String(activeExam.token).toUpperCase().trim();
    const needToken = tokenValid ? 0 : 1;
    const sessionToken = randomToken(24);
    const nowIso = new Date().toISOString();
    let session = db.prepare('SELECT * FROM exam_sessions WHERE exam_id = ? AND student_id = ?').get(activeExam.id, student.id);
    if (!session) {
      const info = db.prepare(`
        INSERT INTO exam_sessions (exam_id, student_id, status, need_token_reverify, current_question_number, last_activity_at, violation_count, started_at, device_info, session_token)
        VALUES (?, ?, 'WORKING', ?, 1, ?, 0, ?, ?, ?)
      `).run(activeExam.id, student.id, needToken, nowIso, nowIso, deviceInfo || defaultDevice, sessionToken);
      session = db.prepare('SELECT * FROM exam_sessions WHERE id = ?').get(Number(info.lastInsertRowid));
      return { session, sessionToken };
    }
    if (session.status === 'FINISHED') {
      return { finished: true, session };
    }
    const nextNeed = session.status === 'LOCKED' ? 1 : needToken;
    db.prepare('UPDATE exam_sessions SET need_token_reverify = ?, last_activity_at = ?, session_token = ? WHERE id = ?').run(nextNeed, nowIso, sessionToken, session.id);
    session.need_token_reverify = nextNeed;
    return { session, sessionToken };
  }

  // Masuk langsung ke soal ("Siap Mengikuti Ujian") dengan verifikasi 4 digit terakhir NISN
  app.post('/api/ujian/start-direct', (req, res) => {
    const { studentId, name, nisnLast4, device_info, token } = req.body || {};
    const pin = String(nisnLast4 || '').trim();
    let student = null;
    if (studentId) {
      student = db.prepare('SELECT * FROM students WHERE id = ?').get(Number(studentId));
    } else if (name) {
      const byName = db.prepare('SELECT * FROM students WHERE LOWER(TRIM(full_name)) = LOWER(TRIM(?))').all(String(name).trim());
      student = byName.find(s => String(s.nisn || '').trim().slice(-4) === pin) || byName[0] || null;
    }
    if (!student) {
      return res.status(404).json({ error: 'Data peserta tidak ditemukan.' });
    }
    if (!pin || String(student.nisn || '').trim().slice(-4) !== pin) {
      return res.status(401).json({ error: 'Verifikasi 4 digit terakhir NISN tidak sesuai.' });
    }

    const activeExam = getActiveExamForStudent(db, student.class_name);
    if (!activeExam) {
      return res.status(404).json({ error: `Belum ada ujian yang aktif saat ini untuk kelas ${student.class_name}.` });
    }

    const opened = openStudentSession(student, activeExam, token, device_info, 'Direct Entry Web');
    if (opened.finished) {
      return res.status(403).json({
        error: `Ujian atas nama ${student.full_name} sudah selesai dikumpulkan dan tidak dapat dibuka atau mengubah jawaban lagi.`,
        status: 'FINISHED'
      });
    }
    const session = opened.session;

    res.json({
      sessionId: session.id,
      sessionToken: opened.sessionToken,
      status: session.status,
      need_token_reverify: session.need_token_reverify,
      student: {
        id: student.id,
        exam_number: student.exam_number,
        full_name: student.full_name,
        class_name: student.class_name,
        nisn: student.nisn,
        birth_info: student.birth_info || '-',
        room: student.room,
        seat_number: student.seat_number
      },
      exam: {
        id: activeExam.id,
        title: activeExam.title,
        subject: activeExam.subject,
        duration_minutes: activeExam.duration_minutes
      }
    });
  });

  // Melanjutkan ujian secara mandiri jika siswa terganggu / pindah tab (tanpa butuh pengawas)
  // Hanya untuk melanjutkan sesi yang tidak terkunci. Sesi LOCKED wajib dibuka pengawas,
  // dan sesi yang butuh verifikasi token wajib memasukkan token ujian terbaru.
  app.post('/api/ujian/self-resume', requireStudentSession, (req, res) => {
    const session = req.examSession;
    if (session.status === 'FINISHED') return res.json({ status: 'FINISHED' });
    if (session.status === 'LOCKED') {
      return res.status(423).json({ error: 'Layar ujian terkunci. Hubungi Pengawas Ruangan untuk membuka kunci.', status: 'LOCKED' });
    }
    if (session.need_token_reverify) {
      return res.status(428).json({ error: 'Masukkan Token Ujian terbaru dari Pengawas untuk melanjutkan.', status: 'NEED_TOKEN' });
    }

    db.prepare('UPDATE exam_sessions SET last_activity_at = ? WHERE id = ?').run(new Date().toISOString(), session.id);
    res.json({ status: 'WORKING', need_token_reverify: 0 });
  });

  app.post('/api/ujian/login', (req, res) => {
    const { exam_number, password, token, device_info } = req.body || {};
    const queryNo = String(exam_number || '').trim();
    const queryPass = String(password || '').trim();
    const student = db.prepare('SELECT * FROM students WHERE (exam_number = ? OR nisn = ?) AND password = ?').get(
      queryNo,
      queryNo,
      queryPass
    );
    if (!student) {
      return res.status(401).json({ error: 'ID Peserta atau Kata Sandi salah!' });
    }

    const activeExam = getActiveExamForStudent(db, student.class_name);
    if (!activeExam) {
      return res.status(404).json({ error: `Belum ada jadwal ujian yang aktif untuk kelas ${student.class_name}.` });
    }

    // Jika token dikirim pada saat login, validasi token. Tanpa token, sesi wajib verifikasi token sebelum menjawab.
    if (token) {
      if (String(token).toUpperCase().trim() !== String(activeExam.token).toUpperCase().trim()) {
        return res.status(403).json({ error: 'Token Ujian tidak sesuai atau sudah berganti (Token berganti otomatis tiap 15 menit)! Tanyakan Token terbaru ke Pengawas Ruangan.' });
      }
    }

    const opened = openStudentSession(student, activeExam, token, device_info, 'Exambro Web');
    if (opened.finished) {
      return res.status(403).json({
        error: `Ujian atas nama ${student.full_name} sudah selesai dikumpulkan dan tidak dapat dibuka atau diubah kembali.`,
        status: 'FINISHED'
      });
    }
    const session = opened.session;

    res.json({
      sessionId: session.id,
      sessionToken: opened.sessionToken,
      status: session.status,
      need_token_reverify: session.need_token_reverify,
      student: {
        id: student.id,
        exam_number: student.exam_number,
        full_name: student.full_name,
        class_name: student.class_name,
        nisn: student.nisn,
        birth_info: student.birth_info || '-',
        room: student.room,
        seat_number: student.seat_number
      },
      exam: {
        id: activeExam.id,
        title: activeExam.title,
        subject: activeExam.subject,
        session_name: activeExam.session_name,
        duration_minutes: activeExam.duration_minutes
      }
    });
  });

  // Ambil token ujian aktif sesuai kelas / sesi siswa (untuk Pop-up Peraturan & Ambil Token)
  // Hanya staf (pengawas/operator) yang boleh melihat token ujian; siswa wajib meminta token ke pengawas
  app.get('/api/ujian/active-token', requireStaffAuth(['pengawas', 'operator']), (req, res) => {
    const { sessionId, class_name } = req.query || {};
    let activeExam = null;
    if (sessionId) {
      const sess = db.prepare('SELECT exam_id FROM exam_sessions WHERE id = ?').get(Number(sessionId));
      if (sess) {
        const rawExam = db.prepare('SELECT * FROM exams WHERE id = ?').get(sess.exam_id);
        if (rawExam) activeExam = ensureFresh15MinToken(db, rawExam);
      }
    }
    if (!activeExam) {
      activeExam = getActiveExamForStudent(db, class_name);
    }
    if (!activeExam) {
      return res.status(404).json({ error: 'Belum ada jadwal ujian yang diaktifkan oleh sekolah.' });
    }
    res.json({
      token: activeExam.token,
      token_remaining_seconds: activeExam.token_remaining_seconds,
      subject: activeExam.subject,
      class_target: activeExam.class_target
    });
  });

  // Verifikasi Token saat masuk subtes / mulai ujian (PDF ABM Hal 9)
  app.post('/api/ujian/verify-subtest-token', requireStudentSession, (req, res) => {
    const { token } = req.body || {};
    const session = req.examSession;
    if (session.status === 'FINISHED') return res.status(403).json({ error: 'Ujian sudah selesai dikumpulkan.', status: 'FINISHED' });
    if (session.status === 'LOCKED') {
      return res.status(423).json({ error: 'Layar ujian terkunci. Hubungi Pengawas Ruangan untuk membuka kunci.', status: 'LOCKED' });
    }

    const rawExam = db.prepare('SELECT * FROM exams WHERE id = ?').get(session.exam_id);
    const activeExam = ensureFresh15MinToken(db, rawExam);
    if (!activeExam) return res.status(404).json({ error: 'Belum ada ujian yang aktif.' });

    const inputTok = String(token || '').toUpperCase().trim();
    const currTok = String(activeExam.token).toUpperCase().trim();
    if (!inputTok || inputTok !== currTok) {
      return res.status(403).json({
        error: 'Token Ujian tidak sesuai atau sudah berganti! Silakan periksa token 6-digit terbaru di papan pengumuman atau tanyakan ke pengawas.'
      });
    }

    db.prepare("UPDATE exam_sessions SET status = 'WORKING', need_token_reverify = 0, last_activity_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      session.id
    );
    res.json({ ok: true, status: 'WORKING' });
  });

  // Verifikasi Token 15-Menit Terbaru saat siswa selesai gangguan / dibuka kuncinya di tengah ujian
  app.post('/api/ujian/verify-resume-token', requireStudentSession, (req, res) => {
    const { token } = req.body || {};
    const session = req.examSession;
    if (session.status === 'FINISHED') return res.status(403).json({ error: 'Ujian sudah selesai dikumpulkan.', status: 'FINISHED' });
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
  app.post('/api/ujian/heartbeat', requireStudentSession, (req, res) => {
    const { currentQuestionNumber } = req.body || {};
    db.prepare('UPDATE exam_sessions SET current_question_number = ?, last_activity_at = ? WHERE id = ?').run(
      Number(currentQuestionNumber) || 1,
      new Date().toISOString(),
      req.examSession.id
    );
    res.json({ ok: true });
  });

  app.get('/api/ujian/session/:sessionId', requireStudentSession, (req, res) => {
    const session = req.examSession;
    const sessionId = session.id;

    const student = db.prepare('SELECT id, exam_number, full_name, class_name, room, seat_number, nisn, birth_info FROM students WHERE id = ?').get(session.student_id);
    if (student && !student.birth_info) student.birth_info = '-';
    const exam = db.prepare('SELECT id, title, subject, class_target, session_name, duration_minutes, shuffle_questions FROM exams WHERE id = ?').get(session.exam_id);

    let questions = getCachedExamQuestions(session.exam_id);

    // Acak urutan soal PG secara deterministik per siswa agar siswa bersebelahan tidak bisa saling contek nomor
    if (exam && exam.shuffle_questions) {
      questions = seededShufflePgQuestions(questions, student.id * 17 + session.id);
    }

    const savedAnswers = db.prepare('SELECT question_id, chosen_option, essay_photo FROM answers WHERE session_id = ?').all(sessionId);
    const answersMap = {};
    const essayPhotosMap = {};
    for (const a of savedAnswers) {
      answersMap[a.question_id] = a.chosen_option;
      if (a.essay_photo) {
        essayPhotosMap[a.question_id] = a.essay_photo;
      }
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
      answers: answersMap,
      essayPhotos: essayPhotosMap
    });
  });

  // Upload Foto Lembar Jawaban Kertas untuk Soal Esai (Wajib sebelum Selesai Ujian)
  app.post('/api/ujian/upload-essay-photo', upload.single('photo'), requireStudentSession, (req, res) => {
    const session = req.examSession;
    const sessionId = session.id;
    const questionId = Number(req.body.questionId);
    const currentQuestionNumber = req.body.currentQuestionNumber ? Number(req.body.currentQuestionNumber) : null;
    if (!questionId) {
      return res.status(400).json({ error: 'sessionId dan questionId wajib diisi.' });
    }
    if (req.file && !isAllowedMediaFile(req.file, 'image')) {
      return res.status(400).json({ error: 'Foto lembar jawaban harus berformat JPG/PNG/WEBP.' });
    }
    if (session.status === 'LOCKED') return res.status(423).json({ error: 'Sesi ujian sedang terkunci.' });
    if (session.need_token_reverify) return res.status(428).json({ error: 'Masukkan Token Ujian terbaru dari Pengawas untuk melanjutkan.', status: 'NEED_TOKEN' });
    if (session.status === 'FINISHED') return res.status(400).json({ error: 'Ujian sudah selesai dikumpulkan.' });

    const question = db.prepare('SELECT id, type, number FROM questions WHERE id = ? AND exam_id = ?').get(questionId, session.exam_id);
    if (!question) return res.status(404).json({ error: 'Soal tidak ditemukan pada jadwal ujian ini.' });
    if (question.type !== 'ESAI') return res.status(400).json({ error: 'Hanya soal esai yang dapat mengunggah foto lembar jawaban.' });

    let photoUrl = null;
    if (req.file) {
      photoUrl = saveUploadedMediaFile(req.file, `essay-s${sessionId}-q${question.number}`);
    } else if (req.body.photoBase64) {
      const base64Data = req.body.photoBase64.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(base64Data, 'base64');
      const filename = `essay-s${sessionId}-q${question.number}-${Date.now()}.jpg`;
      fs.writeFileSync(path.join(uploadsDir, filename), buf);
      photoUrl = `/uploads/${filename}`;
    } else {
      return res.status(400).json({ error: 'File foto lembar jawaban tidak ditemukan.' });
    }

    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO answers (session_id, question_id, chosen_option, essay_photo, updated_at)
      VALUES (?, ?, 'ESAI_PHOTO', ?, ?)
      ON CONFLICT(session_id, question_id) DO UPDATE SET
        chosen_option = 'ESAI_PHOTO',
        essay_photo = excluded.essay_photo,
        updated_at = excluded.updated_at
    `).run(session.id, question.id, photoUrl, nowIso);

    if (currentQuestionNumber) {
      db.prepare('UPDATE exam_sessions SET current_question_number = ?, last_activity_at = ? WHERE id = ?').run(currentQuestionNumber, nowIso, session.id);
    } else {
      db.prepare('UPDATE exam_sessions SET last_activity_at = ? WHERE id = ?').run(nowIso, session.id);
    }

    res.json({ ok: true, questionId: question.id, essayPhoto: photoUrl });
  });

  app.post('/api/ujian/answer', requireStudentSession, (req, res) => {
    const { questionId, chosenOption, currentQuestionNumber } = req.body || {};
    const session = req.examSession;

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

    const question = db.prepare('SELECT id, type FROM questions WHERE id = ? AND exam_id = ?').get(Number(questionId), session.exam_id);
    if (!question) return res.status(404).json({ error: 'Soal tidak ditemukan pada jadwal ujian ini.' });
    if (question.type !== 'PG') return res.status(400).json({ error: 'Soal esai dijawab dengan foto lembar jawaban, bukan pilihan ganda.' });

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

  app.post('/api/ujian/violation', requireStudentSession, (req, res) => {
    const { reason } = req.body || {};
    const session = req.examSession;
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

  app.post('/api/ujian/finish', requireStudentSession, (req, res) => {
    const session = req.examSession;
    if (session.status === 'FINISHED') return res.json({ status: 'FINISHED', finished_at: session.finished_at });
    if (session.status === 'LOCKED') {
      return res.status(423).json({ error: 'Sesi sedang terkunci. Minta pengawas membuka kunci terlebih dahulu.' });
    }
    if (session.need_token_reverify) {
      return res.status(428).json({ error: 'Masukkan Token Ujian terbaru dari Pengawas untuk melanjutkan.', status: 'NEED_TOKEN' });
    }

    // Periksa apakah ujian memiliki soal ESAI dan apakah semua lembar jawaban esai sudah difoto
    const esaiQuestions = db.prepare("SELECT id, number FROM questions WHERE exam_id = ? AND type = 'ESAI' ORDER BY number ASC").all(session.exam_id);
    if (esaiQuestions.length > 0) {
      const qIds = esaiQuestions.map(q => q.id);
      const placeholders = qIds.map(() => '?').join(',');
      const uploadedAnswers = db.prepare(`
        SELECT question_id FROM answers
        WHERE session_id = ? AND question_id IN (${placeholders}) AND essay_photo IS NOT NULL AND essay_photo != ''
      `).all(session.id, ...qIds);
      const uploadedSet = new Set(uploadedAnswers.map(a => a.question_id));
      const missingEsai = esaiQuestions.filter(q => !uploadedSet.has(q.id));
      if (missingEsai.length > 0) {
        const missingNos = missingEsai.map(q => `No. ${q.number}`).join(', ');
        return res.status(400).json({
          error: `Lembar jawaban untuk Soal Esai ${missingNos} belum difoto! Silakan foto lembar kertas jawaban Anda sebelum menyelesaikan ujian.`
        });
      }
    }

    const finishedAt = new Date().toISOString();
    db.prepare("UPDATE exam_sessions SET status = 'FINISHED', finished_at = ? WHERE id = ?").run(finishedAt, session.id);

    res.json({
      status: 'FINISHED',
      finished_at: finishedAt,
      message: 'Alhamdulillah, seluruh jawaban Pilihan Ganda & Foto Lembar Jawaban Esai Anda telah berhasil disimpan di Server CBT SMA Negeri 3 Buru. Pastikan lembar kertas fisik juga telah diserahkan kepada Pengawas Ruangan.'
    });
  });

  // Handler 404 berformat JSON untuk semua endpoint API yang tidak terdaftar
  app.all('/api/*', (req, res) => {
    res.status(404).json({ error: `Endpoint API ${req.method} ${req.path} tidak ditemukan pada server.` });
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
