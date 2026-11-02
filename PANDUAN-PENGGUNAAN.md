# Panduan Penggunaan Sistem CBT Lokal & Android Exambro — SMA Negeri 3 Buru

Sistem ini dirancang khusus untuk pelaksanaan ujian berbasis komputer & HP Android di **SMA Negeri 3 Buru** menggunakan jaringan Wi-Fi/LAN lokal (100% *offline*, siswa tidak membutuhkan kuota internet).

---

## 1. Cara Menyalakan Server CBT di Komputer/Laptop Operator
1. Hubungkan komputer/laptop server ke Router Wi-Fi sekolah.
2. Klik 2x file **`Jalankan-Server-CBT.bat`** (atau jalankan `npm start` di terminal).
3. Jendela hitam server akan menampilkan alamat IP Lokal (contoh: `http://192.168.1.100:8080`).
4. Browser di komputer server akan otomatis terbuka ke halaman utama `http://localhost:8080`.

---

## 2. Daftar Akun Login Bawaan (Siap Pakai)

| Panel / Peran | Alamat Akses | Username | Password |
|---|---|---|---|
| **1. Panel Operator / Admin** | `/operator.html` | `operator` | `admin123` |
| **2. Panel Guru Mata Pelajaran** | `/guru.html` | `guru` | `guru123` |
| **3. Panel Pengawas Ruangan** | `/pengawas.html` | `pengawas` | `pengawas123` |
| **4. Simulasi Ujian Siswa (Exambro)** | `/ujian.html` | `26-03-001` | `BURU01` |

*(Token ujian awal bawaan: **`K7P9M`** — dapat diacak kapan saja oleh Operator).*

---

## 3. Panduan Tugas Per Panel

### A. Panel Operator (`/operator.html`)
- **Kelola Siswa & Jadwal:** Tambah data siswa, kelas, ruang ujian, nomor meja, dan aktifkan jadwal ujian.
- **Acak Token Ujian:** Klik tombol **🔄 Acak Token** setiap pergantian sesi ujian.
- **Pusat Cetak 4 Dokumen Administrasi (Menu "🖨️ Cetak 4 Dokumen Ujian"):**
  1. **Daftar Hadir Peserta Ujian** (otomatis ber-Kop SMA Negeri 3 Buru & kolom tanda tangan zig-zag).
  2. **Kartu Peserta Ujian** (untuk dibawa siswa).
  3. **Kartu Login CBT** (berisi Username, Password, dan alamat IP Server lokal).
  4. **Kartu Meja Ujian** (ukuran besar untuk ditempel di meja kelas).

### B. Panel Guru Mata Pelajaran (`/guru.html`)
- **Import Soal Sekaligus dari Microsoft Word (`.docx`):**
  1. Klik **📥 Unduh Template Word (.docx)** sebagai contoh format.
  2. Ketik soal Pilihan Ganda di bawah penanda `[PG]` lengkap dengan `KUNCI: A/B/C/D/E`.
  3. Ketik soal Esai di bawah penanda `[ESAI]` (naskah soal esai akan tampil di HP siswa dengan instruksi dijawab pada lembar jawaban kertas).
  4. Upload file `.docx` tersebut — seluruh soal otomatis masuk ke Bank Soal.
- **Rekap Nilai Pilihan Ganda (Excel):**
  - Nilai PG **tidak ditampilkan di HP siswa** saat selesai ujian.
  - Guru dapat melihat skor PG (skala 0–100) di tab **Rekap Nilai PG** dan mengunduhnya ke file **Excel (`.xlsx`)**.

### C. Panel Pengawas Ruangan (`/pengawas.html`)
- Pengawas membuka alamat IP Server (`http://IP-SERVER:8080/pengawas.html`) dari HP Pengawas di dalam kelas.
- Jika ada siswa yang mencoba keluar dari aplikasi Exambro (tekan tombol Home/Recent Apps/pindah layar), layar HP siswa otomatis **Terkunci Merah** dan di HP Pengawas muncul **Peringatan Merah** beserta tombol **🔓 Buka Kunci Sekarang**.
- Jika HP siswa mati/habis baterai dan harus pindah ke HP cadangan, Pengawas cukup menekan tombol **🔄 Reset Login**, dan seluruh jawaban siswa sebelumnya tetap tersimpan aman.

---

## 4. Cara Build APK Android Exambro (`android-exambro/`)
Folder `android-exambro/` berisi proyek lengkap Android Studio (Kotlin):
1. Buka folder `android-exambro` menggunakan **Android Studio**.
2. Pilih menu **Build > Build Bundle(s) / APK(s) > Build APK(s)**.
3. File `app-debug.apk` siap dibagikan ke HP Android siswa SMA Negeri 3 Buru.
4. Fitur keamanan yang aktif di dalam APK:
   - **`startLockTask()` (Screen Pinning):** Mengunci layar HP agar tidak bisa keluar aplikasi.
   - **`FLAG_SECURE`:** Memblokir *screenshot* dan perekaman layar (*screen recording*).
   - **`resizeableActivity="false"`:** Memblokir *Split-Screen* (Layar Belah) dan *Floating Window*.
   - **Deteksi Pindah Aplikasi:** Otomatis mengirim laporan pelanggaran ke server dan mengunci layar siswa menjadi merah sampai dibuka oleh Pengawas Ruangan.
