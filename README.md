# QUICK-Shoot — Multi-User WebRTC Chat & File Transfer

A zero-dependency, end-to-end encrypted, peer-to-peer chat and file sharing app. Runs entirely in the browser. No accounts, no central message relay.

## Features

- **Multi-user rooms** — Full mesh WebRTC topology, unlimited participants
- **End-to-end encryption** — Chat messages and files encrypted via Web Crypto API (AES-GCM)
- **File transfer** — Drag & drop, clipboard paste, camera capture; resume/pause support
- **Voice calls** — Mesh audio conferencing via WebRTC
- **Room codes** — 4-character codes for easy sharing (QR code included)
- **Cross-platform** — Works on desktop and mobile browsers

## Architecture

```
┌─────────────┐     WebSocket (signaling only)     ┌─────────────┐
│  Browser A  │ ◄──────────────────────────────────► │  Browser B  │
└──────┬──────┘                                     └──────┬──────┘
       │                                                    │
       │              WebRTC DataChannel (P2P)              │
       │ ◄────────────────────────────────────────────────► │
       │     Encrypted chat / files / audio (never         │
       │      touches the server)                          │
       ▼                                                    ▼
```

- **Signaling server** (`server/index.js`): Exchanges SDP/ICE only. Never sees message content.
- **Metered.ca TURN service**: Managed TURN/STUN relays for NAT traversal (no self-hosting needed).
- **Frontend** (`public/`): Vanilla ES modules, no build step.

## Quick Start (Local Development)

```bash
# 1. Clone and enter directory
cd QUICK-Shoot-main

# 2. Sign up at https://metered.ca (free tier available)
#    Create a project and get your SUBDOMAIN and API KEY

# 3. Copy env template and edit
cp .env.example .env
# Edit .env with your Metered credentials:
# METERED_SUBDOMAIN=your-app-name.metered.live
# METERED_API_KEY=your-api-key-here

# 4. Install deps and start
cd server && npm install && npm start

# 5. Open http://localhost:8080 in two browser tabs (or two devices on same LAN)
```

## Production Deployment

### 1. Server Requirements

- Linux server with Node.js 18+
- Public IPv4 address
- Domain name (recommended) or static IP

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your values from Metered dashboard:
# METERED_SUBDOMAIN=your-app-name.metered.live
# METERED_API_KEY=your-api-key-here
# SERVER_PORT=8080 (or 80/443 behind reverse proxy)
```

### 3. Open Firewall / Security Group Ports

| Port(s) | Protocol | Purpose                          |
|---------|----------|----------------------------------|
| 8080    | TCP      | HTTP signaling + static frontend |

**No TURN ports needed** — Metered handles relay infrastructure.

### 4. DNS

Point your domain to your server's public IP via an A record.

### 5. Deploy

```bash
cd server && npm install --omit=dev && npm start
# Use PM2, systemd, or Docker to keep it running in production
```

### 6. (Optional) Reverse Proxy + TLS

For production, terminate TLS at a reverse proxy (nginx, Caddy, Traefik) in front of port 8080.

### 7. Verify

- Open `https://your-domain.com` on two devices on **different networks** (e.g., one on WiFi, one on mobile hotspot).
- Create a room on one, join on the other.
- Both should show "Connected" within a few seconds.
- Chat and file transfer should work bidirectionally.

## TURN Service (Metered.ca)

### Why Metered?

- **No infrastructure to manage** — No coturn, no Docker, no port forwarding for relay ports
- **Global edge network** — Low-latency relay servers worldwide
- **Free tier available** — Generous monthly minutes for development/small apps
- **REST API** — Simple credential fetching, API key stays on your server

### Credential Flow

1. Client loads page → `fetch("/turn-credentials")`
2. Server proxies to Metered: `GET https://${SUBDOMAIN}.metered.live/api/v1/turn/credentials?apiKey=${API_KEY}`
3. Metered returns array of ICE server objects: `[{urls, username, credential}, ...]`
4. Server forwards JSON to client
5. Client merges with STUN servers and creates `RTCPeerConnection`

The API key **never leaves your server** — only short-lived credentials reach the browser.

## Project Structure

```
QUICK-Shoot-main/
├── .env.example             # Template for Metered credentials
├── .gitignore               # Excludes .env
├── server/
│   ├── package.json
│   └── index.js             # Signaling + /turn-credentials proxy to Metered
└── public/
    ├── index.html
    ├── css/style.css
    └── js/
        ├── app.js           # Main UI logic
        ├── webrtc.js        # PeerMesh, ICE/TURN handling
        ├── signaling.js     # WebSocket signaling client
        ├── filetransfer.js  # Encrypted file transfer protocol
        └── crypto.js        # AES-GCM encryption helpers
```

## Development

```bash
# Run server only
cd server && npm install && npm start

# Frontend served at http://localhost:8080
# Edit files in public/ — refresh browser to see changes
```

## Browser Support

- Chrome/Edge 80+
- Firefox 74+
- Safari 14+ (WebRTC DataChannel, Web Crypto)
- Mobile Chrome/Safari (iOS 14+, Android 10+)

## Security Notes

- **E2E encryption**: Room code → HKDF → AES-GCM key. Server never sees plaintext.
- **TURN credentials**: Short-lived, generated per-session via Metered API. API key stays on server.
- **No logging**: Server logs only connection events, no message content.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Connected" never appears (cross-network) | Metered TURN not configured | Check `.env` has valid `METERED_SUBDOMAIN` and `METERED_API_KEY` |
| Long delay (>10s) before connect | Metered API error / quota exceeded | Check server logs; verify Metered dashboard for usage/limits on free tier |
| `TURN not configured` error | Missing env vars | Set `METERED_SUBDOMAIN` and `METERED_API_KEY` in `.env` and restart |
| File transfer stalls | Network/NAT issues | Retry logic forces relay; check Metered dashboard for relay health |

## License

MIT