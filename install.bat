@echo off
REM Cortex1 Thunderbird Sync - Windows Installation Script
REM This script registers the native messaging host with Thunderbird

echo Installing Cortex1 Thunderbird Sync native messaging host...

REM Get the directory where this script is located
set SCRIPT_DIR=%~dp0

REM Update the path in the JSON manifest
set JSON_FILE=%SCRIPT_DIR%native_host\cortex1_tbird_sync.json
set BAT_FILE=%SCRIPT_DIR%native_host\cortex1_tbird_sync.bat

REM Create registry entry for Thunderbird native messaging
REM Thunderbird looks in HKCU\Software\Mozilla\NativeMessagingHosts\<name>
reg add "HKCU\Software\Mozilla\NativeMessagingHosts\cortex1_tbird_sync" /ve /t REG_SZ /d "%JSON_FILE%" /f

if %ERRORLEVEL% EQU 0 (
    echo.
    echo Installation successful!
    echo.
    echo Next steps:
    echo   1. Open Thunderbird
    echo   2. Go to Add-ons Manager (Tools ^> Add-ons and Themes)
    echo   3. Click the gear icon ^> Install Add-on From File
    echo   4. Select: %SCRIPT_DIR%cortex1-tbird-sync.xpi
    echo.
    echo Or for development:
    echo   1. Go to Add-ons Manager
    echo   2. Click the gear icon ^> Debug Add-ons
    echo   3. Click "Load Temporary Add-on"
    echo   4. Select: %SCRIPT_DIR%manifest.json
) else (
    echo.
    echo Installation failed. Please run as administrator.
)

pause
