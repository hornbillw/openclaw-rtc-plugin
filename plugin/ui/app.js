/**
 * OpenClaw WebRTC UI — main application logic.
 *
 * Connects to the OpenClaw Gateway via WebSocket, handles text chat,
 * and manages WebRTC voice calls.
 *
 * Usage: open http://gateway:port/webrtc/#token=YOUR_GATEWAY_TOKEN
 */
import { RtcPeer } from "./rtc-peer.js";

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const statusEl = document.getElementById("status");
const messagesEl = document.getElementById("messages");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const callBtn = document.getElementById("call-btn");
const hangupBtn = document.getElementById("hangup-btn");
const callStatusEl = document.getElementById("call-status");
const transcriptEl = document.getElementById("transcript");
const transcriptTextEl = document.getElementById("transcript-text");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {WebSocket|null} */
let ws = null;
/** @type {RtcPeer|null} */
let rtcPeer = null;
/** @type {string|null} */
let currentCallId = null;
const pendingRequests = new Map();
let messageSeq = 0;

// Read token from URL hash: #token=xxx
function getToken() {
  const hash = location.hash.slice(1);
  const params = new URLSearchParams(hash);
  return params.get("token") || "";
}

function getGatewayWsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}

// ---------------------------------------------------------------------------
// Gateway WebSocket
// ---------------------------------------------------------------------------

function connectGateway() {
  setStatus("connecting");
  ws = new WebSocket(getGatewayWsUrl());

  ws.onopen = () => setStatus("connected");

  ws.onmessage = (evt) => {
    try {
      handleFrame(JSON.parse(evt.data));
    } catch (err) {
      console.error("Failed to parse frame:", err);
    }
  };

  ws.onclose = () => {
    setStatus("disconnected");
    ws = null;
    setTimeout(connectGateway, 3000);
  };

  ws.onerror = (err) => console.error("WebSocket error:", err);
}

function handleFrame(frame) {
  if (frame.type === "event") handleEvent(frame);
  else if (frame.type === "res") handleResponse(frame);
}

function handleEvent(frame) {
  switch (frame.event) {
    case "connect.challenge": {
      const nonce = frame.payload?.nonce;
      if (nonce) sendConnect(nonce);
      break;
    }
    case "chat": {
      // Streaming chat response
      const p = frame.payload;
      if (p?.type === "delta" && p.text) {
        appendAssistantDelta(p.text);
      } else if (p?.type === "done" || p?.type === "end") {
        finalizeAssistantMessage();
      }
      break;
    }
    case "rtc.transcript": {
      const p = frame.payload;
      if (p?.text) showTranscript(p.text, p.isInterim ?? true);
      break;
    }
    case "rtc.call.ended":
      handleCallEnded();
      break;
  }
}

function handleResponse(frame) {
  const pending = pendingRequests.get(frame.id);
  if (!pending) return;
  pendingRequests.delete(frame.id);
  if (frame.ok) {
    pending.resolve(frame.payload);
  } else {
    pending.reject(new Error(frame.error?.message ?? "Request failed"));
  }
}

function sendConnect(nonce) {
  const token = getToken();
  sendRequest("connect", {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: "webchat-ui",
      displayName: "WebRTC UI",
      version: "2026.3.8",
      platform: navigator.platform || "browser",
      mode: "webchat",
    },
    role: "operator",
    auth: token ? { token } : undefined,
    device: {
      id: "webrtc-ui-" + crypto.randomUUID().slice(0, 8),
      publicKey: "none",
      signature: "none",
      signedAt: Date.now(),
      nonce,
    },
  }).then((result) => {
    if (result?.type === "hello-ok") {
      setStatus("connected");
      appendSystemMessage("Connected to OpenClaw Gateway");
    }
  }).catch((err) => {
    console.error("Connect failed:", err);
    setStatus("disconnected");
    appendSystemMessage("Connection failed: " + err.message);
  });
}

function sendRequest(method, params) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Not connected"));
  }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  appendMessage("user", text);
  chatInput.value = "";

  try {
    await sendRequest("chat.send", { text });
  } catch (err) {
    appendMessage("system", "Error: " + err.message);
  }
});

let currentAssistantEl = null;
let assistantBuffer = "";

function appendMessage(role, text) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendSystemMessage(text) {
  appendMessage("system", text);
}

function appendAssistantDelta(text) {
  if (!currentAssistantEl) {
    currentAssistantEl = document.createElement("div");
    currentAssistantEl.className = "message assistant";
    messagesEl.appendChild(currentAssistantEl);
    assistantBuffer = "";
  }
  assistantBuffer += text;
  currentAssistantEl.textContent = assistantBuffer;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function finalizeAssistantMessage() {
  currentAssistantEl = null;
  assistantBuffer = "";
}

// ---------------------------------------------------------------------------
// Voice call
// ---------------------------------------------------------------------------

callBtn.addEventListener("click", startCall);
hangupBtn.addEventListener("click", hangup);

async function startCall() {
  if (rtcPeer) return;

  setCallStatus("Requesting microphone...");
  callBtn.hidden = true;
  hangupBtn.hidden = false;

  rtcPeer = new RtcPeer({
    onIceCandidate: (candidate) => {
      if (currentCallId) {
        sendRequest("rtc.call.ice", { callId: currentCallId, candidate }).catch(console.error);
      }
    },
    onTrack: (event) => {
      const audio = new Audio();
      audio.srcObject = event.streams[0];
      audio.play().catch(console.error);
    },
    onConnectionStateChange: (state) => {
      console.log("[webrtc-ui] connection state:", state);
      if (state === "connected") {
        setCallStatus("In call");
      } else if (state === "disconnected" || state === "failed") {
        handleCallEnded();
      }
    },
  });

  try {
    setCallStatus("Creating offer...");
    const offerSdp = await rtcPeer.createOffer();

    setCallStatus("Dialing...");
    const result = await sendRequest("rtc.call.start", {
      sdp: offerSdp,
      sessionKey: "webrtc-session-" + (++messageSeq),
    });

    currentCallId = result.callId;
    await rtcPeer.handleAnswer(result.answerSdp);

    for (const candidate of (result.candidates || [])) {
      await rtcPeer.addIceCandidate(candidate);
    }

    setCallStatus("Connecting...");
  } catch (err) {
    console.error("[webrtc-ui] call failed:", err);
    setCallStatus("Failed: " + err.message);
    cleanupCall();
  }
}

function hangup() {
  if (currentCallId) {
    sendRequest("rtc.call.hangup", { callId: currentCallId, reason: "user" }).catch(console.error);
  }
  cleanupCall();
  setCallStatus("Call ended");
}

function handleCallEnded() {
  cleanupCall();
  setCallStatus("Call ended");
}

function cleanupCall() {
  if (rtcPeer) {
    rtcPeer.hangup();
    rtcPeer = null;
  }
  currentCallId = null;
  callBtn.hidden = false;
  hangupBtn.hidden = true;
  transcriptEl.hidden = true;
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

function showTranscript(text, isInterim) {
  transcriptEl.hidden = false;
  transcriptTextEl.textContent = text;
  if (!isInterim) {
    appendMessage("user", text);
    transcriptEl.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function setStatus(state) {
  statusEl.className = `status ${state}`;
  statusEl.textContent = state.charAt(0).toUpperCase() + state.slice(1);
}

function setCallStatus(text) {
  callStatusEl.hidden = false;
  callStatusEl.textContent = text;
  if (text === "Call ended") {
    setTimeout(() => { callStatusEl.hidden = true; }, 3000);
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

if (!getToken()) {
  appendSystemMessage("No token found. Add #token=YOUR_TOKEN to the URL.");
}

connectGateway();
