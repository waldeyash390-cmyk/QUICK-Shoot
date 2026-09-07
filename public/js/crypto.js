// crypto.js — application-layer encryption on top of WebRTC's own DTLS.
//
// WebRTC DataChannels are already encrypted in transit, but this extra
// layer means the *content* of messages/files is only ever readable by
// someone who has the room code — not by the signaling server, and not
// by anyone who merely observes network traffic.
//
// The key is derived with PBKDF2 from the room code + a random salt that
// both sides agree on, then used for AES-256-GCM. The key never leaves
// the browser and is discarded (garbage collected) when the session ends.

const PBKDF2_ITERATIONS = 150_000;

async function deriveKey(roomCode, saltBytes) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(roomCode),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function randomBytes(len) {
  return crypto.getRandomValues(new Uint8Array(len));
}

/** Encrypt a binary payload (ArrayBuffer/Uint8Array). Returns a single
 *  Uint8Array: [12-byte IV][ciphertext]. */
async function encryptBytes(key, plainBytes) {
  const iv = randomBytes(12);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plainBytes);
  const out = new Uint8Array(iv.length + cipher.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(cipher), iv.length);
  return out;
}

async function decryptBytes(key, packed) {
  const bytes = packed instanceof Uint8Array ? packed : new Uint8Array(packed);
  const iv = bytes.slice(0, 12);
  const cipher = bytes.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new Uint8Array(plain);
}

async function encryptJSON(key, obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  return encryptBytes(key, bytes);
}

async function decryptJSON(key, packed) {
  const bytes = await decryptBytes(key, packed);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Derive a stable AES-GCM key from the room code alone, so both peers
 *  arrive at the identical key without an extra signaling round trip.
 *  The salt is derived from the code itself (not secret on its own —
 *  the room code is the secret, and it never touches the server). */
async function deriveKeyFromRoomCode(roomCode) {
  const enc = new TextEncoder();
  const saltSource = await crypto.subtle.digest("SHA-256", enc.encode(`quickshoot-salt:${roomCode}`));
  const salt = new Uint8Array(saltSource).slice(0, 16);
  return deriveKey(roomCode, salt);
}

export const CryptoModule = {
  deriveKey,
  deriveKeyFromRoomCode,
  randomBytes,
  encryptBytes,
  decryptBytes,
  encryptJSON,
  decryptJSON,
};
