#!/bin/bash
set -e

# FIXAM Docker start helper.
#
# Checks that the ports the stack publishes are free before bringing it up, so a
# conflict -- most commonly a local PostgreSQL already on 5432 -- fails here with
# a clear, actionable message instead of Docker's "dependency postgres failed to
# start".
#
# Usage: ./start.sh            (Linux / macOS / Git Bash / WSL)
#        start.cmd             (Windows)

cd "$(dirname "$0")"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'

# "port|env|description" -- same defaults and env overrides as docker-compose.yml
PORTS=(
  "${DB_PORT:-5432}|DB_PORT|PostgreSQL"
  "${NOMINATIM_PORT:-8080}|NOMINATIM_PORT|Geocoding (Nominatim)"
  "${AI_ENGINE_PORT:-8000}|AI_ENGINE_PORT|AI engine"
  "${BACKEND_PORT:-5000}|BACKEND_PORT|Backend API"
  "${SIMULATOR_PORT:-4001}|SIMULATOR_PORT|WhatsApp simulator"
  "${FRONTEND_PORT:-80}|FRONTEND_PORT|Frontend (nginx)"
)

# Returns 0 when the port is already in use.
port_in_use() {
  local port=$1
  # bash's built-in /dev/tcp probe -- no external tool needed.
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    exec 3>&- 3<&-
    return 0
  fi
  # Fall back to netcat where /dev/tcp is unavailable.
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1 && return 0
  fi
  return 1
}

echo -e "${YELLOW}Checking ports before starting FIXAM...${NC}\n"
FAIL=0
for entry in "${PORTS[@]}"; do
  port="${entry%%|*}"; rest="${entry#*|}"; env="${rest%%|*}"; name="${rest#*|}"
  if port_in_use "$port"; then
    echo -e "${RED}✗ Port $port ($name) is already in use.${NC}"
    echo -e "    Stop the other service, or set ${YELLOW}$env${NC} to a free port in .env and retry.\n"
    FAIL=1
  else
    echo -e "${GREEN}✓ Port $port free${NC} ($name)"
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo -e "${RED}Aborting: free the ports above before starting.${NC}"
  exit 1
fi

echo -e "\n${GREEN}All ports free. Starting FIXAM...${NC}"
exec docker compose --profile simulator up -d --build
