# Wajib Ganti Password Bawaan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Akun staf yang login dengan password bawaan wajib ganti password sebelum memakai panel.
**Architecture:** Tanda `mustChangePassword` di entri token staf; `requireStaffAuth` menolak 403; endpoint ganti password; pop-up bersama di 3 panel.
**Tech Stack:** Express 4, node:test, HTML/JS tanpa framework.
**Spec:** `docs/superpowers/specs/2026-11-22-wajib-ganti-password-design.md`

## Global Constraints
- Password bawaan: `admin123`, `guru123`, `pengawas123`. Password baru ≥ 8 karakter, bukan bawaan, ≠ username.
- Kode penolakan: HTTP 403, `code: 'PASSWORD_CHANGE_REQUIRED'`.

## Review Focus
- Refresh halaman setelah login (token di sessionStorage) → pop-up muncul lagi lewat respons 403 (tes server: endpoint staf tetap 403 sebelum ganti).
- Token ujian tidak bocor lewat `/api/server-info` & `/api/ujian/active-token` selama wajib ganti (tes).
- Password lama salah → 401, tanda tetap (tes).
- Login dengan password non-bawaan (staf buatan operator) → tidak ditandai (tes).
- Operator reset password guru ke `guru123` → guru ditandai saat login (tes).

---

### Task 1: Server
**Files:** `src/security.js` (`DEFAULT_STAFF_PASSWORDS`, `isDefaultStaffPassword(pw)`), `src/app.js`, `server.js`; Test `tests/password-change.test.js`
- [ ] Tes Review Focus + jalur sukses: ganti → endpoint staf 200, login ulang password baru tidak ditandai.
- [ ] `node --test tests/password-change.test.js` → FAIL.
- [ ] Implementasi; tes lain yang login dengan password bawaan memakai helper yang mengganti password dulu, atau server tes mematikan cek lewat opsi? → **Tidak**: tes lama memakai `createApp(db)`; tambahkan opsi `createApp(db, { enforceDefaultPasswordChange })` default `true`, dan tes lama yang bergantung pada akun bawaan diberi `false` hanya bila perlu.
- [ ] Semua tes → PASS.

### Task 2: Panel
**Files:** Create `public/password-gate.js`; Modify `public/operator.html`, `guru.html`, `pengawas.html`, `PANDUAN-PENGGUNAAN.md`
- [ ] Panel memanggil `cbtPasswordGate.require(staffToken)` bila `data.mustChangePassword`.
- [ ] Wrapper fetch membuka pop-up pada 403 `PASSWORD_CHANGE_REQUIRED`.
- [ ] Cek di browser: login operator bawaan → pop-up → ganti → panel terbuka; refresh sebelum ganti → pop-up lagi.
