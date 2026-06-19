// webrtc.js — multi-user mesh peer link manager.
// Each PeerMesh manages one RTCPeerConnection per remote peer.
// When a new user joins, we initiate a fresh connection to them.
// All data events bubble up so app.js handles them uniformly.

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

class PeerConnection extends EventTarget {
  constructor(remotePeerId, signaling, isInitiator) {
    super();
    this.remotePeerId = remotePeerId;
    this.signaling = signaling;
    this.isInitiator = isInitiator;
    this.pc = null;
    this.chatChannel = null;
    this.fileChannel = null;
    this._statsTimer = null;
    this._ready = false;
  }

  async start() {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.signaling.send({
          type: "signal",
          to: this.remotePeerId,
          payload: { candidate: e.candidate },
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      this.dispatchEvent(new CustomEvent("state", { detail: { peerId: this.remotePeerId, state } }));
      if (state === "connected") {
        this._ready = true;
        this._startStatsLoop();
      }
      if (["failed", "disconnected", "closed"].includes(state)) {
        this._ready = false;
        this._stopStatsLoop();
      }
    };

    if (this.isInitiator) {
      this.chatChannel = this.pc.createDataChannel("chat", { ordered: true });
      this.fileChannel = this.pc.createDataChannel("file", { ordered: true });
      this._wireChannel(this.chatChannel, "chat");
      this._wireChannel(this.fileChannel, "file");
      await this._makeOffer();
    } else {
      this.pc.ondatachannel = (e) => {
        if (e.channel.label === "chat") {
          this.chatChannel = e.channel;
          this._wireChannel(e.channel, "chat");
        } else if (e.channel.label === "file") {
          this.fileChannel = e.channel;
          this._wireChannel(e.channel, "file");
        }
      };
    }
  }

  _wireChannel(channel, kind) {
    channel.binaryType = "arraybuffer";
    channel.onopen = () =>
      this.dispatchEvent(new CustomEvent("channel-open", { detail: { peerId: this.remotePeerId, kind } }));
    channel.onclose = () =>
      this.dispatchEvent(new CustomEvent("channel-close", { detail: { peerId: this.remotePeerId, kind } }));
    channel.onmessage = (e) =>
      this.dispatchEvent(new CustomEvent("data", { detail: { peerId: this.remotePeerId, kind, data: e.data } }));
  }

  async _makeOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.signaling.send({
      type: "signal",
      to: this.remotePeerId,
      payload: { sdp: this.pc.localDescription },
    });
  }

  async handleSignal(payload) {
    const { sdp, candidate } = payload;
    if (sdp) {
      await this.pc.setRemoteDescription(sdp);
      if (sdp.type === "offer") {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.signaling.send({
          type: "signal",
          to: this.remotePeerId,
          payload: { sdp: this.pc.localDescription },
        });
      }
    } else if (candidate) {
      try { await this.pc.addIceCandidate(candidate); } catch { /* benign */ }
    }
  }

  send(kind, data) {
    const channel = kind === "chat" ? this.chatChannel : this.fileChannel;
    if (channel && channel.readyState === "open") channel.send(data);
  }

  bufferedAmount(kind) {
    const ch = kind === "chat" ? this.chatChannel : this.fileChannel;
    return ch ? ch.bufferedAmount : 0;
  }

  isReady() { return this._ready; }

  _startStatsLoop() {
    this._stopStatsLoop();
    this._statsTimer = setInterval(async () => {
      if (!this.pc) return;
      const stats = await this.pc.getStats();
      let rttMs = null;
      stats.forEach((r) => {
        if (r.type === "candidate-pair" && r.state === "succeeded" && r.currentRoundTripTime != null) {
          rttMs = r.currentRoundTripTime * 1000;
        }
      });
      if (rttMs != null)
        this.dispatchEvent(new CustomEvent("rtt", { detail: { peerId: this.remotePeerId, rttMs } }));
    }, 3000);
  }

  _stopStatsLoop() {
    if (this._statsTimer) clearInterval(this._statsTimer);
    this._statsTimer = null;
  }

  close() {
    this._stopStatsLoop();
    this._ready = false;
    if (this.chatChannel) this.chatChannel.close();
    if (this.fileChannel) this.fileChannel.close();
    if (this.pc) this.pc.close();
  }
}

/**
 * PeerMesh — manages connections to ALL peers in a room.
 * Exposes the same event surface as the old PeerLink so app.js stays simple.
 */
export class PeerMesh extends EventTarget {
  constructor(signaling, myPeerId) {
    super();
    this.signaling = signaling;
    this.myPeerId = myPeerId;
    /** @type {Map<string, PeerConnection>} */
    this.connections = new Map();

    signaling.addEventListener("message", (e) => this._onSignalingMsg(e.detail));
  }

  /** Called once after joining: connect to every already-present peer. */
  async connectToExistingPeers(peerIds) {
    for (const pid of peerIds) {
      await this._createConnection(pid, true /* we initiate */);
    }
  }

  /** Server told us a new peer joined — they will initiate toward us. */
  async acceptNewPeer(peerId) {
    await this._createConnection(peerId, false);
  }

  async _createConnection(remotePeerId, isInitiator) {
    if (this.connections.has(remotePeerId)) return;
    const conn = new PeerConnection(remotePeerId, this.signaling, isInitiator);

    conn.addEventListener("state", (e) => {
      const { peerId, state } = e.detail;
      this.dispatchEvent(new CustomEvent("peer-state", { detail: { peerId, state } }));
      // Bubble up a generic "state" for the first/last connection for backward compat
      const connectedCount = [...this.connections.values()].filter(c => c.isReady()).length;
      if (state === "connected") this.dispatchEvent(new CustomEvent("state", { detail: "connected" }));
      if (["failed", "disconnected", "closed"].includes(state) && connectedCount === 0)
        this.dispatchEvent(new CustomEvent("state", { detail: "disconnected" }));
    });

    conn.addEventListener("rtt", (e) => {
      this.dispatchEvent(new CustomEvent("rtt", { detail: e.detail.rttMs }));
    });

    conn.addEventListener("channel-open", (e) => {
      this.dispatchEvent(new CustomEvent("channel-open", { detail: e.detail }));
    });

    conn.addEventListener("data", (e) => {
      this.dispatchEvent(new CustomEvent("data", { detail: e.detail }));
    });

    this.connections.set(remotePeerId, conn);
    await conn.start();
  }

  _onSignalingMsg(msg) {
    if (msg.type === "signal") {
      const conn = this.connections.get(msg.from);
      if (conn) conn.handleSignal(msg.payload);
    }
  }

  removePeer(peerId) {
    const conn = this.connections.get(peerId);
    if (conn) { conn.close(); this.connections.delete(peerId); }
  }

  /** Send to all open connections. */
  broadcast(kind, data) {
    for (const conn of this.connections.values()) conn.send(kind, data);
  }

  /** Send to one specific peer. */
  sendTo(peerId, kind, data) {
    const conn = this.connections.get(peerId);
    if (conn) conn.send(kind, data);
  }

  /** For backward compat with filetransfer (single-target send). */
  send(kind, data) { this.broadcast(kind, data); }

  bufferedAmount(kind) {
    let max = 0;
    for (const c of this.connections.values()) max = Math.max(max, c.bufferedAmount(kind));
    return max;
  }

  get fileChannel() {
    // Return the first open file channel for backpressure compatibility
    for (const c of this.connections.values()) if (c.fileChannel) return c.fileChannel;
    return null;
  }

  connectedPeerCount() {
    return [...this.connections.values()].filter(c => c.isReady()).length;
  }

  close() {
    for (const c of this.connections.values()) c.close();
    this.connections.clear();
  }
}
