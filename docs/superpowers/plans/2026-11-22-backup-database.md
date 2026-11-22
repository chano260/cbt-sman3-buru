# Backup Database Otomatis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Salinan database otomatis tiap 10 menit + tombol unduh backup di Panel Operator.

**Architecture:** Modul baru `src/backup.js` (snapshot `VACUUM INTO`, rotasi, status, penjadwal). `createApp(db, { backupDir })` memakai modul itu untuk dua endpoint operator. `server.js` menyalakan penjadwal.

**Tech Stack:** Node 22, better-sqlite3 / node:sqlite, Express 4, node:test.

**Spec:** `docs/superpowers/specs/2026-11-22-backup-database-design.md`

## Global Constraints
- Interval 10 menit (`10 * 60 * 1000`), backup pertama 1 menit setelah start, simpan 36 salinan.
- Nama file `cbt-backup-YYYYMMDD-HHMMSS.db` (waktu lokal server).
- Hanya role `operator` untuk endpoint backup. Tidak ada endpoint pemulihan.
- Gagal backup → `console.error`, tidak melempar ke penjadwal.

## Review Focus
- Dua backup dalam detik yang sama → nama bentrok; tambahkan akhiran `-2`, `-3` (tes: dua `createBackup` beruntun menghasilkan 2 file).
- File lain di folder `backups/` (bukan pola `cbt-backup-*.db`) tidak boleh ikut dihapus rotasi (tes).
- Folder `backups/` belum ada → dibuat otomatis (tes memakai folder baru di tmp).
- Salinan harus berisi data yang ditulis tepat sebelum backup walau mode WAL (tes: insert lalu backup lalu buka salinan).
- Penjadwal tidak boleh menahan proses keluar (`timer.unref()`).

---

### Task 1: Modul backup

**Files:** Create `src/backup.js`; Test `tests/backup.test.js`

**Interfaces (Produces):**
- `createBackup(db, dir, { keep = 36 } = {}) -> string` (path file baru)
- `backupStatus(dir) -> { last: string|null (ISO), count: number }`
- `startBackupSchedule(db, dir, { intervalMs, firstDelayMs, keep }) -> { stop() }`

- [ ] Tes: `createBackup` membuat folder + file berpola nama, salinan berisi baris yang baru di-insert (DB file di tmp, WAL).
- [ ] Tes: rotasi — 5 backup dengan `keep: 3` → tersisa 3 terbaru; file `catatan.txt` tetap ada.
- [ ] Tes: `backupStatus` folder kosong/tidak ada → `{ last: null, count: 0 }`; setelah backup → count 1, last terisi.
- [ ] Jalankan `node --test tests/backup.test.js` → FAIL (modul belum ada).
- [ ] Implementasi; `VACUUM INTO ?` dengan path absolut.
- [ ] Jalankan lagi → PASS.

### Task 2: Endpoint operator, tombol panel, server & Docker

**Files:** Modify `src/app.js` (createApp opsi `backupDir`, 2 route), `public/operator.html` (kartu di tab-dashboard), `server.js`, `src/db.js` (default path dari `process.env.DB_PATH`), `docker-compose.yml`, `PANDUAN-PENGGUNAAN.md`, `.gitignore` (`backups/`); Test `tests/backup.test.js`

- [ ] Tes: `GET /api/operator/backup/status` tanpa token → 401, guru → 403, operator → 200 `{last,count}`.
- [ ] Tes: `GET /api/operator/backup/download` operator → 200, header `Content-Disposition` berisi `cbt-backup-`, body diawali `SQLite format 3`.
- [ ] Implementasi, jalankan semua tes → PASS.
- [ ] Panel: tombol "Unduh Backup Sekarang" (fetch + blob) dan teks "Backup otomatis terakhir: …"; cek di browser.
- [ ] Panduan: langkah pulihkan (hentikan server, ganti file, jalankan lagi).
