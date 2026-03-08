import { z } from "zod";

// ---------------------------------------------------------------------------
// Call lifecycle
// ---------------------------------------------------------------------------

export const RtcCallStateSchema = z.enum([
  "initiating", // browser sent offer, awaiting node accept
  "connecting", // SDP exchanged, ICE in progress
  "active", // media flowing
  "hangup-user", // user hung up (terminal)
  "hangup-node", // node/server hung up (terminal)
  "timeout", // no activity timeout (terminal)
  "error", // unrecoverable error (terminal)
]);

export type RtcCallState = z.infer<typeof RtcCallStateSchema>;

export const TERMINAL_STATES = new Set<RtcCallState>([
  "hangup-user",
  "hangup-node",
  "timeout",
  "error",
]);

// ---------------------------------------------------------------------------
// ICE server config
// ---------------------------------------------------------------------------

export const IceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});

export type IceServer = z.infer<typeof IceServerSchema>;

export const DEFAULT_ICE_SERVERS: IceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

// ---------------------------------------------------------------------------
// Signaling messages (browser ↔ gateway)
// ---------------------------------------------------------------------------

export type RtcCallStartParams = {
  sdp: string;
  sessionKey: string;
};

export type RtcCallStartResult = {
  callId: string;
  answerSdp: string;
  candidates: RTCIceCandidateInit[];
  iceServers: IceServer[];
};

export type RtcIceCandidateParams = {
  callId: string;
  candidate: RTCIceCandidateInit;
};

export type RtcHangupParams = {
  callId: string;
  reason?: string;
};

export type RtcCallStatusParams = {
  callId?: string;
};

// RTCIceCandidateInit shape (for Node.js where globalThis.RTCIceCandidateInit is absent)
export type RTCIceCandidateInit = {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
};

// ---------------------------------------------------------------------------
// Call record
// ---------------------------------------------------------------------------

export const RtcCallRecordSchema = z.object({
  callId: z.string(),
  sessionKey: z.string(),
  state: RtcCallStateSchema,
  offerSdp: z.string(),
  answerSdp: z.string().optional(),
  startedAt: z.number(),
  connectedAt: z.number().optional(),
  endedAt: z.number().optional(),
  endReason: z.string().optional(),
  localCandidates: z.array(z.unknown()).default([]),
  remoteCandidates: z.array(z.unknown()).default([]),
  transcript: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    text: z.string(),
    timestamp: z.number(),
  })).default([]),
});

export type RtcCallRecord = z.infer<typeof RtcCallRecordSchema>;

// ---------------------------------------------------------------------------
// Node commands (gateway → RTC node)
// ---------------------------------------------------------------------------

export type NodeAcceptParams = {
  callId: string;
  offerSdp: string;
  iceServers: IceServer[];
};

export type NodeAcceptResult = {
  answerSdp: string;
  candidates: RTCIceCandidateInit[];
};

export type NodeRemoteCandidateParams = {
  callId: string;
  candidate: RTCIceCandidateInit;
};

export type NodeSpeakParams = {
  callId: string;
  text: string;
};

export type NodeHangupParams = {
  callId: string;
  reason: string;
};
