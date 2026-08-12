# FIXAM - Facilitating Issue eXchange for Accountable Municipalities

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**Live Demo:** <a href="https://fixam.maxcit.com/" target="_blank">https://fixam.maxcit.com/</a>

A comprehensive civic engagement ecosystem that empowers citizens to report municipal issues via WhatsApp and enables authorities to manage, analyze, and resolve them efficiently through advanced AI and automation. This project is proudly designed as a **Digital Public Good (DPG)**, adhering to open-source principles to ensure accessibility, transparency, and community-driven improvement.

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
│
├── simulator/             # WhatsApp Simulator (testing, no Meta account needed)
│   ├── public/            # Browser chat UI
│   ├── mockWhatsApp.js    # Stand-in for the WhatsApp transport
│   └── server.js          # Drives the real handler in-process
│
└── docker-compose.yml     # Full stack: db, api, ai engine, web, simulator
```


## System Architecture

![System Architecture](docs/fixam_system_architecture.png)

## Key Features

### 1. 🤖 Intelligent WhatsApp Bot
The primary reporting channel, designed for accessibility and ease of use.
- **Conversational Reporting**: Guided flow for citizens to report issues naturally.
- **AI-Powered Analysis**: instant categorization, summarization, and urgency detection using Embeddings & TextRank.
- **Voice-to-Text**: Native support for **Voice Notes** (Krio/English), transcribed locally via Whisper.
- **Media Support**: Users can send photos or videos as evidence.
- **Safety First**: Automated content moderation filters unsafe images (e.g., nudity) using local NudeNet.
- **Location Intelligence**: GPS pins and typed addresses, reverse-geocoded into district/city/ward. Locations outside the served country are refused, and reports survive a geocoder outage by keeping the citizen's own wording for an admin to place.
- **Duplicate Detection**: Open issues within 100 m reported in the last 7 days are shown to the citizen before they submit — configurable, and never blocking: they can still file it for admin review.
- **Automated Feedback Loop**: Citizens receive real-time status updates via WhatsApp when their issue is acknowledged or resolved, keeping them informed without manual follow-ups.

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

### 6. 🏆 Citizen Rewards System
Gamifying civic engagement to encourage consistent participation.
- **Earn Points**: Citizens accumulate digital points for positive actions:
  - **+10 Points**: Reporting a valid issue.
  - **+50 Points**: When a reported issue is physically resolved (Verified Fix).
  - **+1 Point**: Each time a community member upvotes their report.
- **Leaderboard**: Users can track their "Citizen Score" directly via WhatsApp.
- **Incentives**: High-scoring citizens gain recognition, fostering a sense of ownership and civic pride.

## Quick Start (Docker)

Everything — database, API, AI engine, web portal and the WhatsApp simulator — comes up with one command:

```bash
docker compose --profile simulator up -d --build
```

That is the whole install. No `.env` is required to start: every value has a working default in `docker-compose.yml`. Those defaults are public, so before exposing the stack to anyone, copy the template and set your own:

```bash
cp .env.example .env
```

First run downloads the Whisper model (~3 GB with the default `large-v3`) and builds ~7 GB of images, so allow 15–25 minutes on a normal connection. Later starts take seconds. On a machine with less than 12 GB of RAM, set `WHISPER_MODEL=openai/whisper-base` before starting — see [System Requirements](#system-requirements).

### Configuration

There is exactly one environment file: **`.env` at the repository root**. The backend, the simulator and every maintenance script read it through a shared loader, and Docker Compose passes it to all containers. `.env.example` is its documented template and the only env file in version control.

```
.env.example   committed — the template, safe to publish
.env           gitignored — your real values, never commit
```

The variables you are most likely to change:

| Variable | Why it matters |
|---|---|
| `SUPER_ADMIN_PHONE` / `SUPER_ADMIN_PASSWORD` | Creates the first admin account on boot. Change the password. |
| `DB_PASSWORD` | Defaults to a public value. |
| `FIXAM_BASE_URL` | The address citizens see in ticket links. Must match how the frontend is actually reachable. |
| `WHISPER_MODEL` | Accuracy vs. RAM and speed — see [System Requirements](#system-requirements). |
| `DEV_MODE` | `true` hides the public site behind a maintenance screen and restricts the bot to admins. |
| `SIMULATOR_ENABLED` | Lets the backend mirror admin notifications into the simulator. On by default; simulated traffic is refused when `NODE_ENV=production`. |
| `DUPLICATE_RADIUS_METERS` / `DUPLICATE_WINDOW_DAYS` | Tune duplicate detection (default 100 m / 7 days). |

### What you get

| Service | URL | Notes |
|---|---|---|
| Public civic map | http://localhost | Hidden behind a maintenance screen when `DEV_MODE=true` |
| Public statistics | http://localhost/dashboard | Open to everyone |
| Admin portal | http://localhost/admin | Login required — see below |
| WhatsApp simulator | http://localhost:4001 | Only with `--profile simulator` |
| Backend API | http://localhost:5000/api | Also proxied at `http://localhost/api` |
| PostgreSQL | localhost:5432 | Credentials from `.env` |

The AI engine has no published port; it is reached internally by the backend at `http://ai-engine:8000`.

### Logging in

The super admin is created automatically on first backend boot from `SUPER_ADMIN_PHONE` / `SUPER_ADMIN_PASSWORD`:

- **Phone:** `23200000000` (default)
- **Password:** whatever `SUPER_ADMIN_PASSWORD` is set to

Confirm it worked with `docker compose logs backend | grep "Super admin"`. Later restarts will **not** overwrite the password, so a change made in the dashboard survives redeploys. If you lock yourself out, set `SUPER_ADMIN_RESET_PASSWORD=true` for one boot.

### Everyday commands

```bash
docker compose --profile simulator up -d     # start (after first build)
docker compose logs -f backend               # follow API logs
docker compose down                          # stop, keep data
docker compose down -v                       # stop and erase the database
```

Rebuild after changing code — the images bake in source, so an edit alone changes nothing:

```bash
docker compose build backend simulator && docker compose up -d backend simulator
```

## System Requirements

**The Whisper model you choose decides everything here.** It is loaded into RAM for the life of the container, and the default — `whisper-large-v3`, chosen for transcription accuracy on Krio and accented English — is by far the largest component of the stack.

All figures below are measured on the running stack, not estimated.

### Memory by transcription model

| `WHISPER_MODEL` | AI engine idle | Peak while transcribing | Download | Speed |
|---|---|---|---|---|
| `openai/whisper-large-v3` | **7.1 GB** | **9.7 GB** | ~3.0 GB | slowest |
| `openai/whisper-base` *(default)* | 1.15 GB | ~1.2 GB | ~150 MB | ~15× faster |
| `openai/whisper-tiny` | ~0.8 GB | ~0.9 GB | ~75 MB | fastest |

Everything else in the stack is small and fixed: PostgreSQL ~50 MB, simulator ~40 MB, backend ~30 MB, frontend ~25 MB — about **145 MB combined**.

### Host requirements

| | With `large-v3` (default) | With `base` / `tiny` |
|---|---|---|
| RAM — minimum | 12 GB | 4 GB |
| RAM — recommended | **16 GB** | **8 GB** |
| CPU | 4 cores | 2 cores |
| Disk | 15 GB | 10 GB |

Transcription peaks at **9.7 GB** with `large-v3` — that is the number to size against, not the idle figure. A host with 8 GB will out-of-memory partway through a voice note. Add Docker Desktop's own VM overhead on Windows and macOS on top.

Everything runs on CPU; no GPU is required, and none is used if present.

### Choosing a model

`large-v3` buys accuracy at a real cost in latency. Measured on this stack, a 2-second clip took **19.4 s** to transcribe versus ~1.2 s on `base` — and transcription time scales with audio length, so a 30-second voice note can leave a citizen waiting minutes for the bot to reply.

If your deployment is memory- or latency-constrained, or you are running the simulator on a laptop, switch in `.env`:

```bash
WHISPER_MODEL=openai/whisper-base
```

Then recreate the container: `docker compose up -d --force-recreate ai-engine`.

**Not using the AI features at all?** `docker compose up -d postgres backend frontend` runs on ~200 MB. The bot still works — reports fall back to `Uncategorized`, voice notes are stored untranscribed, and image safety checks are skipped.

> Models download on first start and live inside the container, so recreating `ai-engine` re-downloads them (3 GB for `large-v3`). Keep that in mind on a metered connection.

### Running without Docker

Requires Node.js 16+, PostgreSQL 12+, Python 3.8+, and **FFmpeg** (Whisper decodes every upload through it — without it, transcription fails for every audio format).

```bash
psql -U postgres -c "CREATE DATABASE fixam_db;"
cd backend && npm install && npm run db:setup && npm start
cd backend/ai_service && pip install -r requirements.txt && python main.py
npx serve frontend -p 3000
```

Serve the frontend on **port 3000** — the scripts pick the API host from the port they are served on, and fall back to a same-origin `/api` anywhere else.

## WhatsApp Simulator

Testing a WhatsApp bot normally means a Meta Business account, a verified number, a public webhook URL, and real messages to real phones. The simulator removes all of it: a browser chat window that drives the **real** `whatsappHandler` in-process, against the real database, with a mock transport in place of Meta's API.

```bash
docker compose --profile simulator up -d
# then open http://localhost:4001
```

It is behind a compose profile, so a plain `docker compose up -d` never starts it.

### What you can test

- **Full reporting flow** — greeting, consent, registration, evidence, location, description, duplicate check, confirmation.
- **Media** — photos, videos, voice notes and documents by file upload. Voice notes are transcribed by the same Whisper service production uses.
- **GPS locations** — send exact coordinates, including out-of-area pins to check they are refused.
- **Admin updates** — change an issue's status from the **+** menu ("Admin Status Update") and watch the citizen's notification arrive in the chat. This calls the real admin API, so it exercises the genuine notification path rather than a stub.
- **Multiple citizens** — switch numbers with the **Use number** button; each number keeps its own conversation history, loaded from the message log.
- **Reset** — clear a number's conversation state to start a scenario over without deleting the user.

### Configuration

| Variable | Purpose |
|---|---|
| `SIMULATOR_ENABLED` | **On by default.** Lets the backend recognise simulated conversations and mirror admin notifications back; without it, status updates never reach the simulator chat. Simulated traffic is refused outright when `NODE_ENV=production`. |
| `SIMULATOR_PHONE` | Number the chat window opens with. |
| `SIMULATOR_DB_NAME` | Point at a scratch database to keep simulated reports out of the real one. Defaults to the main database. |

The status dot in the simulator's top-right turns amber when the database is reachable but `SIMULATOR_ENABLED` is not `true` — hover it for the reason.

### How the bot knows

Simulated webhooks carry a marker the handler checks. Recognised simulated traffic skips the `DEV_MODE` admin-only gate (otherwise every test message is refused) and the phone-number-ID check, and is refused outright when `NODE_ENV=production` unless explicitly enabled. Replies go to the mock transport, so **nothing is ever sent to a real phone**.

> Simulated conversations write real rows — users, issues, votes, points. Use `SIMULATOR_DB_NAME` if that matters to you.

## Technology Stack

- **Frontend**: Vanilla JS, Leaflet/Mapbox, Chart.js, CSS
- **Backend**: Node.js, Express, Socket.io
- **Database**: PostgreSQL
- **AI/ML**: Python (FastAPI), Whisper (OpenAI), NudeNet, SentenceTransformers (Embeddings), Summa (TextRank)
- **Integration**: WhatsApp Business API (Meta), OpenStreetMap Nominatim
- **Deployment**: Docker Compose (PostgreSQL, API, AI engine, nginx, simulator)

## Contributing & Community

We welcome contributions to make FIXAM better as an open-source Digital Public Good! Please see our [Contributing Guidelines](CONTRIBUTING.md) to get started. 
We expect all contributors to adhere to our [Code of Conduct](CODE_OF_CONDUCT.md). 
For security concerns, please review our [Security Policy](SECURITY.md).

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
Copyright (c) 2026 MaxCIT Limited.