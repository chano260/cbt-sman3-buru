# Aplikasi Ujian Android Sendiri — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aplikasi Android "Ujian CBT SMAN 3 Buru": kode masuk → halaman login ujian, terkunci, keluar dengan password pengawas; server mendukung kode masuk, tiket aplikasi, sakelar wajib aplikasi.
**Architecture:** Server Express menambah endpoint `/api/app/*` + sakelar di settings; `ujian.html` mendapat hook keluar-pengawas & sintaks kompatibel WebView lama; aplikasi Java (WebView) di `android-exambro/` ditulis ulang tanpa Gradle, dibangun `build-apk.ps1`.
**Tech Stack:** Node 22 / Express / node:test; Android Java (minSdk 23, target 35), aapt2/javac/d8/apksigner.
**Spec:** `docs/superpowers/specs/2026-11-24-aplikasi-ujian-android-design.md`

## Global Constraints
- Paket `id.sch.sman3buru.ujian`, nama "Ujian CBT SMAN 3 Buru", versionCode 2, versionName "2.0.0", minSdk 23, targetSdk 35.
- Alamat bawaan `https://cbt.smanegeri3buru.my.id`. APK keluar ke `public/Exambro-SMAN3-Buru.apk`.
- Kode masuk: angka 4–8 digit, disimpan sebagai hash (settings `app_code_hash`). Password keluar = hash SEB (`seb_quit_hash`, SHA-256 hex).
- Tiket aplikasi: acak, berlaku 12 jam, di memori server; cookie `cbt_app`.
- Sakelar `require_app` (settings, bawaan mati). Aktif → login/start-direct hanya dengan tiket sah atau UA memuat `SEB/`; selain itu 403 "Ujian hanya bisa dibuka lewat aplikasi ujian sekolah".
- Tidak ada kode/password tertanam di APK; password keystore tidak ditulis di `build-apk.ps1`.

## Review Focus
- Kode masuk diubah operator saat siswa sudah masuk → tiket lama tetap berlaku sampai kedaluwarsa (tes: verify, ganti kode, login masih 200).
- Sakelar aktif & siswa iPhone SEB (UA `... SEB/3.6`) → login diterima (tes).
- Tebakan kode beruntun → setelah 10 salah/15 menit per IP: 429 walau kode benar (tes).
- Keluar pengawas di tengah ujian → sesi TIDAK terkunci, `violation_count` tetap, `supervisor_exit_at` terisi (tes).
- WebView lama → script inline `ujian.html` tanpa `?.` / `??` (tes statis).

---

### Task 1: Server — kode masuk, tiket, sakelar wajib aplikasi, keluar pengawas
**Files:** Modify `src/app.js`, `src/db.js` (kolom `exam_sessions.supervisor_exit_at TEXT`); Test `tests/app-android.test.js`
**Produces:**
- `POST /api/operator/app-settings` (operator) `{ code?: '4–8 digit', requireApp?: boolean }` → `{ ok, codeSet, requireApp }`; 400 bila kode bukan 4–8 digit.
- `GET /api/operator/app-settings` → `{ codeSet, requireApp }`.
- `POST /api/app/verify-code` `{ code }` → 200 `{ ok:true, ticket, expiresInSec: 43200 }` + `Set-Cookie: cbt_app=<ticket>`; 401 salah; 404 kode belum diatur; 429 setelah 10 salah/15 menit per IP.
- `POST /api/app/verify-quit` `{ password }` → 200 `{ ok:true, hash }` (hash SHA-256 hex utk cache offline); 401 salah; 404 belum diatur.
- `POST /api/ujian/supervisor-exit` (requireStudentSession) → set `supervisor_exit_at`, status tidak berubah.
- Penjaga `requireAppIfEnabled(req,res,next)` dipasang di `/api/ujian/login` & `/api/ujian/start-direct`; tiket dibaca dari cookie `cbt_app` atau header `X-App-Ticket`.
- [ ] Tes (RED) untuk: operator-only & validasi kode; verify-code ok/401/404/429 (+cookie); sakelar mati → login biasa 200; sakelar aktif → login tanpa tiket 403, dengan cookie tiket 200, UA SEB 200; ganti kode → tiket lama tetap 200; verify-quit ok mengembalikan hash = sha256; supervisor-exit tidak mengunci & `violation_count` tetap.
- [ ] Implementasi → semua tes (`npm test`) PASS.

### Task 2: Panel Operator — kotak "Aplikasi ujian Android"
**Files:** Modify `public/operator.html`
- [ ] Kartu di tab Pantauan (dekat kartu SEB): input kode masuk (angka, inputmode numeric, 4–8), tombol Simpan, status "Kode sudah diatur / belum"; sakelar "Wajibkan aplikasi ujian" (checkbox) dengan keterangan; tautan unduh APK `/Exambro-SMAN3-Buru.apk`.
- [ ] Muat status via `GET /api/operator/app-settings` di `loadOverview`. Cek di browser.

### Task 3: ujian.html — kompatibel WebView lama + hook keluar pengawas
**Files:** Modify `public/ujian.html`; Test `tests/ujian-legacy.test.js`
- [ ] Tes statis: script inline `ujian.html` tidak memuat `?.` atau `??` (abaikan string/komentar sederhana: cari pola `\?\.[a-zA-Z_(\[]` dan `\?\?`).
- [ ] Ganti `examData?.exam?.subject` dkk ke bentuk `a && a.b`.
- [ ] `window.cbtSupervisorExit = async () => {...}`: set `window.__cbtExiting = true`, lepas listener blur/visibility, POST `/api/ujian/supervisor-exit` bila ada sesi; `handleVisibilityChange`/`handleWindowBlur`/`onExambroViolationDetected` mengabaikan saat `__cbtExiting`.

### Task 4: Aplikasi Android
**Files:** Rewrite `android-exambro/app/src/main/java/id/sch/sman3buru/ujian/MainActivity.java` (pindah paket), `AndroidManifest.xml`, `res/layout/activity_main.xml`, `res/values/strings.xml`, ikon `res/mipmap-*/ic_launcher.png` dari logo sekolah; hapus `PhotoProvider`/kode kamera; Modify `build-apk.ps1`.
- Layar kode: logo, judul, 6 titik kode, keypad 0–9/hapus/Masuk (Button native, tanpa EditText → keyboard HP tidak muncul). 5 salah → tahan 60 dtk.
- Verifikasi via `HttpURLConnection` di thread latar ke `<server>/api/app/verify-code`; sukses → `CookieManager.setCookie(server, "cbt_app=<ticket>; Path=/")`, `startLockTask()` (try/catch), lalu WebView `loadUrl(server + "/ujian.html")`.
- Deteksi: `onWindowFocusChanged(false)` / `onPause` saat ujian & bukan `exiting` & bukan dalam 3 dtk setelah `startLockTask` → `evaluateJavascript("window.onExambroViolationDetected && window.onExambroViolationDetected('…')")`; split screen tetap.
- WebView: JS + DOM storage, UA `+ " SMAN3BURU-UJIAN-ANDROID/2.0"`, long-press & seleksi dimatikan (`setLongClickable(false)`, `setOnLongClickListener → true`, `setHapticFeedbackEnabled(false)`), navigasi keluar host server diblokir, Back diabaikan. JS bridge `AndroidExambro` tetap punya `exitLockMode()` (dipanggil ujian.html saat selesai).
- Tombol Keluar (kecil, pojok kanan atas, overlay di atas WebView) → dialog password (EditText password) → `verify-quit`; sukses → simpan hash di SharedPreferences, `exiting=true`, `evaluateJavascript("window.cbtSupervisorExit && window.cbtSupervisorExit()")`, tunggu 1,5 dtk, `stopLockTask()`, `finishAndRemoveTask()`. Server tak terjangkau → cek SHA-256 lokal terhadap hash simpanan; tak ada hash → tampilkan petunjuk keluar darurat.
- Pengaturan tersembunyi: ketuk logo 5× di layar kode → password pengawas (aturan sama) → dialog ganti alamat server (SharedPreferences `server_url`).
- `build-apk.ps1`: paket/jalur baru, minSdk 23 / target 35 / version 2 / 2.0.0, keystore baru `android-exambro/keystore/ujian-release.jks` (sudah di .gitignore `*.jks`), password dari `$env:CBT_KEYSTORE_PASS` atau `Read-Host -AsSecureString`.
- [ ] Bangun APK tanpa error; `apksigner verify` sukses; `aapt2 dump badging` menunjukkan paket, minSdk 23, label.

### Task 5: Uji & dokumentasi
- [ ] Jalankan di emulator bila tersedia (system image), atau serahkan APK untuk dicoba di HP: alur kode → login → keluar.
- [ ] PANDUAN bagian 8: pasang APK, kode masuk, sakelar wajib aplikasi, keluar oleh pengawas, keluar darurat.
