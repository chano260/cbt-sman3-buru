# Backup Database Otomatis — Desain Singkat (2026-11-22)

## Tujuan
Jawaban & nilai siswa tidak boleh hilang bila file `cbt-sman3-buru.db` rusak/terhapus,
atau bila VPS bermasalah. Sebelumnya tidak ada backup sama sekali.

## Disetujui pengguna
- Backup otomatis tiap **10 menit** ke folder `backups/` di samping file database,
  nama berisi tanggal+jam (`cbt-backup-YYYYMMDD-HHMMSS.db`).
- Simpan **36 salinan terbaru** (±6 jam); yang lebih lama dihapus otomatis.
- Salinan dibuat dengan `VACUUM INTO` (snapshot konsisten, aman walau ujian berjalan, WAL ikut terbaca).
- Panel Operator: tombol **"Unduh Backup Sekarang"** (membuat salinan baru lalu mengunduhnya)
  + keterangan waktu backup otomatis terakhir. Hanya role operator.
- **Tidak ada** pemulihan lewat panel (berisiko salah tekan). Cara pulihkan ditulis di panduan.

## Perbaikan terkait
`docker-compose.yml` hanya mem-persist `/app/data`, padahal database ada di `/app`.
Tambah dukungan `DB_PATH` (env) dan set `DB_PATH=/app/data/cbt-sman3-buru.db` di compose,
sehingga database & backup ikut tersimpan permanen. Instalasi pm2 tidak berubah.

## Pilihan pendekatan
- **VACUUM INTO (dipilih):** satu perintah SQL, jalan di better-sqlite3 maupun node:sqlite, hasil satu file utuh.
- Salin file mentah (`fs.copyFile`): bisa menghasilkan salinan rusak karena mode WAL. Ditolak.
- API backup online better-sqlite3: tidak ada di fallback node:sqlite. Ditolak.

## Keputusan saya (bisa dikoreksi)
- Backup pertama dibuat 1 menit setelah server menyala, lalu tiap 10 menit.
- Kegagalan backup hanya dicatat di log server; tidak menghentikan ujian.
- Endpoint: `GET /api/operator/backup/status`, `GET /api/operator/backup/download`.
