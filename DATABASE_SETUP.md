# Database Setup Guide

## Quick Setup Steps

### 1. Create the Database

Open a terminal and run:

```bash
# Login to PostgreSQL (you'll be prompted for password)
psql -U postgres

# Once logged in, create the database
CREATE DATABASE fixam_db;

# Exit psql
\q
```

### 2. Update .env File

Make sure your `backend/.env` file has the correct database credentials:

```env
DB_USER=postgres
DB_HOST=localhost
DB_NAME=fixam_db
DB_PASSWORD=your_actual_password_here
DB_PORT=5432
```

### 3. Run Database Setup Scripts

From the `backend` directory, run:

```bash
# Initialize the database schema (creates tables)
npm run db:init

# Insert mock data
npm run db:seed

# Or run both at once
npm run db:setup
```

### 4. Restart the Backend Server

After the database is set up, restart the backend:

```bash
# Stop the current server (Ctrl+C)
# Then start it again
npm start
```

## Alternative: Manual SQL Execution

If the npm scripts don't work, you can run the SQL files directly:

```bash
# Initialize schema
psql -U postgres -d fixam_db -f db/init_db.sql

# Insert mock data
psql -U postgres -d fixam_db -f db/mock_data.sql
```

## Verify Database Setup

To verify the database is set up correctly:

```bash
psql -U postgres -d fixam_db -c "SELECT COUNT(*) FROM issues;"
```

This should return the count of mock issues (should be 6).
