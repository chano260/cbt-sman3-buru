const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const JAVA = 'android-exambro/app/src/main/java/id/sch/sman3buru/ujian/MainActivity.java';

function methodBody(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} harus ada`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(open, j + 1);
  }
  throw new Error(`body ${signature} tidak lengkap`);
}

test('alarm keluar: HP siswa berbunyi keras (stream alarm, tetap bunyi saat senyap) dan bergetar', () => {
  const java = read(JAVA);
  const start = methodBody(java, 'private void startLeaveAlarm()');
  assert.match(start, /AudioManager\.STREAM_ALARM/, 'bunyi lewat stream alarm agar tetap terdengar saat mode senyap');
  assert.match(start, /setStreamVolume\(AudioManager\.STREAM_ALARM/, 'volume alarm dinaikkan ke maksimum');
  assert.match(start, /startTone\(/);
  assert.match(start, /vibrat/i, 'HP juga bergetar');
  const manifest = read('android-exambro/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android\.permission\.VIBRATE/);
});

test('alarm keluar hanya saat ujian berjalan, bukan di halaman login, saat keluar oleh pengawas, atau setelah selesai', () => {
  const java = read(JAVA);
  const leave = methodBody(java, 'private void reportLeave(String reason)');
  assert.match(leave, /startLeaveAlarm\(\)/, 'reportLeave harus membunyikan alarm');
  assert.match(leave, /examRunning/, 'alarm hanya saat ujian berjalan');
  assert.ok(leave.indexOf('exiting') < leave.indexOf('startLeaveAlarm'), 'keluar oleh pengawas tidak membunyikan alarm');
  // ujian.html memberi tanda mulai/selesai lewat jembatan AndroidExambro
  const bridge = methodBody(java, 'private class Bridge');
  assert.match(bridge, /public void enterLockMode\(\)[\s\S]*examRunning = true/);
  // Prompt "sematkan aplikasi?" yang muncul lagi saat soal dimulai tidak boleh dianggap keluar
  const enter = methodBody(bridge, 'public void enterLockMode()');
  assert.ok(enter.indexOf('examStartedAt = System.currentTimeMillis()') >= 0 &&
    enter.indexOf('examStartedAt = System.currentTimeMillis()') < enter.indexOf('startLockTask()'),
    'masa tenggang diulang sebelum startLockTask() di enterLockMode');
  assert.match(bridge, /public void exitLockMode\(\)[\s\S]*examRunning = false[\s\S]*stopLeaveAlarm\(\)/);
  const html = read('public/ujian.html');
  assert.match(html, /AndroidExambro\.enterLockMode\(\)/);
  assert.match(html, /AndroidExambro\.exitLockMode\(\)/);
});

test('alarm berhenti saat siswa kembali ke aplikasi, saat pengawas menutup aplikasi, dan saat aplikasi ditutup', () => {
  const java = read(JAVA);
  assert.match(methodBody(java, 'public void onWindowFocusChanged(boolean hasFocus)'), /stopLeaveAlarm\(\)/);
  assert.match(methodBody(java, 'protected void onResume()'), /stopLeaveAlarm\(\)/);
  assert.match(methodBody(java, 'protected void onDestroy()'), /stopLeaveAlarm\(\)/);
  assert.match(methodBody(java, 'private void exitApp()'), /stopLeaveAlarm\(\)/);
  const stop = methodBody(java, 'private void stopLeaveAlarm()');
  assert.match(stop, /stopTone\(\)/);
  assert.match(stop, /release\(\)/);
  assert.match(stop, /cancel\(\)/, 'getaran dihentikan');
  assert.match(stop, /setStreamVolume\(AudioManager\.STREAM_ALARM/, 'volume alarm dikembalikan seperti semula');
});
