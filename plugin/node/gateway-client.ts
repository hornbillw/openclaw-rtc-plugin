import { randomUUID, generateKeyPairSync, createPublicKey, createHash, createPrivateKey, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Frame types (subset of gateway protocol)
// ---------------------------------------------------------------------------

type RequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

type ResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
};

type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
};

type Frame = RequestFrame | ResponseFrame | EventFrame;

// ---------------------------------------------------------------------------
// Device identity — Ed25519 keypair for gateway auth
// ---------------------------------------------------------------------------

type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem: string): string {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return createHash("sha256").update(raw).digest("hex");
}

function publicKeyRawBase64Url(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function signPayload(privateKeyPem: string, payload: string): string {
  const key = createPrivateKey(privateKeyPem);
  const sig = sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

function generateDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { deviceId: fingerprintPublicKey(publicKeyPem), publicKeyPem, privateKeyPem };
}

function loadOrCreateIdentity(filePath: string): DeviceIdentity {
  try {
    if (existsSync(filePath)) {
      const raw = JSON.parse(readFileSync(filePath, "utf8"));
      if (raw?.version === 1 && raw.deviceId && raw.publicKeyPem && raw.privateKeyPem) {
        return { deviceId: raw.deviceId, publicKeyPem: raw.publicKeyPem, privateKeyPem: raw.privateKeyPem };
      }
    }
  } catch { /* regenerate */ }

  const identity = generateDeviceIdentity();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ version: 1, ...identity, createdAtMs: Date.now() }, null, 2) + "\n", { mode: 0o600 });
  return identity;
}

/**
 * Build v3 device auth payload for signing.
 */
function buildAuthPayloadV3(params: {
  deviceId: string; clientId: string; clientMode: string;
  role: string; scopes: string; signedAtMs: number;
  token: string; nonce: string; platform: string;
}): string {
  return [
    "v3", params.deviceId, params.clientId, params.clientMode,
    params.role, params.scopes, String(params.signedAtMs),
    params.token, params.nonce, params.platform, "", // deviceFamily
  ].join("|");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GatewayNodeClientOptions = {
  url: string;
  token?: string;
  nodeId?: string;
  displayName?: string;
  commands: string[];
  caps?: string[];
  identityPath?: string;
  onInvoke?: (command: string, params: unknown) => Promise<unknown>;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

// ---------------------------------------------------------------------------
// Lightweight Gateway WS client for RTC Node
// ---------------------------------------------------------------------------

export class GatewayNodeClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private opts: GatewayNodeClientOptions;
  private identity: DeviceIdentity;
  private pending = new Map<string, PendingRequest>();
  private connectSent = false;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;

  constructor(opts: GatewayNodeClientOptions) {
    super();
    this.opts = opts;
    const identityPath = opts.identityPath ??
      join(process.env.HOME ?? "/tmp", ".openclaw", "identity", "rtc-node.json");
    this.identity = loadOrCreateIdentity(identityPath);
  }

  get deviceId(): string {
    return this.identity.deviceId;
  }

  start(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.opts.url, {
      maxPayload: 25 * 1024 * 1024,
    });
    this.ws = ws;
    this.connectSent = false;

    ws.on("open", () => {
      this.backoffMs = 1000;
      this.emit("open");
    });

    ws.on("message", (data) => {
      try {
        const text = typeof data === "string" ? data : data.toString("utf8");
        const frame = JSON.parse(text) as Frame;
        this.handleFrame(frame);
      } catch (err) {
        this.emit("error", err);
      }
    });

    ws.on("close", (code, reason) => {
      this.ws = null;
      this.flushPending(new Error(`gateway closed (${code})`));
      this.emit("close", code, reason.toString("utf8"));
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.emit("error", err);
    });
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.flushPending(new Error("client stopped"));
  }

  /** Send a request to the gateway and await the response. */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("not connected");
    }
    const id = randomUUID();
    const frame: RequestFrame = { type: "req", id, method, params };
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
    });
    this.ws.send(JSON.stringify(frame));
    return p;
  }

  // -----------------------------------------------------------------------
  // Frame handling
  // -----------------------------------------------------------------------

  private handleFrame(frame: Frame): void {
    switch (frame.type) {
      case "event":
        this.handleEvent(frame);
        break;
      case "res":
        this.handleResponse(frame);
        break;
      case "req":
        break;
    }
  }

  private handleEvent(frame: EventFrame): void {
    if (frame.event === "connect.challenge") {
      this.handleChallenge(frame.payload as { nonce: string });
      return;
    }
    if (frame.event === "node.invoke.request") {
      void this.handleInvokeRequest(frame.payload);
      return;
    }
    this.emit("event", frame);
  }

  private handleResponse(frame: ResponseFrame): void {
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);

    if (frame.ok) {
      pending.resolve(frame.payload);
    } else {
      pending.reject(
        new Error(frame.error?.message ?? "request failed"),
      );
    }
  }

  private handleChallenge(payload: { nonce: string }): void {
    if (this.connectSent) return;
    this.connectSent = true;

    const nonce = payload.nonce;
    const signedAtMs = Date.now();
    const role = "node";
    const clientId = "node-host";
    const clientMode = "node";
    const token = this.opts.token ?? "";

    // Build v3 signed payload
    const authPayload = buildAuthPayloadV3({
      deviceId: this.identity.deviceId,
      clientId,
      clientMode,
      role,
      scopes: "",
      signedAtMs,
      token,
      nonce,
      platform: process.platform,
    });
    const signature = signPayload(this.identity.privateKeyPem, authPayload);

    const connectParams = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: clientId,
        displayName: this.opts.displayName ?? `RTC Node (${this.identity.deviceId.slice(0, 8)})`,
        version: "2026.3.8",
        platform: process.platform,
        mode: clientMode,
      },
      role,
      caps: this.opts.caps ?? ["webrtc", "audio"],
      commands: this.opts.commands,
      auth: token ? { token } : undefined,
      device: {
        id: this.identity.deviceId,
        publicKey: publicKeyRawBase64Url(this.identity.publicKeyPem),
        signature,
        signedAt: signedAtMs,
        nonce,
      },
    };

    void this.request("connect", connectParams)
      .then((result) => {
        const hello = result as { type: string; server?: { connId: string } };
        if (hello?.type === "hello-ok") {
          this.emit("connected", hello);
        }
      })
      .catch((err) => {
        this.emit("error", err);
      });
  }

  private async handleInvokeRequest(payload: unknown): Promise<void> {
    const p = payload as {
      id: string;
      command: string;
      paramsJSON?: string;
    };
    if (!p?.id || !p?.command) return;

    let params: unknown;
    try {
      params = p.paramsJSON ? JSON.parse(p.paramsJSON) : undefined;
    } catch {
      params = undefined;
    }

    try {
      const result = this.opts.onInvoke
        ? await this.opts.onInvoke(p.command, params)
        : { error: "no handler" };

      await this.request("node.invoke.result", {
        id: p.id,
        nodeId: this.identity.deviceId,
        ok: true,
        payloadJSON: JSON.stringify(result),
      });
    } catch (err) {
      await this.request("node.invoke.result", {
        id: p.id,
        nodeId: this.identity.deviceId,
        ok: false,
        payloadJSON: JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      }).catch(() => {});
    }
  }

  // -----------------------------------------------------------------------
  // Reconnect
  // -----------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
  }

  private flushPending(err: Error): void {
    for (const p of this.pending.values()) {
      p.reject(err);
    }
    this.pending.clear();
  }
}
