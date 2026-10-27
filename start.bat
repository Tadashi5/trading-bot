@echo off
cd /d C:\Users\djdav\trading-bot
start "Trading Bot Server" cmd /k node server.js
timeout /t 2 /nobreak >nul
start "ngrok Tunnel" cmd /k ngrok http 3000
