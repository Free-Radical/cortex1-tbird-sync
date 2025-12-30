@echo off
REM Cortex1 Thunderbird Sync - Windows Uninstallation Script

echo Uninstalling Cortex1 Thunderbird Sync native messaging host...

reg delete "HKCU\Software\Mozilla\NativeMessagingHosts\cortex1_tbird_sync" /f

if %ERRORLEVEL% EQU 0 (
    echo Uninstallation successful.
) else (
    echo Registry entry not found or already removed.
)

pause
