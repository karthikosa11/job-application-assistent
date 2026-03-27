@echo off
echo Starting Job Application Assistant Server...
echo.

REM Check if .env exists
if not exist ".env" (
    echo [ERROR] .env file not found!
    echo Copy .env.example to .env and fill in your API keys.
    pause
    exit /b 1
)

REM Install dependencies if needed
echo Checking dependencies...
pip install -r requirements.txt -q

echo.
echo Server starting on http://127.0.0.1:8765
echo Load the extension: Chrome > Extensions > Load unpacked > select extension/ folder
echo.

REM Launch server in its own persistent window so it survives this script
start "Job Assistant Server" cmd /k "cd /d "%~dp0tools" && python server.py"
echo Server launched in a new window. Keep that window open while using the extension.
pause
