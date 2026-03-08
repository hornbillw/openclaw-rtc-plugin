#!/usr/bin/env node

/**
 * RTC Node — standalone process that connects to the OpenClaw Gateway via
 * WebSocket (role: "node") and manages WebRTC PeerConnections + audio
 * pipelines for voice calls.
 *
 * Usage:
 *   bun extensions/webrtc/node/index.ts [--gateway ws://127.0.0.1:18789] [--token TOKEN]
 */

import { GatewayNodeClient } from "./gateway-client.js";
import { RtcPeerManager } from "./peer-manager.js";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(): { gateway: string; token?: string; nodeId: string; loopbackSec: number } {
  const args = process.argv.slice(2);
  let gateway = "ws://127.0.0.1:18789";
  let token: string | undefined;
  let nodeId = `rtc-node-${process.pid}`;
  let loopbackSec = 5; // default: 5 second loopback

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--gateway" && args[i + 1]) {
      gateway = args[++i];
    } else if (args[i] === "--token" && args[i + 1]) {
      token = args[++i];
    } else if (args[i] === "--node-id" && args[i + 1]) {
      nodeId = args[++i];
    } else if (args[i] === "--loopback" && args[i + 1]) {
      loopbackSec = Number(args[++i]) || 5;
    } else if (args[i] === "--no-loopback") {
      loopbackSec = 0;
    }
  }

  // Allow env overrides
  gateway = process.env.OPENCLAW_GATEWAY_URL ?? gateway;
  token = process.env.OPENCLAW_GATEWAY_TOKEN ?? token;

  return { gateway, token, nodeId, loopbackSec };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { gateway, token, nodeId, loopbackSec } = parseArgs();

  const peerManager = new RtcPeerManager({ loopbackSec });

  const log = (msg: string) =>
    console.log(`[rtc-node] ${msg}`);

  // Handle commands from the gateway
  const handleCommand = async (
    command: string,
    params: unknown,
  ): Promise<unknown> => {
    const p = (params ?? {}) as Record<string, unknown>;

    switch (command) {
      case "rtc.call.accept": {
        const callId = p.callId as string;
        const offerSdp = p.offerSdp as string;
        const iceServers = p.iceServers as Array<{
          urls: string | string[];
          username?: string;
          credential?: string;
        }>;
        log(`accepting call ${callId}`);
        try {
          const result = await peerManager.acceptCall(callId, offerSdp, iceServers);
          log(`call ${callId} accepted, answer SDP ready`);
          return result;
        } catch (err) {
          log(`call ${callId} acceptCall failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
          throw err;
        }
      }

      case "rtc.call.remote_candidate": {
        const callId = p.callId as string;
        const candidate = p.candidate as {
          candidate: string;
          sdpMid?: string | null;
          sdpMLineIndex?: number | null;
        };
        await peerManager.addRemoteCandidate(callId, candidate);
        return { ok: true };
      }

      case "rtc.call.hangup": {
        const callId = p.callId as string;
        const reason = p.reason as string;
        log(`hanging up call ${callId}: ${reason}`);
        await peerManager.closePeer(callId);
        return { ok: true };
      }

      case "rtc.call.speak": {
        const callId = p.callId as string;
        const text = p.text as string;
        log(`speak request for call ${callId}: "${text.slice(0, 50)}..."`);
        // TODO: Phase 3 — send text to Volcano Engine TTS
        return { ok: true };
      }

      default:
        return { error: `unknown command: ${command}` };
    }
  };

  const client = new GatewayNodeClient({
    url: gateway,
    token,
    displayName: `RTC Node`,
    commands: [
      "rtc.call.accept",
      "rtc.call.remote_candidate",
      "rtc.call.hangup",
      "rtc.call.speak",
    ],
    caps: ["webrtc", "audio"],
    onInvoke: handleCommand,
  });

  client.on("connected", (hello: unknown) => {
    log(`connected to gateway: ${JSON.stringify(hello)}`);
  });

  client.on("error", (err: Error) => {
    log(`error: ${err.message}`);
  });

  client.on("close", (code: number, reason: string) => {
    log(`disconnected (${code}): ${reason}`);
  });

  // PeerManager events
  peerManager.on("connectionstatechange", ({ callId, state }: { callId: string; state: string }) => {
    log(`peer ${callId} connection: ${state}`);
  });

  peerManager.on("peerclose", ({ callId }: { callId: string }) => {
    log(`peer ${callId} closed`);
  });

  peerManager.on("track", ({ callId }: { callId: string }) => {
    log(`received audio track for call ${callId}`);
    // TODO: Phase 3 — wire audio to Volcano Engine
  });

  // Start the client
  log(`connecting to gateway at ${gateway}...`);
  if (loopbackSec > 0) log(`audio loopback enabled: ${loopbackSec}s record → loop`);
  client.start();

  // Graceful shutdown
  const shutdown = async () => {
    log("shutting down...");
    await peerManager.closeAll();
    client.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main().catch((err) => {
  console.error("RTC Node fatal error:", err);
  process.exit(1);
});
