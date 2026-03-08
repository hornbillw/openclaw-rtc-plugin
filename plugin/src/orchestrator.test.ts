import { describe, it, expect, beforeEach } from "vitest";
import { CallOrchestrator } from "./orchestrator.js";

describe("CallOrchestrator", () => {
  let orch: CallOrchestrator;

  beforeEach(() => {
    orch = new CallOrchestrator({ maxConcurrentCalls: 2 });
  });

  describe("startCall", () => {
    it("creates a call in initiating state", () => {
      const { callRecord } = orch.startCall({
        sdp: "offer-sdp",
        sessionKey: "session-1",
      });
      expect(callRecord.state).toBe("initiating");
      expect(callRecord.offerSdp).toBe("offer-sdp");
      expect(callRecord.sessionKey).toBe("session-1");
      expect(callRecord.callId).toBeTruthy();
      expect(callRecord.startedAt).toBeGreaterThan(0);
    });

    it("rejects when max concurrent calls reached", () => {
      orch.startCall({ sdp: "sdp-1", sessionKey: "s1" });
      orch.startCall({ sdp: "sdp-2", sessionKey: "s2" });
      expect(() =>
        orch.startCall({ sdp: "sdp-3", sessionKey: "s3" }),
      ).toThrow("Max concurrent calls (2) reached");
    });

    it("allows new call after previous call ended", () => {
      const { callRecord: c1 } = orch.startCall({
        sdp: "sdp-1",
        sessionKey: "s1",
      });
      orch.hangup(c1.callId, "user");
      // Should succeed because c1 is terminal
      const { callRecord: c2 } = orch.startCall({
        sdp: "sdp-3",
        sessionKey: "s3",
      });
      expect(c2.state).toBe("initiating");
    });

    it("rejects duplicate active call for same session", () => {
      orch.startCall({ sdp: "sdp-1", sessionKey: "s1" });
      expect(() =>
        orch.startCall({ sdp: "sdp-2", sessionKey: "s1" }),
      ).toThrow("already has an active call");
    });

    it("allows new call for same session after previous ended", () => {
      const { callRecord: c1 } = orch.startCall({
        sdp: "sdp-1",
        sessionKey: "s1",
      });
      orch.hangup(c1.callId, "user");
      const { callRecord: c2 } = orch.startCall({
        sdp: "sdp-2",
        sessionKey: "s1",
      });
      expect(c2.state).toBe("initiating");
      expect(c2.callId).not.toBe(c1.callId);
    });
  });

  describe("state transitions", () => {
    it("initiating → connecting via handleAnswer", () => {
      const { callRecord } = orch.startCall({
        sdp: "offer",
        sessionKey: "s1",
      });
      orch.handleAnswer(callRecord.callId, "answer-sdp");
      const call = orch.getCall(callRecord.callId)!;
      expect(call.state).toBe("connecting");
      expect(call.answerSdp).toBe("answer-sdp");
    });

    it("connecting → active via setActive", () => {
      const { callRecord } = orch.startCall({
        sdp: "offer",
        sessionKey: "s1",
      });
      orch.handleAnswer(callRecord.callId, "answer");
      orch.setActive(callRecord.callId);
      const call = orch.getCall(callRecord.callId)!;
      expect(call.state).toBe("active");
      expect(call.connectedAt).toBeGreaterThan(0);
    });

    it("active → hangup-user", () => {
      const { callRecord } = orch.startCall({
        sdp: "offer",
        sessionKey: "s1",
      });
      orch.handleAnswer(callRecord.callId, "answer");
      orch.setActive(callRecord.callId);
      orch.hangup(callRecord.callId, "user");
      const call = orch.getCall(callRecord.callId)!;
      expect(call.state).toBe("hangup-user");
      expect(call.endedAt).toBeGreaterThan(0);
    });

    it("active → hangup-node", () => {
      const { callRecord } = orch.startCall({
        sdp: "offer",
        sessionKey: "s1",
      });
      orch.handleAnswer(callRecord.callId, "answer");
      orch.setActive(callRecord.callId);
      orch.hangup(callRecord.callId, "node-disconnect");
      const call = orch.getCall(callRecord.callId)!;
      expect(call.state).toBe("hangup-node");
    });

    it("rejects handleAnswer on wrong state", () => {
      const { callRecord } = orch.startCall({
        sdp: "offer",
        sessionKey: "s1",
      });
      orch.handleAnswer(callRecord.callId, "answer");
      expect(() =>
        orch.handleAnswer(callRecord.callId, "answer2"),
      ).toThrow('expected "initiating"');
    });

    it("ignores hangup on already-ended call", () => {
      const { callRecord } = orch.startCall({
        sdp: "offer",
        sessionKey: "s1",
      });
      orch.hangup(callRecord.callId, "user");
      // Should not throw
      orch.hangup(callRecord.callId, "node");
      expect(orch.getCall(callRecord.callId)!.state).toBe("hangup-user");
    });
  });

  describe("ICE candidates", () => {
    it("stores local and remote candidates", () => {
      const { callRecord } = orch.startCall({
        sdp: "offer",
        sessionKey: "s1",
      });
      const localCandidate = { candidate: "local-c", sdpMid: "0" };
      const remoteCandidate = { candidate: "remote-c", sdpMid: "0" };
      orch.handleIceCandidate(callRecord.callId, localCandidate, "local");
      orch.handleIceCandidate(callRecord.callId, remoteCandidate, "remote");
      const call = orch.getCall(callRecord.callId)!;
      expect(call.localCandidates).toHaveLength(1);
      expect(call.remoteCandidates).toHaveLength(1);
    });

    it("ignores candidates on ended calls", () => {
      const { callRecord } = orch.startCall({
        sdp: "offer",
        sessionKey: "s1",
      });
      orch.hangup(callRecord.callId, "user");
      orch.handleIceCandidate(
        callRecord.callId,
        { candidate: "c" },
        "local",
      );
      expect(orch.getCall(callRecord.callId)!.localCandidates).toHaveLength(0);
    });
  });

  describe("error and timeout", () => {
    it("setError transitions to error state", () => {
      const { callRecord } = orch.startCall({
        sdp: "offer",
        sessionKey: "s1",
      });
      orch.setError(callRecord.callId, "node crashed");
      const call = orch.getCall(callRecord.callId)!;
      expect(call.state).toBe("error");
      expect(call.endReason).toBe("node crashed");
    });

    it("setTimeout transitions to timeout state", () => {
      const { callRecord } = orch.startCall({
        sdp: "offer",
        sessionKey: "s1",
      });
      orch.setTimeout(callRecord.callId, "silence");
      const call = orch.getCall(callRecord.callId)!;
      expect(call.state).toBe("timeout");
    });
  });

  describe("transcript", () => {
    it("adds transcript entries", () => {
      const { callRecord } = orch.startCall({
        sdp: "offer",
        sessionKey: "s1",
      });
      orch.addTranscript(callRecord.callId, "user", "hello");
      orch.addTranscript(callRecord.callId, "assistant", "hi there");
      const call = orch.getCall(callRecord.callId)!;
      expect(call.transcript).toHaveLength(2);
      expect(call.transcript[0].role).toBe("user");
      expect(call.transcript[0].text).toBe("hello");
      expect(call.transcript[1].role).toBe("assistant");
    });
  });

  describe("queries", () => {
    it("getCallBySession returns active call", () => {
      orch.startCall({ sdp: "offer", sessionKey: "s1" });
      const call = orch.getCallBySession("s1");
      expect(call).toBeDefined();
      expect(call!.sessionKey).toBe("s1");
    });

    it("getAllCalls returns all calls", () => {
      orch.startCall({ sdp: "sdp-1", sessionKey: "s1" });
      orch.startCall({ sdp: "sdp-2", sessionKey: "s2" });
      expect(orch.getAllCalls()).toHaveLength(2);
    });

    it("getCall returns undefined for unknown id", () => {
      expect(orch.getCall("nonexistent")).toBeUndefined();
    });

    it("activeCalls counts only non-terminal calls", () => {
      const { callRecord: c1 } = orch.startCall({
        sdp: "sdp-1",
        sessionKey: "s1",
      });
      orch.startCall({ sdp: "sdp-2", sessionKey: "s2" });
      expect(orch.activeCalls).toBe(2);
      orch.hangup(c1.callId, "user");
      expect(orch.activeCalls).toBe(1);
    });
  });
});
