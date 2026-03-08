import { randomUUID } from "node:crypto";
import type {
  RtcCallRecord,
  RtcCallState,
  RTCIceCandidateInit,
  IceServer,
} from "./types.js";
import { TERMINAL_STATES, DEFAULT_ICE_SERVERS } from "./types.js";

export type OrchestratorOptions = {
  maxConcurrentCalls: number;
  iceServers: IceServer[];
};

export type StartCallParams = {
  sdp: string;
  sessionKey: string;
};

export type StartCallResult = {
  callRecord: RtcCallRecord;
};

/**
 * Manages WebRTC call lifecycle and state transitions.
 * Runs inside the gateway plugin process.
 */
export class CallOrchestrator {
  private calls = new Map<string, RtcCallRecord>();
  private sessionCallMap = new Map<string, string>(); // sessionKey → callId
  private options: OrchestratorOptions;

  constructor(options?: Partial<OrchestratorOptions>) {
    this.options = {
      maxConcurrentCalls: options?.maxConcurrentCalls ?? 5,
      iceServers: options?.iceServers ?? DEFAULT_ICE_SERVERS,
    };
  }

  get activeCalls(): number {
    let count = 0;
    for (const call of this.calls.values()) {
      if (!TERMINAL_STATES.has(call.state)) count++;
    }
    return count;
  }

  get iceServers(): IceServer[] {
    return this.options.iceServers;
  }

  /**
   * Browser initiates a call: creates a new call record in "initiating" state.
   */
  startCall(params: StartCallParams): StartCallResult {
    // Check concurrent limit
    if (this.activeCalls >= this.options.maxConcurrentCalls) {
      throw new Error(
        `Max concurrent calls (${this.options.maxConcurrentCalls}) reached`,
      );
    }

    // Check if session already has an active call
    const existingCallId = this.sessionCallMap.get(params.sessionKey);
    if (existingCallId) {
      const existing = this.calls.get(existingCallId);
      if (existing && !TERMINAL_STATES.has(existing.state)) {
        throw new Error(
          `Session ${params.sessionKey} already has an active call: ${existingCallId}`,
        );
      }
    }

    const callId = randomUUID();
    const record: RtcCallRecord = {
      callId,
      sessionKey: params.sessionKey,
      state: "initiating",
      offerSdp: params.sdp,
      startedAt: Date.now(),
      localCandidates: [],
      remoteCandidates: [],
      transcript: [],
    };

    this.calls.set(callId, record);
    this.sessionCallMap.set(params.sessionKey, callId);
    return { callRecord: record };
  }

  /**
   * Node accepted the call: store answer SDP, transition to "connecting".
   */
  handleAnswer(callId: string, answerSdp: string): void {
    const call = this.requireCall(callId);
    this.assertState(call, "initiating");
    call.answerSdp = answerSdp;
    call.state = "connecting";
  }

  /**
   * ICE candidate received from either browser or node.
   */
  handleIceCandidate(
    callId: string,
    candidate: RTCIceCandidateInit,
    direction: "local" | "remote",
  ): void {
    const call = this.requireCall(callId);
    if (TERMINAL_STATES.has(call.state)) return; // ignore late candidates
    if (direction === "local") {
      call.localCandidates.push(candidate);
    } else {
      call.remoteCandidates.push(candidate);
    }
  }

  /**
   * Call is now active (media flowing).
   */
  setActive(callId: string): void {
    const call = this.requireCall(callId);
    if (call.state === "connecting" || call.state === "initiating") {
      call.state = "active";
      call.connectedAt = Date.now();
    }
  }

  /**
   * Hang up the call.
   */
  hangup(callId: string, reason: string): void {
    const call = this.requireCall(callId);
    if (TERMINAL_STATES.has(call.state)) return; // already ended
    call.state = reason === "user" ? "hangup-user" : "hangup-node";
    call.endedAt = Date.now();
    call.endReason = reason;
  }

  /**
   * Mark call as errored.
   */
  setError(callId: string, reason: string): void {
    const call = this.requireCall(callId);
    if (TERMINAL_STATES.has(call.state)) return;
    call.state = "error";
    call.endedAt = Date.now();
    call.endReason = reason;
  }

  /**
   * Mark call as timed out.
   */
  setTimeout(callId: string, reason: string): void {
    const call = this.requireCall(callId);
    if (TERMINAL_STATES.has(call.state)) return;
    call.state = "timeout";
    call.endedAt = Date.now();
    call.endReason = reason;
  }

  /**
   * Add transcript entry.
   */
  addTranscript(
    callId: string,
    role: "user" | "assistant",
    text: string,
  ): void {
    const call = this.requireCall(callId);
    call.transcript.push({ role, text, timestamp: Date.now() });
  }

  getCall(callId: string): RtcCallRecord | undefined {
    return this.calls.get(callId);
  }

  getCallBySession(sessionKey: string): RtcCallRecord | undefined {
    const callId = this.sessionCallMap.get(sessionKey);
    return callId ? this.calls.get(callId) : undefined;
  }

  getAllCalls(): RtcCallRecord[] {
    return [...this.calls.values()];
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private requireCall(callId: string): RtcCallRecord {
    const call = this.calls.get(callId);
    if (!call) throw new Error(`Call not found: ${callId}`);
    return call;
  }

  private assertState(call: RtcCallRecord, expected: RtcCallState): void {
    if (call.state !== expected) {
      throw new Error(
        `Call ${call.callId} is in state "${call.state}", expected "${expected}"`,
      );
    }
  }
}
