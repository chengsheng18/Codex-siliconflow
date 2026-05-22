@echo off
title Codex x SiliconFlow - Setup & Launch
color 0B
chcp 65001 >nul 2>&1

:: ============================================================
::  Codex x SiliconFlow 一键安装启动脚本
::  1. 检测 Node.js，未安装则提示下载
::  2. 检测端口占用，自动释放
::  3. 启动代理（最小化窗口）
::  4. 自动打开管理面板
:: ============================================================

echo.
echo   ============================================================
echo     Codex x SiliconFlow 一键启动
echo   ============================================================
echo.

:: ========== Step 1: 检测 Node.js ==========
echo [*] Step 1/4: Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo [X] Node.js not found!
    echo.
    echo     Please install Node.js first:
    echo     https://nodejs.org/
    echo.
    echo     After installation, re-run this script.
    echo.
    pause
    exit /b 1
)
node --version >nul 2>&1
for /f "tokens=1 delims=." %%v in ('node --version 2^>nul') do set NODE_MAJOR=%%v
set NODE_MAJOR=%NODE_MAJOR:v=%
if %NODE_MAJOR% LSS 18 (
    echo [!] Node.js %NODE_MAJOR% detected. Recommended: Node.js 18+
)
echo [OK] Node.js found: 
node --version
echo.

:: ========== Step 2: 释放端口 8787（代理） ==========
echo [*] Step 2/4: Checking port 8787 (proxy)...
call :KILL_PORT 8787
echo.

:: ========== Step 3: 释放端口 8788（管理面板） ==========
echo [*] Step 3/4: Checking port 8788 (admin panel)...
call :KILL_PORT 8788
echo.

:: ========== Step 4: 启动代理 ==========
echo [*] Step 4/4: Starting proxy...
echo.

:: 以最小化方式启动代理（新窗口，最小化）
if not exist "%~dp0nim-proxy.js" (
    echo [X] nim-proxy.js not found in current directory!
    echo     Please run this script from the project folder.
    echo.
    pause
    exit /b 1
)

start "Nim-Proxy" /MIN cmd /c "node \"%dp0nim-proxy.js\" & pause"

:: 等待代理启动
echo [*] Waiting for proxy to start...
timeout /t 4 /nobreak >nul

:: 验证端口是否监听
netstat -ano | findstr ":8787 " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
    echo [!] Port 8787 not yet listening, waiting longer...
    timeout /t 3 /nobreak >nul
)

:: ========== 打开管理面板 ==========
echo.
echo [OK] Proxy started!
echo.
echo     Proxy  : http://127.0.0.1:8787/v1
echo     Admin   : http://127.0.0.1:8788/
echo.

:: 打开管理面板
start http://127.0.0.1:8788/

echo [*] Admin panel opened in browser.
echo [*] The proxy is running in a minimized window.
echo [*] To stop: close the "Nim-Proxy" window.
echo.
echo ============================================================
echo   Setup complete! You can now start Codex CLI.
echo ============================================================
echo.
pause
exit /b 0

:: ========== 子程序：杀死占用指定端口的进程 ==========
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
    echo [X] Port %PORT% still in use! (may need admin)
    netstat -ano | findstr ":%PORT% "
) else (
    echo [OK] Port %PORT% released
)
exit /b 0
