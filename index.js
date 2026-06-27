/**
 * Quickshoot — Multi-User Signaling Server
 * -------------------------------------------
 * Supports unlimited users per room in a full-mesh WebRTC topology.
 * Each pair of users negotiates a direct P2P connection via this server.
 *
 * What this server DOES:
 *   - Serves the static frontend (public/).
 *   - Generates short-lived room codes.
 *   - Assigns each socket a unique peerId on connection.
 *   - Relays WebRTC SDP/ICE signals between specific peer pairs using
 *     { to, from } targeting so every user can connect to every other user.
 *   - Notifies all room members when someone joins or leaves.
 *
 * What this server NEVER does:
 *   - Never sees chat messages or file bytes (P2P DataChannels only).
 *   - Never writes to disk or a database.
 */

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const ROOM_JOIN_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const HEARTBEAT_INTERVAL_MS = 25 * 1000;

/** @type {Map<string, Room>} */
const rooms = new Map();

function generateRoomCode() {
  const LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const DIGITS  = "23456789";
  let code;
  do {
    const letters = Array.from({ length: 3 }, () => LETTERS[crypto.randomInt(LETTERS.length)]).join("");
    const digit   = DIGITS[crypto.randomInt(DIGITS.length)];
    const pos = crypto.randomInt(4);
    const arr = letters.split("");
    arr.splice(pos, 0, digit);
    code = arr.join("");
  } while (rooms.has(code));
  return code;
}

function generatePeerId() {
  return crypto.randomBytes(6).toString("hex");
}

class Room {
  constructor(code) {
    this.code = code;
    /** @type {Map<string, WebSocket>} peerId -> socket */
    this.peers = new Map();
    /** @type {Map<string, string>} peerId -> display name (Host / U1 / U2 / ...) */
    this.names = new Map();
    /** Ascending counter used to assign U1, U2, U3... to joiners in order. */
    this.joinCounter = 0;
    this.createdAt = Date.now();
    this.joinTimer = setTimeout(() => {
      if (this.peers.size === 0) this.destroy("expired_unjoined");
    }, ROOM_JOIN_TIMEOUT_MS);
  }

  addPeer(peerId, socket) {
    this.peers.set(peerId, socket);
    clearTimeout(this.joinTimer);
  }

  removePeer(peerId) {
    this.peers.delete(peerId);
    if (this.peers.size === 0) this.destroy("empty");
  }

  /** Send a message to all peers except the sender. */
  broadcast(senderPeerId, msg) {
    const raw = JSON.stringify(msg);
    for (const [pid, sock] of this.peers) {
      if (pid !== senderPeerId && sock.readyState === sock.OPEN) {
        try { sock.send(raw); } catch { /* closing */ }
      }
    }
  }

  /** Send to a specific peer. */
  sendTo(peerId, msg) {
    const sock = this.peers.get(peerId);
    if (sock && sock.readyState === sock.OPEN) {
      try { sock.send(JSON.stringify(msg)); } catch { /* closing */ }
    }
  }

  destroy(reason) {
    clearTimeout(this.joinTimer);
    rooms.delete(this.code);
    for (const [, sock] of this.peers) {
      if (sock.readyState === sock.OPEN) {
        try { sock.send(JSON.stringify({ type: "room-closed", reason })); } catch {}
        sock.roomCode = null;
        sock.peerId = null;
      }
    }
    this.peers.clear();
    this.names.clear();
  }

  peerList() {
    return [...this.peers.keys()];
  }
}

function send(socket, message) {
  try { socket.send(JSON.stringify(message)); } catch {}
}

// ---------------------------------------------------------------------------
// HTTP + static frontend
// ---------------------------------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/healthz", (req, res) => {
  res.json({ ok: true, activeRooms: rooms.size });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket) => {
  socket.isAlive = true;
  socket.roomCode = null;
  socket.peerId = generatePeerId(); // unique ID for this connection

  socket.on("pong", () => { socket.isAlive = true; });

  socket.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch {
      return send(socket, { type: "error", message: "Malformed message." });
    }

    switch (msg.type) {

      case "host": {
        const code = generateRoomCode();
        const room = new Room(code);
        rooms.set(code, room);
        room.addPeer(socket.peerId, socket);
        room.names.set(socket.peerId, "Host");
        socket.roomCode = code;
        send(socket, { type: "hosted", code, peerId: socket.peerId, name: "Host" });
        break;
      }

      case "join": {
        const code = String(msg.code || "").toUpperCase().trim();
        const room = rooms.get(code);

        if (!room) return send(socket, { type: "error", message: "Room code not found or expired." });

        // Snapshot existing peers + their display names BEFORE adding the new one
        const existingPeers = room.peerList().map((pid) => ({
          peerId: pid,
          name: room.names.get(pid) || pid.slice(0, 4).toUpperCase(),
        }));

        // Ascending name: U1, U2, U3... assigned in join order, never reused
        room.joinCounter += 1;
        const name = `U${room.joinCounter}`;
        room.names.set(socket.peerId, name);

        room.addPeer(socket.peerId, socket);
        socket.roomCode = code;

        // Tell the joiner: your peerId/name + all existing peers (with names) in the room
        send(socket, { type: "joined", code, peerId: socket.peerId, name, peers: existingPeers });

        // Tell all existing peers that a new user arrived (with their assigned name)
        room.broadcast(socket.peerId, { type: "peer-joined", peerId: socket.peerId, name });
        break;
      }

      // Targeted signal: { type:"signal", to, payload }
      // from is always the sender's peerId (set server-side for security)
      case "signal": {
        const room = rooms.get(socket.roomCode);
        if (!room) return send(socket, { type: "error", message: "No active room." });
        const target = msg.to;
        if (!target) return;
        room.sendTo(target, { type: "signal", from: socket.peerId, payload: msg.payload });
        break;
      }

      case "leave": {
        const room = rooms.get(socket.roomCode);
        if (room) {
          const name = room.names.get(socket.peerId);
          room.broadcast(socket.peerId, { type: "peer-left", peerId: socket.peerId, name });
          room.removePeer(socket.peerId);
          room.names.delete(socket.peerId);
        }
        socket.roomCode = null;
        break;
      }

      case "ping":
        send(socket, { type: "pong" });
        break;

      default:
        send(socket, { type: "error", message: `Unknown message type: ${msg.type}` });
    }
  });

  socket.on("close", () => {
    const room = rooms.get(socket.roomCode);
    if (room) {
      const name = room.names.get(socket.peerId);
      room.broadcast(socket.peerId, { type: "peer-left", peerId: socket.peerId, name });
      room.removePeer(socket.peerId);
      room.names.delete(socket.peerId);
    }
  });
});

// Heartbeat — drop dead sockets
setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) { socket.terminate(); continue; }
    socket.isAlive = false;
    socket.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`Quickshoot multi-user signaling server listening on :${PORT}`);
});
