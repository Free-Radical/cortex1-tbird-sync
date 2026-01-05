@echo off
REM Build cortex1-tbird-sync.xpi

echo Building cortex1-tbird-sync.xpi...

set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"

REM Remove old xpi
if exist cortex1-tbird-sync.xpi del cortex1-tbird-sync.xpi

REM Create xpi (zip with different extension)
powershell -Command "Compress-Archive -Path manifest.json, sent_folder_discovery.js, background.js, icons -DestinationPath cortex1-tbird-sync.zip -Force"
ren cortex1-tbird-sync.zip cortex1-tbird-sync.xpi

echo.
echo Built: %SCRIPT_DIR%cortex1-tbird-sync.xpi
echo.
echo To install in Thunderbird:
echo   1. Open Thunderbird
echo   2. Go to Add-ons Manager (Tools ^> Add-ons and Themes)
echo   3. Click gear icon ^> Install Add-on From File
echo   4. Select cortex1-tbird-sync.xpi
