@echo off
chcp 65001 >nul
cd /d "%~dp0"
title MyTemple Knowledge 一键打包

echo 正在执行打包，请稍候...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-installer.ps1"
set "BUILD_EXIT_CODE=%ERRORLEVEL%"

if not "%BUILD_EXIT_CODE%"=="0" (
  echo.
  echo 打包失败，请根据上方提示修复后重试。
) else (
  echo.
  echo 打包完成，安装包位于 dist 目录。
)

echo.
pause
exit /b %BUILD_EXIT_CODE%
