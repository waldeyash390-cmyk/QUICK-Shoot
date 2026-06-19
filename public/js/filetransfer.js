// filetransfer.js — high-speed + reliable chunked file transfer.
// KEY FIX: All messages (meta, chunks, complete) sent as binary ArrayBuffer.
//          Mixed string/binary on same DataChannel causes messages to be dropped
//          on some mobile browsers (Chrome Android, Brave, etc).

import { CryptoModule } from "./crypto.js";

const CHUNK_SIZE           = 256 * 1024;
const PIPELINE_DEPTH       = 6;
const BUFFERED_AMOUNT_HIGH = 8 * 1024 * 1024;
const BUFFERED_AMOUNT_LOW  =   512 * 1024;
const PROGRESS_INTERVAL_MS = 80;

// ── Message type bytes (first byte of every frame) ──────────────────────────
const MSG_META     = 0x01;
const MSG_CHUNK    = 0x02;
const MSG_COMPLETE = 0x03;
const MSG_CANCEL   = 0x04;

function genId() {
  return crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
}

// Encode a JS object to a binary frame with a type-byte prefix
function encodeJSON(typeByte, obj) {
  const json  = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  const frame = new Uint8Array(1 + bytes.length);
  frame[0] = typeByte;
  frame.set(bytes, 1);
  return frame.buffer;
}

// Encode a chunk frame: [0x02][4-byte index BE][encrypted bytes]
function encodeChunk(index, encrypted) {
  const frame = new Uint8Array(5 + encrypted.length);
  frame[0] = MSG_CHUNK;
  new DataView(frame.buffer).setUint32(1, index, false);
  frame.set(encrypted, 5);
  return frame.buffer;
}

export class FileTransferManager extends EventTarget {
  constructor(mesh, cryptoKey) {
    super();
    this.mesh = mesh;
    this.key  = cryptoKey;

    this.outQueue  = [];
    this.outActive = null;
    this.inActives = new Map();

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
    const job         = this.outQueue.shift();
    const totalChunks = Math.ceil(job.file.size / CHUNK_SIZE) || 1;

    this.outActive = { id: job.id, file: job.file, totalChunks,
                       startTime: Date.now(), bytesSent: 0 };

    // Send meta as binary
    this.mesh.broadcast("file", encodeJSON(MSG_META, {
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

    const total    = active.totalChunks;
    const pipeline = new Map(); // index → Promise<ArrayBuffer>

    const makeFrame = async (i) => {
      const start     = i * CHUNK_SIZE;
      const slice     = await active.file.slice(start, start + CHUNK_SIZE).arrayBuffer();
      const encrypted = await CryptoModule.encryptBytes(this.key, slice);
      return encodeChunk(i, encrypted);
    };

    // Pre-fill pipeline
    let readHead = 0;
    while (readHead < total && readHead < PIPELINE_DEPTH) {
      pipeline.set(readHead, makeFrame(readHead));
      readHead++;
    }

    let lastProgressTs = 0;

    for (let sendIdx = 0; sendIdx < total; sendIdx++) {
      while (this.mesh.bufferedAmount("file") > BUFFERED_AMOUNT_HIGH) {
        await this._waitForDrain();
      }

      const frame = await pipeline.get(sendIdx);
      pipeline.delete(sendIdx);

      if (readHead < total) {
        pipeline.set(readHead, makeFrame(readHead));
        readHead++;
      }

      this.mesh.broadcast("file", frame);

      active.bytesSent = Math.min((sendIdx + 1) * CHUNK_SIZE, active.file.size);

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

    // Send "complete" as binary — NOT a string — so it's never lost on mobile
    this.mesh.broadcast("file", encodeJSON(MSG_COMPLETE, { id: active.id }));
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
  // _onFileData is synchronous. All data arrives as ArrayBuffer.
  // First byte = message type. Everything else follows.

  _onFileData(data, fromPeerId) {
    // Everything is binary now — reject strings defensively
    if (typeof data === "string") return;

    const bytes    = new Uint8Array(data);
    if (bytes.length < 1) return;
    const msgType  = bytes[0];

    if (msgType === MSG_META) {
      let meta;
      try { meta = JSON.parse(new TextDecoder().decode(bytes.slice(1))); }
      catch { return; }

      const transferKey = `${fromPeerId}:${meta.id}`;
      this.inActives.set(transferKey, {
        id: meta.id, name: meta.name, size: meta.size, mime: meta.mime,
        total: meta.totalChunks,
        chunks: new Array(meta.totalChunks).fill(null),
        decryptedCount: 0,
        completeReceived: false,
        finished: false,
        fromPeerId, transferKey,
        startTime: Date.now(),
        lastProgressTs: 0,
      });
      this.dispatchEvent(new CustomEvent("receive-start", {
        detail: { id: transferKey, name: meta.name, size: meta.size },
      }));
      return;
    }

    if (msgType === MSG_COMPLETE) {
      let msg;
      try { msg = JSON.parse(new TextDecoder().decode(bytes.slice(1))); }
      catch { return; }

      for (const active of this.inActives.values()) {
        if (active.fromPeerId === fromPeerId && active.id === msg.id) {
          active.completeReceived = true;
          this._checkAndFinish(active);
          break;
        }
      }
      return;
    }

    if (msgType === MSG_CANCEL) {
      let msg;
      try { msg = JSON.parse(new TextDecoder().decode(bytes.slice(1))); }
      catch { return; }

      for (const [key, active] of this.inActives) {
        if (active.fromPeerId === fromPeerId && active.id === msg.id) {
          this.inActives.delete(key);
          this.dispatchEvent(new CustomEvent("receive-cancelled", { detail: { id: key } }));
          break;
        }
      }
      return;
    }

    if (msgType === MSG_CHUNK) {
      if (bytes.length < 5) return;

      let active = null;
      for (const a of this.inActives.values()) {
        if (a.fromPeerId === fromPeerId) { active = a; break; }
      }
      if (!active) return;

      const chunkIndex = new DataView(bytes.buffer, bytes.byteOffset + 1, 4).getUint32(0, false);
      // Slice from original buffer to avoid extra copy
      const encrypted  = bytes.buffer.slice(bytes.byteOffset + 5, bytes.byteOffset + bytes.length);

      const cap = active;
      const idx = chunkIndex;

      CryptoModule.decryptBytes(this.key, encrypted).then((plain) => {
        cap.chunks[idx] = plain;
        cap.decryptedCount++;

        const now     = Date.now();
        const bytesRx = Math.min(cap.decryptedCount * CHUNK_SIZE, cap.size);
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
  }

  _checkAndFinish(active) {
    if (active.finished)          return;
    if (!active.completeReceived) return;
    if (active.decryptedCount < active.total) return;
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
