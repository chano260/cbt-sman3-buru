// Tanggal "hari ini" menurut jam sekolah (Maluku = WIT, UTC+9), bukan jam UTC server.
// Bisa diganti lewat variabel lingkungan SCHOOL_TZ bila sekolah di zona lain.
const SCHOOL_TZ = process.env.SCHOOL_TZ || 'Asia/Jayapura';

function schoolToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SCHOOL_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// Ujian yang tanggalnya sudah lewat dimatikan otomatis saat tanggal berganti.
// Jadwal tanpa tanggal tidak disentuh. Mengembalikan jumlah ujian yang dimatikan.
function deactivatePastExams(db, today = schoolToday()) {
  return db.prepare(`
    UPDATE exams SET is_active = 0
    WHERE is_active = 1 AND exam_date IS NOT NULL AND exam_date != '' AND exam_date < ?
  `).run(today).changes;
}

module.exports = { SCHOOL_TZ, schoolToday, deactivatePastExams };
