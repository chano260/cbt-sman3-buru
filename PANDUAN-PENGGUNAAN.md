# Panduan Penggunaan & Deploy VPS Sistem CBT — SMA Negeri 3 Buru

Sistem CBT **SMA Negeri 3 Buru** mendukung 2 mode pelaksanaan sekaligus:
1. **Mode Online via VPS Pribadi (450–500+ Siswa Serentak)**: Dioptimasi dengan *SQLite WAL High-Concurrency*, *RAM Question Cache*, dan **QR Code Otomatis** untuk aplikasi **Exambro Scan QR** yang sudah dimiliki sekolah.
2. **Mode Offline via Wi-Fi / LAN Lokal Sekolah**: Tanpa kuota internet di komputer operator sekolah.

---

## 1. Cara Deploy ke VPS Anda (Untuk 450+ Siswa Serentak)

Spesifikasi VPS minimal yang disarankan untuk **450–500 siswa bersamaan**: **2 vCPU, 2 GB RAM, SSD 20 GB** (Ubuntu 22.04 / 24.04 atau Debian 12).

### Cara A: Menggunakan PM2 (Node.js Langsung di Ubuntu/Debian)
Jalankan perintah berikut di terminal SSH VPS Anda:
```bash
# 1. Install Node.js 22 & PM2
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential python3
sudo npm install -g pm2

# 2. Masuk ke folder aplikasi & install paket
cd cbt-sman3-buru
npm install --omit=dev

# 3. Jalankan server di background dengan PM2 (otomatis hidup saat VPS restart)
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### Cara B: Menggunakan Docker Compose (1 Perintah)
```bash
docker compose up -d --build
```

### Mengatur Domain / IP Publik VPS & QR Code Exambro Sekolah
1. Buka **Panel Operator** di `http://IP-VPS-ANDA:8080/operator.html` (atau domain Anda).
2. Pada kotak **"🌐 Alamat Domain / IP Publik VPS"**, ketik alamat VPS Anda, misalnya:
   - `https://cbt.sman3buru.sch.id` *(jika memakai domain)*, atau
   - `http://103.xxx.xxx.xxx:8080` *(jika langsung memakai IP VPS)*.
3. Klik **"💾 Simpan & Buat QR"**.
4. **Selesai!** QR Code di layar Operator, layar Pengawas, **Kartu Login**, dan **Kartu Meja** otomatis mengarah ke alamat VPS Anda. Siswa cukup membuka aplikasi Exambro yang sudah ada di sekolah lalu **Scan QR Code** di Kartu Meja / Kartu Login mereka.

---

## 2. Daftar Akun Login Bawaan (Siap Pakai)

| Panel / Peran | Alamat Akses | Username | Password |
|---|---|---|---|
| **1. Panel Operator / Admin** | `/operator.html` | `operator` | `admin123` |
| **2. Panel Guru Mata Pelajaran** | `/guru.html` | `guru` | `guru123` |
| **3. Panel Pengawas Ruangan** | `/pengawas.html` | `pengawas` | `pengawas123` |
| **4. Portal Ujian Siswa (Exambro)** | `/ujian.html` | `26-03-001` | `BURU01` |

*(Token ujian berganti otomatis setiap **15 menit** dan tampil di layar Operator & Pengawas).*

---

## 3. Fitur Utama Per Panel

### A. Panel Operator (`/operator.html`)
- **QR Code Exambro Otomatis:** Mendukung aplikasi Exambro sekolah yang menggunakan fitur **Scan QR Code**.
- **Token Ujian Otomatis Ganti Tiap 15 Menit:** Jika siswa mengalami gangguan / keluar aplikasi di tengah ujian, setelah dibuka kuncinya oleh Pengawas, siswa wajib memasukkan **Token 15-Menit terbaru** agar tidak bisa mengerjakan di luar pengawasan.
- **Import Data Siswa Sekaligus dari Excel (`.xlsx`):** Unduh template Excel dan upload ratusan siswa (450+ siswa) sekaligus dalam 1 klik.
- **👁️ Pantau Kerja Siswa (Live Anti-Contek):** Melihat siswa sedang berada di soal nomor berapa dan jawaban apa saja yang dipilih secara *real-time*.
- **Pusat Cetak 4 Dokumen Administrasi A4/PDF:**
  1. **Daftar Hadir Peserta Ujian** (Kop SMA Negeri 3 Buru & tanda tangan zig-zag).
  2. **Kartu Peserta Ujian**.
  3. **Kartu Login CBT + QR Code Exambro**.
  4. **Kartu Meja Ujian + QR Code Exambro**.

### B. Panel Guru Mata Pelajaran (`/guru.html`)
- **Import Soal Sekaligus dari Microsoft Word (`.docx`):** Mendukung Pilihan Ganda (`[PG]` + `KUNCI: A-E`), gambar di dalam soal, dan Esai (`[ESAI]`).
- **Rekap Nilai Pilihan Ganda (Excel `.xlsx`):** Nilai PG tidak pernah ditampilkan di HP siswa untuk mencegah kebocoran kunci jawaban.

### C. Panel Pengawas Ruangan (`/pengawas.html`)
- Menampilkan **QR Code Exambro** dan **Token 15-Menit Aktif** di kelas.
- Notifikasi merah otomatis jika siswa keluar dari Exambro (`TERKUNCI`), lengkap dengan tombol **🔓 Buka Kunci**, **🔄 Reset Login**, dan **👁️ Pantau Kerja**.

---

## 4. Backup & Pemulihan Database

Semua data (siswa, soal, jawaban, nilai) ada di satu file database: `cbt-sman3-buru.db`
(di folder aplikasi; jika memakai Docker: `data/cbt-sman3-buru.db`).

**Backup otomatis:** server menyalin database **tiap 10 menit** ke folder `backups/` di samping file
database, dengan nama `cbt-backup-TANGGAL-JAM.db`. Hanya **36 salinan terakhir** (±6 jam) yang disimpan.

**Unduh ke laptop/flashdisk:** Panel Operator → tab **Pantauan & Token** → kotak **💾 Backup Database**
→ **⬇️ Unduh Backup Sekarang**. Lakukan sebelum dan sesudah setiap sesi ujian, karena backup di VPS
tidak menolong bila VPS-nya sendiri rusak.

**Memulihkan (hanya bila database rusak/terhapus):**
1. Hentikan server: `pm2 stop cbt-sman3-buru` (Docker: `docker compose stop`).
2. Simpan dulu file lama: ganti nama `cbt-sman3-buru.db` menjadi `cbt-sman3-buru.db.rusak`,
   dan hapus file `cbt-sman3-buru.db-wal` serta `cbt-sman3-buru.db-shm` bila ada.
3. Salin file backup yang dipilih (dari `backups/` atau hasil unduhan) ke folder yang sama,
   lalu beri nama `cbt-sman3-buru.db`.
4. Jalankan lagi server: `pm2 start cbt-sman3-buru` (Docker: `docker compose start`).
5. Data kembali ke kondisi saat backup itu dibuat; jawaban setelah jam backup tersebut tidak ikut.

> Catatan Docker: mulai versi ini database disimpan di folder `data/` agar tidak hilang saat container
> dibuat ulang. Jika sebelumnya server sudah berjalan lewat Docker, salin dulu database lama dari container
> (`docker cp cbt-sman3-buru:/app/cbt-sman3-buru.db ./data/`) sebelum `docker compose up -d --build`.
