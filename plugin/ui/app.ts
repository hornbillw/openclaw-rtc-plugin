/**
 * OpenClaw WebRTC UI — main application logic.
 *
 * Connects to the OpenClaw Gateway via WebSocket, handles text chat,
 * and manages WebRTC voice calls.
 */

import { RtcPeer } from "./rtc-peer.js";

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const statusEl = document.getElementById("status")!;
const messagesEl = document.getElementById("messages")!;
const chatForm = document.getElementById("chat-form") as HTMLFormElement;
const chatInput = document.getElementById("chat-input") as HTMLInputElement;
const callBtn = document.getElementById("call-btn") as HTMLButtonElement;
const hangupBtn = document.getElementById("hangup-btn") as HTMLButtonElement;
const callStatusEl = document.getElementById("call-status")!;
const transcriptEl = document.getElementById("transcript")!;
const transcriptTextEl = document.getElementById("transcript-text")!;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let ws: WebSocket | null = null;
let rtcPeer: RtcPeer | null = null;
let currentCallId: string | null = null;
let pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let messageSeq = 0;

// Derive gateway WS URL from page location
function getGatewayWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}

// ---------------------------------------------------------------------------
// Gateway WebSocket
// ---------------------------------------------------------------------------

function connectGateway(): void {
  setStatus("connecting");
  const url = getGatewayWsUrl();
  ws = new WebSocket(url);

  ws.onopen = () => {
    setStatus("connected");
    // Wait for challenge, then connect
  };

  ws.onmessage = (evt) => {
    try {
      const frame = JSON.parse(evt.data as string);
      handleFrame(frame);
    } catch (err) {
      console.error("Failed to parse frame:", err);
    }
  };

  ws.onclose = () => {
    setStatus("disconnected");
    ws = null;
    // Auto-reconnect after 3s
    setTimeout(connectGateway, 3000);
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
  };
}

function handleFrame(frame: { type: string; id?: string; event?: string; ok?: boolean; payload?: unknown }): void {
  switch (frame.type) {
    case "event":
      handleEvent(frame as { event: string; payload?: unknown });
      break;
    case "res":
      handleResponse(frame as { id: string; ok: boolean; payload?: unknown; error?: { message: string } });
      break;
  }
}

function handleEvent(frame: { event: string; payload?: unknown }): void {
  switch (frame.event) {
    case "connect.challenge": {
      const p = frame.payload as { nonce: string };
      sendConnect(p.nonce);
      break;
    }
    case "chat.delta": {
      const p = frame.payload as { text?: string };
      if (p?.text) appendAssistantDelta(p.text);
      break;
    }
    case "chat.done":
      finalizeAssistantMessage();
      break;
    case "rtc.transcript": {
      const p = frame.payload as { text?: string; isInterim?: boolean };
      if (p?.text) showTranscript(p.text, p.isInterim ?? true);
      break;
    }
    case "rtc.call.ended": {
      handleCallEnded();
      break;
    }
  }
}

function handleResponse(frame: { id: string; ok: boolean; payload?: unknown; error?: { message: string } }): void {
  const pending = pendingRequests.get(frame.id);
  if (pending) {
    pendingRequests.delete(frame.id);
    if (frame.ok) {
      pending.resolve(frame.payload);
    } else {
      pending.reject(new Error(frame.error?.message ?? "Request failed"));
    }
  }
}

function sendConnect(nonce: string): void {
  sendRequest("connect", {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: "webrtc-ui",
      version: "2026.3.8",
      platform: "browser",
      mode: "frontend",
    },
    role: "operator",
    device: {
      id: "webrtc-ui-" + crypto.randomUUID().slice(0, 8),
      publicKey: "",
      signature: "",
      signedAt: Date.now(),
      nonce,
    },
  });
}

function sendRequest(method: string, params?: unknown): Promise<unknown> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Not connected"));
  }
  const id = crypto.randomUUID();
  const frame = { type: "req", id, method, params };
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    ws!.send(JSON.stringify(frame));
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
    appendMessage("assistant", `Error: ${(err as Error).message}`);
  }
});

let currentAssistantMessage: HTMLDivElement | null = null;
let assistantBuffer = "";

function appendMessage(role: "user" | "assistant", text: string): void {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendAssistantDelta(text: string): void {
  if (!currentAssistantMessage) {
    currentAssistantMessage = document.createElement("div");
    currentAssistantMessage.className = "message assistant";
    messagesEl.appendChild(currentAssistantMessage);
    assistantBuffer = "";
  }
  assistantBuffer += text;
  currentAssistantMessage.textContent = assistantBuffer;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function finalizeAssistantMessage(): void {
  currentAssistantMessage = null;
  assistantBuffer = "";
}

// ---------------------------------------------------------------------------
// Voice call
// ---------------------------------------------------------------------------

callBtn.addEventListener("click", startCall);
hangupBtn.addEventListener("click", hangup);

async function startCall(): Promise<void> {
  if (rtcPeer) return;

  setCallStatus("Dialing...");
  callBtn.hidden = true;
  hangupBtn.hidden = false;

  rtcPeer = new RtcPeer({
    onIceCandidate: (candidate) => {
      if (currentCallId) {
        sendRequest("rtc.call.ice", { callId: currentCallId, candidate }).catch(console.error);
      }
    },
    onTrack: (event) => {
      // Play remote audio
      const audio = new Audio();
      audio.srcObject = event.streams[0];
      audio.play().catch(console.error);
    },
    onConnectionStateChange: (state) => {
      if (state === "connected") {
        setCallStatus("Connected");
      } else if (state === "disconnected" || state === "failed") {
        handleCallEnded();
      }
    },
  });

  try {
    const offerSdp = await rtcPeer.createOffer();

    const result = await sendRequest("rtc.call.start", {
      sdp: offerSdp,
      sessionKey: "webrtc-session-" + (++messageSeq),
    }) as {
      callId: string;
      answerSdp: string;
      candidates: RTCIceCandidateInit[];
      iceServers: RTCIceServer[];
    };

    currentCallId = result.callId;
    await rtcPeer.handleAnswer(result.answerSdp);

    // Add remote ICE candidates
    for (const candidate of result.candidates) {
      await rtcPeer.addIceCandidate(candidate);
    }

    setCallStatus("Connecting...");
  } catch (err) {
    setCallStatus(`Failed: ${(err as Error).message}`);
    cleanupCall();
  }
}

function hangup(): void {
  if (currentCallId) {
    sendRequest("rtc.call.hangup", { callId: currentCallId, reason: "user" }).catch(console.error);
  }
  cleanupCall();
  setCallStatus("Call ended");
}

function handleCallEnded(): void {
  cleanupCall();
  setCallStatus("Call ended");
}

function cleanupCall(): void {
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

function showTranscript(text: string, isInterim: boolean): void {
  transcriptEl.hidden = false;
  transcriptTextEl.textContent = text;
  if (!isInterim) {
    // Final transcript — add as user message
    appendMessage("user", text);
    transcriptEl.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function setStatus(state: "connected" | "disconnected" | "connecting"): void {
  statusEl.className = `status ${state}`;
  statusEl.textContent = state.charAt(0).toUpperCase() + state.slice(1);
}

function setCallStatus(text: string): void {
  callStatusEl.hidden = false;
  callStatusEl.textContent = text;
  if (text === "Call ended") {
    setTimeout(() => {
      callStatusEl.hidden = true;
    }, 3000);
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

connectGateway();
