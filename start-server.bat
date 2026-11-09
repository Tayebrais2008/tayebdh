@echo off
cd /d "%~dp0"

set "SERVER_STATUS="
for /f "delims=" %%A in ('curl.exe -fsS "http://127.0.0.1:3030/api/status" 2^>nul') do set "SERVER_STATUS=%%A"
if not "%SERVER_STATUS%"=="" (
  echo A server is already running on port 3030.
  echo %SERVER_STATUS% | findstr /C:"deviceOwnership" >nul
  if errorlevel 1 (
    echo This server needs an update for the private patient request list.
    echo Close its black window with Ctrl+C, then run this file again.
  ) else (
    echo Patient requests and visit alerts are ready.
    echo Open this address in your browser: http://127.0.0.1:3030
  )
  pause
  exit /b
)

echo Starting the appointment server. Keep this window open.
echo Open http://127.0.0.1:3030 on this computer.
echo For phones on the same Wi-Fi, use the network address shown below.
echo Doctor access codes appear next to the doctors' names.
echo.
node server.js
pause
