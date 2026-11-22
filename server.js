const path = require('node:path');
const { initDb, DEFAULT_DB_PATH } = require('./src/db');
const { createApp, getLocalLanIp } = require('./src/app');
const { startBackupSchedule } = require('./src/backup');

const PORT = process.env.PORT || 8080;
const db = initDb(DEFAULT_DB_PATH);
// Backup otomatis tiap 10 menit ke folder backups/ di samping file database (36 salinan terakhir)
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DEFAULT_DB_PATH), 'backups');
const app = createApp(db, { backupDir: BACKUP_DIR });
startBackupSchedule(db, BACKUP_DIR);

// Peringatan keras jika akun staf masih memakai password bawaan
const { verifyPassword } = require('./src/security');
const DEFAULT_CREDS = { operator: 'admin123', guru: 'guru123', pengawas: 'pengawas123', pengawas2: 'pengawas123' };
const stillDefault = Object.entries(DEFAULT_CREDS).filter(([u, p]) => {
  const row = db.prepare('SELECT password FROM users WHERE username = ?').get(u);
  return row && verifyPassword(p, row.password);
}).map(([u]) => u);
if (stillDefault.length > 0) {
  console.warn('!!! PERINGATAN KEAMANAN: akun berikut masih memakai password bawaan: ' + stillDefault.join(', '));
  console.warn('!!! Segera ganti password lewat Panel Operator > Kelola Staf sebelum ujian dimulai.');
}

const server = app.listen(PORT, '0.0.0.0', 2048, () => {
  const ip = getLocalLanIp();
  console.log('==============================================================');
  console.log('   SERVER CBT - SMA NEGERI 3 BURU (SIAP 500+ SISWA SERENTAK)  ');
  console.log('==============================================================');
  console.log(`-> Buka di Komputer Server ini : http://localhost:${PORT}`);
  console.log(`-> Alamat IP LAN / Wi-Fi Lokal : http://${ip}:${PORT}`);
  console.log('');
  console.log(`   * Panel Operator : http://${ip}:${PORT}/operator.html`);
  console.log(`   * Panel Guru     : http://${ip}:${PORT}/guru.html`);
  console.log(`   * Panel Pengawas : http://${ip}:${PORT}/pengawas.html`);
  console.log(`   * Ujian Exambro  : http://${ip}:${PORT}/ujian.html`);
  console.log(`-> Backup otomatis tiap 10 menit: ${BACKUP_DIR}`);
  console.log('==============================================================');
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
