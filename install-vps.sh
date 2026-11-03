#!/usr/bin/env bash
set -e

echo "=========================================================="
echo "  INSTALASI OTOMATIS SERVER CBT - SMA NEGERI 3 BURU (VPS) "
echo "=========================================================="

# 1. Cek & Install Node.js 22 + Build Tools jika belum ada
if ! command -v node >/dev/null 2>&1; then
  echo "-> Menginstal Node.js 22 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

sudo apt-get update -y
sudo apt-get install -y build-essential python3

# 2. Install dependensi aplikasi CBT
echo "-> Menginstal paket aplikasi CBT..."
npm install --omit=dev

# 3. Install PM2 agar server CBT selalu menyala 24 jam
if ! command -v pm2 >/dev/null 2>&1; then
  echo "-> Menginstal PM2 Process Manager..."
  sudo npm install -g pm2
fi

# 4. Buka Port 8080 di Firewall VPS (jika memakai UFW)
if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow 8080/tcp || true
fi

# 5. Jalankan Server CBT dengan PM2
pm2 delete cbt-sman3-buru >/dev/null 2>&1 || true
pm2 start ecosystem.config.js
pm2 save

PUBLIC_IP=$(curl -s https://ifconfig.me || hostname -I | awk '{print $1}')
echo "=========================================================="
echo "  SELESAI! SERVER CBT SMA NEGERI 3 BURU SUDAH ONLINE!     "
echo "=========================================================="
echo "-> Panel Operator : http://${PUBLIC_IP}:8080/operator.html"
echo "-> Panel Guru     : http://${PUBLIC_IP}:8080/guru.html"
echo "-> Panel Pengawas : http://${PUBLIC_IP}:8080/pengawas.html"
echo "-> Ujian Exambro  : http://${PUBLIC_IP}:8080/ujian.html"
echo "=========================================================="
