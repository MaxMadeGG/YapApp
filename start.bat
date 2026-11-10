@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
if not exist node_modules\electron\dist\electron.exe node node_modules\electron\install.js
call npm start
