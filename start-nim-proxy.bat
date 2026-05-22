@echo off
title Nim-Proxy for Codex v3.7
color 0A
chcp 65001 >nul 2>&1

echo.
echo ============================================
echo   Codex x SiliconFlow Protocol Converter v3.7
echo   Responses API ---(proxy)---> Chat Completions
echo   + Web Admin Panel (http://127.0.0.1:8787/)
echo ============================================
echo.

:: Step1: Check Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [X] Node.js not found!
    echo     Download: https://nodejs.org/
    pause & exit /b 1
)
echo [OK] Node.js found:
node --version

:: Step2: Check and free port 8787 (proxy)
echo.
echo [*] Checking port 8787 (proxy)...
call :KILL_PORT 8787

:: Step3: Check and free port 8788 (admin panel)
echo [*] Checking port 8788 (admin panel)...
call :KILL_PORT 8788

:: Step4: Auto-open admin panel in browser (3s after proxy starts)
start "" /min timeout /t 3 /nobreak >nul && start http://127.0.0.1:8788/

:: Step5: Start proxy
echo.
echo --------------------------------------------
echo   Starting Nim-Proxy v3.7
echo --------------------------------------------
echo     Proxy  : http://127.0.0.1:8787/v1
echo     Admin  : http://127.0.0.1:8787/
echo     (Admin panel is served on the same port as proxy)
echo     Target : https://api.siliconflow.cn/v1
echo.
echo [*] Admin panel opening in browser...
echo [*] Keep this window open, then start Codex CLI
echo [*] Press Ctrl+C to stop proxy
echo --------------------------------------------
echo.

node "%~dp0nim-proxy.js"

echo.
echo [*] Proxy stopped. Press any key to exit...
pause >nul
exit /b 0


:: ========== Subroutine: Kill process on port ==========
:KILL_PORT
set PORT=%1
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
    echo [OK] Port %PORT% is free
    exit /b 0
)

echo [!] Port %PORT% is in use. Killing old process...

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    echo     Killing PID %%a...
    taskkill /PID %%a /F >nul 2>&1
)

timeout /t 2 /nobreak >nul

netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo [X] Port %PORT% still in use! (try run as admin)
    netstat -ano | findstr ":%PORT% "
    pause & exit /b 1
) else (
    echo [OK] Port %PORT% released
)
exit /b 0
