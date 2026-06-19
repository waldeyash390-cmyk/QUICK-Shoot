// filetransfer.js — robust multi-file transfer over WebRTC DataChannel.
// All messages are binary (no mixed string/binary — mobile browsers drop strings).
// Chunk frames carry the transfer ID so receiver always routes to correct file.

import { CryptoModule } from "./crypto.js";

// ── Tuning ───────────────────────────────────────────────────────────────────
const CHUNK_SIZE           = 16 * 1024;   // 16 KB — safe for all mobile browsers
const PIPELINE_DEPTH       = 8;           // encrypt N chunks ahead of sending
const BUFFERED_AMOUNT_HIGH = 4 * 1024 * 1024;
const BUFFERED_AMOUNT_LOW  =   256 * 1024;
const PROGRESS_INTERVAL_MS = 100;

// ── Wire protocol (first byte = type) ────────────────────────────────────────
// MSG_META     : [0x01][JSON bytes]          — file metadata
// MSG_CHUNK    : [0x02][8B id][4B idx][data] — encrypted chunk
// MSG_COMPLETE : [0x03][8B id]               — all chunks sent
// MSG_CANCEL   : [0x04][8B id]               — transfer aborted
//
// Transfer ID is a fixed 8-byte ASCII string embedded in every binary frame
// so the receiver can always route chunks to the correct file, even when
// multiple transfers are in-flight simultaneously.

const MSG_META     = 0x01;
const MSG_CHUNK    = 0x02;
const MSG_COMPLETE = 0x03;
const MSG_CANCEL   = 0x04;
const ID_BYTES     = 8; // bytes reserved for transfer id in binary frames

const enc = new TextEncoder();
const dec = new TextDecoder();

function genId() {
  // 8-char alphanumeric, fits in exactly ID_BYTES bytes when ASCII-encoded
  const arr = crypto.getRandomValues(new Uint8Array(6));
  return btoa(String.fromCharCode(...arr)).replace(/[^a-zA-Z0-9]/g, "x").slice(0, 8);
}

function writeId(view, offset, id) {
  const b = enc.encode(id.padEnd(ID_BYTES, "\0"));
  for (let i = 0; i < ID_BYTES; i++) view.setUint8(offset + i, b[i]);
}

function readId(bytes, offset) {
  return dec.decode(bytes.slice(offset, offset + ID_BYTES)).replace(/\0/g, "");
}

function encodeControlMsg(typeByte, id) {
  // [type 1B][id 8B]
  const buf  = new ArrayBuffer(1 + ID_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, typeByte);
  writeId(view, 1, id);
  return buf;
}

function encodeMetaMsg(id, meta) {
  // [0x01][id 8B][JSON bytes]
  const json  = enc.encode(JSON.stringify(meta));
  const buf   = new ArrayBuffer(1 + ID_BYTES + json.length);
  const view  = new DataView(buf);
  view.setUint8(0, MSG_META);
  writeId(view, 1, id);
  new Uint8Array(buf, 1 + ID_BYTES).set(json);
  return buf;
}

function encodeChunkMsg(id, index, encrypted) {
  // [0x02][id 8B][index 4B][encrypted]
  const buf  = new ArrayBuffer(1 + ID_BYTES + 4 + encrypted.length);
  const view = new DataView(buf);
  view.setUint8(0, MSG_CHUNK);
  writeId(view, 1, id);
  view.setUint32(1 + ID_BYTES, index, false);
  new Uint8Array(buf, 1 + ID_BYTES + 4).set(encrypted);
  return buf;
}

// ── Main class ───────────────────────────────────────────────────────────────

export class FileTransferManager extends EventTarget {
  constructor(mesh, cryptoKey) {
    super();
    this.mesh = mesh;
    this.key  = cryptoKey;

    this.outQueue  = [];
    this.outActive = null;
    this.inActives = new Map(); // transferKey (`${peerId}:${id}`) → state

    mesh.addEventListener("data", (e) => {
      if (e.detail.kind === "file")
        this._onFileData(e.detail.data, e.detail.peerId);
    });
  }

  // ── Send side ─────────────────────────────────────────────────────────────

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
    const { id, file } = this.outQueue.shift();
    const totalChunks  = Math.ceil(file.size / CHUNK_SIZE) || 1;

    this.outActive = { id, file, totalChunks, startTime: Date.now(), bytesSent: 0 };

    this.mesh.broadcast("file", encodeMetaMsg(id, {
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
      totalChunks,
    }));

    await this._sendAllChunks();
  }

  async _sendAllChunks() {
    const active = this.outActive;
    if (!active) return;
    const { id, file, totalChunks: total } = active;
    const pipeline = new Map(); // index → Promise<ArrayBuffer>

    const makeFrame = async (i) => {
      const start     = i * CHUNK_SIZE;
      const slice     = await file.slice(start, start + CHUNK_SIZE).arrayBuffer();
      const encrypted = await CryptoModule.encryptBytes(this.key, slice);
      return encodeChunkMsg(id, i, encrypted);
    };

    // Pre-fill pipeline
    let readHead = 0;
    while (readHead < total && readHead < PIPELINE_DEPTH) {
      pipeline.set(readHead, makeFrame(readHead));
      readHead++;
    }

    let lastTs = 0;

    for (let i = 0; i < total; i++) {
      // Backpressure
      while (this.mesh.bufferedAmount("file") > BUFFERED_AMOUNT_HIGH) {
        await this._waitForDrain();
      }

      const frame = await pipeline.get(i);
      pipeline.delete(i);

      if (readHead < total) { pipeline.set(readHead, makeFrame(readHead)); readHead++; }

      this.mesh.broadcast("file", frame);
      active.bytesSent = Math.min((i + 1) * CHUNK_SIZE, file.size);

      const now = Date.now();
      if (now - lastTs >= PROGRESS_INTERVAL_MS || i === total - 1) {
        lastTs = now;
        const elapsed  = (now - active.startTime) / 1000;
        const speedBps = elapsed > 0.5 ? active.bytesSent / elapsed : 0;
        const etaSec   = speedBps > 0 ? (file.size - active.bytesSent) / speedBps : null;
        this.dispatchEvent(new CustomEvent("send-progress", {
          detail: { id, sent: i + 1, total,
                    bytesSent: active.bytesSent, fileSize: file.size,
                    speedBps, etaSec },
        }));
      }
    }

    // Complete signal carries the ID so receiver knows which transfer finished
    this.mesh.broadcast("file", encodeControlMsg(MSG_COMPLETE, id));
    this.dispatchEvent(new CustomEvent("send-complete", { detail: { id } }));
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

  // ── Receive side ──────────────────────────────────────────────────────────
  // Synchronous — no await, no races. Every binary frame carries the transfer
  // ID so routing is always exact, even with multiple concurrent transfers.

  _onFileData(data, fromPeerId) {
    if (typeof data === "string") return; // reject legacy strings defensively

    const bytes = new Uint8Array(data);
    if (bytes.length < 1) return;
    const type = bytes[0];

    if (type === MSG_META) {
      if (bytes.length < 1 + ID_BYTES) return;
      const id  = readId(bytes, 1);
      let   meta;
      try { meta = JSON.parse(dec.decode(bytes.slice(1 + ID_BYTES))); } catch { return; }

      const transferKey = `${fromPeerId}:${id}`;
      this.inActives.set(transferKey, {
        id, name: meta.name, size: meta.size, mime: meta.mime,
        total: meta.totalChunks,
        chunks: new Array(meta.totalChunks).fill(null),
        decryptedCount: 0,
        completeReceived: false,
        finished: false,
        fromPeerId, transferKey,
        startTime: Date.now(), lastProgressTs: 0,
      });
      this.dispatchEvent(new CustomEvent("receive-start", {
        detail: { id: transferKey, name: meta.name, size: meta.size },
      }));
      return;
    }

    if (type === MSG_COMPLETE) {
      if (bytes.length < 1 + ID_BYTES) return;
      const id  = readId(bytes, 1);
      const key = `${fromPeerId}:${id}`;
      const active = this.inActives.get(key);
      if (active) {
        active.completeReceived = true;
        this._checkAndFinish(active);
      }
      return;
    }

    if (type === MSG_CANCEL) {
      if (bytes.length < 1 + ID_BYTES) return;
      const id  = readId(bytes, 1);
      const key = `${fromPeerId}:${id}`;
      const active = this.inActives.get(key);
      if (active) {
        this.inActives.delete(key);
        this.dispatchEvent(new CustomEvent("receive-cancelled", { detail: { id: key } }));
      }
      return;
    }

    if (type === MSG_CHUNK) {
      // [0x02][id 8B][index 4B][encrypted...]
      if (bytes.length < 1 + ID_BYTES + 4) return;
      const id         = readId(bytes, 1);
      const key        = `${fromPeerId}:${id}`;
      const active     = this.inActives.get(key); // exact lookup — no wrong-file routing
      if (!active || active.finished) return;

      const chunkIndex = new DataView(bytes.buffer, bytes.byteOffset + 1 + ID_BYTES, 4)
                           .getUint32(0, false);
      const encrypted  = bytes.buffer.slice(
        bytes.byteOffset + 1 + ID_BYTES + 4,
        bytes.byteOffset + bytes.length
      );

      if (chunkIndex >= active.total) return; // sanity

      const cap = active;
      const idx = chunkIndex;

      CryptoModule.decryptBytes(this.key, encrypted).then((plain) => {
        if (cap.finished) return; // already done, discard
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
            detail: { id: cap.transferKey,
                      received: cap.decryptedCount, total: cap.total,
                      bytesReceived: bytesRx, fileSize: cap.size,
                      speedBps, etaSec },
          }));
        }

        this._checkAndFinish(cap);
      }).catch((err) => console.error("Decrypt failed chunk", idx, err));
    }
  }

  _checkAndFinish(active) {
    if (active.finished)          return;
    if (!active.completeReceived) return;
    if (active.decryptedCount < active.total) return;
    // Verify no gaps
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
