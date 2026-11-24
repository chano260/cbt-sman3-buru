// Impor daftar siswa (Excel biasa maupun ekspor Dapodik) untuk asesmen.
// Sistem melengkapi yang kosong: ruang = kelas, nomor meja urut nama, nomor peserta & password otomatis,
// tempat & tanggal lahir digabung. Kolom yang sudah diisi operator di Excel selalu dipakai apa adanya.
const crypto = require('crypto');

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

// Tanpa huruf/angka yang mudah tertukar saat diketik siswa (O/0, I/1/L)
const PASSWORD_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const COLUMN_ALIASES = {
  name: ['nama', 'nama siswa', 'nama lengkap', 'nama peserta didik', 'nama peserta', 'full_name'],
  className: ['kelas', 'rombel', 'rombel saat ini', 'rombongan belajar', 'nama rombel', 'class_name'],
  nisn: ['nisn'],
  birthPlace: ['tempat lahir'],
  birthDate: ['tanggal lahir', 'tgl lahir', 'tgl. lahir'],
  birthInfo: ['tempat tanggal lahir', 'tempat, tanggal lahir', 'ttl', 'birth_info'],
  examNumber: ['nomor peserta', 'no peserta', 'no. peserta', 'nomor ujian', 'exam_number'],
  room: ['ruang', 'ruangan', 'ruang ujian', 'room'],
  seat: ['nomor meja', 'no meja', 'no. meja', 'meja', 'seat_number'],
  password: ['password', 'kata sandi']
};

const norm = (v) => String(v == null ? '' : v).toLowerCase().replace(/\s+/g, ' ').trim();
const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

function formatDate(d) {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Tanggal lahir: tanggal Excel (Date / nomor seri), "2008-01-14", "14/01/2008", "14-01-2008", atau teks bebas
function formatBirthDate(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date && !isNaN(value)) return formatDate(value);
  if (typeof value === 'number' && value > 1 && value < 80000) {
    return formatDate(new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000));
  }
  const s = clean(value);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return formatDate(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) return formatDate(new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])));
  return s;
}

function formatBirthInfo(place, date) {
  const out = [clean(place), formatBirthDate(date)].filter(Boolean).join(', ');
  return out || '-';
}

function generatePassword() {
  let s = '';
  for (let i = 0; i < 6; i++) s += PASSWORD_CHARS[crypto.randomInt(PASSWORD_CHARS.length)];
  return s;
}

// NISN yang tersimpan sebagai angka di Excel kehilangan nol di depan; NISN selalu 10 digit
function cleanNisn(v) {
  if (typeof v === 'number') return String(Math.round(v)).padStart(10, '0');
  return clean(v);
}

// Cari baris header: file Dapodik biasanya punya beberapa baris judul sebelum tabel
function findColumns(matrix) {
  const limit = Math.min(matrix.length, 20);
  for (let r = 0; r < limit; r++) {
    const cells = (matrix[r] || []).map(norm);
    const col = {};
    for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
      const idx = cells.findIndex(c => aliases.includes(c));
      if (idx >= 0) col[key] = idx;
    }
    if (col.name !== undefined && col.className !== undefined) return { headerRow: r, col };
  }
  return null;
}

// Mengubah isi sheet (array baris) menjadi daftar siswa. null bila kolom Nama/Kelas tidak ditemukan.
function parseStudentSheet(matrix) {
  const found = findColumns(matrix);
  if (!found) return null;
  const { headerRow, col } = found;
  const get = (cells, key) => (col[key] === undefined ? '' : cells[col[key]]);
  const rows = [];
  for (const cells of matrix.slice(headerRow + 1)) {
    if (!cells) continue;
    const name = clean(get(cells, 'name'));
    const className = clean(get(cells, 'className'));
    if (!name || !className) continue;
    const birthInfoRaw = clean(get(cells, 'birthInfo'));
    const place = get(cells, 'birthPlace');
    const date = get(cells, 'birthDate');
    const seat = Number(get(cells, 'seat'));
    rows.push({
      name,
      className,
      nisn: cleanNisn(get(cells, 'nisn')),
      birthInfo: birthInfoRaw || (clean(place) || date !== '' ? formatBirthInfo(place, date) : ''),
      examNumber: clean(get(cells, 'examNumber')),
      room: clean(get(cells, 'room')),
      seat: Number.isFinite(seat) && seat > 0 ? Math.round(seat) : null,
      password: clean(get(cells, 'password'))
    });
  }
  return rows;
}

const byText = (a, b) => String(a).localeCompare(String(b), 'id', { numeric: true, sensitivity: 'base' });

function defaultPrefix(now = new Date()) {
  return `${String(now.getFullYear()).slice(2)}-03-`;
}

function cleanPrefix(v) {
  const s = String(v == null ? '' : v).trim();
  return /^[A-Za-z0-9 ._\/-]{0,20}$/.test(s) ? s : null;
}

// Menyimpan hasil impor ke database dalam satu transaksi
function importStudents(db, rows, prefix) {
  const existing = db.prepare('SELECT * FROM students').all();
  const byNisn = new Map();
  const byExam = new Map();
  for (const s of existing) {
    if (s.nisn && s.nisn !== '-') byNisn.set(s.nisn, s);
    byExam.set(s.exam_number, s);
  }

  // Nomor peserta baru melanjutkan nomor terbesar dengan awalan yang sama
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const seqRe = new RegExp(`^${escaped}(\\d+)$`);
  let seq = existing.reduce((max, s) => {
    const m = String(s.exam_number).match(seqRe);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  const nextExamNumber = () => {
    let num;
    do { seq++; num = prefix + String(seq).padStart(3, '0'); } while (byExam.has(num));
    return num;
  };

  const insert = db.prepare(`
    INSERT INTO students (exam_number, nisn, full_name, class_name, room, seat_number, password, birth_info)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE students SET exam_number = ?, nisn = ?, full_name = ?, class_name = ?, room = ?, seat_number = ?, password = ?, birth_info = ?
    WHERE id = ?
  `);

  // Siswa baru diberi nomor berurutan per kelas lalu per nama
  const ordered = rows.slice().sort((a, b) => byText(a.className, b.className) || byText(a.name, b.name));
  const classesWithSeats = new Set(rows.filter(r => r.seat).map(r => r.className));
  const touchedClasses = new Set();
  let created = 0;
  let updated = 0;

  const run = db.transaction(() => {
    for (const r of ordered) {
      const match = (r.examNumber && byExam.get(r.examNumber)) || (r.nisn && byNisn.get(r.nisn)) || null;
      const room = r.room || r.className;
      touchedClasses.add(r.className);
      if (match) {
        const examNumber = r.examNumber || match.exam_number;
        update.run(
          examNumber, r.nisn || match.nisn, r.name, r.className, room,
          r.seat || match.seat_number, r.password || match.password, r.birthInfo || match.birth_info || '-',
          match.id
        );
        byExam.delete(match.exam_number);
        const fresh = { ...match, exam_number: examNumber, nisn: r.nisn || match.nisn };
        byExam.set(examNumber, fresh);
        if (fresh.nisn && fresh.nisn !== '-') byNisn.set(fresh.nisn, fresh);
        updated++;
      } else {
        const examNumber = r.examNumber || nextExamNumber();
        const info = insert.run(examNumber, r.nisn || '-', r.name, r.className, room, r.seat || 0, r.password || generatePassword(), r.birthInfo || '-');
        const fresh = { id: Number(info.lastInsertRowid), exam_number: examNumber, nisn: r.nisn || '-', seat_number: r.seat || 0 };
        byExam.set(examNumber, fresh);
        if (r.nisn) byNisn.set(r.nisn, fresh);
        created++;
      }
    }

    // Nomor meja urut nama di setiap kelas, kecuali kelas yang mejanya diisi sendiri di Excel
    const setSeat = db.prepare('UPDATE students SET seat_number = ? WHERE id = ?');
    for (const cls of touchedClasses) {
      if (classesWithSeats.has(cls)) continue;
      const list = db.prepare('SELECT id, full_name FROM students WHERE class_name = ?').all(cls)
        .sort((a, b) => byText(a.full_name, b.full_name));
      list.forEach((s, i) => setSeat.run(i + 1, s.id));
    }
  });
  run();
  return { importedCount: created + updated, createdCount: created, updatedCount: updated };
}

module.exports = { parseStudentSheet, importStudents, formatBirthInfo, formatBirthDate, generatePassword, defaultPrefix, cleanPrefix };
