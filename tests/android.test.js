const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Android Exambro project enforces screen pinning, anti-screenshot FLAG_SECURE, and blocks split-screen', () => {
  const root = path.join(__dirname, '..', 'android-exambro');
  const manifest = fs.readFileSync(path.join(root, 'app/src/main/AndroidManifest.xml'), 'utf8');
  const mainKt = fs.readFileSync(path.join(root, 'app/src/main/java/id/sch/sman3buru/exambro/MainActivity.kt'), 'utf8');

  assert.ok(manifest.includes('android:resizeableActivity="false"'));
  assert.ok(mainKt.includes('FLAG_SECURE'));
  assert.ok(mainKt.includes('startLockTask()'));
  assert.ok(mainKt.includes('X-Exambro-App'));

  const apkPath = path.join(__dirname, '..', 'public', 'Exambro-SMAN3-Buru.apk');
  assert.ok(fs.existsSync(apkPath), 'Signed Exambro-SMAN3-Buru.apk must exist in public/');
  assert.ok(fs.statSync(apkPath).size > 5000, 'APK file must be non-empty');
});
