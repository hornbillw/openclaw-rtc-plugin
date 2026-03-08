import { EventEmitter } from "node:events";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Volcano Engine Realtime API binary frame protocol
//
// Reference: https://www.volcengine.com/docs/6561/1167274
//
// Frame format:
//   byte 0: protocol version (0x01)
//   byte 1: header size (in 4-byte units)
//   byte 2: message type (0x01=full client, 0x09=audio-only client, 0x0f=error server)
//            + message type specific flags
//   byte 3: message serialization (0x00=none, 0x01=JSON, 0x0f=custom)
//            + message compression (0x00=none, 0x01=gzip)
//   bytes 4-7: payload size (uint32 big-endian)
//   bytes 8+: payload
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = 0x01;
const HEADER_SIZE_UNITS = 0x01; // 1 * 4 = 4 bytes header

// Message types
const MSG_FULL_CLIENT = 0x01;
const MSG_AUDIO_ONLY_CLIENT = 0x09;
const MSG_FULL_SERVER = 0x09; // server-side full message
const MSG_AUDIO_ONLY_SERVER = 0x0b;
const MSG_ERROR_SERVER = 0x0f;

// Serialization
const SERIAL_JSON = 0x01;
const SERIAL_NONE = 0x00;

// Compression
const COMPRESS_NONE = 0x00;

export type VolcClientConfig = {
  appId: string;
  accessKey: string;
  resourceId?: string;
  speaker?: string;
};

export type VolcSessionOptions = {
  /** "O" (online) or "SC" (semi-cached) */
  model?: "O" | "SC";
  speaker?: string;
};

type VolcEvent =
  | { type: "asr"; text: string; isInterim: boolean }
  | { type: "tts_audio"; audio: Buffer }
  | { type: "asr_ended" }
  | { type: "session_started" }
  | { type: "error"; error: Error };

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class VolcRealtimeClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: VolcClientConfig;
  private sessionActive = false;

  constructor(config: VolcClientConfig) {
    super();
    this.config = config;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get isSessionActive(): boolean {
    return this.sessionActive;
  }

  /**
   * Connect to the Volcano Engine Realtime API.
   */
  async connect(): Promise<void> {
    const url = "wss://openspeech.bytedance.com/api/v3/realtime/dialogue";
    const headers = {
      "X-Api-App-ID": this.config.appId,
      "X-Api-Access-Key": this.config.accessKey,
      "X-Api-Resource-Id": this.config.resourceId ?? "volc.speech.dialog",
    };

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      this.ws = ws;

      ws.on("open", () => resolve());
      ws.on("error", (err) => {
        this.emit("error", err);
        reject(err);
      });
      ws.on("message", (data) => this.handleMessage(data as Buffer));
      ws.on("close", () => {
        this.sessionActive = false;
        this.ws = null;
      });
    });
  }

  /**
   * Start a dialogue session.
   */
  startSession(options?: VolcSessionOptions): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }

    const payload = {
      event: "StartSession",
      params: {
        model: options?.model ?? "O",
        speaker: options?.speaker ?? this.config.speaker ?? "zh_female_cancan_mars_bigtts",
        audio_config: {
          input: { encoding: "pcm", sample_rate: 16000, channels: 1 },
          output: { encoding: "ogg_opus", sample_rate: 24000 },
        },
      },
    };

    this.sendJsonFrame(payload);
    this.sessionActive = true;
  }

  /**
   * Send raw PCM audio data (16kHz, mono, int16 LE).
   * Should be called in ~20ms intervals (320 samples = 640 bytes per packet).
   */
  sendAudio(pcmBuffer: Buffer): void {
    if (!this.ws || !this.sessionActive) return;
    this.sendAudioFrame(pcmBuffer);
  }

  /**
   * Send text for TTS synthesis (used when Agent replies).
   */
  sendTtsText(text: string): void {
    if (!this.ws || !this.sessionActive) return;
    const payload = {
      event: "ChatTTSText",
      text,
    };
    this.sendJsonFrame(payload);
  }

  /**
   * Finish the current session.
   */
  finishSession(): void {
    if (!this.ws || !this.sessionActive) return;
    const payload = { event: "FinishSession" };
    this.sendJsonFrame(payload);
    this.sessionActive = false;
  }

  /**
   * Disconnect from the API.
   */
  disconnect(): void {
    this.sessionActive = false;
    this.ws?.close();
    this.ws = null;
  }

  // -----------------------------------------------------------------------
  // Frame encoding
  // -----------------------------------------------------------------------

  private sendJsonFrame(payload: unknown): void {
    const json = JSON.stringify(payload);
    const payloadBuf = Buffer.from(json, "utf8");
    const header = this.buildHeader(MSG_FULL_CLIENT, SERIAL_JSON, payloadBuf.length);
    const frame = Buffer.concat([header, payloadBuf]);
    this.ws?.send(frame);
  }

  private sendAudioFrame(pcmData: Buffer): void {
    const header = this.buildHeader(MSG_AUDIO_ONLY_CLIENT, SERIAL_NONE, pcmData.length);
    const frame = Buffer.concat([header, pcmData]);
    this.ws?.send(frame);
  }

  private buildHeader(
    msgType: number,
    serialization: number,
    payloadSize: number,
  ): Buffer {
    const header = Buffer.alloc(8);
    header[0] = (PROTOCOL_VERSION << 4) | HEADER_SIZE_UNITS;
    header[1] = (msgType << 4) | 0x00; // type + flags
    header[2] = (serialization << 4) | COMPRESS_NONE;
    header[3] = 0x00; // reserved
    header.writeUInt32BE(payloadSize, 4);
    return header;
  }

  // -----------------------------------------------------------------------
  // Frame decoding
  // -----------------------------------------------------------------------

  private handleMessage(data: Buffer): void {
    if (data.length < 8) return;

    const msgType = (data[1] >> 4) & 0x0f;
    const serialization = (data[2] >> 4) & 0x0f;
    const payloadSize = data.readUInt32BE(4);
    const payload = data.subarray(8, 8 + payloadSize);

    if (msgType === MSG_ERROR_SERVER) {
      const text = serialization === SERIAL_JSON
        ? JSON.stringify(JSON.parse(payload.toString("utf8")))
        : payload.toString("utf8");
      this.emit("error", new Error(`Volcano API error: ${text}`));
      return;
    }

    if (msgType === MSG_AUDIO_ONLY_SERVER) {
      // TTS audio data
      this.emitEvent({ type: "tts_audio", audio: Buffer.from(payload) });
      return;
    }

    if (serialization === SERIAL_JSON) {
      try {
        const json = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
        this.handleJsonEvent(json);
      } catch (err) {
        this.emit("error", new Error(`Failed to parse server JSON: ${err}`));
      }
    }
  }

  private handleJsonEvent(json: Record<string, unknown>): void {
    const event = json.event as string | undefined;

    switch (event) {
      case "ASRResponse": {
        const text = (json.text as string) ?? "";
        const isInterim = (json.is_final as boolean) !== true;
        this.emitEvent({ type: "asr", text, isInterim });
        break;
      }
      case "ASREnded":
        this.emitEvent({ type: "asr_ended" });
        break;
      case "SessionStarted":
        this.emitEvent({ type: "session_started" });
        break;
      case "TTSResponse": {
        // TTS response may contain audio inline or signal completion
        if (json.audio && typeof json.audio === "string") {
          const audio = Buffer.from(json.audio, "base64");
          this.emitEvent({ type: "tts_audio", audio });
        }
        break;
      }
      case "Error": {
        const msg = (json.message as string) ?? "Unknown Volcano error";
        this.emitEvent({ type: "error", error: new Error(msg) });
        break;
      }
      default:
        // Emit generic event for unknown types
        this.emit("raw", json);
    }
  }

  private emitEvent(evt: VolcEvent): void {
    switch (evt.type) {
      case "asr":
        this.emit("asr", evt.text, evt.isInterim);
        break;
      case "tts_audio":
        this.emit("tts_audio", evt.audio);
        break;
      case "asr_ended":
        this.emit("asr_ended");
        break;
      case "session_started":
        this.emit("session_started");
        break;
      case "error":
        this.emit("error", evt.error);
        break;
    }
  }
}
