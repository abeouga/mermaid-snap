@echo off
chcp 65001 >nul
rem Mermaid Snap ワークベンチを起動して、ブラウザーで開く。
rem 隣の kusakari_document（または kusakari-usecase）を使う。別の場所なら、このファイルにフォルダーをドラッグするか、引数で渡す。
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。https://nodejs.org/ja から LTS 版を入れてから、もう一度実行してください。
  pause
  exit /b 1
)
node serve.mjs --open %*
pause
