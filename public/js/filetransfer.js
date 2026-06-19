// filetransfer.js — high-speed + reliable chunked file transfer.
// SENDING: pipeline encrypts N chunks ahead while sending current chunk,
//          so the channel is never idle waiting for crypto.
// RECEIVING: all chunks collected, blob assembled only after every chunk
//            is confirmed decrypted — no race conditions.

import { CryptoModule } from "./crypto.js";

const CHUNK_SIZE          = 256 * 1024;  // 256 KB — good balance of speed vs reliability
const PIPELINE_DEPTH      = 6;           // encrypt this many chunks ahead of sending
const BUFFERED_AMOUNT_HIGH = 8 * 1024 * 1024; // 8 MB — pause sending above this
const BUFFERED_AMOUNT_LOW  =   512 * 1024;     // 512 KB — resume sending below this
const PROGRESS_INTERVAL_MS = 80;         // update UI at most every 80ms (no DOM thrash)

function genId() {
  return crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
}

export class FileTransferManager extends EventTarget {
  constructor(mesh, cryptoKey) {
    super();
    this.mesh = mesh;
    this.key  = cryptoKey;

    this.outQueue  = [];
    this.outActive = null;
    this.inActives = new Map();   // transferKey → state

    mesh.addEventListener("data", (e) => {
      if (e.detail.kind === "file")
        this._onFileData(e.detail.data, e.detail.peerId);
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
    const job        = this.outQueue.shift();
    const totalChunks = Math.ceil(job.file.size / CHUNK_SIZE) || 1;

    this.outActive = { id: job.id, file: job.file, totalChunks,
                       startTime: Date.now(), bytesSent: 0 };

    this.mesh.broadcast("file", JSON.stringify({
      t: "meta", id: job.id,
      name: job.file.name, size: job.file.size,
      mime: job.file.type || "application/octet-stream",
      totalChunks,
    }));

    await this._sendAllChunks();
  }

  async _sendAllChunks() {
    const active = this.outActive;
    if (!active) return;

    const total = active.totalChunks;

    // Pipeline: a map of chunkIndex → Promise<Uint8Array frame>
    // We keep PIPELINE_DEPTH encryptions running ahead of the send cursor.
    const pipeline = new Map();

    const makeFrame = async (i) => {
      const start     = i * CHUNK_SIZE;
      const slice     = await active.file.slice(start, start + CHUNK_SIZE).arrayBuffer();
      const encrypted = await CryptoModule.encryptBytes(this.key, slice);
      const frame     = new Uint8Array(4 + encrypted.length);
      new DataView(frame.buffer).setUint32(0, i, false);
      frame.set(encrypted, 4);
      return frame;
    };

    // Pre-fill the pipeline
    let readHead = 0;
    while (readHead < total && readHead < PIPELINE_DEPTH) {
      pipeline.set(readHead, makeFrame(readHead));
      readHead++;
    }

    let lastProgressTs = 0;

    for (let sendIdx = 0; sendIdx < total; sendIdx++) {
      // Backpressure — pause if WebRTC buffer is saturated
      while (this.mesh.bufferedAmount("file") > BUFFERED_AMOUNT_HIGH) {
        await this._waitForDrain();
      }

      // Wait for this chunk's encryption to finish
      const frame = await pipeline.get(sendIdx);
      pipeline.delete(sendIdx);

      // Kick off the next encryption immediately so it runs in parallel
      if (readHead < total) {
        pipeline.set(readHead, makeFrame(readHead));
        readHead++;
      }

      this.mesh.broadcast("file", frame.buffer);

      active.bytesSent = Math.min((sendIdx + 1) * CHUNK_SIZE, active.file.size);

      // Throttle progress events — no need to fire 1000/sec
      const now = Date.now();
      if (now - lastProgressTs >= PROGRESS_INTERVAL_MS || sendIdx === total - 1) {
        lastProgressTs = now;
        const elapsed  = (now - active.startTime) / 1000;
        const speedBps = elapsed > 0.5 ? active.bytesSent / elapsed : 0;
        const etaSec   = speedBps > 0 ? (active.file.size - active.bytesSent) / speedBps : null;
        this.dispatchEvent(new CustomEvent("send-progress", {
          detail: {
            id: active.id, sent: sendIdx + 1, total,
            bytesSent: active.bytesSent, fileSize: active.file.size,
            speedBps, etaSec,
          },
        }));
      }
    }

    this.mesh.broadcast("file", JSON.stringify({ t: "complete", id: active.id }));
    this.dispatchEvent(new CustomEvent("send-complete", { detail: { id: active.id } }));
    this.outActive = null;
    this._pump();
  }

  _waitForDrain() {
    return new Promise((resolve) => {
      const ch = this.mesh.fileChannel;
      if (!ch) return resolve();
      ch.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW;
      const h = () => { ch.removeEventListener("bufferedamountlow", h); resolve(); };
      ch.addEventListener("bufferedamountlow", h);
    });
  }

  resumeIfNeeded() {}

  // ── Receiving ─────────────────────────────────────────────────────────────
  // _onFileData is NOT async — synchronous dispatch avoids all race conditions.
  // Decryptions run in parallel (fire-and-forget .then()), each updating a
  // counter. The blob is assembled only when BOTH conditions are met:
  //   • completeReceived === true   (sender sent the "complete" message)
  //   • decryptedCount  === total   (every chunk decrypted successfully)

  _onFileData(data, fromPeerId) {
    if (typeof data === "string") {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      if (msg.t === "meta") {
        const transferKey = `${fromPeerId}:${msg.id}`;
        this.inActives.set(transferKey, {
          id: msg.id, name: msg.name, size: msg.size, mime: msg.mime,
          total: msg.totalChunks,
          chunks: new Array(msg.totalChunks).fill(null),
          decryptedCount: 0,
          completeReceived: false,
          finished: false,
          fromPeerId, transferKey,
          startTime: Date.now(),
          lastProgressTs: 0,
        });
        this.dispatchEvent(new CustomEvent("receive-start", {
          detail: { id: transferKey, name: msg.name, size: msg.size },
        }));

      } else if (msg.t === "complete") {
        for (const active of this.inActives.values()) {
          if (active.fromPeerId === fromPeerId && active.id === msg.id) {
            active.completeReceived = true;
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

    // Binary chunk
    const bytes = new Uint8Array(data);
    if (bytes.length < 4) return;

    let active = null;
    for (const a of this.inActives.values()) {
      if (a.fromPeerId === fromPeerId) { active = a; break; }
    }
    if (!active) return;

    const chunkIndex = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
    const encrypted  = bytes.slice(4);

    // Capture by value — no closure-over-mutable-variable bugs
    const cap = active;
    const idx = chunkIndex;

    // All chunk decryptions run in parallel — maximum throughput on receiver too
    CryptoModule.decryptBytes(this.key, encrypted).then((plain) => {
      cap.chunks[idx] = plain;
      cap.decryptedCount++;

      // Throttled progress events
      const now      = Date.now();
      const bytesRx  = Math.min(cap.decryptedCount * CHUNK_SIZE, cap.size);
      if (now - cap.lastProgressTs >= PROGRESS_INTERVAL_MS || cap.decryptedCount === cap.total) {
        cap.lastProgressTs = now;
        const elapsed  = (now - cap.startTime) / 1000;
        const speedBps = elapsed > 0.5 ? bytesRx / elapsed : 0;
        const etaSec   = speedBps > 0 ? (cap.size - bytesRx) / speedBps : null;
        this.dispatchEvent(new CustomEvent("receive-progress", {
          detail: {
            id: cap.transferKey,
            received: cap.decryptedCount, total: cap.total,
            bytesReceived: bytesRx, fileSize: cap.size,
            speedBps, etaSec,
          },
        }));
      }

      this._checkAndFinish(cap);
    }).catch((err) => {
      console.error("Decrypt failed chunk", idx, err);
    });
  }

  _checkAndFinish(active) {
    if (active.finished)          return;
    if (!active.completeReceived) return;
    if (active.decryptedCount < active.total) return;

    // Final safety check — no null slots
    for (let i = 0; i < active.total; i++) {
      if (active.chunks[i] === null) return;
    }

    active.finished = true;
    this.inActives.delete(active.transferKey);

    const blob = new Blob(active.chunks, { type: active.mime });
    this.dispatchEvent(new CustomEvent("receive-complete", {
      detail: { id: active.transferKey, name: active.name, size: active.size, blob },
    }));
  }
}
