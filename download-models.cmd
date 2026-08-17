@echo off
REM Pre-download all AI models into the `model-cache` volume, in the foreground.
REM One-time cost (~3.5 GB); later starts load from disk. Safe to re-run/resume.
cd /d "%~dp0"

docker compose stop ai-engine
docker compose run --rm ai-engine python download_model.py
docker compose up -d ai-engine
