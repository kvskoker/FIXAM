# FIXAM - Facilitating Issue eXchange for Accountable Municipalities

**Live Demo:** <a href="https://fixam.maxcit.com/" target="_blank">https://fixam.maxcit.com/</a>

A comprehensive civic engagement ecosystem that empowers citizens to report municipal issues via WhatsApp and enables authorities to manage, analyze, and resolve them efficiently through advanced AI and automation.

## Project Structure

```
Codebase/
├── frontend/              # Web interface
│   ├── admin/             # Admin Portal
│   │   ├── issues.html    # Issue Management & Timeline
│   │   ├── overview.html  # Analytics & Insights Dashboard
│   │   └── users.html     # User & Group Management
│   ├── css/
│   │   └── style.css      # Design System
│   ├── js/                # Application Logic
│   │   ├── map.js         # Interactive Civic Map
│   │   └── ...
│   ├── index.html         # Public Civic Map
│   └── dashboard.html     # Public Statistics
│
├── backend/               # Node.js API Core
│   ├── db/                # PostgreSQL Schema & Migrations
│   ├── services/
│   │   ├── aiService.js   # AI Integration (Classification, Summarization)
│   │   ├── whatsappHandler.js # Conversational Logic & State Machine
│   │   └── ...
│   ├── ai_service/        # Local Python AI Microservices
│   │   ├── main.py        # FastAPI Entrypoint
│   │   └── ...            # Whisper, NudeNet, Embeddings
│   └── ...
```

## Key Features

### 1. 🤖 Intelligent WhatsApp Bot
The primary reporting channel, designed for accessibility and ease of use.
- **Conversational Reporting**: Guided flow for citizens to report issues naturally.
- **AI-Powered Analysis**: instant categorization, summarization, and urgency detection using LLMs.
- **Voice-to-Text**: Native support for **Voice Notes** (Krio/English), transcribed locally via Whisper.
- **Media Support**: Users can send photos or videos as evidence.
- **Safety First**: Automated content moderation filters unsafe images (e.g., nudity) using local NudeNet.
- **Location Intelligence**: Handles GPS location sharing and text-based addresses with reverse geocoding.
- **Duplicate Detection**: Smart detection of similar issues within a 100m radius to prevent spam and redundancy.

### 2. 🌍 Public Civic Map & Dashboard
Transparent real-time visualization for the community.
- **Interactive Map**: Visualizes reported issues with color-coded markers (Critical, In Progress, Resolved).
- **Vote & Support**: Citizens can upvote issues to signal priority to authorities.
- **Search & Filter**: Find issues by category, ID, or status.
- **Statistics**: Public view of resolution rates and key metrics.

### 3. 🛡️ Admin Command Center
A powerful suite for government and operational teams.
- **Dashboard & Analytics**: High-level overview of reporting trends, resolution rates, and critical hotspots.
- **Issue Management**: 
  - Detailed view of every report with geolocation, evidence, and AI analysis.
  - **Activity Timeline**: Full audit trail showing *who* reported it, *when*, and every status change.
  - **Status Workflow**: Manage lifecycle (Acknowledged → In Progress → Fixed) with mandatory resolution notes.
- **Duplicate Management**: Advanced tools to link/unlink reports, aggregating votes and keeping the map clean.
- **User & Group Management**: 
  - Manage personnel (Admins, Operations, Users).
  - Create Departments/Groups (e.g., "Roads Authority", "Water Board") to organize operational teams.
- **Role-Based Access**: Granular permissions for Admins vs. Operational staff.
- **Persistent Filtering**: Shareable URLs with pre-applied filters for efficient collaboration.

### 4. ⚡ Automatic Operational Alerts
Bridging the gap between report and resolution.
- **Smart Routing**: Issues are automatically forwarded to the relevant department based on category (e.g., "Electricity" → Energy Authorities/EDSA).
- **Instant Notifications**: Operational team members receive immediate WhatsApp alerts containing:
  - 🚨 Issue Title & ID
  - 📍 Precise Location/Address
  - 🔗 Direct Link to Web Portal
- **Broadcast System**: Ensures entire teams are synchronized on critical infrastructure failures.

### 5. 🧠 Local AI Engine
Privacy-focused, offline-capable AI services running alongside the platform.
- **Text Classification**: Automatically tags issues (e.g., "Pothole" → "Road Infrastructure").
- **Transcription**: Voice-to-text for inclusive reporting.
- **Content Safety**: On-device image analysis to protect the platform from abuse.

## Setup Instructions

### Prerequisites
- Node.js (v16+)
- PostgreSQL (v12+ with PostGIS)
- Python 3.8+ (for AI Service)
- FFmpeg (for voice processing)

### Quick Start

#### 1. Database
```bash
psql -U postgres -c "CREATE DATABASE fixam_db;"
```

#### 2. Backend & Database Init
```bash
cd backend
npm install
# Configure .env (see template)
npm run db:setup  # Inits schema & seeds mock data
npm start
```

#### 3. AI Service (Optional but Recommended)
```bash
cd backend/ai_service
pip install -r requirements.txt
python main.py
```

#### 4. Frontend
```bash
# Serve static files from root
npx serve frontend
```

## Technology Stack

- **Frontend**: Vanilla JS, Leaflet/Mapbox, Chart.js, CSS
- **Backend**: Node.js, Express, Socket.io
- **Database**: PostgreSQL
- **AI/ML**: Python (FastAPI), Whisper (OpenAI), NudeNet, Google Gemini (Cloud fallback)
- **Integration**: WhatsApp Business API (Meta), OpenStreetMap Nominatim

## License

ISC