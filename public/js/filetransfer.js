// filetransfer.js — reliable chunked file transfer over WebRTC data channels.
// Sending: reads file in chunks, encrypts each, sends sequentially with backpressure.
// Receiving: collects all chunks, assembles blob only after ALL chunks are confirmed received.

import { CryptoModule } from "./crypto.js";

const CHUNK_SIZE = 64 * 1024; // 64 KB — smaller chunks = more reliable on mobile/slow links
const BUFFERED_AMOUNT_HIGH = 4 * 1024 * 1024; // 4 MB backpressure threshold
const BUFFERED_AMOUNT_LOW  = 512 * 1024;       // 512 KB resume threshold

function genId() {
  return crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
}

export class FileTransferManager extends EventTarget {
  constructor(mesh, cryptoKey) {
    super();
    this.mesh = mesh;
    this.key = cryptoKey;

    this.outQueue = [];
    this.outActive = null;

    // Map of transferKey -> incoming transfer state
    this.inActives = new Map();

    mesh.addEventListener("data", (e) => {
      if (e.detail.kind === "file") {
        this._onFileData(e.detail.data, e.detail.peerId);
      }
    });
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  enqueue(files) {
    for (const file of files) {
      const id = genId();
      this.outQueue.push({ id, file });
      this.dispatchEvent(new CustomEvent("queued", {
        detail: { id, name: file.name, size: file.size },
      }));
    }
    this._pump();
  }

  async _pump() {
    if (this.outActive || this.outQueue.length === 0) return;
    const job = this.outQueue.shift();
    const totalChunks = Math.ceil(job.file.size / CHUNK_SIZE) || 1;

    this.outActive = {
      id: job.id,
      file: job.file,
      totalChunks,
      startTime: Date.now(),
      bytesSent: 0,
    };

    // Send metadata first
    this.mesh.broadcast("file", JSON.stringify({
      t: "meta",
      id: job.id,
      name: job.file.name,
      size: job.file.size,
      mime: job.file.type || "application/octet-stream",
      totalChunks,
    }));

    await this._sendAllChunks();
  }

  async _sendAllChunks() {
    const active = this.outActive;
    if (!active) return;

    const total = active.totalChunks;

    for (let i = 0; i < total; i++) {
      // Backpressure: wait if buffer is too full
      while (this.mesh.bufferedAmount("file") > BUFFERED_AMOUNT_HIGH) {
        await this._waitForDrain();
      }

      // Read and encrypt this chunk
      const start = i * CHUNK_SIZE;
      const slice = await active.file.slice(start, start + CHUNK_SIZE).arrayBuffer();
      const encrypted = await CryptoModule.encryptBytes(this.key, slice);

      // Frame: [4 bytes chunk index BE] [encrypted data]
      const frame = new Uint8Array(4 + encrypted.length);
      new DataView(frame.buffer).setUint32(0, i, false);
      frame.set(encrypted, 4);

      this.mesh.broadcast("file", frame.buffer);

      active.bytesSent = Math.min((i + 1) * CHUNK_SIZE, active.file.size);
      const elapsed = (Date.now() - active.startTime) / 1000;
      const speedBps = elapsed > 0.5 ? active.bytesSent / elapsed : 0;
      const remaining = active.file.size - active.bytesSent;
      const etaSec = speedBps > 0 ? remaining / speedBps : null;

      this.dispatchEvent(new CustomEvent("send-progress", {
        detail: {
          id: active.id,
          sent: i + 1,
          total,
          bytesSent: active.bytesSent,
          fileSize: active.file.size,
          speedBps,
          etaSec,
        },
      }));
    }

    // All chunks sent — tell receiver we're done
    this.mesh.broadcast("file", JSON.stringify({ t: "complete", id: active.id }));
    this.dispatchEvent(new CustomEvent("send-complete", { detail: { id: active.id } }));
    this.outActive = null;
    this._pump();
  }

  _waitForDrain() {
    return new Promise((resolve) => {
      const channel = this.mesh.fileChannel;
      if (!channel) return resolve();
      channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW;
      const handler = () => {
        channel.removeEventListener("bufferedamountlow", handler);
        resolve();
      };
      channel.addEventListener("bufferedamountlow", handler);
    });
  }

  resumeIfNeeded() {}

  // ── Receiving ─────────────────────────────────────────────────────────────
  // NOTE: This is NOT async — we handle everything synchronously to avoid
  // any race conditions with the event loop. Decryption promises are tracked
  // and we only assemble the blob after ALL of them resolve.

  _onFileData(data, fromPeerId) {
    if (typeof data === "string") {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      if (msg.t === "meta") {
        const transferKey = `${fromPeerId}:${msg.id}`;
        this.inActives.set(transferKey, {
          id: msg.id,
          name: msg.name,
          size: msg.size,
          mime: msg.mime,
          total: msg.totalChunks,
          // Pre-allocate array so chunks land at correct indices
          chunks: new Array(msg.totalChunks).fill(null),
          decryptedCount: 0,   // how many chunks have finished decrypting
          receivedCount: 0,    // how many binary frames arrived
          completeReceived: false, // did we get the "complete" message
          fromPeerId,
          transferKey,
          startTime: Date.now(),
        });
        this.dispatchEvent(new CustomEvent("receive-start", {
          detail: { id: transferKey, name: msg.name, size: msg.size },
        }));

      } else if (msg.t === "complete") {
        // Find the matching active transfer
        for (const active of this.inActives.values()) {
          if (active.fromPeerId === fromPeerId && active.id === msg.id) {
            active.completeReceived = true;
            // Check if all decryptions already finished before this message arrived
            this._checkAndFinish(active);
            break;
          }
        }

      } else if (msg.t === "cancel") {
        for (const [key, active] of this.inActives) {
          if (active.fromPeerId === fromPeerId && active.id === msg.id) {
            this.inActives.delete(key);
            this.dispatchEvent(new CustomEvent("receive-cancelled", { detail: { id: key } }));
            break;
          }
        }
      }
      return;
    }

    // Binary frame: find the active transfer for this peer
    let active = null;
    for (const a of this.inActives.values()) {
      if (a.fromPeerId === fromPeerId) { active = a; break; }
    }
    if (!active) return;

    // Parse frame header
    const bytes = new Uint8Array(data);
    if (bytes.length < 4) return;
    const chunkIndex = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
    const encrypted = bytes.slice(4);

    active.receivedCount++;

    // Decrypt async — but capture reference to active NOW (synchronously)
    const capturedActive = active;
    const capturedIndex = chunkIndex;

    CryptoModule.decryptBytes(this.key, encrypted).then((plain) => {
      capturedActive.chunks[capturedIndex] = plain;
      capturedActive.decryptedCount++;

      const elapsed = (Date.now() - capturedActive.startTime) / 1000;
      const bytesReceived = Math.min(capturedActive.decryptedCount * CHUNK_SIZE, capturedActive.size);
      const speedBps = elapsed > 0.5 ? bytesReceived / elapsed : 0;
      const remaining = capturedActive.size - bytesReceived;
      const etaSec = speedBps > 0 ? remaining / speedBps : null;

      this.dispatchEvent(new CustomEvent("receive-progress", {
        detail: {
          id: capturedActive.transferKey,
          received: capturedActive.decryptedCount,
          total: capturedActive.total,
          bytesReceived,
          fileSize: capturedActive.size,
          speedBps,
          etaSec,
        },
      }));

      // Each time a chunk finishes decrypting, check if we're done
      this._checkAndFinish(capturedActive);

    }).catch((err) => {
      console.error("Chunk decrypt failed at index", capturedIndex, err);
    });
  }

  // Called after every decrypt completes AND when "complete" message arrives.
  // Assembles the blob only when BOTH conditions are true:
  //   1. completeReceived === true  (sender said it's done)
  //   2. decryptedCount === total   (all chunks decrypted successfully)
  _checkAndFinish(active) {
    if (active.finished) return; // already done
    if (!active.completeReceived) return; // still waiting for "complete" message
    if (active.decryptedCount < active.total) return; // still waiting for chunks

    // Verify no chunk is missing
    for (let i = 0; i < active.total; i++) {
      if (active.chunks[i] === null) return; // gap — shouldn't happen but be safe
    }

    active.finished = true;

    const blob = new Blob(active.chunks, { type: active.mime });
    this.inActives.delete(active.transferKey);

    this.dispatchEvent(new CustomEvent("receive-complete", {
      detail: {
        id: active.transferKey,
        name: active.name,
        size: active.size,
        blob,
      },
    }));
  }
}
