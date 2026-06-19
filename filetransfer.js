// filetransfer.js — multi-user version.
// Sending: broadcasts file chunks to all connected peers.
// Receiving: tracks one active incoming transfer PER sender peer.

import { CryptoModule } from "./crypto.js";

const CHUNK_SIZE = 16 * 1024;
const BUFFERED_AMOUNT_HIGH = 1 * 1024 * 1024;
const BUFFERED_AMOUNT_LOW = 256 * 1024;

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
    /** @type {Map<string, object>} peerId -> active incoming transfer */
    this.inActives = new Map();

    mesh.addEventListener("data", (e) => {
      if (e.detail.kind === "file") this._onFileData(e.detail.data, e.detail.peerId);
    });
  }

  enqueue(files) {
    for (const file of files) {
      const id = genId();
      this.outQueue.push({ id, file });
      this.dispatchEvent(new CustomEvent("queued", { detail: { id, name: file.name, size: file.size } }));
    }
    this._pump();
  }

  async _pump() {
    if (this.outActive || this.outQueue.length === 0) return;
    const job = this.outQueue.shift();
    this.outActive = {
      id: job.id,
      file: job.file,
      chunkIndex: 0,
      totalChunks: Math.ceil(job.file.size / CHUNK_SIZE) || 1,
    };

    this.mesh.broadcast("file", JSON.stringify({
      t: "meta",
      id: job.id,
      name: job.file.name,
      size: job.file.size,
      mime: job.file.type || "application/octet-stream",
      totalChunks: this.outActive.totalChunks,
    }));

    await this._sendChunksFrom(0);
  }

  async _sendChunksFrom(startChunk) {
    const active = this.outActive;
    if (!active) return;
    active.chunkIndex = startChunk;

    while (active.chunkIndex < active.totalChunks) {
      if (this.mesh.bufferedAmount("file") > BUFFERED_AMOUNT_HIGH) {
        await this._waitForDrain();
      }

      const start = active.chunkIndex * CHUNK_SIZE;
      const slice = await active.file.slice(start, start + CHUNK_SIZE).arrayBuffer();
      const encrypted = await CryptoModule.encryptBytes(this.key, slice);

      const header = new Uint8Array(4);
      new DataView(header.buffer).setUint32(0, active.chunkIndex, false);
      const frame = new Uint8Array(header.length + encrypted.length);
      frame.set(header, 0);
      frame.set(encrypted, header.length);

      this.mesh.broadcast("file", frame.buffer);

      active.chunkIndex++;
      this.dispatchEvent(new CustomEvent("send-progress", {
        detail: { id: active.id, sent: active.chunkIndex, total: active.totalChunks },
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
      const handler = () => { channel.removeEventListener("bufferedamountlow", handler); resolve(); };
      channel.addEventListener("bufferedamountlow", handler);
    });
  }

  resumeIfNeeded() {
    if (this.outActive) this._sendChunksFrom(this.outActive.chunkIndex);
  }

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
          fromPeerId,
          transferKey,
        });
        this.dispatchEvent(new CustomEvent("receive-start", {
          detail: { id: transferKey, name: msg.name, size: msg.size },
        }));
      } else if (msg.t === "complete") {
        // find the transfer from this peer
        for (const [key, active] of this.inActives) {
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

    // Binary chunk — identify which transfer it belongs to by sender
    const bytes = new Uint8Array(data);
    const chunkIndex = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
    const encrypted = bytes.slice(4);
    const plain = await CryptoModule.decryptBytes(this.key, encrypted);

    // Find the active transfer for this sender
    let active = null;
    for (const a of this.inActives.values()) {
      if (a.fromPeerId === fromPeerId) { active = a; break; }
    }
    if (!active) return;

    active.chunks[chunkIndex] = plain;
    active.received++;

    this.dispatchEvent(new CustomEvent("receive-progress", {
      detail: { id: active.transferKey, received: active.received, total: active.total },
    }));
  }

  async _finishIncoming(active) {
    const blob = new Blob(active.chunks, { type: active.mime });
    this.dispatchEvent(new CustomEvent("receive-complete", {
      detail: { id: active.transferKey, name: active.name, size: active.size, blob },
    }));
    this.inActives.delete(active.transferKey);
  }
}
