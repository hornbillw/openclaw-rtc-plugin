// Use inline type declarations to avoid dependency on specific plugin-sdk sub-paths
// that may not exist in the global openclaw installation.

// Minimal NodeRegistry interface — mirrors src/gateway/node-registry.ts
type NodeSession = {
  nodeId: string;
  caps: string[];
  commands: string[];
  displayName?: string;
};

type NodeInvokeResult = {
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string | null;
  error?: { code?: string; message?: string } | null;
};

type NodeRegistry = {
  listConnected(): NodeSession[];
  get(nodeId: string): NodeSession | undefined;
  invoke(params: {
    nodeId: string;
    command: string;
    params?: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
  }): Promise<NodeInvokeResult>;
};

type GatewayRequestHandlerOptions = {
  params?: Record<string, unknown>;
  respond: (ok: boolean, payload?: unknown) => void;
  context?: { nodeRegistry: NodeRegistry; [key: string]: unknown };
  client?: unknown;
  req?: unknown;
};

type OpenClawPluginApi = {
  id: string;
  name: string;
  config: unknown;
  pluginConfig?: Record<string, unknown>;
  runtime: unknown;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  registerGatewayMethod: (method: string, handler: (opts: GatewayRequestHandlerOptions) => void | Promise<void>) => void;
  registerHttpRoute: (params: {
    path: string;
    handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void | Promise<void>;
    auth: "gateway" | "plugin";
    match?: "exact" | "prefix";
  }) => void;
  registerService: (service: { id: string; start: () => void | Promise<void>; stop?: () => void | Promise<void> }) => void;
  registerTool: (tool: unknown) => void;
  registerCli: (registrar: (ctx: unknown) => void | Promise<void>, opts?: { commands?: string[] }) => void;
  resolvePath: (input: string) => string;
};

import {
  resolveWebRtcConfig,
  validateWebRtcConfig,
  type WebRtcConfig,
} from "./src/config.js";
import { CallOrchestrator } from "./src/orchestrator.js";
import type {
  RtcCallStartParams,
  RtcIceCandidateParams,
  RtcHangupParams,
  RtcCallStatusParams,
  NodeAcceptResult,
} from "./src/types.js";

function sendError(
  respond: (ok: boolean, payload?: unknown) => void,
  err: unknown,
) {
  const message = err instanceof Error ? err.message : String(err);
  respond(false, { error: message });
}

const webrtcPlugin = {
  id: "webrtc",
  name: "WebRTC",
  description: "WebRTC voice communication plugin for browser-based voice calls",
  configSchema: {
    parse(value: unknown): WebRtcConfig {
      return resolveWebRtcConfig(value);
    },
    uiHints: {
      enabled: { label: "Enable WebRTC" },
      "volcAppId": { label: "Volcano Engine App ID", sensitive: true },
      "volcAccessKey": { label: "Volcano Engine Access Key", sensitive: true },
      "volcSpeaker": { label: "TTS Speaker", advanced: true },
      "maxConcurrentCalls": { label: "Max Concurrent Calls", advanced: true },
      "maxCallDurationSec": { label: "Max Call Duration (sec)", advanced: true },
      "silenceTimeoutSec": { label: "Silence Timeout (sec)", advanced: true },
      "iceServers": { label: "ICE Servers", advanced: true },
    },
  },

  register(api: OpenClawPluginApi) {
    const config = resolveWebRtcConfig(api.pluginConfig);
    const validation = validateWebRtcConfig(config);

    const orchestrator = new CallOrchestrator({
      maxConcurrentCalls: config.maxConcurrentCalls,
      iceServers: config.iceServers,
    });

    // -----------------------------------------------------------------
    // Gateway Methods
    // -----------------------------------------------------------------

    // rtc.call.start — browser initiates a call (contains SDP offer)
    api.registerGatewayMethod(
      "rtc.call.start",
      async ({ params, respond, context }: GatewayRequestHandlerOptions) => {
        try {
          if (!config.enabled) {
            respond(false, { error: "WebRTC plugin is disabled" });
            return;
          }
          if (!validation.valid) {
            respond(false, { error: `Config invalid: ${validation.errors.join(", ")}` });
            return;
          }
          if (!context?.nodeRegistry) {
            respond(false, { error: "Node registry unavailable" });
            return;
          }

          const sdp = typeof params?.sdp === "string" ? params.sdp.trim() : "";
          const sessionKey =
            typeof params?.sessionKey === "string"
              ? params.sessionKey.trim()
              : "";
          if (!sdp || !sessionKey) {
            respond(false, { error: "sdp and sessionKey are required" });
            return;
          }

          const { callRecord } = orchestrator.startCall({ sdp, sessionKey });

          // Forward offer to RTC node via node.invoke
          const nodeResult = await invokeRtcNode<NodeAcceptResult>(
            context.nodeRegistry,
            api.logger,
            {
              command: "rtc.call.accept",
              params: {
                callId: callRecord.callId,
                offerSdp: sdp,
                iceServers: orchestrator.iceServers,
              },
            },
          );

          if (!nodeResult) {
            const errDetail = nodeResult === null ? "RTC node invoke failed (check gateway logs)" : "No RTC node available";
            orchestrator.setError(callRecord.callId, errDetail);
            respond(false, { error: errDetail });
            return;
          }

          orchestrator.handleAnswer(callRecord.callId, nodeResult.answerSdp);

          respond(true, {
            callId: callRecord.callId,
            answerSdp: nodeResult.answerSdp,
            candidates: nodeResult.candidates ?? [],
            iceServers: orchestrator.iceServers,
          });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    // rtc.call.ice — ICE candidate exchange (bidirectional)
    api.registerGatewayMethod(
      "rtc.call.ice",
      async ({ params, respond, context }: GatewayRequestHandlerOptions) => {
        try {
          const callId = typeof params?.callId === "string" ? params.callId : "";
          const candidate = params?.candidate;
          if (!callId || !candidate) {
            respond(false, { error: "callId and candidate are required" });
            return;
          }

          orchestrator.handleIceCandidate(
            callId,
            candidate as RtcIceCandidateParams["candidate"],
            "remote",
          );

          // Forward to RTC node
          if (context?.nodeRegistry) {
            await invokeRtcNode(context.nodeRegistry, api.logger, {
              command: "rtc.call.remote_candidate",
              params: { callId, candidate },
            });
          }

          respond(true, { ok: true });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    // rtc.call.hangup — hang up (bidirectional)
    api.registerGatewayMethod(
      "rtc.call.hangup",
      async ({ params, respond, context }: GatewayRequestHandlerOptions) => {
        try {
          const callId = typeof params?.callId === "string" ? params.callId : "";
          const reason = typeof params?.reason === "string" ? params.reason : "user";
          if (!callId) {
            respond(false, { error: "callId is required" });
            return;
          }

          orchestrator.hangup(callId, reason);

          // Notify RTC node
          if (context?.nodeRegistry) {
            await invokeRtcNode(context.nodeRegistry, api.logger, {
              command: "rtc.call.hangup",
              params: { callId, reason },
            });
          }

          respond(true, { ok: true });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    // rtc.call.status — query call status
    api.registerGatewayMethod(
      "rtc.call.status",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const callId = typeof params?.callId === "string" ? params.callId : "";
          if (callId) {
            const call = orchestrator.getCall(callId);
            if (!call) {
              respond(false, { error: `Call not found: ${callId}` });
              return;
            }
            respond(true, { call });
          } else {
            const calls = orchestrator.getAllCalls();
            respond(true, { calls, activeCalls: orchestrator.activeCalls });
          }
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    // -----------------------------------------------------------------
    // HTTP route — serve WebUI static files
    // -----------------------------------------------------------------
    api.registerHttpRoute({
      path: "/plugins/webrtc",
      match: "prefix",
      auth: "plugin",
      handler: async (req, res) => {
        const { createReadStream, existsSync, statSync } = await import("node:fs");
        const { join, extname } = await import("node:path");
        const { fileURLToPath } = await import("node:url");

        const baseDir = join(
          fileURLToPath(import.meta.url).replace(/\/index\.[tj]s$/, ""),
          "ui",
        );

        // Strip /plugins/webrtc prefix
        const urlPath = (req.url ?? "/").replace(/^\/plugins\/webrtc\/?/, "/");
        // Also strip query string
        const cleanPath = urlPath.split("?")[0];
        const filePath = cleanPath === "/" || cleanPath === ""
          ? join(baseDir, "index.html")
          : join(baseDir, cleanPath);

        // Security: prevent directory traversal
        if (!filePath.startsWith(baseDir)) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }

        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          // SPA fallback
          const indexPath = join(baseDir, "index.html");
          if (existsSync(indexPath)) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            createReadStream(indexPath).pipe(res);
            return;
          }
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const MIME_TYPES: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".ts": "text/javascript; charset=utf-8",
          ".json": "application/json",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".ico": "image/x-icon",
        };

        const ext = extname(filePath);
        const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
        res.writeHead(200, { "Content-Type": contentType });
        createReadStream(filePath).pipe(res);
      },
    });

    // -----------------------------------------------------------------
    // Service lifecycle
    // -----------------------------------------------------------------
    api.registerService({
      id: "webrtc",
      start: async () => {
        if (!config.enabled) return;
        api.logger.info("[webrtc] Service started");
      },
      stop: async () => {
        // Hangup all active calls on shutdown
        for (const call of orchestrator.getAllCalls()) {
          if (
            call.state !== "hangup-user" &&
            call.state !== "hangup-node" &&
            call.state !== "timeout" &&
            call.state !== "error"
          ) {
            orchestrator.hangup(call.callId, "gateway-shutdown");
          }
        }
        api.logger.info("[webrtc] Service stopped");
      },
    });
  },
};

/**
 * Find the first connected RTC node (a node with "webrtc" capability).
 * Commands are dispatched by the Gateway's invoke mechanism; the node
 * declares supported commands at connect time, but we match by cap only
 * because the NodeRegistry may not expose commands in all versions.
 */
function findRtcNode(
  nodeRegistry: NodeRegistry,
  _command: string,
): NodeSession | null {
  const nodes = nodeRegistry.listConnected();
  return nodes.find((n) => n.caps.includes("webrtc")) ?? null;
}

/**
 * Invoke a command on the first available RTC node via the gateway's node.invoke mechanism.
 * Returns null if no node is available.
 */
async function invokeRtcNode<T = unknown>(
  nodeRegistry: NodeRegistry,
  logger: OpenClawPluginApi["logger"],
  opts: { command: string; params: unknown; timeoutMs?: number },
): Promise<T | null> {
  const node = findRtcNode(nodeRegistry, opts.command);
  if (!node) {
    logger.warn(`[webrtc] invokeRtcNode: no RTC node available for ${opts.command}`);
    return null;
  }

  logger.info(`[webrtc] invokeRtcNode: ${opts.command} → node ${node.nodeId.slice(0, 8)}…`);

  const result = await nodeRegistry.invoke({
    nodeId: node.nodeId,
    command: opts.command,
    params: opts.params,
    timeoutMs: opts.timeoutMs ?? 15_000,
    idempotencyKey: crypto.randomUUID(),
  });

  if (!result.ok) {
    const errMsg = result.error?.message ?? "invoke failed";
    logger.error(`[webrtc] invokeRtcNode: ${opts.command} failed: ${errMsg}`);
    return null;
  }

  // Parse payloadJSON if present, otherwise use payload directly
  if (result.payloadJSON) {
    try {
      return JSON.parse(result.payloadJSON) as T;
    } catch {
      return (result.payload ?? null) as T | null;
    }
  }
  return (result.payload ?? null) as T | null;
}

export default webrtcPlugin;
