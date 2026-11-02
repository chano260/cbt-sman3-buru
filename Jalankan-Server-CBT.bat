@echo off
title SERVER CBT LOKAL - SMA NEGERI 3 BURU
cd /d "%~dp0"
echo Menyalakan Server CBT Lokal SMA Negeri 3 Buru...
start http://localhost:8080
node server.js
pause
