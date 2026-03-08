import { describe, it, expect, vi, beforeEach } from "vitest";
import { RtcPeerManager } from "./peer-manager.js";

// Mock werift — the real module won't be installed in CI without adding it to deps
vi.mock("werift", () => {
  class MockRTCSessionDescription {
    sdp: string;
    type: string;
    constructor(sdp: string, type: string) {
      this.sdp = sdp;
      this.type = type;
    }
  }

  class MockRTCIceCandidate {
    candidate: string;
    sdpMid?: string;
    sdpMLineIndex?: number;
    constructor(init: { candidate: string; sdpMid?: string; sdpMLineIndex?: number }) {
      this.candidate = init.candidate;
      this.sdpMid = init.sdpMid;
      this.sdpMLineIndex = init.sdpMLineIndex;
    }
  }

  class MockRTCPeerConnection {
    connectionState = "new";
    localDescription: { sdp: string } | null = null;
    private iceCandidateCallbacks: Array<(c: unknown) => void> = [];
    private trackCallbacks: Array<(e: unknown) => void> = [];
    private stateChangeCallbacks: Array<() => void> = [];
    private remoteDescription: MockRTCSessionDescription | null = null;

    onIceCandidate = {
      subscribe: (cb: (c: unknown) => void) => {
        this.iceCandidateCallbacks.push(cb);
      },
    };
    onTrack = {
      subscribe: (cb: (e: unknown) => void) => {
        this.trackCallbacks.push(cb);
      },
    };
    onConnectionStateChange = {
      subscribe: (cb: () => void) => {
        this.stateChangeCallbacks.push(cb);
      },
    };

    addTransceiver(_kind: string, _opts: unknown) {
      return {};
    }

    async setRemoteDescription(desc: MockRTCSessionDescription) {
      this.remoteDescription = desc;
    }

    async createAnswer() {
      return { sdp: "mock-answer-sdp", type: "answer" };
    }

    async setLocalDescription(desc: { sdp: string }) {
      this.localDescription = desc;
    }

    async addIceCandidate(_candidate: unknown) {
      // no-op in mock
    }

    async close() {
      this.connectionState = "closed";
    }
  }

  return {
    RTCPeerConnection: MockRTCPeerConnection,
    RTCSessionDescription: MockRTCSessionDescription,
    RTCIceCandidate: MockRTCIceCandidate,
  };
});

describe("RtcPeerManager", () => {
  let manager: RtcPeerManager;

  beforeEach(() => {
    manager = new RtcPeerManager();
  });

  describe("acceptCall", () => {
    it("creates a peer and returns answer SDP", async () => {
      const result = await manager.acceptCall("call-1", "offer-sdp-content");
      expect(result.answerSdp).toBe("mock-answer-sdp");
      expect(manager.getPeer("call-1")).toBeDefined();
    });

    it("returns empty candidates initially", async () => {
      const result = await manager.acceptCall("call-2", "offer-sdp");
      // Mock doesn't fire ICE candidates synchronously
      expect(result.candidates).toEqual([]);
    });
  });

  describe("addRemoteCandidate", () => {
    it("throws for unknown call", async () => {
      await expect(
        manager.addRemoteCandidate("unknown", { candidate: "c" }),
      ).rejects.toThrow("No peer for call");
    });

    it("succeeds for existing call", async () => {
      await manager.acceptCall("call-1", "offer-sdp");
      await expect(
        manager.addRemoteCandidate("call-1", {
          candidate: "candidate:...",
          sdpMid: "0",
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("closePeer", () => {
    it("removes the peer", async () => {
      await manager.acceptCall("call-1", "offer-sdp");
      expect(manager.getPeer("call-1")).toBeDefined();
      await manager.closePeer("call-1");
      expect(manager.getPeer("call-1")).toBeUndefined();
    });

    it("is a no-op for unknown call", async () => {
      await expect(manager.closePeer("unknown")).resolves.toBeUndefined();
    });
  });

  describe("closeAll", () => {
    it("closes all peers", async () => {
      await manager.acceptCall("call-1", "sdp1");
      await manager.acceptCall("call-2", "sdp2");
      await manager.closeAll();
      expect(manager.getPeer("call-1")).toBeUndefined();
      expect(manager.getPeer("call-2")).toBeUndefined();
    });
  });
});
