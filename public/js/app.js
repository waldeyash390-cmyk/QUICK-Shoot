// app.js — multi-user entry point. No framework, plain DOM.

import { CryptoModule } from "./crypto.js";
import { Signaling } from "./signaling.js";
import { PeerMesh } from "./webrtc.js";
import { FileTransferManager } from "./filetransfer.js";

// ---------------------------------------------------------------- DOM refs
const $ = (id) => document.getElementById(id);

const els = {
  roomTag: $("roomTag"),
  settingsBtn: $("settingsBtn"),

  screenHome: $("screenHome"),
  hostBtn: $("hostBtn"),
  joinForm: $("joinForm"),
  joinCodeInput: $("joinCodeInput"),
  homeError: $("homeError"),

  screenWaiting: $("screenWaiting"),
  waitingLabel: $("waitingLabel"),
  roomCodeBlock: $("roomCodeBlock"),
  roomCodeText: $("roomCodeText"),
  copyCodeBtn: $("copyCodeBtn"),
  qrImg: $("qrImg"),
  waitingHint: $("waitingHint"),
  cancelWaitBtn: $("cancelWaitBtn"),

  screenChat: $("screenChat"),
  messages: $("messages"),
  peerCount: $("peerCount"),
  fileDrop: $("fileDrop"),
  fileInput: $("fileInput"),
  fileList: $("fileList"),
  composerForm: $("composerForm"),
  attachBtn: $("attachBtn"),
  messageInput: $("messageInput"),
  typingIndicator: $("typingIndicator"),

  settingsOverlay: $("settingsOverlay"),
  settingsConnState: $("settingsConnState"),
  settingsRoomCode: $("settingsRoomCode"),
  settingsTimer: $("settingsTimer"),
  leaveBtn: $("leaveBtn"),
  closeSettingsBtn: $("closeSettingsBtn"),

  leaveConfirmOverlay: $("leaveConfirmOverlay"),
  leaveCancelBtn: $("leaveCancelBtn"),
  leaveConfirmBtn: $("leaveConfirmBtn"),

  toast: $("toast"),
};

// ---------------------------------------------------------------- state
const state = {
  roomCode: null,
  myPeerId: null,
  signaling: null,
  mesh: null,         // PeerMesh replaces peerLink
  cryptoKey: null,
  fileTransfer: null,
  connectedAt: null,
  timerHandle: null,
  myMsgCount: 0,
  // Track which peers are typing
  typingPeers: new Set(),
};

// ---------------------------------------------------------------- helpers
function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true; }

function showScreen(name) {
  hide(els.screenHome);
  hide(els.screenWaiting);
  hide(els.screenChat);
  if (name === "home") show(els.screenHome);
  if (name === "waiting") show(els.screenWaiting);
  if (name === "chat") show(els.screenChat);
}

function setStatus(stateName, label) {
  els.settingsConnState.textContent = label;
}

function updatePeerCount() {
  if (!state.mesh) return;
  const n = state.mesh.connectedPeerCount();
  // n peers + me = n+1 total in room
  els.peerCount.textContent = `${n + 1} in room`;
}

function toast(msg, ms = 2200) {
  els.toast.textContent = msg;
  show(els.toast);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => hide(els.toast), ms);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatClock(totalSeconds) {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const s = Math.floor(totalSeconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function normalizeCode(raw) {
  return raw.toUpperCase().replace(/[^A-Z0-9-]/g, "");
}

function resetToHome() {
  showScreen("home");
  setStatus("offline", "Offline");
  hide(els.roomTag);
  hide(els.peerCount);
  hide(els.settingsBtn);
  els.messages.innerHTML = "";
  els.fileList.innerHTML = "";
  els.joinCodeInput.value = "";
  hide(els.homeError);
  if (state.timerHandle) clearInterval(state.timerHandle);
  state.roomCode = null;
  state.myPeerId = null;
  state.mesh = null;
  state.cryptoKey = null;
  state.fileTransfer = null;
  state.connectedAt = null;
  state.typingPeers.clear();
  updateTypingIndicator();
}

// ---------------------------------------------------------------- host flow
async function startHosting() {
  showScreen("waiting");
  els.waitingLabel.textContent = "Setting up your room…";
  hide(els.roomCodeBlock);
  hide(els.qrImg);
  els.waitingHint.textContent = "Generating a secure room code…";
  setStatus("connecting", "Connecting…");

  state.signaling = new Signaling();
  state.signaling.addEventListener("open", () => state.signaling.send({ type: "host" }));
  state.signaling.addEventListener("message", (e) => handleSignalingMessage(e.detail));
  state.signaling.connect();
}

async function startJoining(code) {
  state.roomCode = code;
  showScreen("waiting");
  els.waitingLabel.textContent = `Joining ${code}…`;
  hide(els.roomCodeBlock);
  hide(els.qrImg);
  els.waitingHint.textContent = "Connecting to the room…";
  setStatus("connecting", "Connecting…");

  state.signaling = new Signaling();
  state.signaling.addEventListener("open", () => state.signaling.send({ type: "join", code }));
  state.signaling.addEventListener("message", (e) => handleSignalingMessage(e.detail));
  state.signaling.connect();
}

async function handleSignalingMessage(msg) {
  switch (msg.type) {

    case "hosted": {
      state.roomCode = msg.code;
      state.myPeerId = msg.peerId;
      els.roomCodeText.textContent = msg.code;
      show(els.roomCodeBlock);
      els.waitingLabel.textContent = "Waiting for others to join…";
      els.waitingHint.textContent = "Share this code. Anyone with it can join the room.";
      const shareUrl = `${location.origin}${location.pathname}?code=${encodeURIComponent(msg.code)}`;
      els.qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&qzone=1&data=${encodeURIComponent(shareUrl)}`;
      show(els.qrImg);
      // Host creates the mesh but waits; no peers yet
      state.cryptoKey = await CryptoModule.deriveKeyFromRoomCode(state.roomCode);
      state.mesh = new PeerMesh(state.signaling, state.myPeerId);
      wireMeshEvents();
      // Host enters chat immediately so they can see who joins
      onFirstConnect();
      break;
    }

    case "joined": {
      state.myPeerId = msg.peerId;
      state.roomCode = msg.code;
      state.cryptoKey = await CryptoModule.deriveKeyFromRoomCode(state.roomCode);
      state.mesh = new PeerMesh(state.signaling, state.myPeerId);
      wireMeshEvents();
      // Connect to every peer already in the room
      if (msg.peers.length > 0) {
        await state.mesh.connectToExistingPeers(msg.peers);
      } else {
        // Room was empty (e.g. host left, room not destroyed yet — shouldn't normally happen)
        onFirstConnect();
      }
      break;
    }

    case "peer-joined": {
      // Someone new entered; as the existing user we don't initiate — they do
      if (state.mesh) {
        await state.mesh.acceptNewPeer(msg.peerId);
        // Let them know we're here via mesh event
      }
      break;
    }

    case "peer-left": {
      if (state.mesh) {
        state.mesh.removePeer(msg.peerId);
        addSystemMessage(`A user left the room.`);
        state.typingPeers.delete(msg.peerId);
        updateTypingIndicator();
        updatePeerCount();
      }
      break;
    }

    case "error": {
      toast(msg.message);
      els.homeError.textContent = msg.message;
      show(els.homeError);
      cleanupConnection();
      showScreen("home");
      break;
    }

    case "room-closed": {
      toast("Session ended — room closed.");
      cleanupConnection();
      showScreen("home");
      break;
    }

    default:
      break; // signal messages are consumed by PeerMesh internals
  }
}

let _firstConnectDone = false;

function onFirstConnect() {
  if (_firstConnectDone) return;
  _firstConnectDone = true;
  state.connectedAt = Date.now();
  state.fileTransfer = new FileTransferManager(state.mesh, state.cryptoKey);
  wireFileTransferEvents();

  showScreen("chat");
  els.roomTag.textContent = state.roomCode;
  show(els.roomTag);
  show(els.peerCount);
  show(els.settingsBtn);
  els.settingsRoomCode.textContent = state.roomCode;
  setStatus("online", "Connected");
  addSystemMessage("Joined room. Share the code for others to join!");
  updatePeerCount();

  state.timerHandle = setInterval(() => {
    const secs = Math.floor((Date.now() - state.connectedAt) / 1000);
    const clock = formatClock(secs);
    els.settingsTimer.textContent = clock;
  }, 1000);
}

function wireMeshEvents() {
  state.mesh.addEventListener("state", (e) => {
    if (e.detail === "connected") {
      onFirstConnect();
      updatePeerCount();
    }
    if (["disconnected", "failed", "closed"].includes(e.detail)) {
      setStatus("offline", "Disconnected");
    }
  });

  state.mesh.addEventListener("peer-state", (e) => {
    const { peerId, state: peerState } = e.detail;
    if (peerState === "connected") {
      addSystemMessage("A new user joined the room.");
      updatePeerCount();
    }
  });

  state.mesh.addEventListener("rtt", (e) => updateQuality(e.detail));

  state.mesh.addEventListener("data", (e) => {
    if (e.detail.kind === "chat") onChatData(e.detail.data, e.detail.peerId);
  });
}

function onDisconnected() {
  setStatus("offline", "Disconnected");
  addSystemMessage("Connection lost. The other person may have left.");
}

function cleanupConnection() {
  _firstConnectDone = false;
  if (state.mesh) state.mesh.close();
  if (state.signaling) state.signaling.close();
  if (state.timerHandle) clearInterval(state.timerHandle);
}

function updateQuality(rttMs) {
  // Signal-strength bars removed from the UI; quality data is no longer displayed.
}

// ---------------------------------------------------------------- chat
function addMessage({ text, mine, ts, senderLabel }) {
  const div = document.createElement("div");
  div.className = `msg ${mine ? "me" : ""}`;
  const body = document.createElement("span");
  body.className = "body";
  body.textContent = text;
  const meta = document.createElement("span");
  meta.className = "meta";
  const time = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  meta.textContent = mine ? time : `${senderLabel || "Peer"} · ${time}`;
  div.append(body, meta);
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

function addSystemMessage(text) {
  const div = document.createElement("div");
  div.className = "msg system";
  div.textContent = text;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function updateTypingIndicator() {
  if (state.typingPeers.size > 0) {
    const n = state.typingPeers.size;
    els.typingIndicator.textContent = n === 1 ? "Someone is typing…" : `${n} people are typing…`;
    show(els.typingIndicator);
  } else {
    hide(els.typingIndicator);
  }
}

async function broadcastChatPayload(obj) {
  const encrypted = await CryptoModule.encryptJSON(state.cryptoKey, obj);
  state.mesh.broadcast("chat", encrypted.buffer.slice(0));
}

async function onChatData(rawArrayBuffer, fromPeerId) {
  const msg = await CryptoModule.decryptJSON(state.cryptoKey, rawArrayBuffer);
  const shortId = fromPeerId.slice(0, 4).toUpperCase();

  if (msg.t === "msg") {
    addMessage({ text: msg.text, mine: false, ts: msg.ts, senderLabel: shortId });
    state.typingPeers.delete(fromPeerId);
    updateTypingIndicator();
  } else if (msg.t === "typing") {
    if (msg.state) state.typingPeers.add(fromPeerId);
    else state.typingPeers.delete(fromPeerId);
    updateTypingIndicator();
  }
}

let typingTimeout = null;
els.messageInput.addEventListener("input", () => {
  if (!state.mesh) return;
  broadcastChatPayload({ t: "typing", state: true });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => broadcastChatPayload({ t: "typing", state: false }), 1500);

  els.messageInput.style.height = "auto";
  els.messageInput.style.height = `${els.messageInput.scrollHeight}px`;
});

els.composerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.messageInput.value.trim();
  if (!text || !state.mesh) return;

  const ts = Date.now();
  await broadcastChatPayload({ t: "msg", text, ts });
  addMessage({ text, mine: true, ts });

  els.messageInput.value = "";
  els.messageInput.style.height = "auto";
  clearTimeout(typingTimeout);
  broadcastChatPayload({ t: "typing", state: false });
});

els.messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.composerForm.requestSubmit();
  }
});

// ---------------------------------------------------------------- files
function formatSpeed(bps) {
  if (!bps || bps <= 0) return "";
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(2)} MB/s`;
}

function formatEta(sec) {
  if (sec === null || sec === undefined || !isFinite(sec) || sec < 0) return "";
  if (sec < 60) return `${Math.ceil(sec)}s left`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.ceil(sec % 60)}s left`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m left`;
}

// Build a rich file-item row and return refs to its updatable parts
function createFileItem({ id, name, size, direction }) {
  const li = document.createElement("li");
  li.className = "file-item file-item--active";
  li.id = `file-${id}`;
  li.innerHTML = `
    <div class="fi-top">
      <span class="fi-arrow">${direction === "up" ? "↑" : "↓"}</span>
      <span class="fi-name">${escapeHtml(name)}</span>
      <span class="fi-size">${formatBytes(size)}</span>
    </div>
    <div class="fi-bar-wrap">
      <progress class="fi-progress" max="100" value="0"></progress>
    </div>
    <div class="fi-bottom">
      <span class="fi-pct">0%</span>
      <span class="fi-speed"></span>
      <span class="fi-eta"></span>
      <span class="fi-spacer"></span>
      ${direction === "up" ? `
        <button class="fi-btn fi-pause" title="Pause">⏸</button>
        <button class="fi-btn fi-cancel" title="Cancel">✕</button>
      ` : `
        <button class="fi-btn fi-cancel" title="Cancel">✕</button>
      `}
    </div>`;
  els.fileList.appendChild(li);

  return {
    li,
    progress: li.querySelector(".fi-progress"),
    pct:      li.querySelector(".fi-pct"),
    speed:    li.querySelector(".fi-speed"),
    eta:      li.querySelector(".fi-eta"),
    pauseBtn: li.querySelector(".fi-pause"),
    cancelBtn:li.querySelector(".fi-cancel"),
  };
}

function wireFileTransferEvents() {
  const ft = state.fileTransfer;

  // Track pause state per outgoing transfer id
  const pausedIds = new Set();

  ft.addEventListener("queued", (e) => {
    const { id, name, size } = e.detail;
    const refs = createFileItem({ id, name, size, direction: "up" });

    if (refs.pauseBtn) {
      refs.pauseBtn.addEventListener("click", () => {
        if (pausedIds.has(id)) {
          // Resume
          pausedIds.delete(id);
          refs.pauseBtn.textContent = "⏸";
          refs.pauseBtn.title = "Pause";
          refs.li.classList.remove("file-item--paused");
          if (ft.resumeIfNeeded) ft.resumeIfNeeded();
        } else {
          // Pause
          pausedIds.add(id);
          refs.pauseBtn.textContent = "▶";
          refs.pauseBtn.title = "Resume";
          refs.li.classList.add("file-item--paused");
          refs.eta.textContent = "Paused";
          refs.speed.textContent = "";
        }
      });
    }

    if (refs.cancelBtn) {
      refs.cancelBtn.addEventListener("click", () => {
        if (ft.cancel) ft.cancel(id);
        refs.li.remove();
        pausedIds.delete(id);
      });
    }
  });

  ft.addEventListener("send-progress", (e) => {
    const { id, sent, total, speedBps, etaSec } = e.detail;
    if (pausedIds.has(id)) return;
    const li = document.getElementById(`file-${id}`);
    if (!li) return;
    const pct = Math.round((sent / total) * 100);
    li.querySelector(".fi-progress").value = pct;
    li.querySelector(".fi-pct").textContent  = `${pct}%`;
    li.querySelector(".fi-speed").textContent = formatSpeed(speedBps);
    li.querySelector(".fi-eta").textContent   = formatEta(etaSec);
  });

  ft.addEventListener("send-complete", (e) => {
    const li = document.getElementById(`file-${e.detail.id}`);
    if (!li) return;
    li.querySelector(".fi-progress").value   = 100;
    li.querySelector(".fi-pct").textContent  = "100%";
    li.querySelector(".fi-speed").textContent = "";
    li.querySelector(".fi-eta").textContent   = "Sent ✓";
    li.querySelector(".fi-bottom").querySelectorAll(".fi-btn").forEach(b => b.remove());
    li.classList.remove("file-item--active", "file-item--paused");
    li.classList.add("file-item--done");
  });

  ft.addEventListener("receive-start", (e) => {
    const { id, name, size } = e.detail;
    const refs = createFileItem({ id, name, size, direction: "down" });

    if (refs.cancelBtn) {
      refs.cancelBtn.addEventListener("click", () => {
        // Can't truly cancel a WebRTC receive mid-stream, just hide it
        refs.li.remove();
      });
    }
  });

  ft.addEventListener("receive-progress", (e) => {
    const { id, received, total, speedBps, etaSec } = e.detail;
    const li = document.getElementById(`file-${id}`);
    if (!li) return;
    const pct = Math.round((received / total) * 100);
    li.querySelector(".fi-progress").value   = pct;
    li.querySelector(".fi-pct").textContent  = `${pct}%`;
    li.querySelector(".fi-speed").textContent = formatSpeed(speedBps);
    li.querySelector(".fi-eta").textContent   = formatEta(etaSec);
  });

  ft.addEventListener("receive-complete", (e) => {
    const { id, name, blob } = e.detail;
    const li = document.getElementById(`file-${id}`);
    if (!li) return;
    const url = URL.createObjectURL(blob);

    li.classList.remove("file-item--active");
    li.classList.add("file-item--done");
    li.innerHTML = `
      <div class="fi-top">
        <span class="fi-arrow fi-arrow--done">↓</span>
        <span class="fi-name">${escapeHtml(name)}</span>
        <span class="fi-size">${formatBytes(blob.size)}</span>
      </div>
      <div class="fi-bottom">
        <span class="fi-eta fi-done-label">Done ✓</span>
        <span class="fi-spacer"></span>
        <a class="fi-btn fi-dl-btn" href="${url}" download="${escapeHtml(name)}">⬇ Download</a>
      </div>`;

    li.querySelector(".fi-dl-btn").addEventListener("click", () => {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });
  });

  ft.addEventListener("receive-cancelled", (e) => {
    const li = document.getElementById(`file-${e.detail.id}`);
    if (li) li.remove();
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

els.attachBtn.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => {
  if (els.fileInput.files.length && state.fileTransfer) {
    state.fileTransfer.enqueue([...els.fileInput.files]);
  }
  els.fileInput.value = "";
});

["dragover", "dragenter"].forEach((evt) =>
  els.fileDrop.addEventListener(evt, (e) => {
    e.preventDefault();
    els.fileDrop.classList.add("dragover");
  })
);
["dragleave", "dragend"].forEach((evt) =>
  els.fileDrop.addEventListener(evt, () => els.fileDrop.classList.remove("dragover"))
);
els.fileDrop.addEventListener("drop", (e) => {
  e.preventDefault();
  els.fileDrop.classList.remove("dragover");
  if (e.dataTransfer.files.length && state.fileTransfer) {
    state.fileTransfer.enqueue([...e.dataTransfer.files]);
  }
});

els.messageInput.addEventListener("paste", (e) => {
  const items = [...(e.clipboardData?.items || [])];
  const imageItem = items.find((i) => i.type.startsWith("image/"));
  if (imageItem && state.fileTransfer) {
    const file = imageItem.getAsFile();
    if (file) state.fileTransfer.enqueue([file]);
  }
});

// ---------------------------------------------------------------- home UI
els.hostBtn.addEventListener("click", startHosting);

els.joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const code = normalizeCode(els.joinCodeInput.value.trim());
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
    els.homeError.textContent = "Enter a code in the format XXXX-XXXX.";
    show(els.homeError);
    return;
  }
  hide(els.homeError);
  startJoining(code);
});

els.joinCodeInput.addEventListener("input", () => {
  els.joinCodeInput.value = normalizeCode(els.joinCodeInput.value);
});

els.copyCodeBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.roomCode);
  toast("Room code copied.");
});

els.cancelWaitBtn.addEventListener("click", () => {
  cleanupConnection();
  resetToHome();
});

const prefillCode = new URLSearchParams(location.search).get("code");
if (prefillCode) els.joinCodeInput.value = normalizeCode(prefillCode);

// ---------------------------------------------------------------- settings & leave
els.settingsBtn.addEventListener("click", () => show(els.settingsOverlay));
els.closeSettingsBtn.addEventListener("click", () => hide(els.settingsOverlay));
els.settingsOverlay.addEventListener("click", (e) => {
  if (e.target === els.settingsOverlay) hide(els.settingsOverlay);
});

els.leaveBtn.addEventListener("click", () => {
  hide(els.settingsOverlay);
  show(els.leaveConfirmOverlay);
});
els.leaveCancelBtn.addEventListener("click", () => hide(els.leaveConfirmOverlay));
els.leaveConfirmBtn.addEventListener("click", () => {
  state.signaling?.send({ type: "leave" });
  cleanupConnection();
  hide(els.leaveConfirmOverlay);
  resetToHome();
  toast("Session ended.");
});

window.addEventListener("beforeunload", () => {
  state.signaling?.send({ type: "leave" });
});

// ---------------------------------------------------------------- init
resetToHome();
