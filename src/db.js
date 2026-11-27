const path = require('node:path');
const { hashPassword, isHashed } = require('./security');

function createSqliteConnection(dbPath) {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    if (dbPath !== ':memory:') {
      db.pragma('journal_mode = WAL');
    }
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000');
    db.pragma('busy_timeout = 5000');
    return db;
  } catch {
    // Fallback ke modul bawaan Node 22+ (node:sqlite) dengan antarmuka identik
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') {
      raw.exec('PRAGMA journal_mode = WAL;');
    }
    raw.exec('PRAGMA synchronous = NORMAL; PRAGMA cache_size = -64000; PRAGMA busy_timeout = 5000;');
    return {
      exec: (sql) => raw.exec(sql),
      pragma: (str) => raw.exec(`PRAGMA ${str};`),
      prepare: (sql) => {
        const stmt = raw.prepare(sql);
        return {
          get: (...args) => stmt.get(...args),
          all: (...args) => stmt.all(...args),
          run: (...args) => stmt.run(...args)
        };
      },
      transaction: (fn) => (...args) => {
        raw.exec('BEGIN');
        try {
          const res = fn(...args);
          raw.exec('COMMIT');
          return res;
        } catch (err) {
          raw.exec('ROLLBACK');
          throw err;
        }
      },
      close: () => raw.close()
    };
  }
}

const DEFAULT_DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'cbt-sman3-buru.db');

function initDb(dbPath = DEFAULT_DB_PATH) {
  const db = createSqliteConnection(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('operator', 'guru', 'pengawas')),
      subject TEXT,
      room TEXT
    );

    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exam_number TEXT UNIQUE NOT NULL,
      nisn TEXT NOT NULL,
      full_name TEXT NOT NULL,
      class_name TEXT NOT NULL,
      room TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      password TEXT NOT NULL,
      birth_info TEXT
    );

    CREATE TABLE IF NOT EXISTS exams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      subject TEXT NOT NULL,
      class_target TEXT NOT NULL,
      exam_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      session_name TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 90,
      token TEXT NOT NULL,
      token_updated_at TEXT,
      shuffle_questions INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      teacher_id INTEGER,
      -- 1 = sudah dijadwalkan operator (tampil di Daftar jadwal); 0 = masih bank soal guru
      is_scheduled INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exam_id INTEGER NOT NULL,
      number INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('PG', 'ESAI')),
      question_text TEXT NOT NULL,
      image_data TEXT,
      audio_data TEXT,
      option_a TEXT,
      option_b TEXT,
      option_c TEXT,
      option_d TEXT,
      option_e TEXT,
      answer_key TEXT
    );

    CREATE TABLE IF NOT EXISTS exam_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exam_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('WORKING', 'LOCKED', 'FINISHED')) DEFAULT 'WORKING',
      need_token_reverify INTEGER NOT NULL DEFAULT 0,
      current_question_number INTEGER NOT NULL DEFAULT 1,
      last_activity_at TEXT,
      violation_count INTEGER NOT NULL DEFAULT 0,
      last_violation_reason TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      device_info TEXT,
      UNIQUE(exam_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      chosen_option TEXT NOT NULL,
      essay_photo TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(session_id, question_id)
    );

    CREATE TABLE IF NOT EXISTS room_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exam_id INTEGER NOT NULL,
      room TEXT NOT NULL,
      pengawas_name TEXT NOT NULL,
      notes TEXT,
      absent_students TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_questions_exam ON questions(exam_id, type, number);
    CREATE INDEX IF NOT EXISTS idx_sessions_exam ON exam_sessions(exam_id, student_id);
    CREATE INDEX IF NOT EXISTS idx_answers_session ON answers(session_id, question_id);
  `);

  // Migrasi aman jika file database lama sudah ada
  const safeAlter = [
    "ALTER TABLE answers ADD COLUMN essay_photo TEXT",
    "ALTER TABLE exams ADD COLUMN token_updated_at TEXT",
    "ALTER TABLE exam_sessions ADD COLUMN need_token_reverify INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE exam_sessions ADD COLUMN current_question_number INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE exam_sessions ADD COLUMN last_activity_at TEXT",
    "ALTER TABLE questions ADD COLUMN audio_data TEXT",
    "ALTER TABLE students ADD COLUMN birth_info TEXT",
    "ALTER TABLE exam_sessions ADD COLUMN session_token TEXT",
    "ALTER TABLE exams ADD COLUMN prev_token TEXT",
    "ALTER TABLE exam_sessions ADD COLUMN supervisor_exit_at TEXT",
    // Mapel pilihan: daftar mapel pilihan siswa (dipisah koma) dan tanda jadwal mapel pilihan
    "ALTER TABLE students ADD COLUMN elective_subjects TEXT",
    "ALTER TABLE exams ADD COLUMN is_elective INTEGER NOT NULL DEFAULT 0",
    // Gambar opsi PG per huruf, JSON {"A": "data:image/...", ...}
    "ALTER TABLE questions ADD COLUMN option_images TEXT"
  ];
  for (const sql of safeAlter) {
    try { db.exec(sql); } catch {}
  }

  // Tanda "sudah dijadwalkan". Untuk database lama: paket yang aktif atau sudah pernah dipakai siswa
  // dianggap jadwal; paket lain tetap sebagai bank soal guru.
  try {
    db.exec('ALTER TABLE exams ADD COLUMN is_scheduled INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE exams SET is_scheduled = 1 WHERE is_active = 1 OR id IN (SELECT DISTINCT exam_id FROM exam_sessions)');
  } catch (e) { /* kolom sudah ada */ }

  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (userCount === 0) {
    const insertUser = db.prepare(`
      INSERT INTO users (username, password, full_name, role, subject, room)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertUser.run('operator', 'admin123', 'Operator Utama SMAN 3 Buru', 'operator', null, 'Semua Ruang');
    insertUser.run('guru', 'guru123', 'Ibu Dra. Siti Aminah, S.Pd.', 'guru', 'Kimia & Pengetahuan Umum', null);
    insertUser.run('pengawas', 'pengawas123', 'Bpk. La Ode Hidayat, S.Pd.', 'pengawas', null, 'Ruang 01');
    insertUser.run('pengawas2', 'pengawas123', 'Ibu Wa Ode Kartini, S.Pd.', 'pengawas', null, 'Ruang 02');

    const insertStudent = db.prepare(`
      INSERT INTO students (exam_number, nisn, full_name, class_name, room, seat_number, password, birth_info)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const sampleStudents = [
      ['26-03-001', '0081234501', 'Ahmad Fauzi', 'XII IPA 1', 'Ruang 01', 1, 'BURU01', 'Namlea, 14 Januari 2008'],
      ['26-03-002', '0081234502', 'Siti Rahma Wabula', 'XII IPA 1', 'Ruang 01', 2, 'BURU02', 'Waprea, 22 Maret 2008'],
      ['26-03-003', '0081234503', 'Budi Santoso Tomia', 'XII IPA 1', 'Ruang 01', 3, 'BURU03', 'Namlea, 05 Juli 2008'],
      ['26-03-004', '0081234504', 'Rizky Pratama Lesnussa', 'XII IPA 1', 'Ruang 01', 4, 'BURU04', 'Kayeli, 19 Agustus 2008'],
      ['26-03-005', '0081234505', 'Nadia Putri Tasijawa', 'XII IPA 1', 'Ruang 01', 5, 'BURU05', 'Namlea, 11 November 2008'],
      ['26-03-006', '0081234506', 'Fajar Ramadhan Behuku', 'XII IPA 1', 'Ruang 01', 6, 'BURU06', 'Waeapo, 02 Oktober 2008'],
      ['26-03-007', '0081234507', 'Maria Gracia Hukunala', 'XII IPA 2', 'Ruang 02', 1, 'BURU07', 'Namlea, 28 April 2008'],
      ['26-03-008', '0081234508', 'Yusuf Ibrahim Besan', 'XII IPA 2', 'Ruang 02', 2, 'BURU08', 'Air Buaya, 17 Desember 2008']
    ];
    for (const s of sampleStudents) {
      insertStudent.run(...s);
    }

    const insertExam = db.prepare(`
      INSERT INTO exams (title, subject, class_target, exam_date, start_time, session_name, duration_minutes, token, token_updated_at, shuffle_questions, is_active, teacher_id, is_scheduled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    const examInfo = insertExam.run(
      'Penilaian Akhir Semester (PAS) Ganjil',
      'Kimia',
      'XII IPA 1',
      '2026-11-02',
      '08:00 WIT',
      'Sesi 1',
      90,
      'K7P9M',
      new Date().toISOString(),
      1,
      1,
      2
    );
    const examId = Number(examInfo.lastInsertRowid);

    const insertQ = db.prepare(`
      INSERT INTO questions (exam_id, number, type, question_text, option_a, option_b, option_c, option_d, option_e, answer_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertQ.run(
      examId, 1, 'PG',
      'Perhatikan reaksi kimia berikut. Manakah pernyataan yang tepat mengenai pengaruh penambahan katalis terhadap laju reaksi?',
      'Laju reaksi tidak bergantung pada konsentrasi pereaksi',
      'Penambahan katalis menurunkan energi aktivasi reaksi',
      'Memperkecil frekuensi tumbukan efektif antar partikel',
      'Konsentrasi pereaksi selalu tetap setiap satuan waktu',
      'Mengubah nilai perubahan entalpi (ΔH) reaksi akhir',
      'B'
    );
    insertQ.run(
      examId, 2, 'PG',
      'Sifat koligatif larutan hanya bergantung pada...',
      'Jenis zat terlarut di dalam larutan',
      'Warna dan kekentalan zat pelarut',
      'Jumlah partikel zat terlarut dalam larutan',
      'Volume wadah tempat larutan disimpan',
      'Tekanan udara di luar ruangan laboratorium',
      'C'
    );
    insertQ.run(
      examId, 3, 'PG',
      'Unsur gas mulia yang paling banyak terdapat di atmosfer bumi adalah...',
      'Helium (He)',
      'Neon (Ne)',
      'Argon (Ar)',
      'Kripton (Kr)',
      'Xenon (Xe)',
      'C'
    );
    insertQ.run(
      examId, 4, 'PG',
      'Pada sel volta, elektroda tempat terjadinya reaksi oksidasi disebut...',
      'Katoda',
      'Anoda',
      'Elektrolit',
      'Jembatan garam',
      'Membran semipermeabel',
      'B'
    );
    insertQ.run(
      examId, 5, 'PG',
      'Ibu kota Kabupaten Buru di Provinsi Maluku terletak di...',
      'Ambon',
      'Masohi',
      'Namlea',
      'Namrole',
      'Piru',
      'C'
    );
    insertQ.run(
      examId, 6, 'ESAI',
      'Jelaskan 3 faktor utama yang memengaruhi pergeseran kesetimbangan kimia menurut Asas Le Chatelier beserta contoh penerapannya di industri!',
      null, null, null, null, null, null
    );
    insertQ.run(
      examId, 7, 'ESAI',
      'Sebuah larutan glukosa dibuat dengan melarutkan 18 gram glukosa (Mr = 180) ke dalam 500 gram air. Hitunglah molalitas larutan tersebut dan tuliskan langkah perhitungannya secara lengkap di lembar jawaban kertas!',
      null, null, null, null, null, null
    );
  }

  // Migrasi keamanan: hash semua password staf yang masih tersimpan sebagai teks biasa
  const plainUsers = db.prepare('SELECT id, password FROM users').all().filter(u => !isHashed(u.password));
  if (plainUsers.length > 0) {
    const upd = db.prepare('UPDATE users SET password = ? WHERE id = ?');
    for (const u of plainUsers) upd.run(hashPassword(u.password), u.id);
  }

  return db;
}

module.exports = { initDb, DEFAULT_DB_PATH };
