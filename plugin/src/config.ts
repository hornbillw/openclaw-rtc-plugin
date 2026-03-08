import { z } from "zod";
import { IceServerSchema, DEFAULT_ICE_SERVERS } from "./types.js";

export const WebRtcConfigSchema = z.object({
  enabled: z.boolean().default(false),
  iceServers: z.array(IceServerSchema).default(DEFAULT_ICE_SERVERS),
  volcAppId: z.string().optional(),
  volcAccessKey: z.string().optional(),
  volcResourceId: z.string().default("volc.speech.dialog"),
  volcSpeaker: z.string().default("zh_female_cancan_mars_bigtts"),
  maxConcurrentCalls: z.number().int().min(1).default(5),
  maxCallDurationSec: z.number().int().min(1).default(600),
  silenceTimeoutSec: z.number().int().min(1).default(30),
});

export type WebRtcConfig = z.infer<typeof WebRtcConfigSchema>;

export function resolveWebRtcConfig(raw: unknown): WebRtcConfig {
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return WebRtcConfigSchema.parse({
    ...obj,
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : false,
  });
}

export function validateWebRtcConfig(config: WebRtcConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (config.enabled) {
    if (!config.volcAppId) errors.push("volcAppId is required when enabled");
    if (!config.volcAccessKey) errors.push("volcAccessKey is required when enabled");
  }
  return { valid: errors.length === 0, errors };
}
