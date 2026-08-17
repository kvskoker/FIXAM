# FIXAM WhatsApp Simulator

A local stand-in for WhatsApp. It drives the **real** `FixamHandler`
(`backend/services/whatsappHandler.js`) with synthetic webhook payloads, so the
whole citizen journey — consent, registration, reporting an issue with photo and
location, voting, tracking, endorsing — can be tested without Meta's API, a
public tunnel, or a real phone.

It also closes the loop the other way: when an admin changes an issue's status,
the notification the backend sends to the citizen appears in the simulated chat.

```
   browser  ──►  simulator  ──►  FixamHandler  ──►  Postgres
  (chat UI)      :4001           (real code)
       ▲                                              │
       │                                              ▼
       └────────  backend :5000  ◄── admin status update
                (mirrors outgoing messages back)
```

## Setup

```bash
cd simulator && npm install
```

Add to `backend/.env`:

```
SIMULATOR_ENABLED=true
SIMULATOR_URL=http://localhost:4001
SIMULATOR_PORT=4001
SIMULATOR_PHONE=23272123456
# SIMULATOR_DB_NAME=fixam_db_sim   # optional: keep simulated data out of the main DB
```

`SIMULATOR_ENABLED` is what makes the bot **recognise** simulated messages. It is
ignored when `NODE_ENV=production`, and the simulator refuses to start there.

## Run

```bash
cd simulator && npm start
```

Open <http://localhost:4001>. The dot in the top right is green only when the
database is reachable *and* the bot recognises the simulator; hover it for
detail.

For admin status updates, also run the backend (`cd backend && npm start`).

## How the bot knows a message is simulated

Every payload the simulator builds carries `simulator: true` and the sentinel
`metadata.phone_number_id = "fixam-simulator"`. `backend/services/simulator.js`
is the single place that decides whether to believe it — and it never does in
production. When a message is recognised as simulated, the handler:

- skips the phone-number-ID check that rejects webhooks from other WhatsApp
  numbers, and
- skips the `DEV_MODE` maintenance gate, which otherwise answers every
  non-admin with "closed to public use" and makes the simulator useless.

Everything else runs exactly as it does for a real message, including the AI
classification, geocoding and database writes.

## Chat actions (the `+` button)

| Action | What it does |
| --- | --- |
| Photo / Voice / Video / Document | Uploads the file and delivers it as a media message |
| Location | Sends GPS coordinates (defaults to Freetown) |
| Admin Status Update | Picks one of this number's issues and calls the real `PUT /api/admin/issues/:id/status`; the resulting WhatsApp notification comes back into the chat |
| New User | Switches to a fresh random Sierra Leone number |
| Reset Conversation | Clears `conversation_state` and `pending_consent` for the current number |

## Notes

- **Phone numbers.** The bot accepts only the configured country's numbers (see
  `FIXAM_COUNTRY_CODE` in the root `.env`), and the simulator enforces the same:
  the country calling code followed by the national number, at that country's
  length. For Sierra Leone that is **11 digits, `232` then 8** (e.g.
  `23272123456`). Decorations are tolerated (`+232 72 123456`), but a local
  `0…` number, a foreign code, or the wrong length is refused with an error.
- **Real data.** Simulated conversations create real rows: users, issues, votes,
  points. Set `SIMULATOR_DB_NAME` to a scratch database if that matters.
- **Schema check.** On startup the simulator verifies the tables and columns the
  handler needs and prints exactly what is missing. A stale database otherwise
  surfaces as a bare "Error submitting report" at the very end of a long
  conversation.
- **Real sends are not hijacked.** The backend asks the simulator whether a
  recipient is one it is driving (remembered in `.known-phones.json`) before
  suppressing a real WhatsApp send, so a running simulator never swallows
  messages meant for a real tester's phone.

## HTTP API

| Endpoint | Purpose |
| --- | --- |
| `POST /simulate` | `{ phone_number, message, message_type }` — send text |
| `POST /simulate/location` | `{ phone_number, latitude, longitude }` |
| `POST /simulate/upload` | multipart `file` — returns a `media_id` |
| `POST /simulate/media` | `{ phone_number, media_id, media_type }` |
| `POST /simulate/admin-update` | `{ ticket_id, status, note }` |
| `POST /simulate/reset-state` | `{ phone_number }` |
| `GET /simulate/issues?phone=` | Issues reported by that number |
| `GET /simulate/notifications?phone=&since=` | Messages pushed from outside the chat |
| `POST /simulate/notify` | Used by the backend to mirror an outgoing message |
| `GET /status`, `GET /config` | Health and client configuration |

These make scripted end-to-end tests straightforward — drive a whole
conversation with a series of `POST /simulate` calls and assert on `responses`.
