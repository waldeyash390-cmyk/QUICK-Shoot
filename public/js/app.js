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
  copyCodeLabel: $("copyCodeLabel"),
  qrImg: $("qrImg"),
  qrWrap: $("qrWrap"),
  waitingHint: $("waitingHint"),
  cancelWaitBtn: $("cancelWaitBtn"),
  cancelWaitBtnHost: $("cancelWaitBtnHost"),
  joinLobby: $("joinLobby"),
  joinLobbyTitle: $("joinLobbyTitle"),
  joinLobbySub: $("joinLobbySub"),
  hostLobby: $("hostLobby"),
  setupState: $("setupState"),
  jstep1: $("jstep1"),
  jstep2: $("jstep2"),
  jstep3: $("jstep3"),

  screenChat: $("screenChat"),
  messages: $("messages"),
  peerCount: $("peerCount"),
  fileDrop: $("fileDrop"),
  fileInput: $("fileInput"),
  fileList: $("fileList"),
  composerForm: $("composerForm"),
  attachBtn: $("attachBtn"),
  cameraBtn: $("cameraBtn"),
  callBtn: $("callBtn"),
  callNotification: $("callNotification"),
  callNotifSub: $("callNotifSub"),
  callAcceptBtn: $("callAcceptBtn"),
  callDeclineBtn: $("callDeclineBtn"),
  callActiveBar: $("callActiveBar"),
  callActiveLabel: $("callActiveLabel"),
  callActiveTimer: $("callActiveTimer"),
  callEndBtn: $("callEndBtn"),
  callRemoteAudio: $("callRemoteAudio"),
  cameraOverlay: $("cameraOverlay"),
  cameraCloseBtn: $("cameraCloseBtn"),
  cameraVideo: $("cameraVideo"),
  cameraCanvas: $("cameraCanvas"),
  cameraPreview: $("cameraPreview"),
  cameraFlash: $("cameraFlash"),
  cameraControls: $("cameraControls"),
  cameraFlipBtn: $("cameraFlipBtn"),
  cameraShutterBtn: $("cameraShutterBtn"),
  cameraRetakeRow: $("cameraRetakeRow"),
  cameraRetakeBtn: $("cameraRetakeBtn"),
  cameraSendPhotoBtn: $("cameraSendPhotoBtn"),
  messageInput: $("messageInput"),
  typingIndicator: $("typingIndicator"),

  settingsOverlay: $("settingsOverlay"),
  settingsConnState: $("settingsConnState"),
  settingsRoomCode: $("settingsRoomCode"),
  settingsTimer: $("settingsTimer"),
  themeToggleBtn: $("themeToggleBtn"),
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
  // peerId -> display name ("Host" for the room creator, "U1","U2"... for joiners)
  peerNames: new Map(),
  myName: null,
  // Peers that were already in the room when we joined (don't announce them as "joined")
  existingPeerIds: new Set(),
  // Call state
  call: {
    active: false,
    localStream: null,
    peerConnections: new Map(), // peerId -> RTCPeerConnection (audio-only)
    callTimerHandle: null,
    callStartTime: null,
    incomingCallFrom: null,
  },
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
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
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
  state.peerNames.clear();
  state.existingPeerIds.clear();
  state.myName = null;
  updateTypingIndicator();
  callCleanup();
}

// ---------------------------------------------------------------- host flow
async function startHosting() {
  showScreen("waiting");
  // Show setup spinner while connecting
  show(els.setupState);
  hide(els.hostLobby);
  hide(els.joinLobby);
  els.waitingLabel.textContent = "Setting up your room…";
  hide(els.roomCodeBlock);
  if (els.qrWrap) hide(els.qrWrap);
  setStatus("connecting", "Connecting…");

  state.signaling = new Signaling();
  state.signaling.addEventListener("open", () => state.signaling.send({ type: "host" }));
  state.signaling.addEventListener("message", (e) => handleSignalingMessage(e.detail));
  state.signaling.connect();
}

async function startJoining(code) {
  state.roomCode = code;
  showScreen("waiting");
  // Show join lobby UI
  hide(els.setupState);
  hide(els.hostLobby);
  show(els.joinLobby);
  els.joinLobbyTitle.textContent = `Joining ${code}`;
  els.joinLobbySub.textContent = "Connecting securely…";
  // Animate steps
  setJoinStep(1);
  setStatus("connecting", "Connecting…");

  state.signaling = new Signaling();
  state.signaling.addEventListener("open", () => {
    setJoinStep(2);
    els.joinLobbySub.textContent = "Verifying room…";
    state.signaling.send({ type: "join", code });
  });
  state.signaling.addEventListener("message", (e) => handleSignalingMessage(e.detail));
  state.signaling.connect();
}

function setJoinStep(n) {
  [els.jstep1, els.jstep2, els.jstep3].forEach((el, i) => {
    if (!el) return;
    const dot = el.querySelector(".join-step-dot");
    if (i < n - 1) { dot.className = "join-step-dot done"; }
    else if (i === n - 1) { dot.className = "join-step-dot active"; }
    else { dot.className = "join-step-dot"; }
  });
}

async function handleSignalingMessage(msg) {
  switch (msg.type) {

    case "hosted": {
      state.roomCode = msg.code;
      state.myPeerId = msg.peerId;
      state.myName = msg.name || "Host";
      state.peerNames.set(state.myPeerId, state.myName);
      els.roomCodeText.textContent = msg.code;
      // Switch from setup spinner to host lobby
      hide(els.setupState);
      hide(els.joinLobby);
      show(els.hostLobby);
      show(els.roomCodeBlock);
      if (els.waitingHint) els.waitingHint.textContent = "Waiting for someone to join…";
      const shareUrl = `${location.origin}${location.pathname}?code=${encodeURIComponent(msg.code)}`;
      els.qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&qzone=1&data=${encodeURIComponent(shareUrl)}`;
      if (els.qrWrap) show(els.qrWrap);
      // Host creates the mesh but waits for first peer before entering chat
      state.cryptoKey = await CryptoModule.deriveKeyFromRoomCode(state.roomCode);
      state.mesh = new PeerMesh(state.signaling, state.myPeerId);
      wireMeshEvents();
      // DO NOT call onFirstConnect() here — host waits on the lobby until a user joins
      break;
    }

    case "joined": {
      state.myPeerId = msg.peerId;
      state.roomCode = msg.code;
      state.myName = msg.name || "U?";
      state.peerNames.set(state.myPeerId, state.myName);
      for (const p of msg.peers || []) {
        state.peerNames.set(p.peerId, p.name);
        state.existingPeerIds.add(p.peerId); // mark as pre-existing, not "new joiners"
      }
      state.cryptoKey = await CryptoModule.deriveKeyFromRoomCode(state.roomCode);
      state.mesh = new PeerMesh(state.signaling, state.myPeerId);
      wireMeshEvents();
      // Connect to every peer already in the room
      if (msg.peers.length > 0) {
        await state.mesh.connectToExistingPeers(msg.peers.map((p) => p.peerId));
      } else {
        // Room was empty (e.g. host left, room not destroyed yet — shouldn't normally happen)
        onFirstConnect();
      }
      break;
    }

    case "peer-joined": {
      // Someone new entered; as the existing user we don't initiate — they do
      state.peerNames.set(msg.peerId, msg.name || msg.peerId.slice(0, 4).toUpperCase());
      if (state.mesh) {
        await state.mesh.acceptNewPeer(msg.peerId);
        // If host is still on waiting screen (hasn't entered chat yet), transition now
        if (els.screenWaiting && !els.screenWaiting.hidden) {
          // Animate step 3 if join lobby visible (for joiner path), or just enter chat
          onFirstConnect();
        }
      }
      break;
    }

    case "peer-left": {
      if (state.mesh) {
        const leftName = msg.name || state.peerNames.get(msg.peerId) || "A user";
        state.mesh.removePeer(msg.peerId);
        addSystemMessage(`${leftName} left the room.`);
        state.peerNames.delete(msg.peerId);
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
  if (state.myName === "Host") {
    addSystemMessage("Room created. Share the code for others to join!");
  } else {
    addSystemMessage(`You joined as ${state.myName}. Welcome!`);
  }
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
      // If joiner lobby is visible, animate step 3 then enter
      if (els.joinLobby && !els.joinLobby.hidden) {
        setJoinStep(3);
        els.joinLobbySub.textContent = "Almost there…";
        setTimeout(() => { onFirstConnect(); updatePeerCount(); }, 700);
      } else {
        onFirstConnect();
        updatePeerCount();
      }
    }
    if (["disconnected", "failed", "closed"].includes(e.detail)) {
      setStatus("offline", "Disconnected");
    }
  });

  state.mesh.addEventListener("peer-state", (e) => {
    const { peerId, state: peerState } = e.detail;
    if (peerState === "connected") {
      // Only announce peers that joined AFTER us, not ones already in the room
      if (!state.existingPeerIds.has(peerId)) {
        const joinedName = state.peerNames.get(peerId) || "A new user";
        addSystemMessage(`${joinedName} joined the room.`);
      }
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

  // Detect code blocks (```...```) and render with copy button
  const codeBlockRx = /```([\s\S]*?)```/g;
  const inlineCodeRx = /`([^`]+)`/g;
  if (codeBlockRx.test(text) || inlineCodeRx.test(text)) {
    body.innerHTML = "";
    let last = 0;
    const fullRx = /```([\s\S]*?)```|`([^`]+)`/g;
    let m;
    fullRx.lastIndex = 0;
    while ((m = fullRx.exec(text)) !== null) {
      if (m.index > last) {
        body.appendChild(document.createTextNode(text.slice(last, m.index)));
      }
      const isBlock = m[0].startsWith("```");
      const code = (m[1] || m[2] || "").trim();
      if (isBlock) {
        const wrap = document.createElement("div");
        wrap.className = "msg-code-block";
        const pre = document.createElement("pre");
        const codeEl = document.createElement("code");
        codeEl.textContent = code;
        pre.appendChild(codeEl);
        const copyBtn = document.createElement("button");
        copyBtn.className = "msg-code-copy";
        copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy`;
        copyBtn.addEventListener("click", async () => {
          await navigator.clipboard.writeText(code);
          copyBtn.textContent = "✓ Copied";
          copyBtn.classList.add("copied");
          setTimeout(() => {
            copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy`;
            copyBtn.classList.remove("copied");
          }, 2000);
        });
        wrap.append(copyBtn, pre);
        body.appendChild(wrap);
      } else {
        const codeEl = document.createElement("code");
        codeEl.className = "msg-inline-code";
        codeEl.textContent = code;
        body.appendChild(codeEl);
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) body.appendChild(document.createTextNode(text.slice(last)));
  } else {
    body.textContent = text;
  }

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
  const label = state.peerNames.get(fromPeerId) || fromPeerId.slice(0, 4).toUpperCase();

  if (msg.t === "msg") {
    addMessage({ text: msg.text, mine: false, ts: msg.ts, senderLabel: label });
    state.typingPeers.delete(fromPeerId);
    updateTypingIndicator();
  } else if (msg.t === "typing") {
    if (msg.state) state.typingPeers.add(fromPeerId);
    else state.typingPeers.delete(fromPeerId);
    updateTypingIndicator();
  } else if (msg.t === "call-invite") {
    callHandleInvite(fromPeerId, label);
  } else if (msg.t === "call-accept") {
    callHandleAccept(fromPeerId);
  } else if (msg.t === "call-decline") {
    callHandleDecline(fromPeerId);
  } else if (msg.t === "call-end") {
    callHandleRemoteEnd(fromPeerId);
  } else if (msg.t === "call-signal") {
    callHandleSignal(fromPeerId, msg.payload);
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

// Keep --composer-h in sync with the fixed composer's real rendered height,
// so the chat area always reserves exactly enough space and content never
// hides behind it (handles the textarea growing, safe-area insets, etc).
if (typeof ResizeObserver !== "undefined") {
  const syncComposerHeight = () => {
    document.documentElement.style.setProperty(
      "--composer-h",
      `${els.composerForm.offsetHeight}px`
    );
  };
  new ResizeObserver(syncComposerHeight).observe(els.composerForm);
  syncComposerHeight();
}

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
  if (!/^[A-Z0-9]{4}$/.test(code)) {
    els.homeError.textContent = "Enter the 4-character room code (e.g. OKT3).";
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
  try {
    await navigator.clipboard.writeText(state.roomCode);
    if (els.copyCodeLabel) {
      els.copyCodeLabel.textContent = "Copied!";
      els.copyCodeBtn.classList.add("copied");
      setTimeout(() => {
        if (els.copyCodeLabel) els.copyCodeLabel.textContent = "Copy";
        els.copyCodeBtn.classList.remove("copied");
      }, 2000);
    }
    toast("Room code copied.");
  } catch(e) { toast("Couldn't copy — try manually."); }
});

els.cancelWaitBtn.addEventListener("click", () => {
  cleanupConnection();
  resetToHome();
});

if (els.cancelWaitBtnHost) {
  els.cancelWaitBtnHost.addEventListener("click", () => {
    cleanupConnection();
    resetToHome();
  });
}

const prefillCode = new URLSearchParams(location.search).get("code");
if (prefillCode) els.joinCodeInput.value = normalizeCode(prefillCode);

// ---------------------------------------------------------------- settings & leave
els.settingsBtn.addEventListener("click", () => show(els.settingsOverlay));
els.closeSettingsBtn.addEventListener("click", () => hide(els.settingsOverlay));
els.settingsOverlay.addEventListener("click", (e) => {
  if (e.target === els.settingsOverlay) hide(els.settingsOverlay);
});

// ---------------------------------------------------------------- theme toggle
const THEME_KEY = "qs-theme";

function applyTheme(theme) {
  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
    els.themeToggleBtn.textContent = "☀️ Light";
  } else {
    document.documentElement.removeAttribute("data-theme");
    els.themeToggleBtn.textContent = "🌙 Dark";
  }
}

(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
  applyTheme(saved === "light" ? "light" : "dark");
})();

els.themeToggleBtn.addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
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

// ================================================================
// CAMERA FEATURE
// ================================================================

const camera = {
  stream: null,
  facingMode: "environment", // start with rear cam
  capturedBlob: null,
};

function cameraShow() {
  els.cameraOverlay.removeAttribute("hidden");
  els.cameraPreview.setAttribute("hidden", "");
  els.cameraPreview.src = "";
  els.cameraRetakeRow.setAttribute("hidden", "");
  els.cameraControls.removeAttribute("hidden");
  camera.capturedBlob = null;
  cameraStart();
}

function cameraHide() {
  cameraStop();
  els.cameraOverlay.setAttribute("hidden", "");
  els.cameraPreview.setAttribute("hidden", "");
  els.cameraPreview.src = "";
  els.cameraRetakeRow.setAttribute("hidden", "");
  els.cameraControls.removeAttribute("hidden");
  camera.capturedBlob = null;
}

async function cameraStart() {
  cameraStop();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: camera.facingMode, width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
    camera.stream = stream;
    els.cameraVideo.srcObject = stream;
    els.cameraVideo.removeAttribute("hidden");
  } catch (err) {
    els.cameraVideo.setAttribute("hidden", "");
    const vf = document.getElementById("cameraViewfinder");
    vf.innerHTML = `
      <div class="camera-error">
        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
        Camera access denied or unavailable.<br>Please allow camera permissions and try again.
      </div>`;
  }
}

function cameraStop() {
  if (camera.stream) {
    camera.stream.getTracks().forEach((t) => t.stop());
    camera.stream = null;
  }
  els.cameraVideo.srcObject = null;
}

function cameraCapture() {
  const video = els.cameraVideo;
  const canvas = els.cameraCanvas;
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 960;
  const ctx = canvas.getContext("2d");
  // Mirror front camera capture
  if (camera.facingMode === "user") {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // Flash effect
  const flash = els.cameraFlash;
  flash.classList.remove("flash-off");
  flash.classList.add("flash-on");
  requestAnimationFrame(() => {
    flash.classList.remove("flash-on");
    flash.classList.add("flash-off");
  });

  canvas.toBlob(
    (blob) => {
      camera.capturedBlob = blob;
      const url = URL.createObjectURL(blob);
      els.cameraPreview.src = url;
      els.cameraPreview.removeAttribute("hidden");
      cameraStop();
      els.cameraVideo.setAttribute("hidden", "");
      els.cameraControls.setAttribute("hidden", "");
      els.cameraRetakeRow.removeAttribute("hidden");
    },
    "image/jpeg",
    0.92
  );
}

async function cameraSendPhoto() {
  if (!camera.capturedBlob || !state.fileTransfer) return;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = new File([camera.capturedBlob], `photo-${ts}.jpg`, { type: "image/jpeg" });
  state.fileTransfer.enqueue([file]);
  cameraHide();
}

// Event listeners
els.cameraBtn.addEventListener("click", () => {
  if (!state.fileTransfer) return; // only usable in active session
  cameraShow();
});

els.cameraCloseBtn.addEventListener("click", cameraHide);
els.cameraOverlay.addEventListener("click", (e) => {
  if (e.target === els.cameraOverlay) cameraHide();
});

els.cameraShutterBtn.addEventListener("click", cameraCapture);

els.cameraFlipBtn.addEventListener("click", () => {
  camera.facingMode = camera.facingMode === "environment" ? "user" : "environment";
  // Mirror live view for front cam
  els.cameraVideo.style.transform = camera.facingMode === "user" ? "scaleX(-1)" : "";
  cameraStart();
});

els.cameraRetakeBtn.addEventListener("click", () => {
  if (camera.capturedBlob) {
    URL.revokeObjectURL(els.cameraPreview.src);
    camera.capturedBlob = null;
  }
  els.cameraPreview.setAttribute("hidden", "");
  els.cameraPreview.src = "";
  els.cameraRetakeRow.setAttribute("hidden", "");
  els.cameraControls.removeAttribute("hidden");
  // Rebuild viewfinder if error replaced it
  const vf = document.getElementById("cameraViewfinder");
  if (!vf.contains(els.cameraVideo)) {
    vf.innerHTML = "";
    vf.appendChild(els.cameraVideo);
    vf.appendChild(els.cameraCanvas);
    vf.appendChild(els.cameraPreview);
    vf.appendChild(els.cameraFlash);
  }
  els.cameraVideo.removeAttribute("hidden");
  cameraStart();
});

els.cameraSendPhotoBtn.addEventListener("click", cameraSendPhoto);

// ================================================================
// CALL FEATURE
// ================================================================

const CALL_ICE = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// --- helpers ---
function callIsActive() { return state.call.active; }

function callShowNotification(peerLabel) {
  els.callNotifSub.textContent = `${peerLabel} is calling…`;
  els.callNotification.removeAttribute("hidden");
}
function callHideNotification() {
  els.callNotification.setAttribute("hidden", "");
}
function callShowActiveBar(label) {
  els.callActiveLabel.textContent = label || "Call active";
  els.callActiveBar.removeAttribute("hidden");
  document.body.classList.add("call-bar-active");
}
function callHideActiveBar() {
  els.callActiveBar.setAttribute("hidden", "");
  document.body.classList.remove("call-bar-active");
}
function callStartTimer() {
  state.call.callStartTime = Date.now();
  if (state.call.callTimerHandle) clearInterval(state.call.callTimerHandle);
  state.call.callTimerHandle = setInterval(() => {
    const secs = Math.floor((Date.now() - state.call.callStartTime) / 1000);
    const m = Math.floor(secs / 60);
    const s = (secs % 60).toString().padStart(2, "0");
    els.callActiveTimer.textContent = `${m}:${s}`;
  }, 1000);
}
function callStopTimer() {
  if (state.call.callTimerHandle) clearInterval(state.call.callTimerHandle);
  state.call.callTimerHandle = null;
  els.callActiveTimer.textContent = "0:00";
}

// Broadcast a call-typed chat payload to all peers
async function callBroadcast(obj) {
  const encrypted = await CryptoModule.encryptJSON(state.cryptoKey, obj);
  state.mesh.broadcast("chat", encrypted.buffer.slice(0));
}
async function callSendTo(peerId, obj) {
  const encrypted = await CryptoModule.encryptJSON(state.cryptoKey, obj);
  state.mesh.sendTo(peerId, "chat", encrypted.buffer.slice(0));
}

// --- WebRTC audio peer connection per caller ---
async function callCreateAudioPC(remotePeerId, isInitiator) {
  const pc = new RTCPeerConnection({ iceServers: CALL_ICE });

  // Add local audio tracks
  if (state.call.localStream) {
    state.call.localStream.getTracks().forEach(t => pc.addTrack(t, state.call.localStream));
  }

  // Play remote audio
  pc.ontrack = (e) => {
    els.callRemoteAudio.srcObject = e.streams[0];
  };

  // ICE → send via encrypted chat channel
  pc.onicecandidate = async (e) => {
    if (e.candidate) {
      await callSendTo(remotePeerId, { t: "call-signal", payload: { candidate: e.candidate } });
    }
  };

  state.call.peerConnections.set(remotePeerId, pc);

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await callSendTo(remotePeerId, { t: "call-signal", payload: { sdp: pc.localDescription } });
  }
  return pc;
}

async function callHandleSignal(fromPeerId, payload) {
  let pc = state.call.peerConnections.get(fromPeerId);
  if (!pc) {
    // We just accepted the call; create PC as non-initiator
    pc = await callCreateAudioPC(fromPeerId, false);
  }
  const { sdp, candidate } = payload;
  if (sdp) {
    await pc.setRemoteDescription(sdp);
    if (sdp.type === "offer") {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await callSendTo(fromPeerId, { t: "call-signal", payload: { sdp: pc.localDescription } });
    }
  } else if (candidate) {
    try { await pc.addIceCandidate(candidate); } catch { /* benign */ }
  }
}

// --- Call flow ---

// Caller: starts a call
async function callStart() {
  if (!state.mesh || state.mesh.connectedPeerCount() === 0) {
    toast("No one else is in the room.");
    return;
  }
  if (callIsActive()) {
    toast("Already in a call.");
    return;
  }
  try {
    state.call.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch {
    toast("Microphone access denied.");
    return;
  }
  await callBroadcast({ t: "call-invite" });
  state.call.active = true;
  els.callBtn.classList.add("call-btn--active");
  callShowActiveBar("Calling…");
  callStartTimer();
  addSystemMessage("📞 You started a call. Waiting for others to join…");
}

// Receiver: someone invited us
function callHandleInvite(fromPeerId, peerLabel) {
  if (callIsActive()) {
    // We're already in a call — auto-join new participants
    callAccept(fromPeerId);
    return;
  }
  state.call.incomingCallFrom = fromPeerId;
  callShowNotification(peerLabel);
}

// Receiver: user clicks Accept
async function callAccept(fromPeerId) {
  const targetId = fromPeerId || state.call.incomingCallFrom;
  callHideNotification();
  if (callIsActive() && state.call.peerConnections.has(targetId)) return;

  if (!state.call.localStream) {
    try {
      state.call.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      toast("Microphone access denied.");
      return;
    }
  }
  state.call.active = true;
  state.call.incomingCallFrom = null;
  els.callBtn.classList.add("call-btn--active");
  callShowActiveBar("Call active");
  if (!state.call.callStartTime) callStartTimer();

  await callSendTo(targetId, { t: "call-accept" });
  // Create audio PC — we are NOT the initiator (caller will initiate SDP)
  await callCreateAudioPC(targetId, false);
  addSystemMessage("📞 You joined the call.");
}

// Caller: someone accepted
async function callHandleAccept(fromPeerId) {
  if (!callIsActive()) return;
  callShowActiveBar("Call active");
  // Now initiate SDP toward this peer
  await callCreateAudioPC(fromPeerId, true);
}

// Receiver: user clicks Decline
async function callDecline() {
  callHideNotification();
  if (state.call.incomingCallFrom) {
    await callSendTo(state.call.incomingCallFrom, { t: "call-decline" });
  }
  state.call.incomingCallFrom = null;
}

function callHandleDecline(fromPeerId) {
  toast("Call declined.");
  addSystemMessage("📵 Call was declined.");
  if (!state.call.peerConnections.size) {
    callCleanup();
  }
}

// Either side ends the call
async function callEnd() {
  await callBroadcast({ t: "call-end" });
  callCleanup();
  addSystemMessage("📵 Call ended.");
}

function callHandleRemoteEnd(fromPeerId) {
  const pc = state.call.peerConnections.get(fromPeerId);
  if (pc) { pc.close(); state.call.peerConnections.delete(fromPeerId); }
  if (state.call.peerConnections.size === 0) {
    callCleanup();
    addSystemMessage("📵 The call ended.");
  }
}

function callCleanup() {
  callHideNotification();
  callHideActiveBar();
  callStopTimer();
  state.call.active = false;
  state.call.incomingCallFrom = null;
  if (state.call.localStream) {
    state.call.localStream.getTracks().forEach(t => t.stop());
    state.call.localStream = null;
  }
  for (const pc of state.call.peerConnections.values()) pc.close();
  state.call.peerConnections.clear();
  els.callRemoteAudio.srcObject = null;
  els.callBtn.classList.remove("call-btn--active");
}

// --- Button events ---
els.callBtn.addEventListener("click", () => {
  if (!state.fileTransfer) return; // only in active session
  if (callIsActive()) {
    callEnd();
  } else {
    callStart();
  }
});

els.callAcceptBtn.addEventListener("click", () => callAccept(null));
els.callDeclineBtn.addEventListener("click", () => callDecline());
els.callEndBtn.addEventListener("click", () => {
  callEnd();
  addSystemMessage("📵 You ended the call.");
});
