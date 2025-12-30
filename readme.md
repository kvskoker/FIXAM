# FIXAM - Facilitating Issue eXchange for Accountable Municipalities

A civic engagement platform that enables citizens to report municipal issues via WhatsApp and visualize them on an interactive map.

## Project Structure

```
Codebase/
├── frontend/              # Web interface
│   ├── css/
│   │   └── style.css     # Global styles
│   ├── js/
│   │   ├── map.js        # Map logic
│   │   └── dashboard.js  # Dashboard logic
│   ├── index.html        # Civic Map (Public View)
│   └── dashboard.html    # Government Dashboard
│
├── backend/              # Node.js API server
│   ├── db/
│   │   ├── index.js      # Database connection
│   │   ├── init_db.sql   # Schema
│   │   └── mock_data.sql # Sample data
│   ├── routes/
│   │   └── api.js        # API endpoints
│   ├── scripts/
│   │   └── setupDb.js    # Database setup script
│   ├── services/
│   │   ├── aiService.js      # Gemini AI integration
│   │   └── whatsappService.js # WhatsApp API integration
│   ├── .env              # Environment variables
│   ├── server.js         # Express server
│   └── package.json
│
└── readme.md             # Original project specification
```

## Features

### 1. Civic Map (Public Interface)
- Interactive map showing reported issues
- Color-coded markers (Red=Critical, Yellow=In Progress, Green=Fixed)
- Issue filtering and voting system
- Real-time updates from database

### 2. Government Dashboard
- Statistical overview of reports
- Category distribution charts
- Priority alerts for critical issues
- Sentiment analysis (planned)

### 3. WhatsApp Integration
- Report issues via conversational interface
- AI-powered categorization and summarization
- Location sharing support
- Automated ticket generation

## Setup Instructions

### Prerequisites
- Node.js (v16 or higher)
- PostgreSQL (v12 or higher)
- Python 3.8+ (for local AI service)
- FFmpeg (for audio processing in AI service)
- WhatsApp Business API access

### Local AI Service Setup

FIXAM includes a local AI service that provides:
- **Image Safety Classification** (NudeNet): Filters inappropriate images
- **Audio Transcription** (Whisper): Converts voice notes to text
- **Text Classification** (EmbeddingGemma): Categorizes issues

The AI service runs independently on port 8000 and is called by the backend for processing media and text.

```bash
# Navigate to AI service directory
cd backend/ai_service

# Install dependencies
pip install -r requirements.txt

# Start the service
python main.py
```

The service will be available at `http://localhost:8000`

**Endpoints:**
- `POST /classify-image`: Image safety check (returns `safe` or `nude`)
- `POST /transcribe`: Audio transcription (returns `{"text": "transcribed text", "filename": "..."}`)
- `POST /classify`: Text classification with custom labels
- `POST /analyze`: Generate text embeddings

For production deployment on Linux servers, see `backend/ai_service/README.md` for systemd setup instructions.

### 1. Database Setup

First, create the PostgreSQL database:

```bash
# Login to PostgreSQL
psql -U postgres

# Create database
CREATE DATABASE fixam_db;

# Exit psql
\q
```

### 2. Backend Setup

```bash
# Navigate to backend directory
cd backend

# Install dependencies
npm install

# Configure environment variables
# Edit .env file with your credentials:
# - Database credentials
# - WhatsApp API credentials (optional)
# - Gemini API key (optional)

# Initialize database schema
npm run db:init

# Seed with mock data
npm run db:seed

# Or run both at once
npm run db:setup

# Start the backend server
npm start
```

The backend will run on `http://localhost:5000`

### 3. Frontend Setup

```bash
# Navigate to the root directory
cd ..

# Serve the frontend (using any static server)
npx serve frontend

# Or use Python
python -m http.server 3000 --directory frontend
```

The frontend will be available at `http://localhost:3000`

## Environment Variables

Create a `.env` file in the `backend/` directory:

```env
PORT=5000

# WhatsApp API Configuration
WHATSAPP_VERIFY_TOKEN=my_secure_verify_token
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_ACCESS_TOKEN=your_access_token

# Gemini AI Configuration
GEMINI_API_KEY=your_gemini_api_key

# Database Configuration (PostgreSQL)
DB_USER=postgres
DB_HOST=localhost
DB_NAME=fixam_db
DB_PASSWORD=your_password
DB_PORT=5432
```

## API Endpoints

### GET /api/issues
Fetch all reported issues from the database.

**Response:**
```json
[
  {
    "id": 1,
    "title": "Burst Pipe on Jomo Kenyatta Road",
    "category": "Water",
    "status": "critical",
    "lat": 8.4845,
    "lng": -13.2345,
    "description": "Large water pipe burst...",
    "image_url": "https://...",
    "votes": 156,
    "created_at": "2023-10-27T10:30:00"
  }
]
```

### GET /api/webhook
WhatsApp webhook verification endpoint.

### POST /api/webhook
Handle incoming WhatsApp messages.

## WhatsApp Workflow

1. **User sends "Hi"** → Bot asks for issue description
2. **User describes issue** → AI analyzes and categorizes → Bot asks for location
3. **User shares location** → Issue saved to database → Ticket ID returned

## Database Schema

### Issues Table
```sql
CREATE TABLE issues (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    category VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'critical',
    lat DECIMAL(10, 6) NOT NULL,
    lng DECIMAL(10, 6) NOT NULL,
    description TEXT,
    image_url TEXT,
    votes INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Development Scripts

```bash
# Backend
npm start              # Start server
npm run dev           # Start with nodemon (auto-reload)
npm run db:init       # Initialize database schema
npm run db:seed       # Insert mock data
npm run db:setup      # Init + seed

# Frontend
npx serve frontend    # Serve static files
```

## Testing Without External APIs

The application includes mock modes for both WhatsApp and Gemini AI services:

- **WhatsApp Mock**: If credentials are not set, messages are logged to console
- **Gemini Mock**: If API key is not set, returns basic text analysis

This allows you to test the core functionality without external API dependencies.

## Technology Stack

- **Frontend**: HTML, CSS, JavaScript, Leaflet.js, Chart.js
- **Backend**: Node.js, Express
- **Database**: PostgreSQL with PostGIS (for future geospatial queries)
- **Maps**: OpenStreetMap, Nominatim API
- **Messaging**: WhatsApp Business API (Meta Graph API)
- **AI**: 
  - Google Gemini API (issue categorization)
  - Local AI Service (FastAPI):
    - NudeNet (image safety classification)
    - Whisper (audio transcription)
    - EmbeddingGemma (text classification)

## Enhancements

- [x] Image upload support via WhatsApp ✅
- [x] Voice note transcription (Whisper AI) ✅
- [x] Real-time updates (WebSockets) ✅
- [x] Duplicate detection (100m radius check) ✅
- [x] PostGIS integration for advanced geospatial queries ✅
- [x] Sentiment analysis on comments ✅
- [x] Heatmap visualization ✅

## Contributing

This is an open-source project. Contributions are welcome!

## License

ISC