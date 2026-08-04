@echo off
cd /d "%~dp0"
echo ============================================
echo  Enviando alteracoes para o GitHub...
echo ============================================
echo.
git add .
git commit -m "cleanup: remove debug log de vAI"
git push origin main
echo.
echo ============================================
echo  PRONTO! Agora rode os comandos na VPS.
echo ============================================
pause
