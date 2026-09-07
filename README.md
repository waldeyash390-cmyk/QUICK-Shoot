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
- **coturn TURN server**: Relays traffic when direct P2P fails (symmetric NAT, carrier-grade NAT).
- **Frontend** (`public/`): Vanilla ES modules, no build step.

## Quick Start (Local Development)

```bash
# 1. Clone and enter directory
cd QUICK-Shoot-main

# 2. Copy env template and edit
cp .env.example .env
# Edit .env — at minimum set TURN_SECRET (generate with: openssl rand -base64 32)
# For local testing, TURN_DOMAIN=host.docker.internal works from containers

# 3. Start both services
docker-compose up --build

# 4. Open http://localhost:8080 in two browser tabs (or two devices on same LAN)
```

## Production Deployment

### 1. Server Requirements

- Linux server with Docker & Docker Compose
- Public IPv4 address
- Domain name (recommended) or static IP

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your values:
# TURN_SECRET=   # openssl rand -base64 32  (keep this secret!)
# TURN_DOMAIN=   # your-domain.com or public IP (e.g., 203.0.113.10)
# TURN_REALM=    # your-domain.com (used in TURN auth realm)
# SERVER_PORT=   # 8080 (or 80/443 behind reverse proxy)
```

### 3. Open Firewall / Security Group Ports

| Port(s)        | Protocol | Purpose                          |
|----------------|----------|----------------------------------|
| 8080           | TCP      | HTTP signaling + static frontend |
| 3478           | UDP/TCP  | TURN/STUN control                |
| 49160–49200    | UDP      | TURN relay data (media/file)     |

**Cloud providers (AWS, GCP, DigitalOcean, etc.):** Add inbound rules for the above ports in your security group / firewall.

**Linux (ufw):**
```bash
sudo ufw allow 8080/tcp
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 49160:49200/udp
```

### 4. DNS

Point `TURN_DOMAIN` (e.g., `turn.yourdomain.com`) to your server's public IP via an A record.

### 5. Deploy

```bash
docker-compose up -d --build
```

### 6. (Optional) Reverse Proxy + TLS

For production, terminate TLS at a reverse proxy (nginx, Caddy, Traefik) in front of port 8080. The TURN server runs on plain UDP/TCP (no TLS) for maximum compatibility. If you need TURNS (TLS), enable `--tls-listening-port` in coturn and add certs.

### 7. Verify

- Open `https://your-domain.com` on two devices on **different networks** (e.g., one on WiFi, one on mobile hotspot).
- Create a room on one, join on the other.
- Both should show "Connected" within a few seconds.
- Chat and file transfer should work bidirectionally.

## TURN Server Details

### Why coturn?

- **STUN alone fails** on symmetric NAT / carrier-grade NAT (common on mobile data).
- **Free public TURN relays** are rate-limited and unreliable for production.
- **coturn** is battle-tested, supports long-term credentials via `use-auth-secret` (no user database needed).

### Credential Generation (REST API)

The server exposes `GET /turn-credentials?peerId=xxx` which returns short-lived credentials:

```
username = "<unix_timestamp_24h_from_now>:<peerId>"
credential = base64(HMAC-SHA1(TURN_SECRET, username))
```

This follows the [coturn REST API convention](https://github.com/coturn/coturn/blob/master/README.turnserver#LONG-TERM-CREDENTIALS-MECHANISM). The secret never leaves the server.

### coturn Configuration (docker-compose)

```yaml
coturn:
  image: coturn/coturn:latest
  command: >
    -n
    -a
    -v
    --use-auth-secret
    --static-auth-secret=${TURN_SECRET}
    --realm=${TURN_REALM}
    --server-name=${TURN_DOMAIN}
    --min-port=49160
    --max-port=49200
    --no-tls
    --no-dtls
```

- `--use-auth-secret` + `--static-auth-secret`: Enables HMAC-based auth (no user DB).
- `--min-port`/`--max-port`: Relay port range (must be open in firewall).
- `--no-tls`/`--no-dtls`: Plain UDP/TCP. Add certs for TURNS if needed.

## Project Structure

```
QUICK-Shoot-main/
├── docker-compose.yml       # Server + coturn
├── .env.example             # Template for secrets
├── .gitignore               # Excludes .env
├── server/
│   ├── Dockerfile
│   ├── package.json
│   └── index.js             # Signaling + /turn-credentials endpoint
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
# Run server only (no coturn) — STUN-only, works on same LAN
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
- **TURN secret**: Only used to sign credentials. Not exposed to clients.
- **Short-lived creds**: Expire in 24h (configurable via `TURN_TTL_SECONDS`).
- **No logging**: Server logs only connection events, no message content.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Connected" never appears (cross-network) | TURN not reachable | Check firewall ports 3478 + 49160-49200 UDP |
| Long delay (>10s) before connect | TURN misconfigured | Verify `TURN_DOMAIN` resolves to public IP; check coturn logs (`docker logs quickshoot-coturn`) |
| File transfer stalls | Relay port range blocked | Open 49160-49200 UDP in cloud firewall |
| `TURN server not configured` | Missing `TURN_SECRET` | Set in `.env` and restart |

## License

MIT