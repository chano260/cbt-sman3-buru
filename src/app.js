const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const multer = require('multer');
const XLSX = require('xlsx');
const QRCode = require('qrcode');
const { parseDocxBuffer, parseQuestionsFromText, generateWordTemplateBuffer } = require('./wordParser');
const { hashPassword, verifyPassword, safeEqual, randomToken, isDefaultStaffPassword } = require('./security');
const { createBackup, backupStatus } = require('./backup');

const STAFF_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // Token login staf berlaku 12 jam
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, fieldSize: 12 * 1024 * 1024 } // Maks 25 MB per file audio/gambar
});

// Impor Excel dibatasi ketat (mitigasi kerentanan xlsx 0.18.5 saat membaca file berbahaya)
const EXCEL_MAX_BYTES = 2 * 1024 * 1024;
const excelUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: EXCEL_MAX_BYTES, files: 1 } });

// Esai dikerjakan di lembar kertas. Siswa menandai tiap soal esai "sudah menjawab".
// 'ESAI_PHOTO' tetap dihitung selesai untuk data lama dari masa fitur foto esai.
const ESSAY_DONE = 'ESAI_DONE';
const ESSAY_DONE_VALUES = [ESSAY_DONE, 'ESAI_PHOTO'];

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Ubah sheet menjadi baris objek tanpa prototype (kunci seperti __proto__ diabaikan)
function safeSheetRows(ws) {
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
  if (!matrix.length) return [];
  const headers = matrix[0].map(h => String(h || '').trim());
  return matrix.slice(1).map(cells => {
    const obj = Object.create(null);
    headers.forEach((h, i) => {
      if (!h || UNSAFE_KEYS.has(h)) return;
      const v = cells[i];
      if (v !== '' && v !== undefined && v !== null) obj[h] = v;
    });
    return obj;
  }).filter(r => Object.keys(r).length > 0);
}

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

const TOKEN_GRACE_SECONDS = 120; // token lama masih diterima 2 menit setelah pergantian otomatis

// ---------- Pencocokan kelas & mapel (persis, bukan potongan kata) ----------
function normText(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isAllClassesTarget(target) {
  const t = normText(target);
  return !t || t === 'all' || t === 'semua kelas' || t === '-';
}

// null = semua kelas; selain itu daftar kelas ternormalisasi
function parseClassTargets(target) {
  if (isAllClassesTarget(target)) return null;
  return String(target).split(/[,;]+/).map(normText).filter(Boolean);
}

function classInTarget(className, target) {
  const list = parseClassTargets(target);
  return list === null || list.includes(normText(className));
}

function classTargetsOverlap(a, b) {
  const la = parseClassTargets(a);
  const lb = parseClassTargets(b);
  if (la === null || lb === null) return true;
  return la.some(c => lb.includes(c));
}

function splitSubjects(str) {
  return String(str || '').split(/[,;&/]+/).map(normText).filter(Boolean);
}

// Mapel ujian harus sama persis dengan salah satu mapel yang diampu
function subjectMatches(teacherSubjectStr, examSubjectStr) {
  const exam = normText(examSubjectStr);
  return !!exam && splitSubjects(teacherSubjectStr).includes(exam);
}

// Nonaktifkan hanya ujian aktif yang target kelasnya bentrok (ujian paralel per kelas)
function deactivateOverlappingExams(db, examId, classTarget) {
  const actives = db.prepare('SELECT id, class_target FROM exams WHERE is_active = 1 AND id != ?').all(Number(examId) || 0);
  const off = db.prepare('UPDATE exams SET is_active = 0 WHERE id = ?');
  for (const e of actives) {
    if (classTargetsOverlap(e.class_target, classTarget)) off.run(e.id);
  }
}

function tokenMatches(exam, input) {
  const tok = String(input || '').toUpperCase().trim();
  if (!tok || !exam) return false;
  if (tok === String(exam.token || '').toUpperCase().trim()) return true;
  if (exam.prev_token && tok === String(exam.prev_token).toUpperCase().trim() && exam.token_updated_at) {
    const sinceRotate = (Date.now() - new Date(exam.token_updated_at).getTime()) / 1000;
    return sinceRotate <= TOKEN_GRACE_SECONDS;
  }
  return false;
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
    const prevToken = exam.token_updated_at ? exam.token : null;
    db.prepare('UPDATE exams SET token = ?, token_updated_at = ?, prev_token = ? WHERE id = ?').run(nextToken, nowIso, prevToken, exam.id);
    exam.prev_token = prevToken;
    exam.token = nextToken;
    exam.token_updated_at = nowIso;
    return { ...exam, token_remaining_seconds: TOKEN_ROTATION_SECONDS };
  }

  return {
    ...exam,
    token_remaining_seconds: Math.max(0, TOKEN_ROTATION_SECONDS - elapsedSec)
  };
}

// Pilih ujian aktif untuk sebuah kelas: utamakan yang menyebut kelas itu, lalu yang untuk "Semua Kelas"
function pickExamForClass(activeExams, className) {
  const specific = activeExams.find(e => {
    const list = parseClassTargets(e.class_target);
    return list !== null && list.includes(normText(className));
  });
  return specific || activeExams.find(e => isAllClassesTarget(e.class_target)) || null;
}

// Pencocokan ujian aktif sesuai kelas siswa (ujian paralel per kelas, anti-tertukar)
function getActiveExamForStudent(db, className) {
  const actives = db.prepare('SELECT * FROM exams WHERE is_active = 1 ORDER BY id DESC').all();
  if (className && !isAllClassesTarget(className)) {
    const pick = pickExamForClass(actives, className);
    return pick ? ensureFresh15MinToken(db, pick) : null;
  }
  return actives[0] ? ensureFresh15MinToken(db, actives[0]) : null;
}

// Cari bank soal sumber untuk salin otomatis: mapel sama persis DAN guru yang sama
function findDonorExam(db, targetExamId, subject, teacherId) {
  const candidates = db.prepare(`
    SELECT id, subject FROM exams
    WHERE id != ? AND teacher_id IS ?
      AND (SELECT COUNT(*) FROM questions WHERE exam_id = exams.id) > 0
    ORDER BY id DESC
  `).all(Number(targetExamId), teacherId === undefined || teacherId === null ? null : Number(teacherId));
  return candidates.find(c => normText(c.subject) === normText(subject)) || null;
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

// ---------- Safe Exam Browser (iPhone/iPad) ----------
// Format .seb resmi (safeexambrowser.org/developer/seb-file-format.html):
// gzip( "plnd" + gzip(plist XML) ) untuk pengaturan tanpa enkripsi.
// hashedQuitPassword = SHA-256 (hex) dari password keluar; bila diisi, SEB iOS berjalan dalam
// mode aman dengan kunci iOS (Automatic Assessment Configuration).
function xmlEscape(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildSebConfig(startURL, hashedQuitPassword) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>sebConfigPurpose</key>
  <integer>0</integer>
  <key>sebMode</key>
  <integer>0</integer>
  <key>startURL</key>
  <string>${xmlEscape(startURL)}</string>
  <key>hashedQuitPassword</key>
  <string>${xmlEscape(hashedQuitPassword)}</string>
  <key>allowQuit</key>
  <true/>
  <key>URLFilterEnable</key>
  <false/>
  <key>sendBrowserExamKey</key>
  <false/>
</dict>
</plist>
`;
  const inner = zlib.gzipSync(Buffer.from(xml, 'utf8'));
  return zlib.gzipSync(Buffer.concat([Buffer.from('plnd', 'latin1'), inner]));
}

// Nilai PG skala 0–100, dibulatkan ke bilangan bulat (pembulatan biasa: ,5 ke atas).
// Dikali 100 dulu baru dibagi supaya pecahan seperti 17,5 tidak meleset karena galat bilangan biner.
function pgScore(correct, total) {
  return total > 0 ? Math.round((correct * 100) / total) : 0;
}

function calculateExamScores(db, examId) {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  if (!exam) return { exam: null, pgCount: 0, esaiCount: 0, scores: [] };

  const pgQuestions = db.prepare("SELECT id, number, answer_key FROM questions WHERE exam_id = ? AND type = 'PG'").all(examId);
  const esaiCount = db.prepare("SELECT COUNT(*) as c FROM questions WHERE exam_id = ? AND type = 'ESAI'").get(examId).c;
  const pgCount = pgQuestions.length;
  const keyMap = new Map(pgQuestions.map(q => [q.id, (q.answer_key || '').toUpperCase()]));

  const sessions = db.prepare('SELECT * FROM exam_sessions WHERE exam_id = ?').all(examId);
  const sessionMap = new Map(sessions.map(s => [s.student_id, s]));
  // Hanya siswa kelas target ujian, ditambah siswa yang sudah punya sesi (misal setelah pindah kelas)
  const students = db.prepare('SELECT * FROM students ORDER BY room ASC, seat_number ASC, full_name ASC').all()
    .filter(st => sessionMap.has(st.id) || classInTarget(st.class_name, exam.class_target));

  // Satu query untuk semua jawaban ujian ini (bukan satu query per siswa)
  const answersBySession = new Map();
  const allAnswers = db.prepare(`
    SELECT a.session_id, a.question_id, a.chosen_option, a.updated_at, q.number
    FROM answers a
    JOIN questions q ON q.id = a.question_id
    JOIN exam_sessions s ON s.id = a.session_id
    WHERE s.exam_id = ?
    ORDER BY q.number ASC
  `).all(examId);
  for (const a of allAnswers) {
    if (!answersBySession.has(a.session_id)) answersBySession.set(a.session_id, []);
    answersBySession.get(a.session_id).push(a);
  }

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
        esai_answered: 0,
        total_esai: esaiCount,
        recent_choices: [],
        score: 0
      };
    }

    const ansRows = answersBySession.get(sess.id) || [];

    let correct = 0;
    let answeredPg = 0;
    let esaiAnswered = 0;
    const recentChoices = [];
    for (const ans of ansRows) {
      if (ESSAY_DONE_VALUES.includes(ans.chosen_option)) esaiAnswered++;
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
    const rawScore = pgScore(correct, pgCount);

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
      esai_answered: esaiAnswered,
      total_esai: esaiCount,
      recent_choices: recentChoices,
      score: rawScore
    };
  });

  return { exam, pgCount, esaiCount, scores };
}

function createApp(db, { backupDir = path.join(__dirname, '..', 'backups'), enforceDefaultPasswordChange = true } = {}) {
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

    // QR kedua untuk iPhone/iPad: tautan seb(s):// ke file .seb (hanya bila password keluar sudah diatur)
    const rowSeb = db.prepare("SELECT value FROM settings WHERE key = 'seb_quit_hash'").get();
    const sebReady = !!(rowSeb && rowSeb.value);
    const sebUrl = baseUrl.replace(/^https:\/\//i, 'sebs://').replace(/^http:\/\//i, 'seb://').replace(/\/ujian\.html$/i, '') + '/seb/ujian.seb';
    const sebQrDataUrl = sebReady ? await QRCode.toDataURL(sebUrl, { width: 240, margin: 3 }) : null; // ruang kosong lebih lebar: mudah dibedakan dari QR lain

    return {
      publicUrl: rowUrl ? rowUrl.value : '',
      qrMode,
      qrPayload,
      baseUrl,
      examUrl,
      qrDataUrl,
      sebReady,
      sebUrl,
      sebQrDataUrl
    };
  }

  function teacherCanAccessExam(staffUser, examOrObj) {
    if (!examOrObj || !staffUser) return false;
    if (staffUser.role === 'operator') return true;
    if (staffUser.role !== 'guru') return false;

    // 1. Akun guru WAJIB mengampu mata pelajaran ini (nama mapel sama persis). Guru tanpa mapel tidak punya akses.
    if (!subjectMatches(staffUser.subject, examOrObj.subject)) {
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
  function staffTokenFromReq(req) {
    const authHeader = req.headers.authorization || '';
    let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token && req.method === 'GET') token = String(req.query.staffToken || '');
    return token;
  }

  // Staf yang masih wajib ganti password bawaan diperlakukan seperti belum login (kecuali di requireStaffAuth)
  function getStaffFromReq(req) {
    const user = getStaffSessionFromReq(req);
    return user && !user.mustChangePassword ? user : null;
  }

  function getStaffSessionFromReq(req) {
    const token = staffTokenFromReq(req);
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
    return { ...user, mustChangePassword: !!entry.mustChangePassword };
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
      const staffUser = getStaffSessionFromReq(req);
      if (!staffUser) {
        return res.status(401).json({ error: 'Akses ditolak: Silakan login staf terlebih dahulu.' });
      }
      if (staffUser.mustChangePassword) {
        return res.status(403).json({ code: 'PASSWORD_CHANGE_REQUIRED', error: 'Akun ini masih memakai password bawaan. Ganti password terlebih dahulu.' });
      }
      if (allowedRoles && !allowedRoles.includes(staffUser.role) && staffUser.role !== 'operator') {
        return res.status(403).json({ error: 'Peran akun tidak memiliki akses ke menu ini.' });
      }
      req.staffUser = staffUser;
      next();
    };
  }

  // Ruang yang menjadi tanggung jawab akun pengawas (null = tidak dibatasi: operator / pengawas "Semua Ruang")
  function pengawasRoomOf(user) {
    if (!user || user.role !== 'pengawas') return null;
    const room = String(user.room || '').trim();
    if (!room || room === 'ALL' || /^semua/i.test(room)) return null;
    return room;
  }

  function canManageStudentRoom(user, student) {
    const room = pengawasRoomOf(user);
    return !room || (student && student.room === room);
  }

  // Muat sesi + siswa lalu pastikan pengawas hanya mengelola siswa di ruangnya
  function loadSessionForStaff(req, res) {
    const session = db.prepare('SELECT * FROM exam_sessions WHERE id = ?').get(Number(req.params.sessionId));
    if (!session) {
      res.status(404).json({ error: 'Sesi siswa tidak ditemukan' });
      return null;
    }
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(session.student_id);
    if (!canManageStudentRoom(req.staffUser, student)) {
      res.status(403).json({ error: `Akses ditolak: siswa ini bukan peserta di ruang Anda (${pengawasRoomOf(req.staffUser)}).` });
      return null;
    }
    return { session, student };
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

  // Jadwal ujian untuk Beranda (publik): hanya informasi jadwal, tanpa token & tanpa soal.
  // Draf bank soal yang masih kosong tidak ditampilkan. Ujian aktif di urutan teratas.
  app.get('/api/jadwal-ujian', (req, res) => {
    const jadwal = db.prepare(`
      SELECT e.id, e.subject, e.title, e.class_target, e.exam_date, e.start_time, e.session_name,
             e.duration_minutes, e.is_active
      FROM exams e
      WHERE e.is_active = 1 OR EXISTS (SELECT 1 FROM questions q WHERE q.exam_id = e.id)
      ORDER BY e.is_active DESC, e.exam_date ASC, e.start_time ASC, e.id ASC
    `).all();
    res.json({ jadwal });
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
    const mustChangePassword = enforceDefaultPasswordChange && isDefaultStaffPassword(password);
    const staffToken = randomToken(24);
    staffTokens.set(staffToken, { userId: user.id, expiresAt: Date.now() + STAFF_TOKEN_TTL_MS, mustChangePassword });
    res.json({ user, staffToken, mustChangePassword });
  });

  // Ganti password sendiri (wajib bila login memakai password bawaan)
  app.post('/api/staff/change-password', (req, res) => {
    const token = staffTokenFromReq(req);
    const entry = token && staffTokens.get(token);
    const user = getStaffSessionFromReq(req);
    if (!user || !entry) return res.status(401).json({ error: 'Silakan login staf terlebih dahulu.' });

    const oldPw = String((req.body || {}).old_password || '').trim();
    const newPw = String((req.body || {}).new_password || '').trim();
    const row = db.prepare('SELECT password FROM users WHERE id = ?').get(user.id);
    if (!verifyPassword(oldPw, row.password)) {
      return res.status(401).json({ error: 'Password lama salah.' });
    }
    if (newPw.length < 8) return res.status(400).json({ error: 'Password baru minimal 8 karakter.' });
    if (isDefaultStaffPassword(newPw)) return res.status(400).json({ error: 'Password baru tidak boleh memakai password bawaan.' });
    if (newPw.toLowerCase() === String(user.username).toLowerCase()) {
      return res.status(400).json({ error: 'Password baru tidak boleh sama dengan username.' });
    }
    if (newPw === oldPw) return res.status(400).json({ error: 'Password baru harus berbeda dari password lama.' });

    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(newPw), user.id);
    entry.mustChangePassword = false;
    res.json({ ok: true });
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
    // Ujian paralel per kelas: kirim SEMUA ujian aktif beserta tokennya (activeExam tetap untuk kompatibilitas)
    const activeExams = exams.filter(e => e.is_active === 1).map(e => {
      const fresh = activeExam && e.id === activeExam.id ? activeExam : ensureFresh15MinToken(db, e);
      return {
        id: fresh.id,
        title: fresh.title,
        subject: fresh.subject,
        class_target: fresh.class_target,
        session_name: fresh.session_name,
        token: fresh.token,
        token_remaining_seconds: fresh.token_remaining_seconds,
        teacher_name: fresh.teacher_name,
        pg_count: fresh.pg_count,
        esai_count: fresh.esai_count,
        total_questions: fresh.total_questions
      };
    });
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

      // Satu query untuk jawaban semua sesi terbaru (bukan satu query per siswa)
      const overviewAnswers = new Map();
      const latestIds = [...latestSessionByStudent.values()].map(s => s.id);
      for (let i = 0; i < latestIds.length; i += 400) {
        const chunk = latestIds.slice(i, i + 400);
        const rows = db.prepare(`
          SELECT a.session_id, a.question_id, a.chosen_option, a.updated_at, q.number
          FROM answers a
          JOIN questions q ON q.id = a.question_id
          WHERE a.session_id IN (${chunk.map(() => '?').join(',')})
          ORDER BY q.number ASC
        `).all(...chunk);
        for (const a of rows) {
          if (!overviewAnswers.has(a.session_id)) overviewAnswers.set(a.session_id, []);
          overviewAnswers.get(a.session_id).push(a);
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
        const ansRows = overviewAnswers.get(sess.id) || [];

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
        const score = pgScore(correct, cache.pgCount);

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
      activeExams,
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

  // ---------- Aplikasi ujian Android sekolah ----------
  // Kode masuk aplikasi (diatur operator, disimpan ter-hash), tiket aplikasi 12 jam di memori,
  // dan sakelar "Wajibkan aplikasi ujian" (bawaan mati, untuk masa peralihan).
  const APP_TICKET_TTL_MS = 12 * 60 * 60 * 1000;
  const APP_CODE_MAX_FAILS = 10;
  const APP_CODE_WINDOW_MS = 15 * 60 * 1000;
  const appTickets = new Map();
  const appCodeFailures = new Map();

  function getSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  }
  function setSetting(key, value) {
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }
  function appSettingsState() {
    return { codeSet: !!getSetting('app_code_hash'), requireApp: getSetting('require_app') === '1' };
  }
  function readCookie(req, name) {
    const raw = String(req.headers.cookie || '');
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return '';
  }
  function hasValidAppTicket(req) {
    const ticket = String(req.headers['x-app-ticket'] || '') || readCookie(req, 'cbt_app');
    if (!ticket) return false;
    const exp = appTickets.get(ticket);
    if (!exp) return false;
    if (Date.now() > exp) { appTickets.delete(ticket); return false; }
    return true;
  }
  function isSafeExamBrowser(req) {
    return /\bSEB\/\d/.test(String(req.headers['user-agent'] || ''));
  }
  function requireAppIfEnabled(req, res, next) {
    if (getSetting('require_app') !== '1') return next();
    if (hasValidAppTicket(req) || isSafeExamBrowser(req)) return next();
    return res.status(403).json({ error: 'Ujian hanya bisa dibuka lewat aplikasi ujian sekolah (atau Safe Exam Browser untuk iPhone/PC).' });
  }

  app.get('/api/operator/app-settings', requireStaffAuth(['operator']), (req, res) => {
    res.json(appSettingsState());
  });

  app.post('/api/operator/app-settings', requireStaffAuth(['operator']), (req, res) => {
    const { code, requireApp } = req.body || {};
    if (code !== undefined) {
      const c = String(code).trim();
      if (!/^\d{4,8}$/.test(c)) return res.status(400).json({ error: 'Kode masuk aplikasi harus 4–8 digit angka.' });
      setSetting('app_code_hash', hashPassword(c));
    }
    if (requireApp !== undefined) setSetting('require_app', requireApp ? '1' : '0');
    res.json({ ok: true, ...appSettingsState() });
  });

  app.post('/api/app/verify-code', (req, res) => {
    const key = String(req.ip || req.socket.remoteAddress || '');
    const fail = appCodeFailures.get(key);
    if (fail && fail.count >= APP_CODE_MAX_FAILS && Date.now() - fail.firstAt < APP_CODE_WINDOW_MS) {
      return res.status(429).json({ error: 'Terlalu banyak percobaan kode salah. Tunggu beberapa menit.' });
    }
    const hash = getSetting('app_code_hash');
    if (!hash) return res.status(404).json({ error: 'Kode masuk aplikasi belum diatur operator.' });
    const code = String((req.body || {}).code || '').trim();
    if (!verifyPassword(code, hash)) {
      const cur = (fail && Date.now() - fail.firstAt < APP_CODE_WINDOW_MS) ? fail : { count: 0, firstAt: Date.now() };
      cur.count++;
      appCodeFailures.set(key, cur);
      return res.status(401).json({ error: 'Kode masuk salah.' });
    }
    appCodeFailures.delete(key);
    const ticket = randomToken(24);
    appTickets.set(ticket, Date.now() + APP_TICKET_TTL_MS);
    res.setHeader('Set-Cookie', `cbt_app=${ticket}; Path=/; Max-Age=${APP_TICKET_TTL_MS / 1000}; HttpOnly; SameSite=Lax`);
    res.json({ ok: true, ticket, expiresInSec: APP_TICKET_TTL_MS / 1000 });
  });

  app.post('/api/app/verify-quit', (req, res) => {
    const hash = getSetting('seb_quit_hash');
    if (!hash) return res.status(404).json({ error: 'Password pengawas (password keluar SEB) belum diatur operator.' });
    const pw = String((req.body || {}).password || '').trim();
    const given = crypto.createHash('sha256').update(pw, 'utf8').digest('hex');
    if (!safeEqual(given, hash)) return res.status(401).json({ error: 'Password pengawas salah.' });
    res.json({ ok: true, hash });
  });

  // Password keluar Safe Exam Browser (disimpan sebagai hash SHA-256, password asli tidak disimpan)
  app.post('/api/operator/seb-settings', requireStaffAuth(['operator']), async (req, res) => {
    const pw = String((req.body || {}).quitPassword || '').trim();
    if (pw.length < 6) return res.status(400).json({ error: 'Password keluar SEB minimal 6 karakter.' });
    const hash = crypto.createHash('sha256').update(pw, 'utf8').digest('hex');
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('seb_quit_hash', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(hash);
    res.json({ ok: true, ...(await buildQrBundle(req)) });
  });

  // File pengaturan SEB untuk iPhone/iPad (publik: hanya berisi alamat ujian & hash password keluar)
  app.get('/seb/ujian.seb', (req, res) => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'seb_quit_hash'").get();
    if (!row || !row.value) {
      return res.status(404).json({ error: 'Pengaturan Safe Exam Browser belum dibuat operator.' });
    }
    const baseUrl = getEffectiveBaseUrl(req);
    const examUrl = baseUrl.endsWith('/ujian.html') ? baseUrl : `${baseUrl}/ujian.html`;
    res.setHeader('Content-Type', 'application/seb');
    res.setHeader('Content-Disposition', 'attachment; filename="ujian.seb"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buildSebConfig(examUrl, row.value));
  });

  app.post('/api/operator/token', requireStaffAuth(['operator']), (req, res) => {
    const { examId, customToken } = req.body || {};
    const newToken = customToken ? String(customToken).toUpperCase().trim() : generateRandomToken();
    if (!/^[A-Z0-9]{4,8}$/.test(newToken)) {
      return res.status(400).json({ error: 'Token custom harus 4-8 karakter huruf/angka tanpa spasi.' });
    }
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
        deactivateOverlappingExams(db, existing.id, class_target || existing.class_target);
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
    deactivateOverlappingExams(db, 0, class_target || 'Semua Kelas');

    let targetTeacherId = null;
    if (req.body && req.body.teacher_id) {
      targetTeacherId = Number(req.body.teacher_id);
    } else {
      const teachers = db.prepare("SELECT id, subject FROM users WHERE role = 'guru' ORDER BY id ASC").all();
      const match = teachers.find(t => subjectMatches(t.subject, subject));
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
    const donor = findDonorExam(db, newExamId, subject, targetTeacherId);
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
      const donor = findDonorExam(db, examId, targetExam.subject, targetExam.teacher_id);
      if (donor) {
        autoCopied = copyQuestions(db, donor.id, examId);
        invalidateQuestionsCache(examId);
      }
    }

    deactivateOverlappingExams(db, examId, targetExam.class_target);
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
      // Sengaja TIDAK mengaktifkan ujian lain secara otomatis: operator yang memilih jadwal berikutnya
      db.prepare('DELETE FROM exams WHERE id = ?').run(examId);
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
  app.post('/api/operator/students/import-excel', requireStaffAuth(['operator']), excelUpload.single('file'), (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: 'File Excel (.xlsx) tidak ditemukan' });
      }
      const ext = path.extname(String(req.file.originalname || '')).toLowerCase();
      if (ext !== '.xlsx' && ext !== '.xls') {
        return res.status(400).json({ error: 'Format file harus Excel (.xlsx atau .xls).' });
      }
      // Hasil rumus tetap terbaca dari nilai tersimpan di file; teks rumus, HTML, gaya & makro tidak diproses
      const wb = XLSX.read(req.file.buffer, {
        type: 'buffer', cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false, sheets: 0
      });
      const sheetName = wb.SheetNames[0];
      const rows = safeSheetRows(wb.Sheets[sheetName]);
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
    if (!canManageStudentRoom(req.staffUser, student)) {
      return res.status(403).json({ error: `Akses ditolak: siswa ini bukan peserta di ruang Anda (${pengawasRoomOf(req.staffUser)}).` });
    }

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

  // ---------- Impor akun guru & pengawas dari Excel ----------
  const STAFF_TEMPLATE_COLUMNS = ['Peran', 'Nama Lengkap', 'Username', 'Password', 'Mapel / Ruang'];

  app.get('/api/operator/template-staff-excel', requireStaffAuth(['operator']), (req, res) => {
    const rows = [
      ['guru', 'Ibu Dra. Siti Aminah, S.Pd.', 'guru_kimia', 'Kimia#2026', 'Kimia'],
      ['guru', 'Bpk. Ahmad Lessy, S.Pd.', 'guru_mtk', 'Mtk#2026', 'Matematika, Fisika'],
      ['pengawas', 'Bpk. La Ode Hidayat, S.Pd.', 'pengawas_r01', 'Ruang01#2026', 'Ruang 01']
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([STAFF_TEMPLATE_COLUMNS, ...rows]);
    ws['!cols'] = [{ wch: 10 }, { wch: 30 }, { wch: 16 }, { wch: 16 }, { wch: 22 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Akun Guru & Pengawas');
    const help = XLSX.utils.aoa_to_sheet([
      ['Petunjuk pengisian'],
      ['Peran: isi "guru" atau "pengawas". Akun operator tidak bisa dibuat lewat impor.'],
      ['Username: tanpa spasi. Bila username sudah ada, datanya diperbarui.'],
      ['Password: minimal 8 karakter disarankan. Kosongkan untuk akun lama bila password tidak diubah.'],
      ['Mapel / Ruang: guru = nama mapel (dua mapel dipisah koma), pengawas = nama ruang, misal Ruang 01.']
    ]);
    help['!cols'] = [{ wch: 100 }];
    XLSX.utils.book_append_sheet(wb, help, 'Petunjuk');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Template-Import-Akun-Guru-Pengawas.xlsx"');
    res.send(buf);
  });

  app.post('/api/operator/staff/import-excel', requireStaffAuth(['operator']), excelUpload.single('file'), (req, res) => {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'File Excel (.xlsx) tidak ditemukan' });
    const ext = path.extname(String(req.file.originalname || '')).toLowerCase();
    if (ext !== '.xlsx' && ext !== '.xls') return res.status(400).json({ error: 'Format file harus Excel (.xlsx atau .xls).' });

    let rows;
    try {
      // Hasil rumus tetap terbaca dari nilai tersimpan; teks rumus, HTML, gaya & makro tidak diproses
      const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false, sheets: 0 });
      rows = safeSheetRows(wb.Sheets[wb.SheetNames[0]]);
    } catch (err) {
      return res.status(400).json({ error: 'File Excel tidak bisa dibaca: ' + err.message });
    }
    if (!rows.length) return res.status(400).json({ error: 'File Excel kosong' });

    const pick = (r, keys) => { for (const k of keys) if (r[k] !== undefined) return String(r[k]).trim(); return ''; };
    const findUser = db.prepare('SELECT id, role FROM users WHERE username = ?');
    const insertUser = db.prepare('INSERT INTO users (username, password, full_name, role, subject, room) VALUES (?, ?, ?, ?, ?, ?)');
    const updateUser = db.prepare(`UPDATE users SET full_name = ?, role = ?, subject = ?, room = ?,
      password = COALESCE(?, password) WHERE id = ?`);

    let created = 0;
    let updated = 0;
    const skipped = [];
    const run = db.transaction(() => {
      rows.forEach((r, i) => {
        const rowNo = i + 2; // baris 1 = judul kolom
        const roleRaw = pick(r, ['Peran', 'Role', 'role']).toLowerCase();
        const role = /guru/.test(roleRaw) ? 'guru' : /pengawas/.test(roleRaw) ? 'pengawas' : '';
        const fullName = pick(r, ['Nama Lengkap', 'Nama', 'full_name']);
        const username = pick(r, ['Username', 'username']);
        const password = pick(r, ['Password', 'password']);
        const meta = pick(r, ['Mapel / Ruang', 'Mapel', 'Ruang', 'Mata Pelajaran']);

        if (!role) return skipped.push({ row: rowNo, reason: roleRaw ? `peran "${roleRaw}" tidak didukung (hanya guru/pengawas)` : 'peran kosong' });
        if (!fullName) return skipped.push({ row: rowNo, reason: 'nama lengkap kosong' });
        if (!username || /\s/.test(username)) return skipped.push({ row: rowNo, reason: 'username kosong atau berisi spasi' });

        const subject = role === 'guru' ? (meta || null) : null;
        const room = role === 'pengawas' ? (meta || null) : null;
        const existing = findUser.get(username);
        if (existing) {
          if (existing.role === 'operator') return skipped.push({ row: rowNo, reason: `username "${username}" milik akun operator` });
          updateUser.run(fullName, role, subject, room, password ? hashPassword(password) : null, existing.id);
          updated++;
        } else {
          if (!password) return skipped.push({ row: rowNo, reason: 'password kosong untuk akun baru' });
          insertUser.run(username, hashPassword(password), fullName, role, subject, room);
          created++;
        }
      });
    });
    try {
      run();
    } catch (err) {
      return res.status(500).json({ error: 'Gagal mengimpor akun: ' + err.message });
    }
    res.json({ created, updated, skipped });
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

  // Backup database: status backup otomatis & unduh salinan baru (hanya operator)
  app.get('/api/operator/backup/status', requireStaffAuth(['operator']), (req, res) => {
    res.json(backupStatus(backupDir));
  });

  app.get('/api/operator/backup/download', requireStaffAuth(['operator']), (req, res) => {
    let file;
    try {
      file = createBackup(db, backupDir);
    } catch (err) {
      console.error('[backup] GAGAL unduh:', err.message);
      return res.status(500).json({ error: 'Gagal membuat backup: ' + err.message });
    }
    res.download(file, path.basename(file));
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
        // 1. Mata pelajaran ujian WAJIB sama persis dengan mapel yang diampu oleh akun guru ini!
        if (!subjectMatches(staffUser.subject, exam.subject)) return false;

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
    if (req.staffUser.role === 'guru' && !subjectMatches(req.staffUser.subject, subject)) {
      return res.status(403).json({ error: `Anda hanya dapat membuat bank soal untuk mapel yang Anda ampu (${req.staffUser.subject || 'belum diatur operator'}).` });
    }
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

  // Ubah data paket: nama, kelas, durasi. Mapel tidak diubah (hak akses guru ditentukan dari mapel).
  app.put('/api/guru/exams/:id', requireStaffAuth(['guru', 'operator']), (req, res) => {
    const examId = Number(req.params.id);
    const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
    if (!exam) return res.status(404).json({ error: 'Paket ujian tidak ditemukan' });
    if (!teacherCanAccessExam(req.staffUser, exam)) {
      return res.status(403).json({ error: 'Akses ditolak: Anda tidak memiliki akses ke paket ujian ini.' });
    }
    const body = req.body || {};
    const title = String(body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Nama paket ujian wajib diisi.' });
    const classTarget = String(body.class_target || '').trim() || 'Semua Kelas';
    const duration = Number(body.duration_minutes);
    if (!Number.isInteger(duration) || duration < 1 || duration > 600) {
      return res.status(400).json({ error: 'Durasi pengerjaan harus 1–600 menit.' });
    }

    // Paket yang sedang aktif tidak boleh menabrak kelas ujian aktif lain (siswa bingung paket mana yang keluar)
    if (exam.is_active) {
      const clash = db.prepare('SELECT id, subject, title, class_target FROM exams WHERE is_active = 1 AND id != ?').all(examId)
        .find(e => classTargetsOverlap(e.class_target, classTarget));
      if (clash) {
        return res.status(409).json({
          error: `Paket ini sedang aktif, dan kelas ${classTarget} bentrok dengan ujian aktif lain: ${clash.subject} — ${clash.title} (${clash.class_target}). Minta operator menonaktifkan salah satunya dulu.`
        });
      }
    }

    db.prepare('UPDATE exams SET title = ?, class_target = ?, duration_minutes = ? WHERE id = ?').run(title, classTarget, duration, examId);
    res.json({ ok: true, exam: db.prepare('SELECT id, title, subject, class_target, duration_minutes, is_active FROM exams WHERE id = ?').get(examId) });
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
      // Sengaja TIDAK mengaktifkan ujian lain secara otomatis: operator yang memilih jadwal berikutnya
      db.prepare('DELETE FROM exams WHERE id = ?').run(examId);
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

  // Edit isi soal (nomor, jenis, teks, opsi, kunci). Gambar & audio diatur lewat endpoint media di atas.
  // Kunci boleh dibetulkan walau siswa sudah menjawab: nilai dihitung ulang otomatis dari kunci terbaru.
  app.put('/api/guru/questions/:questionId', requireStaffAuth(['guru', 'operator']), (req, res) => {
    const questionId = Number(req.params.questionId);
    const existing = db.prepare('SELECT q.*, e.teacher_id, e.subject, e.class_target FROM questions q JOIN exams e ON q.exam_id = e.id WHERE q.id = ?').get(questionId);
    if (!existing) return res.status(404).json({ error: 'Soal tidak ditemukan' });
    if (!teacherCanAccessExam(req.staffUser, existing)) {
      return res.status(403).json({ error: 'Akses ditolak: Anda tidak memiliki akses ke butir soal ini.' });
    }

    const body = req.body || {};
    const number = Number(body.number);
    if (!Number.isInteger(number) || number < 1) return res.status(400).json({ error: 'Nomor soal harus angka 1 atau lebih.' });
    const type = body.type === 'ESAI' ? 'ESAI' : 'PG';
    const text = String(body.question_text || '').trim();
    if (!text && !existing.image_data) return res.status(400).json({ error: 'Teks soal wajib diisi (kecuali soal bergambar).' });

    const opt = (k) => String(body[k] == null ? '' : body[k]).trim();
    let key = null;
    if (type === 'PG') {
      key = String(body.answer_key || '').trim().toUpperCase();
      if (!/^[A-E]$/.test(key)) return res.status(400).json({ error: 'Kunci jawaban harus A, B, C, D, atau E.' });
      if (!opt(`option_${key.toLowerCase()}`)) return res.status(400).json({ error: `Opsi ${key} kosong, padahal dipilih sebagai kunci jawaban.` });
    }

    const answeredCount = db.prepare('SELECT COUNT(*) AS c FROM answers WHERE question_id = ?').get(questionId).c;
    if (type !== existing.type && answeredCount > 0) {
      return res.status(409).json({
        error: `Jenis soal tidak dapat diganti karena sudah ada ${answeredCount} jawaban siswa untuk soal ini.`
      });
    }

    const isPg = type === 'PG';
    db.prepare(`
      UPDATE questions SET number = ?, type = ?, question_text = ?,
        option_a = ?, option_b = ?, option_c = ?, option_d = ?, option_e = ?, answer_key = ?
      WHERE id = ?
    `).run(
      number, type, text,
      isPg ? opt('option_a') : null,
      isPg ? opt('option_b') : null,
      isPg ? opt('option_c') : null,
      isPg ? opt('option_d') : null,
      isPg ? opt('option_e') : null,
      key,
      questionId
    );
    invalidateQuestionsCache(existing.exam_id);
    const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId);
    res.json({ ok: true, question, answeredCount });
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
        // Mengganti soal saat siswa sudah menjawab akan memutus jawaban dari soalnya (nilai hilang)
        const answered = db.prepare('SELECT COUNT(*) AS c FROM answers a JOIN questions q ON q.id = a.question_id WHERE q.exam_id = ?').get(examId).c;
        if (answered > 0) {
          return res.status(409).json({
            error: `Soal tidak dapat diganti karena sudah ada ${answered} jawaban siswa pada paket ini. Gunakan mode tambah soal, atau buat paket ujian baru.`
          });
        }
      }

      const insertQ = db.prepare(`
        INSERT INTO questions (exam_id, number, type, question_text, image_data, option_a, option_b, option_c, option_d, option_e, answer_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const importTx = db.transaction(() => {
      if (replaceExisting) {
        db.prepare('DELETE FROM questions WHERE exam_id = ?').run(examId);
      }
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
      });
      importTx();

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
      'Esai Ditandai Dijawab': `${s.esai_answered || 0}/${s.total_esai || 0}`,
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
    // Pengawas dengan ruang tertentu selalu dikunci ke ruangnya sendiri
    const ownRoom = pengawasRoomOf(req.staffUser);
    const room = ownRoom || req.query.room || 'ALL';
    const actives = db.prepare('SELECT * FROM exams WHERE is_active = 1 ORDER BY id DESC').all().map(e => ensureFresh15MinToken(db, e));
    const qrBundle = await buildQrBundle(req);
    if (actives.length === 0) return res.json({ activeExam: null, activeExams: [], ...qrBundle, lockedRoom: ownRoom, students: [], reports: [] });

    // Ujian paralel: setiap siswa di ruang ini dipetakan ke ujian aktif sesuai kelasnya
    const roomStudents = db.prepare('SELECT * FROM students ORDER BY room ASC, seat_number ASC, full_name ASC').all()
      .filter(s => room === 'ALL' || s.room === room);
    const scoreCache = new Map();
    const scoresFor = (examId) => {
      if (!scoreCache.has(examId)) {
        const data = calculateExamScores(db, examId);
        scoreCache.set(examId, { data, byStudent: new Map(data.scores.map(s => [s.student_id, s])) });
      }
      return scoreCache.get(examId);
    };
    const examUse = new Map();
    const students = roomStudents.map(st => {
      const exam = pickExamForClass(actives, st.class_name);
      if (!exam) {
        return {
          student_id: st.id, session_id: null, exam_id: null, exam_subject: '-', exam_title: '-',
          exam_number: st.exam_number, nisn: st.nisn, full_name: st.full_name, class_name: st.class_name,
          room: st.room, seat_number: st.seat_number, status: 'NOT_STARTED', need_token_reverify: 0,
          current_question_number: null, last_activity_at: null, violation_count: 0, last_violation_reason: null,
          answered_pg: 0, total_pg: 0, recent_choices: []
        };
      }
      examUse.set(exam.id, (examUse.get(exam.id) || 0) + 1);
      const { score, correct_pg, wrong_pg, ...rest } = scoresFor(exam.id).byStudent.get(st.id);
      return rest;
    });

    const usedExams = actives.filter(e => examUse.has(e.id));
    const listForRoom = usedExams.length > 0 ? usedExams : actives;
    const primary = [...listForRoom].sort((a, b) => (examUse.get(b.id) || 0) - (examUse.get(a.id) || 0))[0];
    const primaryScores = scoresFor(primary.id).data;
    const examIds = listForRoom.map(e => e.id);
    const reports = db.prepare(`SELECT * FROM room_reports WHERE exam_id IN (${examIds.map(() => '?').join(',')}) ORDER BY id DESC`).all(...examIds);
    const pub = (e) => ({
      id: e.id,
      title: e.title,
      subject: e.subject,
      class_target: e.class_target,
      session_name: e.session_name,
      token: e.token,
      token_remaining_seconds: e.token_remaining_seconds,
      duration_minutes: e.duration_minutes
    });
    res.json({
      ...qrBundle,
      lockedRoom: ownRoom,
      activeExam: pub(primary),
      activeExams: listForRoom.map(pub),
      pgCount: primaryScores.pgCount,
      esaiCount: primaryScores.esaiCount,
      students,
      reports
    });
  });

  // Endpoint Intip / Pantau Kerja Siswa Secara Langsung untuk Operator & Pengawas (Anti-Contek)
  app.get('/api/pengawas/student-work/:sessionId', requireStaffAuth(['pengawas', 'operator', 'guru']), (req, res) => {
    const sessionId = Number(req.params.sessionId);
    const loaded = loadSessionForStaff(req, res);
    if (!loaded) return;
    const session = loaded.session;

    if (req.staffUser && req.staffUser.role === 'guru') {
      const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(session.exam_id);
      if (!teacherCanAccessExam(req.staffUser, exam)) {
        return res.status(403).json({ error: 'Akses ditolak: Anda tidak memiliki akses ke lembar kerja ini.' });
      }
    }

    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(session.student_id);
    const questions = db.prepare('SELECT id, number, type, question_text, option_a, option_b, option_c, option_d, option_e FROM questions WHERE exam_id = ? ORDER BY number ASC').all(session.exam_id);
    const answers = db.prepare('SELECT question_id, chosen_option, updated_at FROM answers WHERE session_id = ?').all(sessionId);
    const ansMap = new Map(answers.map(a => [a.question_id, a]));

    const workDetail = questions.map(q => {
      const a = ansMap.get(q.id);
      const isEssay = q.type === 'ESAI';
      return {
        question_id: q.id,
        number: q.number,
        type: q.type,
        question_snippet: q.question_text.slice(0, 95) + (q.question_text.length > 95 ? '...' : ''),
        chosen_option: a && !isEssay ? a.chosen_option : null,
        essay_answered: isEssay ? !!(a && ESSAY_DONE_VALUES.includes(a.chosen_option)) : undefined,
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
    if (!loadSessionForStaff(req, res)) return;
    // Saat dibuka kuncinya oleh pengawas, siswa berstatus WORKING tetapi wajib memasukkan Token 15-menit terbaru (need_token_reverify = 1)
    db.prepare("UPDATE exam_sessions SET status = 'WORKING', need_token_reverify = 1 WHERE id = ?").run(sessionId);
    res.json({ ok: true, sessionId, status: 'WORKING', need_token_reverify: 1 });
  });

  app.post('/api/pengawas/reset-login/:sessionId', requireStaffAuth(['pengawas', 'operator']), (req, res) => {
    const sessionId = Number(req.params.sessionId);
    if (!loadSessionForStaff(req, res)) return;
    db.prepare("UPDATE exam_sessions SET status = 'WORKING', need_token_reverify = 1, device_info = NULL WHERE id = ?").run(sessionId);
    res.json({ ok: true, sessionId });
  });

  app.post('/api/pengawas/report', requireStaffAuth(['pengawas', 'operator']), (req, res) => {
    const { exam_id, pengawas_name, notes, absent_students } = req.body || {};
    const room = pengawasRoomOf(req.staffUser) || (req.body || {}).room;
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
    const tokenValid = tokenMatches(activeExam, examToken);
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
  app.post('/api/ujian/start-direct', requireAppIfEnabled, (req, res) => {
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
  // Fitur sekolah: siswa boleh melanjutkan sendiri setelah gangguan / pindah tab (tanpa pengawas).
  // Hanya pemilik sesi (token sesi valid) yang bisa; jumlah pelanggaran tetap tercatat untuk pengawas.
  app.post('/api/ujian/self-resume', requireStudentSession, (req, res) => {
    const session = req.examSession;
    if (session.status === 'FINISHED') return res.json({ status: 'FINISHED' });

    db.prepare("UPDATE exam_sessions SET status = 'WORKING', need_token_reverify = 0, last_activity_at = ? WHERE id = ?").run(new Date().toISOString(), session.id);
    res.json({ status: 'WORKING', need_token_reverify: 0 });
  });

  app.post('/api/ujian/login', requireAppIfEnabled, (req, res) => {
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
      if (!tokenMatches(activeExam, token)) {
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
  // Token ujian boleh dilihat staf (pengawas/operator) atau siswa yang sudah login (fitur "Ambil Token"),
  // tetapi tidak oleh pengunjung anonim.
  function requireStaffOrStudentSession(req, res, next) {
    const staff = getStaffFromReq(req);
    if (staff && (staff.role === 'pengawas' || staff.role === 'operator')) {
      req.staffUser = staff;
      return next();
    }
    if (req.headers['x-session-token']) return requireStudentSession(req, res, next);
    return res.status(401).json({ error: 'Silakan login terlebih dahulu untuk mengambil token ujian.' });
  }

  app.get('/api/ujian/active-token', requireStaffOrStudentSession, (req, res) => {
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

    if (!tokenMatches(activeExam, token)) {
      return res.status(403).json({
        error: 'Token Ujian tidak sesuai atau sudah berganti! Silakan periksa token terbaru di papan pengumuman atau tanyakan ke pengawas.'
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
    if (!tokenMatches(activeExam, token)) {
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

    const savedAnswers = db.prepare('SELECT question_id, chosen_option FROM answers WHERE session_id = ?').all(sessionId);
    const answersMap = {};
    const essayAnsweredMap = {};
    for (const a of savedAnswers) {
      if (ESSAY_DONE_VALUES.includes(a.chosen_option)) essayAnsweredMap[a.question_id] = true;
      else answersMap[a.question_id] = a.chosen_option;
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
      essayAnswered: essayAnsweredMap
    });
  });

  // Tandai soal esai "sudah menjawab" (jawaban ditulis di lembar kertas, diserahkan ke pengawas)
  app.post('/api/ujian/essay-answered', requireStudentSession, (req, res) => {
    const session = req.examSession;
    const questionId = Number((req.body || {}).questionId);
    const answered = (req.body || {}).answered !== false;
    if (!questionId) return res.status(400).json({ error: 'questionId wajib diisi.' });
    if (session.status === 'FINISHED') return res.status(400).json({ error: 'Ujian sudah selesai dikumpulkan.', status: 'FINISHED' });
    if (session.status === 'LOCKED') return res.status(423).json({ error: 'Sesi ujian sedang terkunci.', status: 'LOCKED' });
    if (session.need_token_reverify) return res.status(428).json({ error: 'Masukkan Token Ujian terbaru dari Pengawas untuk melanjutkan.', status: 'NEED_TOKEN' });

    const question = db.prepare('SELECT id, type FROM questions WHERE id = ? AND exam_id = ?').get(questionId, session.exam_id);
    if (!question) return res.status(404).json({ error: 'Soal tidak ditemukan pada jadwal ujian ini.' });
    if (question.type !== 'ESAI') return res.status(400).json({ error: 'Hanya soal esai yang dapat ditandai sudah dijawab.' });

    const exam = db.prepare('SELECT duration_minutes FROM exams WHERE id = ?').get(session.exam_id);
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(session.started_at).getTime()) / 1000));
    if (exam && elapsedSeconds > (exam.duration_minutes || 90) * 60) {
      return res.status(400).json({ error: 'Waktu ujian telah habis. Tekan Selesai untuk mengumpulkan ujian.', status: 'TIME_UP' });
    }

    const nowIso = new Date().toISOString();
    if (answered) {
      db.prepare(`
        INSERT INTO answers (session_id, question_id, chosen_option, essay_photo, updated_at)
        VALUES (?, ?, ?, NULL, ?)
        ON CONFLICT(session_id, question_id) DO UPDATE SET
          chosen_option = excluded.chosen_option,
          updated_at = excluded.updated_at
      `).run(session.id, question.id, ESSAY_DONE, nowIso);
    } else {
      db.prepare('DELETE FROM answers WHERE session_id = ? AND question_id = ?').run(session.id, question.id);
    }
    db.prepare('UPDATE exam_sessions SET last_activity_at = ? WHERE id = ?').run(nowIso, session.id);
    res.json({ ok: true, questionId: question.id, answered });
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

  // Keluar aplikasi oleh pengawas (password benar di aplikasi): dicatat, bukan pelanggaran
  app.post('/api/ujian/supervisor-exit', requireStudentSession, (req, res) => {
    const now = new Date().toISOString();
    db.prepare('UPDATE exam_sessions SET supervisor_exit_at = ?, last_activity_at = ? WHERE id = ?').run(now, now, req.examSession.id);
    res.json({ ok: true, supervisor_exit_at: now });
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

    // Semua soal esai harus sudah ditandai "sudah menjawab" (jawaban ditulis di lembar kertas)
    const esaiQuestions = db.prepare("SELECT id, number FROM questions WHERE exam_id = ? AND type = 'ESAI' ORDER BY number ASC").all(session.exam_id);
    if (esaiQuestions.length > 0) {
      const qIds = esaiQuestions.map(q => q.id);
      const placeholders = qIds.map(() => '?').join(',');
      const doneAnswers = db.prepare(`
        SELECT question_id FROM answers
        WHERE session_id = ? AND question_id IN (${placeholders}) AND chosen_option IN (${ESSAY_DONE_VALUES.map(() => '?').join(',')})
      `).all(session.id, ...qIds, ...ESSAY_DONE_VALUES);
      const doneSet = new Set(doneAnswers.map(a => a.question_id));
      // Nomor yang dilihat siswa: esai tampil setelah semua soal PG
      const pgCount = db.prepare("SELECT COUNT(*) AS c FROM questions WHERE exam_id = ? AND type = 'PG'").get(session.exam_id).c;
      const missingNos = esaiQuestions
        .map((q, i) => ({ q, shown: pgCount + i + 1 }))
        .filter(x => !doneSet.has(x.q.id))
        .map(x => `No. ${x.shown}`);
      if (missingNos.length > 0) {
        return res.status(400).json({
          error: `Soal Esai ${missingNos.join(', ')} belum ditandai sudah dijawab. Tulis jawabannya di lembar kertas, lalu tekan tombol "Saya sudah menjawab soal ini di kertas".`
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

  // Error upload (file terlalu besar, dsb.) dikembalikan sebagai JSON yang jelas, bukan halaman error 500
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      const status = err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FIELD_VALUE' ? 413 : 400;
      return res.status(status).json({ error: status === 413 ? 'Ukuran file terlalu besar.' : `Upload gagal: ${err.message}` });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Data yang dikirim terlalu besar.' });
    }
    next(err);
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

module.exports = { createApp, getLocalLanIp, calculateExamScores, pgScore };
