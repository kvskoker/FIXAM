#!/bin/bash
set -e

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting FIXAM installation...${NC}"

# 1. Check for .env file
if [ ! -f backend/.env ]; then
    echo -e "${RED}Error: backend/.env file not found!${NC}"
    echo "Please create the backend/.env file with necessary credentials before running this script."
    exit 1
fi

# Load environment variables
echo "Loading environment variables..."
export $(grep -v '^#' backend/.env | xargs)

# 2. Check/Install PostgreSQL
echo -e "${GREEN}Checking PostgreSQL...${NC}"
if command -v psql >/dev/null 2>&1; then
    PG_VERSION=$(psql --version | awk '{print $3}' | cut -d. -f1)
    if [ "$PG_VERSION" -lt 17 ]; then
        echo -e "${RED}Error: PostgreSQL version $PG_VERSION is installed, but version 17 or higher is required.${NC}"
        exit 1
    else
        echo "PostgreSQL version $PG_VERSION is installed."
    fi
else
    echo "PostgreSQL not found. Installing PostgreSQL 17..."
    sudo apt-get update
    sudo apt-get install -y postgresql-common
    # Install the repository automation script if not present
    if [ ! -f /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh ]; then
         sudo apt-get install -y postgresql-common
    fi
    # Run the script to add the repo (non-interactive)
    sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
    sudo apt-get update
    sudo apt-get install -y postgresql-17
    
    # Start and enable service
    sudo systemctl start postgresql
    sudo systemctl enable postgresql
fi

# 3. Check/Install Node.js
echo -e "${GREEN}Checking Node.js...${NC}"
if command -v node >/dev/null 2>&1; then
    NODE_VERSION=$(node -v | cut -d. -f1 | sed 's/v//')
    if [ "$NODE_VERSION" -lt 22 ]; then
        echo -e "${RED}Error: Node.js version $NODE_VERSION is installed, but version 22 or higher is required.${NC}"
        exit 1
    else
        echo "Node.js version $NODE_VERSION is installed."
    fi
else
    echo "Node.js not found. Installing Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# 4. Install Global Tools (PM2)
echo -e "${GREEN}Installing PM2...${NC}"
sudo npm install -g pm2

# 5. Database User Configuration
echo -e "${GREEN}Configuring Database User...${NC}"
# Try to connect with provided credentials
if PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -U $DB_USER -d postgres -c '\q' 2>/dev/null; then
    echo "Database user '$DB_USER' credentials work."
else
    echo "Could not connect with '$DB_USER'. Attempting to create/configure user..."
    # This requires sudo access to postgres user on the server
    if [ "$DB_USER" = "postgres" ]; then
        sudo -u postgres psql -c "ALTER USER postgres PASSWORD '$DB_PASSWORD';"
    else
        # Check if user exists
        if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
             sudo -u postgres psql -c "ALTER USER \"$DB_USER\" WITH PASSWORD '$DB_PASSWORD';"
        else
             sudo -u postgres psql -c "CREATE USER \"$DB_USER\" WITH PASSWORD '$DB_PASSWORD' CREATEDB;"
        fi
    fi
    echo "User configured."
fi

# 6. Backend Setup
echo -e "${GREEN}Setting up Backend...${NC}"
cd backend
npm install

# Create Database
echo "Creating database '$DB_NAME'..."
export PGPASSWORD=$DB_PASSWORD
if psql -h $DB_HOST -U $DB_USER -d postgres -lqt | cut -d \| -f 1 | grep -qw $DB_NAME; then
    echo "Database '$DB_NAME' already exists."
else
    createdb -h $DB_HOST -U $DB_USER -p $DB_PORT $DB_NAME
    echo "Database '$DB_NAME' created."
fi

# Run DB Init
echo "Initializing database tables..."
npm run db:init

cd ..

# 7. Frontend Setup
echo -e "${GREEN}Setting up Frontend...${NC}"
cd frontend
if [ -f package.json ]; then
    echo "Installing frontend packages..."
    npm install
else
    echo "No package.json found in frontend. Skipping npm install."
fi
cd ..

# 8. Create Services
echo -e "${GREEN}Creating PM2 Services...${NC}"
# Backend Service
pm2 delete fixam-backend 2>/dev/null || true
pm2 start backend/server.js --name "fixam-backend"

# Install serve globally
sudo npm install -g serve

# Make frontend start script executable
chmod +x start-frontend.sh

# Frontend Service
pm2 delete fixam-frontend 2>/dev/null || true
# Start serve using PM2 with the startup script
pm2 start ./start-frontend.sh --name "fixam-frontend"

# Save PM2 list
pm2 save

# Setup PM2 startup hook
echo "Setting up PM2 startup..."
# This command generates and executes the startup script
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u $USER --hp $HOME

echo -e "${GREEN}Installation complete!${NC}"
echo "Backend is running."
echo "Frontend is running on port 3000."
echo "Use 'pm2 status' to check service status."
echo "Use 'pm2 logs' to view logs."
