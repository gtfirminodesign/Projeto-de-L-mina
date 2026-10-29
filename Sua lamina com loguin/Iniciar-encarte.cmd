@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  set "ENCARTE_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
) else (
  set "ENCARTE_NODE=node"
)
if not "%ENCARTE_NODE%"=="node" if not exist "%ENCARTE_NODE%" (
  echo O Node.js nao foi encontrado. Instale o Node.js LTS em https://nodejs.org e tente novamente.
  pause
  exit /b 1
)
"%ENCARTE_NODE%" "%~dp0server.cjs" --open
if errorlevel 1 pause
endlocal
