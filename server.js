const { initDb } = require('./src/db');
const { createApp, getLocalLanIp } = require('./src/app');

const PORT = process.env.PORT || 8080;
const db = initDb();
const app = createApp(db);

app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalLanIp();
  console.log('==============================================================');
  console.log('   SERVER CBT LOKAL - SMA NEGERI 3 BURU (AKTIF & SIAP UJIAN)  ');
  console.log('==============================================================');
  console.log(`-> Buka di Komputer Server ini : http://localhost:${PORT}`);
  console.log(`-> Alamat IP LAN / Wi-Fi Lokal : http://${ip}:${PORT}`);
  console.log('');
  console.log(`   * Panel Operator : http://${ip}:${PORT}/operator.html`);
  console.log(`   * Panel Guru     : http://${ip}:${PORT}/guru.html`);
  console.log(`   * Panel Pengawas : http://${ip}:${PORT}/pengawas.html`);
  console.log(`   * Ujian Exambro  : http://${ip}:${PORT}/ujian.html`);
  console.log('==============================================================');
});
