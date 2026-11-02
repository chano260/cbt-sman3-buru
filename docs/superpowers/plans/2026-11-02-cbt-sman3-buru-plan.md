# CBT Lokal & Android Exambro SMA Negeri 3 Buru — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Membangun sistem Server CBT Lokal (100% offline LAN/Wi-Fi dengan 3 panel terpisah: Operator, Guru, Pengawas, serta Portal Ujian Siswa) dan proyek Aplikasi Android Native Exambro (pengunci layar & anti-kecurangan) untuk SMA Negeri 3 Buru.

**Architecture:** Aplikasi Server Node.js + Express + SQLite (`better-sqlite3` dalam mode WAL) yang menyajikan REST API dan antarmuka Web Offline-First (tanpa ketergantungan CDN internet). Soal diimpor dari Microsoft Word (`.docx`) menggunakan `mammoth` + parser khusus `[PG]`/`[ESAI]`, dan rekap nilai PG diekspor ke Excel (`.xlsx`) menggunakan `xlsx`. Aplikasi Android Exambro ditulis dalam Kotlin menggunakan `WebView` + `startLockTask()` (*Screen Pinning*) + `FLAG_SECURE` dan melapor otomatis ke endpoint pelanggaran saat siswa mencoba keluar aplikasi.

**Tech Stack:** Node.js, Express, `better-sqlite3`, `mammoth`, `xlsx`, `docx` (generator template Word), Vanilla HTML5/CSS3/JS (Offline-First Modern UI), Android SDK / Kotlin (Exambro APK).

**Spec:** `C:\Users\cavat\.gemini\antigravity\scratch\cbt-sman3-buru\docs\superpowers\specs\2026-11-02-cbt-sman3-buru-design.md`

## Global Constraints

- Berjalan 100% *offline* di jaringan LAN/Wi-Fi lokal sekolah tanpa ketergantungan pada CDN internet eksternal.
- API ujian siswa (`/api/ujian/*`) dilarang keras mengirimkan field `kunci_jawaban` atau `skor` ke perangkat siswa, baik saat ujian berlangsung maupun setelah selesai.
- Jawaban Pilihan Ganda (PG) langsung tersimpan ke database setiap kali siswa mengklik opsi A/B/C/D/E.
- Soal Esai tampil teks/gambarnya di HP siswa dengan instruksi dikerjakan di lembar jawaban kertas (tanpa input teks esai di HP).
- Operator wajib memiliki Pusat Cetak A4 ber-Kop **PEMERINTAH PROVINSI MALUKU — DINAS PENDIDIKAN DAN KEBUDAYAAN — SMA NEGERI 3 BURU** untuk 4 dokumen: Daftar Hadir (tanda tangan zig-zag), Kartu Peserta, Kartu Login, dan Kartu Meja.

## Review Focus

- Format penulisan di Microsoft Word yang tidak seragam (misal spasi ekstra, huruf kecil `kunci: b`, atau nomor soal dengan tanda kurung `1)`) tetap terbaca dengan benar oleh parser Word.
- Siswa yang me-refresh halaman atau ganti HP (setelah di-reset login oleh Pengawas) tetap mendapatkan seluruh jawaban PG yang sudah dipilih sebelumnya dan sisa waktu yang akurat.
- Siswa yang berstatus `LOCKED` (karena terdeteksi keluar aplikasi) ditolak oleh server jika mencoba mengirim jawaban PG sampai Pengawas menekan tombol **Buka Kunci**.
- Saat siswa menyelesaikan ujian, halaman selesai hanya menampilkan konfirmasi penyimpanan jawaban tanpa membocorkan nilai atau jumlah benar/salah.
- Perhitungan skor Pilihan Ganda (skala 0–100) tetap akurat meskipun di dalam paket ujian yang sama terdapat soal Esai (pembagi skor PG hanya menghitung jumlah soal PG, bukan total PG + Esai).

---

### Task 1: Pondasi Server, Database SQLite (WAL) & Data Awal (Seed SMA N 3 Buru)

**Files:**
- Create: `package.json`
- Create: `src/db.js`
- Create: `tests/db.test.js`

**Interfaces:**
- Consumes: none
- Produces:
  - `initDb(dbPath?: string): Database` in `src/db.js`
  - Tabel: `users` (role: `'operator' | 'guru' | 'pengawas'`), `students`, `exams`, `questions` (type: `'PG' | 'ESAI'`), `exam_sessions` (status: `'WORKING' | 'LOCKED' | 'FINISHED'`), `answers`, `room_reports`

- [ ] **Step 1: Inisialisasi proyek Node.js dan tulis pengujian database di `tests/db.test.js`**

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');

test('initDb creates tables and seeds default SMAN 3 Buru accounts, students, and exam', () => {
  const db = initDb(':memory:');
  const operator = db.prepare("SELECT * FROM users WHERE role = 'operator'").get();
  const guru = db.prepare("SELECT * FROM users WHERE role = 'guru'").get();
  const pengawas = db.prepare("SELECT * FROM users WHERE role = 'pengawas'").get();
  const students = db.prepare('SELECT * FROM students').all();
  const questions = db.prepare('SELECT * FROM questions').all();

  assert.equal(operator.username, 'operator');
  assert.equal(guru.username, 'guru');
  assert.equal(pengawas.username, 'pengawas');
  assert.ok(students.length >= 5);
  assert.ok(questions.some(q => q.type === 'PG'));
  assert.ok(questions.some(q => q.type === 'ESAI'));
});
```

- [ ] **Step 2: Jalankan pengujian untuk memastikan gagal sebelum implementasi**

Run: `node --test tests/db.test.js`
Expected: FAIL dengan `Cannot find module '../src/db'`

- [ ] **Step 3: Implementasikan `initDb(dbPath)` di `src/db.js` beserta instalasi paket di `package.json`**

Instal `express`, `better-sqlite3`, `mammoth`, `xlsx`, `multer`, `docx` dan aktifkan `pragma('journal_mode = WAL')` di `src/db.js`. Buat tabel `users`, `students`, `exams`, `questions`, `exam_sessions`, `answers`, `room_reports` dan isi data awal SMA Negeri 3 Buru jika tabel masih kosong.

- [ ] **Step 4: Jalankan pengujian untuk memastikan lulus**

Run: `node --test tests/db.test.js`
Expected: PASS

---

### Task 2: Mesin Parser Soal Microsoft Word (`.docx`) & Generator Template Word

**Files:**
- Create: `src/wordParser.js`
- Create: `tests/wordParser.test.js`

**Interfaces:**
- Consumes: `mammoth`, `docx`
- Produces:
  - `parseQuestionsFromText(rawText: string): Array<{ type: 'PG'|'ESAI', number: number, question_text: string, option_a?: string, option_b?: string, option_c?: string, option_d?: string, option_e?: string, answer_key?: string }>`
  - `parseDocxBuffer(buffer: Buffer): Promise<Array<QuestionItem>>`
  - `generateWordTemplateBuffer(): Promise<Buffer>`

- [ ] **Step 1: Tulis pengujian parser soal PG & Esai (termasuk variasi spasi/huruf kecil) di `tests/wordParser.test.js`**

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQuestionsFromText, parseDocxBuffer, generateWordTemplateBuffer } = require('../src/wordParser');

test('parseQuestionsFromText parses PG with key and ESAI blocks tolerantly', () => {
  const sample = `
  [PG]
  1. Ibu kota Provinsi Maluku adalah...
  A. Tual
  B. Ambon
  C. Namlea
  D. Masohi
  E. Dobo
  kunci : b

  2) Hasil dari 5 + 5 adalah...
  a. 8
  b. 9
  c. 10
  d. 11
  e. 12
  KUNCI: C

  [ESAI]
  31. Jelaskan 3 faktor utama kesetimbangan kimia!
  `;
  const result = parseQuestionsFromText(sample);
  assert.equal(result.length, 3);
  assert.equal(result[0].type, 'PG');
  assert.equal(result[0].answer_key, 'B');
  assert.equal(result[1].answer_key, 'C');
  assert.equal(result[2].type, 'ESAI');
  assert.equal(result[2].answer_key, null);
});

test('generateWordTemplateBuffer produces a valid .docx buffer that parseDocxBuffer can parse back', async () => {
  const buf = await generateWordTemplateBuffer();
  const parsed = await parseDocxBuffer(buf);
  assert.ok(parsed.some(q => q.type === 'PG'));
  assert.ok(parsed.some(q => q.type === 'ESAI'));
});
```

- [ ] **Step 2: Jalankan pengujian untuk memastikan gagal**

Run: `node --test tests/wordParser.test.js`
Expected: FAIL dengan `Cannot find module '../src/wordParser'`

- [ ] **Step 3: Implementasikan `src/wordParser.js`**

Gunakan `mammoth.convertToHtml` / `extractRawText` (dengan dukungan ekstraksi gambar base64 inline) dan regex yang toleran terhadap format `[PG]`, `[ESAI]`, penomoran `1.` atau `1)`, opsi `A.` s/d `E.`, dan `KUNCI: X`. Gunakan paket `docx` untuk membuat file template `.docx` resmi SMA N 3 Buru yang bisa diunduh guru.

- [ ] **Step 4: Jalankan pengujian untuk memastikan lulus**

Run: `node --test tests/wordParser.test.js`
Expected: PASS

---

### Task 3: Backend REST API (Operator, Guru, Pengawas, dan Ujian Siswa Anti-Bocor)

**Files:**
- Create: `src/app.js`
- Create: `server.js`
- Create: `Jalankan-Server-CBT.bat`
- Create: `tests/api.test.js`

**Interfaces:**
- Consumes: `initDb` dari `src/db.js`, `parseDocxBuffer` & `generateWordTemplateBuffer` dari `src/wordParser.js`
- Produces:
  - `createApp(db): ExpressApp` di `src/app.js`
  - Endpoint Auth & Staf: `POST /api/staff/login`, `GET /api/operator/overview`, `POST /api/operator/students`, `POST /api/operator/token`, `GET /api/operator/print-data`, `GET /api/guru/exams`, `POST /api/guru/exams/:id/import-word`, `GET /api/guru/exams/:id/export-excel`, `GET /api/pengawas/room`, `POST /api/pengawas/unlock/:sessionId`, `POST /api/pengawas/reset-login/:sessionId`
  - Endpoint Siswa: `POST /api/ujian/login`, `GET /api/ujian/session/:sessionId`, `POST /api/ujian/answer`, `POST /api/ujian/violation`, `POST /api/ujian/finish`

- [ ] **Step 1: Tulis pengujian integrasi API untuk kelima fokus keamanan & alur ujian di `tests/api.test.js`**

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');

test('Student exam lifecycle: login, auto-save PG, no key/score leak, lock on violation, unlock by pengawas, accurate PG-only score for guru', async (t) => {
  const db = initDb(':memory:');
  const app = createApp(db);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const exam = db.prepare('SELECT * FROM exams LIMIT 1').get();
  const student = db.prepare('SELECT * FROM students LIMIT 1').get();

  // 1. Login siswa
  const loginRes = await fetch(`${base}/api/ujian/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exam_number: student.exam_number, password: student.password, token: exam.token })
  }).then(r => r.json());
  assert.ok(loginRes.sessionId);

  // 2. Ambil soal — pastikan tidak ada answer_key yang bocor ke siswa
  const sessionData = await fetch(`${base}/api/ujian/session/${loginRes.sessionId}`).then(r => r.json());
  assert.ok(sessionData.questions.length > 0);
  for (const q of sessionData.questions) {
    assert.equal(q.answer_key, undefined);
  }

  // 3. Auto-save jawaban PG pertama dengan benar
  const firstPg = db.prepare("SELECT * FROM questions WHERE exam_id = ? AND type = 'PG' ORDER BY number ASC LIMIT 1").get(exam.id);
  const ansRes = await fetch(`${base}/api/ujian/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: loginRes.sessionId, questionId: firstPg.id, chosenOption: firstPg.answer_key })
  });
  assert.equal(ansRes.status, 200);

  // 4. Pelanggaran keluar aplikasi -> mengunci sesi & menolak pengiriman jawaban baru
  await fetch(`${base}/api/ujian/violation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: loginRes.sessionId, reason: 'Keluar aplikasi / pindah layar' })
  });
  const blockedAns = await fetch(`${base}/api/ujian/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: loginRes.sessionId, questionId: firstPg.id, chosenOption: 'A' })
  });
  assert.equal(blockedAns.status, 423);

  // 5. Pengawas membuka kunci -> siswa bisa lanjut dan selesaikan ujian tanpa bocor nilai
  await fetch(`${base}/api/pengawas/unlock/${loginRes.sessionId}`, { method: 'POST' });
  const finishRes = await fetch(`${base}/api/ujian/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: loginRes.sessionId })
  }).then(r => r.json());
  assert.equal(finishRes.score, undefined);
  assert.equal(finishRes.status, 'FINISHED');

  // 6. Guru melihat skor PG yang dihitung hanya dari total soal PG (bukan PG + Esai)
  const pgCount = db.prepare("SELECT COUNT(*) as c FROM questions WHERE exam_id = ? AND type = 'PG'").get(exam.id).c;
  const guruScores = await fetch(`${base}/api/guru/exams/${exam.id}/scores`).then(r => r.json());
  const studentScoreRow = guruScores.scores.find(s => s.student_id === student.id);
  assert.equal(studentScoreRow.score, Number(((1 / pgCount) * 100).toFixed(1)));
});
```

- [ ] **Step 2: Jalankan pengujian untuk memastikan gagal**

Run: `node --test tests/api.test.js`
Expected: FAIL dengan `Cannot find module '../src/app'`

- [ ] **Step 3: Implementasikan `src/app.js`, `server.js`, dan `Jalankan-Server-CBT.bat`**

Implementasikan semua route REST API untuk Operator, Guru, Pengawas, dan Siswa, serta pembuatan file Excel (`.xlsx`) rekap nilai PG dan deteksi IP LAN otomatis saat `server.js` menyala.

- [ ] **Step 4: Jalankan pengujian untuk memastikan lulus**

Run: `node --test tests/api.test.js`
Expected: PASS

---

### Task 4: Antarmuka Web Modern Offline-First (Operator + Pusat Cetak 4 Dokumen, Guru, Pengawas, & Ujian Siswa)

**Files:**
- Create: `public/styles.css`
- Create: `public/index.html` (Portal Utama & Pilih Panel / Login)
- Create: `public/operator.html` (Panel Operator + Pusat Cetak Daftar Hadir, Kartu Peserta, Kartu Login, Kartu Meja)
- Create: `public/guru.html` (Panel Guru + Import Word `.docx` + Pratinjau PG & Esai + Export Excel)
- Create: `public/pengawas.html` (Panel Pengawas Mobile-Friendly + Alert Merah + Buka Kunci + Reset Login)
- Create: `public/ujian.html` (Portal Ujian Siswa Exambro + Auto-save PG + Banner Esai Kertas + Deteksi Pindah Layar)
- Create: `tests/ui.test.js`

**Interfaces:**
- Consumes: REST API dari `src/app.js`
- Produces: Halaman web statis bebas CDN di `public/*` yang terhubung ke seluruh endpoint `/api/*`

- [ ] **Step 1: Tulis pengujian ketersediaan halaman UI dan bebas CDN eksternal di `tests/ui.test.js`**

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');

test('All 5 web interfaces load with 200 OK and contain zero external CDN links (100% offline-ready)', async (t) => {
  const db = initDb(':memory:');
  const app = createApp(db);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const page of ['/', '/operator.html', '/guru.html', '/pengawas.html', '/ujian.html']) {
    const res = await fetch(`${base}${page}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes('https://fonts.googleapis.com'), `${page} must not depend on external fonts`);
    assert.ok(!html.includes('https://cdn.'), `${page} must not depend on external CDN`);
  }
});
```

- [ ] **Step 2: Jalankan pengujian untuk memastikan gagal**

Run: `node --test tests/ui.test.js`
Expected: FAIL (404 Not Found)

- [ ] **Step 3: Implementasikan seluruh halaman UI modern di `public/`**

Pastikan:
- `public/operator.html` memiliki fitur cetak siap print A4 ber-Kop **SMA NEGERI 3 BURU** untuk: **Daftar Hadir** (tanda tangan zig-zag), **Kartu Peserta**, **Kartu Login**, dan **Kartu Meja**.
- `public/guru.html` memiliki fitur unduh template Word (`.docx`), upload/import soal `.docx` (PG + Esai), edit/tambah soal manual, dan export nilai PG ke Excel (`.xlsx`).
- `public/pengawas.html` nyaman dibuka dari HP pengawas di kelas, menampilkan peringatan merah real-time saat ada siswa terkunci, tombol **Buka Kunci**, dan tombol **Reset Login**.
- `public/ujian.html` memiliki tampilan bersih modern, navigasi soal PG dan soal Esai (dengan kotak instruksi jawab di kertas), deteksi keluar tab/aplikasi yang langsung mengunci layar siswa menjadi merah sampai dibuka oleh pengawas, serta layar selesai ujian yang **tidak menampilkan nilai**.

- [ ] **Step 4: Jalankan pengujian untuk memastikan lulus**

Run: `node --test tests/ui.test.js`
Expected: PASS

---

### Task 5: Proyek Aplikasi Android Native Exambro (`android-exambro/`) & Panduan Penggunaan Sekolah

**Files:**
- Create: `android-exambro/app/src/main/AndroidManifest.xml`
- Create: `android-exambro/app/src/main/java/id/sch/sman3buru/exambro/MainActivity.kt`
- Create: `android-exambro/app/src/main/res/layout/activity_main.xml`
- Create: `android-exambro/app/build.gradle.kts`
- Create: `android-exambro/settings.gradle.kts`
- Create: `android-exambro/build.gradle.kts`
- Create: `PANDUAN-PENGGUNAAN.md`
- Create: `tests/android.test.js`

**Interfaces:**
- Consumes: Endpoint `/ujian.html` dan `/api/ujian/violation` dari Server CBT Lokal
- Produces: Proyek Android Studio Kotlin lengkap di `android-exambro/` dengan `startLockTask()`, `FLAG_SECURE`, `resizeableActivity="false"`, dan injeksi header `X-Exambro-App: SMAN3BURU-SECURE`

- [ ] **Step 1: Tulis pengujian verifikasi konfigurasi keamanan Android Exambro di `tests/android.test.js`**

```javascript
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
});
```

- [ ] **Step 2: Jalankan pengujian untuk memastikan gagal**

Run: `node --test tests/android.test.js`
Expected: FAIL (`ENOENT`)

- [ ] **Step 3: Buat kode sumber lengkap proyek Android Exambro di `android-exambro/` dan `PANDUAN-PENGGUNAAN.md`**

Tulis konfigurasi Gradle, `AndroidManifest.xml` (dengan `resizeableActivity="false"`, `usesCleartextTraffic="true"` untuk IP LAN lokal), layout koneksi IP Server + WebView Ujian, dan `MainActivity.kt` yang mengunci layar (`startLockTask()`), memblokir screenshot (`FLAG_SECURE`), menyembunyikan status/navigation bar (*Immersive Sticky*), dan memanggil JavaScript bridge pelanggaran saat siswa mencoba keluar.

- [ ] **Step 4: Jalankan seluruh rangkaian pengujian proyek**

Run: `node --test`
Expected: PASS semua pengujian (`db.test.js`, `wordParser.test.js`, `api.test.js`, `ui.test.js`, `android.test.js`)
