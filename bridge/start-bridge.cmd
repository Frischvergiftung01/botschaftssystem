@echo off
rem Startet die Bridge auf dem Medien-PC. Doppelklick genuegt.
rem Der Ordner darf liegen, wo er will - das Skript arbeitet immer in seinem
rem eigenen Verzeichnis (%~dp0), also auch auf dem Desktop.
chcp 65001 >nul
title Botschaften-Bridge  -  Koenigsbau
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js ist auf diesem Rechner nicht installiert oder nicht im Pfad.
  echo   Ohne Node laeuft die Bridge nicht: https://nodejs.org  ^(LTS-Fassung^)
  echo.
  pause
  exit /b 1
)

if not exist "einstellungen.json" (
  echo   Keine einstellungen.json gefunden - lege sie aus der Vorlage an.
  copy "einstellungen.beispiel.json" "einstellungen.json" >nul
)

echo.
echo   ============================================================
echo    Botschaften-Bridge
echo.
echo    Dieses Fenster offen lassen - es ist die Bridge.
echo    Mitgeschrieben wird in den Ordner logs\.
echo    Beenden: Strg+C, dann J.
echo   ============================================================
echo.

:start
node bridge.js
echo.
echo   Bridge beendet ^(%date% %time%^). Neustart in 5 Sekunden ...
echo   Soll sie AUS bleiben: dieses Fenster jetzt schliessen.
timeout /t 5 >nul
goto start
