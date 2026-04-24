@echo off
title GitHub Sync - Opsin
cd /d "%~dp0"

echo ==============================
echo  GitHub Sync - Opsin
echo ==============================
echo.

echo [1/3] Staging and committing local changes...
git add .
git diff --cached --quiet
if %errorlevel% neq 0 (
    git commit -m "sync: %date% %time%"
)

echo.
echo [2/3] Pulling latest changes from GitHub...
git pull origin main --no-rebase
if %errorlevel% neq 0 (
    echo ERROR: Pull failed. There may be a conflict requiring manual resolution.
    pause
    exit /b 1
)

echo.
echo [3/3] Pushing to GitHub...
git push origin main
if %errorlevel% neq 0 (
    echo ERROR: Push failed.
    pause
    exit /b 1
)

echo.
echo SUCCESS: Synced with GitHub Pages!
echo.
pause