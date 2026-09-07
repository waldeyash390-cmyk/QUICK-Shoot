// signaling.js — talks to the server only to exchange room codes and
// WebRTC handshake metadata (SDP/ICE). Never carries chat or file content.

export class Signaling extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    this._reconnectAttempts = 0;
    this._manualClose = false;
    this._keepaliveTimer = null;
  }

  connect() {
    this._manualClose = false;
    this.ws = new WebSocket(this.url);

    this.ws.addEventListener("open", () => {
  this._reconnectAttempts = 0;
  clearInterval(this._keepaliveTimer);
  this._keepaliveTimer = setInterval(() => {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "ping" }));
    }
  }, 20_000);
  this.dispatchEvent(new Event("open"));
});

    this.ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this.dispatchEvent(new CustomEvent("message", { detail: msg }));
    });

    this.ws.addEventListener("close", () => {
  clearInterval(this._keepaliveTimer);
  this.dispatchEvent(new Event("close"));
  if (!this._manualClose) this._scheduleReconnect();
});

    this.ws.addEventListener("error", () => {
      this.dispatchEvent(new Event("error"));
    });
  }

  _scheduleReconnect() {
    this._reconnectAttempts++;
    const delay = Math.min(1000 * 2 ** this._reconnectAttempts, 10_000);
    setTimeout(() => {
      if (!this._manualClose) this.connect();
    }, delay);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  close() {
  this._manualClose = true;
  clearInterval(this._keepaliveTimer);
  if (this.ws) this.ws.close();
  }
}
