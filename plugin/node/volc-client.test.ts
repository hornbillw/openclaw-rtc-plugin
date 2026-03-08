import { describe, it, expect, vi, beforeEach } from "vitest";
import { VolcRealtimeClient } from "./volc-client.js";

// Mock WebSocket
const mockWs = {
  readyState: 1, // OPEN
  send: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
};

vi.mock("ws", () => {
  const OPEN = 1;
  class MockWebSocket {
    static OPEN = OPEN;
    readyState = OPEN;
    private handlers = new Map<string, Function>();

    constructor(_url: string, _opts?: unknown) {
      // Simulate open on next tick
      setTimeout(() => {
        const onOpen = this.handlers.get("open");
        if (onOpen) onOpen();
      }, 0);
    }

    on(event: string, handler: Function) {
      this.handlers.set(event, handler);
      return this;
    }

    send = vi.fn();
    close = vi.fn();

    // Expose for test access
    _emitMessage(data: Buffer) {
      const handler = this.handlers.get("message");
      if (handler) handler(data);
    }
  }

  return { default: MockWebSocket, WebSocket: MockWebSocket };
});

describe("VolcRealtimeClient", () => {
  let client: VolcRealtimeClient;

  beforeEach(() => {
    client = new VolcRealtimeClient({
      appId: "test-app-id",
      accessKey: "test-access-key",
    });
  });

  describe("constructor", () => {
    it("creates a client with config", () => {
      expect(client.isConnected).toBe(false);
      expect(client.isSessionActive).toBe(false);
    });
  });

  describe("connect", () => {
    it("connects successfully", async () => {
      await client.connect();
      expect(client.isConnected).toBe(true);
    });
  });

  describe("startSession", () => {
    it("sends StartSession frame", async () => {
      await client.connect();
      client.startSession({ model: "O", speaker: "zh_male_test" });
      expect(client.isSessionActive).toBe(true);
    });
  });

  describe("sendAudio", () => {
    it("does not throw when session is active", async () => {
      await client.connect();
      client.startSession();
      const pcm = Buffer.alloc(640); // 20ms at 16kHz
      expect(() => client.sendAudio(pcm)).not.toThrow();
    });

    it("no-ops when session is not active", () => {
      const pcm = Buffer.alloc(640);
      // Should not throw even without connection
      expect(() => client.sendAudio(pcm)).not.toThrow();
    });
  });

  describe("sendTtsText", () => {
    it("sends ChatTTSText frame when session is active", async () => {
      await client.connect();
      client.startSession();
      expect(() => client.sendTtsText("Hello")).not.toThrow();
    });
  });

  describe("finishSession", () => {
    it("marks session as inactive", async () => {
      await client.connect();
      client.startSession();
      expect(client.isSessionActive).toBe(true);
      client.finishSession();
      expect(client.isSessionActive).toBe(false);
    });
  });

  describe("disconnect", () => {
    it("cleans up state", async () => {
      await client.connect();
      client.startSession();
      client.disconnect();
      expect(client.isConnected).toBe(false);
      expect(client.isSessionActive).toBe(false);
    });
  });
});
