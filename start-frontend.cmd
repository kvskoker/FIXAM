@echo off
REM Windows companion to start-frontend.sh.
REM
REM Both the directory and the port matter. `serve frontend` from anywhere but
REM the repo root serves nothing and every path 404s, and the frontend JS
REM (js/map.js, js/dashboard.js, js/admin_common.js, js/maintenance.js) reaches
REM the API on :5000 only when it is itself served from port 3000 -- on any
REM other port it falls back to a same-origin /api that does not exist.
cd /d "%~dp0"
serve frontend -p 3000
