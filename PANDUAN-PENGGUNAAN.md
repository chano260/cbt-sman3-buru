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

> **🔐 Wajib ganti password:** password bawaan akun staf (`admin123`, `guru123`, `pengawas123`) hanya
> untuk **login pertama**. Setelah login, panel menampilkan pop-up **"Ganti Password Dulu"** dan semua menu
> terkunci sampai password baru disimpan (minimal 8 karakter, bukan password bawaan, tidak sama dengan username).
> Password yang dibuat operator untuk guru/pengawas lewat menu **Akun Guru & Pengawas** tidak perlu diganti,
> kecuali operator mengisinya dengan salah satu password bawaan.

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

---

## 5. Uji Beban (Simulasi Siswa Serentak)

Gunakan sebelum hari ujian untuk memastikan VPS sanggup melayani seluruh siswa yang mengerjakan bersamaan.
Skrip menyalakan **server tes terpisah** (port 8199) dengan **database sementara**, jadi data asli dan
ujian yang sedang berjalan **tidak tersentuh**; semua data tes dihapus setelah selesai.

> ⚠️ Jalankan **di luar jam ujian** — uji ini memakai tenaga (CPU) VPS yang sama dengan server asli.

```bash
cd folder-aplikasi-cbt
node scripts/uji-beban.js --siswa 500 --pengawas 15 --menit 5
```

| Opsi | Arti | Bawaan |
|---|---|---|
| `--siswa` | jumlah siswa tes yang mengerjakan bersamaan | 500 |
| `--pengawas` | jumlah pengawas tes (= jumlah ruang) | 15 |
| `--menit` | lama uji | 5 |
| `--datang` | siswa datang bertahap selama N detik pertama | 60 |
| `--port` | port server tes | 8199 |

Siswa tes meniru siswa sungguhan: login + token, buka soal, cek sesi tiap 6 detik, menjawab satu soal tiap
20–40 detik, lalu menandai esai dan menekan Selesai. Pengawas tes memantau ruang tiap 2,5 detik.

Di akhir tampil tabel waktu tunggu per jenis permintaan dan kesimpulan:
- ✅ **SANGGUP** — 95% permintaan selesai di bawah 1 detik dan gagal di bawah 1%.
- ⚠️ **BERAT** — 95% permintaan butuh 1–3 detik; siswa akan merasakan jeda.
- ❌ **TIDAK SANGGUP** — lebih lambat/banyak gagal; bagi siswa ke beberapa sesi atau tingkatkan VPS.

Skrip tidak bisa diarahkan ke alamat luar (termasuk domain sekolah), sehingga tidak mungkin mengisi
database asli dengan siswa palsu. Tekan **Ctrl+C** untuk berhenti; server tes ikut dimatikan.

---

## 6. Impor Akun Guru & Pengawas dari Excel

Panel Operator → **Akun guru & pengawas** → kotak **Impor akun guru & pengawas dari Excel**.

1. Klik **Unduh template Excel**. File berisi contoh baris dan lembar **Petunjuk**.
2. Isi satu baris per akun:

| Kolom | Isi |
|---|---|
| Peran | `guru` atau `pengawas` |
| Nama Lengkap | nama dan gelar, misal `Ibu Dra. Siti Aminah, S.Pd.` |
| Username | tanpa spasi, misal `guru_kimia` |
| Password | password login (disarankan minimal 8 karakter) |
| Mapel / Ruang | guru: nama mapel (dua mapel dipisah koma); pengawas: nama ruang, misal `Ruang 01` |

3. Pilih file lalu klik **Unggah & impor**. Hasilnya menampilkan jumlah akun baru, akun yang diperbarui,
   dan nomor baris yang dilewati beserta alasannya.

Catatan:
- Username yang sudah ada akan **diperbarui**; bila kolom Password dikosongkan, password lama tetap dipakai.
- Akun **operator** tidak bisa dibuat atau diubah lewat impor (demi keamanan).
- Password disimpan terenkripsi. Bila diisi `guru123`/`pengawas123`, pemilik akun wajib menggantinya saat login pertama.

---

## 7. Ujian di iPhone / iPad dengan Safe Exam Browser (SEB)

Aplikasi ujian Android (SMANTRI CBT / Exambro) tidak tersedia untuk iOS. Siswa pengguna iPhone/iPad memakai
**Safe Exam Browser** (gratis di App Store, buatan ETH Zürich). SEB mengunci iPhone selama ujian dengan mode
bawaan iOS (Automatic Assessment Configuration): siswa tidak bisa pindah aplikasi, membuka notifikasi, atau
mengambil screenshot sampai password keluar dimasukkan.

**Persiapan oleh operator (sekali saja):**
1. Panel Operator → **Pantauan & token** → kotak **QR iPhone / iPad (Safe Exam Browser)**.
2. Isi **Password keluar SEB** (minimal 6 karakter), lalu **Simpan**. Password ini hanya untuk pengawas.
   Server hanya menyimpan hash-nya, bukan password asli.
3. QR SEB langsung muncul di Panel Operator, di papan token Panel Pengawas (tombol **Android | iPhone** untuk berganti QR, supaya hanya satu QR yang tampil), dan sebagai **kartu meja iPhone tersendiri**: Panel Operator → **Cetak dokumen** → **5. Kartu meja iPhone / iPad (Safe Exam Browser)**. Cetak hanya untuk meja siswa pengguna iPhone/iPad; kartu meja biasa hanya memuat QR Android, kartu login tanpa QR.
   Isinya tautan `sebs://<domain-sekolah>/seb/ujian.seb` yang membuka SEB dengan alamat ujian sekolah.

**Saat ujian (siswa iPhone/iPad):**
1. Pasang **Safe Exam Browser** dari App Store (lakukan sehari sebelum ujian).
2. Pindai **QR iPhone / iPad (SEB)** dengan kamera iPhone, lalu pilih buka di SEB.
3. Login seperti biasa (nomor peserta, kata sandi, token dari pengawas).
4. Setelah selesai, pengawas memasukkan **password keluar SEB** di iPhone siswa untuk menutup SEB.

Catatan:
- Bila alamat domain/IP server diganti di Panel Operator, QR SEB ikut berubah otomatis.
- Bila password keluar diganti, siswa yang sedang memakai pengaturan lama tetap memakai password lama
  sampai SEB dibuka ulang lewat QR baru.
- Cobalah satu iPhone sebelum hari ujian untuk memastikan SEB dan mode kunci berjalan di perangkat itu.

## 8. Aplikasi Ujian Android Sekolah (Ujian CBT SMAN 3 Buru)

Aplikasi ujian buatan sekolah sendiri. Tidak memerlukan aplikasi pendukung (tidak ada Simple Keyboard,
tidak ada pindai QR); siswa memakai keyboard bawaan HP. Izin yang diminta hanya internet.
Berjalan di Android 6.0 ke atas.

**Persiapan (operator):**
1. Bagikan file APK: `https://<domain-sekolah>/Exambro-SMAN3-Buru.apk`. Siswa memasangnya sehari sebelum ujian
   (izinkan "pasang dari sumber tidak dikenal" bila diminta).
2. Panel Operator → kartu **Aplikasi ujian Android** → isi **Kode masuk** (4–8 angka) → Simpan.
   Kode ini diberitahukan pengawas di ruang ujian, boleh diganti setiap sesi.
3. Atur **password keluar** di kartu Safe Exam Browser (bab 7). Password yang sama dipakai pengawas
   untuk menutup aplikasi Android.
4. Opsional: centang **Wajibkan aplikasi ujian**. Setelah dicentang, login ujian hanya bisa dilakukan dari
   aplikasi Android sekolah atau Safe Exam Browser (iPhone/iPad); browser biasa ditolak.
   Tanpa centang, browser biasa tetap boleh dipakai seperti sebelumnya.

**Saat ujian (siswa):**
1. Buka aplikasi **Ujian CBT SMAN 3 Buru** → masukkan kode masuk dari pengawas → **Masuk**.
2. Bila muncul "Sematkan aplikasi / App pinned", ketuk **Mengerti / Got it** agar layar terkunci di aplikasi.
3. Halaman login ujian langsung terbuka: login seperti biasa (nomor peserta, kata sandi, token).
4. Tangkapan layar diblokir. Keluar ke Home, membuka aplikasi lain, atau layar belah dicatat sebagai pelanggaran
   seperti biasa.

**Keluar aplikasi (pengawas):**
- Ketuk **Keluar** di bilah atas → masukkan password keluar → **Lanjut**. Aplikasi tertutup dan kunci layar lepas.
  Keluar oleh pengawas dicatat server sebagai "keluar oleh pengawas", bukan pelanggaran, dan sesi tidak dikunci.
- Bila internet putus, aplikasi tetap bisa ditutup dengan password yang sudah pernah dipakai di HP itu.
  Bila tetap tidak bisa: tahan tombol **Kembali + Ringkasan (Recent)** bersamaan untuk melepas sematan,
  lalu tutup aplikasi.
- Pengaturan tersembunyi (alamat server): ketuk logo di layar kode 5 kali. Biasanya tidak perlu diubah.

**PENTING – simpan cadangan kunci tanda tangan APK.**
Folder `android-exambro/keystore/` (file `ujian-release.jks` dan `keystore-password.txt`) tidak ikut git.
Salin ke flashdisk/Drive sekolah. Tanpa file ini, versi aplikasi berikutnya tidak bisa dipasang menimpa
versi lama di HP siswa (siswa harus hapus aplikasi lama dulu).
Membangun ulang APK: `powershell -ExecutionPolicy Bypass -File build-apk.ps1` (butuh Android SDK + JDK).
