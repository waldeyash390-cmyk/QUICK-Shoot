// filetransfer.js — maximum throughput version.
// Uses a parallel pipeline: multiple chunks are encrypted and queued
// simultaneously so the channel is never starved waiting for crypto.
// This mirrors how speed tests saturate bandwidth — continuous data flow.

import { CryptoModule } from "./crypto.js";

const CHUNK_SIZE = 512 * 1024;           // 512KB chunks
const PIPELINE_DEPTH = 8;                // encrypt 8 chunks ahead in parallel
const BUFFERED_AMOUNT_HIGH = 8 * 1024 * 1024;  // 8MB buffer before pausing
const BUFFERED_AMOUNT_LOW  = 1 * 1024 * 1024;  // resume at 1MB

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
    this.inActives = new Map();

    mesh.addEventListener("data", (e) => {
      if (e.detail.kind === "file") this._onFileData(e.detail.data, e.detail.peerId);
    });
  }

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
    this.outActive = {
      id: job.id,
      file: job.file,
      totalChunks: Math.ceil(job.file.size / CHUNK_SIZE) || 1,
      startTime: Date.now(),
      bytesSent: 0,
      chunksSent: 0,
    };

    this.mesh.broadcast("file", JSON.stringify({
      t: "meta",
      id: job.id,
      name: job.file.name,
      size: job.file.size,
      mime: job.file.type || "application/octet-stream",
      totalChunks: this.outActive.totalChunks,
    }));

    await this._sendAllChunks();
  }

  async _sendAllChunks() {
    const active = this.outActive;
    if (!active) return;

    const total = active.totalChunks;
    let nextChunkToRead = 0;
    let nextChunkToSend = 0;
    const pipeline = new Map();

    const encryptChunk = async (index) => {
      const start = index * CHUNK_SIZE;
      const slice = await active.file.slice(start, start + CHUNK_SIZE).arrayBuffer();
      const encrypted = await CryptoModule.encryptBytes(this.key, slice);
      const header = new Uint8Array(4);
      new DataView(header.buffer).setUint32(0, index, false);
      const frame = new Uint8Array(4 + encrypted.length);
      frame.set(header, 0);
      frame.set(encrypted, 4);
      return frame;
    };

    while (
      nextChunkToRead < total &&
      nextChunkToRead - nextChunkToSend < PIPELINE_DEPTH
    ) {
      const idx = nextChunkToRead++;
      encryptChunk(idx).then((frame) => pipeline.set(idx, frame));
    }

    while (nextChunkToSend < total) {
      while (this.mesh.bufferedAmount("file") > BUFFERED_AMOUNT_HIGH) {
        await this._waitForDrain();
      }

      while (!pipeline.has(nextChunkToSend)) {
        await new Promise((r) => setTimeout(r, 1));
      }

      const frame = pipeline.get(nextChunkToSend);
      pipeline.delete(nextChunkToSend);
      this.mesh.broadcast("file", frame.buffer);

      nextChunkToSend++;
      active.chunksSent = nextChunkToSend;
      active.bytesSent = Math.min(nextChunkToSend * CHUNK_SIZE, active.file.size);

      if (nextChunkToRead < total) {
        const idx = nextChunkToRead++;
        encryptChunk(idx).then((frame) => pipeline.set(idx, frame));
      }

      const elapsed = (Date.now() - active.startTime) / 1000;
      const speedBps = elapsed > 0.5 ? active.bytesSent / elapsed : 0;
      const remaining = active.file.size - active.bytesSent;
      const etaSec = speedBps > 0 ? remaining / speedBps : null;

      this.dispatchEvent(new CustomEvent("send-progress", {
        detail: {
          id: active.id,
          sent: nextChunkToSend,
          total,
          bytesSent: active.bytesSent,
          fileSize: active.file.size,
          speedBps,
          etaSec,
        },
      }));
    }

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

  async _onFileData(data, fromPeerId) {
    if (typeof data === "string") {
      const msg = JSON.parse(data);
      if (msg.t === "meta") {
        const transferKey = `${fromPeerId}:${msg.id}`;
        this.inActives.set(transferKey, {
          id: msg.id,
          name: msg.name,
          size: msg.size,
          mime: msg.mime,
          total: msg.totalChunks,
          chunks: new Array(msg.totalChunks),
          received: 0,
          bytesReceived: 0,
          fromPeerId,
          transferKey,
          startTime: Date.now(),
        });
        this.dispatchEvent(new CustomEvent("receive-start", {
          detail: { id: transferKey, name: msg.name, size: msg.size },
        }));
      } else if (msg.t === "complete") {
        for (const [, active] of this.inActives) {
          if (active.fromPeerId === fromPeerId && active.id === msg.id) {
            await this._finishIncoming(active);
            break;
          }
        }
      } else if (msg.t === "cancel") {
        for (const [key, active] of this.inActives) {
          if (active.fromPeerId === fromPeerId) {
            this.inActives.delete(key);
            this.dispatchEvent(new CustomEvent("receive-cancelled", { detail: { id: key } }));
          }
        }
      }
      return;
    }

    const bytes = new Uint8Array(data);
    const chunkIndex = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
    const encrypted = bytes.slice(4);

    let active = null;
    for (const a of this.inActives.values()) {
      if (a.fromPeerId === fromPeerId) { active = a; break; }
    }
    if (!active) return;

    CryptoModule.decryptBytes(this.key, encrypted).then((plain) => {
      active.chunks[chunkIndex] = plain;
      active.received++;
      active.bytesReceived = Math.min(active.received * CHUNK_SIZE, active.size);

      const elapsed = (Date.now() - active.startTime) / 1000;
      const speedBps = elapsed > 0.5 ? active.bytesReceived / elapsed : 0;
      const remaining = active.size - active.bytesReceived;
      const etaSec = speedBps > 0 ? remaining / speedBps : null;

      this.dispatchEvent(new CustomEvent("receive-progress", {
        detail: {
          id: active.transferKey,
          received: active.received,
          total: active.total,
          bytesReceived: active.bytesReceived,
          fileSize: active.size,
          speedBps,
          etaSec,
        },
      }));
    });
  }

  async _finishIncoming(active) {
    await new Promise((resolve) => {
      const check = () => {
        if (active.received >= active.total) return resolve();
        setTimeout(check, 10);
      };
      check();
    });
    const blob = new Blob(active.chunks, { type: active.mime });
    this.dispatchEvent(new CustomEvent("receive-complete", {
      detail: { id: active.transferKey, name: active.name, size: active.size, blob },
    }));
    this.inActives.delete(active.transferKey);
  }
}
