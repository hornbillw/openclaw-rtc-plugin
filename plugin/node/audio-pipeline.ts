/**
 * Audio pipeline utilities for WebRTC ↔ Volcano Engine audio conversion.
 *
 * WebRTC (via werift) typically delivers Opus-decoded PCM at 48kHz.
 * Volcano Engine expects PCM 16kHz mono int16 LE.
 * Volcano Engine TTS returns OGG/Opus at 24kHz by default.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Volcano Engine input sample rate */
export const VOLC_INPUT_RATE = 16000;
/** Volcano Engine output sample rate (TTS) */
export const VOLC_OUTPUT_RATE = 24000;
/** WebRTC standard sample rate */
export const WEBRTC_RATE = 48000;
/** 20ms frame size at 16kHz = 320 samples = 640 bytes */
export const VOLC_FRAME_BYTES = 640;
/** 20ms frame size at 48kHz = 960 samples = 1920 bytes */
export const WEBRTC_FRAME_BYTES = 1920;

// ---------------------------------------------------------------------------
// PCM resampling — linear interpolation
// ---------------------------------------------------------------------------

function clamp16(value: number): number {
  return Math.max(-32768, Math.min(32767, value));
}

/**
 * Resample PCM int16 LE buffer from one sample rate to another using linear interpolation.
 */
export function resamplePcm(
  input: Buffer,
  fromRate: number,
  toRate: number,
): Buffer {
  if (fromRate === toRate) return input;

  const inputSamples = input.length / 2;
  const ratio = fromRate / toRate;
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;

    const s0 = input.readInt16LE(srcIndex * 2);
    const nextIdx = Math.min(srcIndex + 1, inputSamples - 1);
    const s1 = input.readInt16LE(nextIdx * 2);
    const sample = Math.round(s0 + frac * (s1 - s0));

    output.writeInt16LE(clamp16(sample), i * 2);
  }

  return output;
}

/**
 * Downsample 48kHz PCM to 16kHz PCM (3:1 ratio, optimized path).
 */
export function downsample48to16(input: Buffer): Buffer {
  return resamplePcm(input, WEBRTC_RATE, VOLC_INPUT_RATE);
}

/**
 * Upsample 24kHz PCM to 48kHz PCM (1:2 ratio, for TTS playback).
 */
export function upsample24to48(input: Buffer): Buffer {
  return resamplePcm(input, VOLC_OUTPUT_RATE, WEBRTC_RATE);
}

// ---------------------------------------------------------------------------
// Frame chunking
// ---------------------------------------------------------------------------

/**
 * Split a PCM buffer into fixed-size chunks (for 20ms Volcano Engine frames).
 */
export function* chunkPcm(
  audio: Buffer,
  chunkSize: number = VOLC_FRAME_BYTES,
): Generator<Buffer> {
  for (let i = 0; i < audio.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, audio.length);
    const chunk = audio.subarray(i, end);
    // Pad last chunk if needed
    if (chunk.length < chunkSize) {
      const padded = Buffer.alloc(chunkSize);
      chunk.copy(padded);
      yield padded;
    } else {
      yield chunk;
    }
  }
}

// ---------------------------------------------------------------------------
// Audio accumulator — buffers incoming audio and emits fixed-size frames
// ---------------------------------------------------------------------------

export class AudioFrameAccumulator {
  private buffer = Buffer.alloc(0);
  private frameSize: number;

  constructor(frameSize: number = VOLC_FRAME_BYTES) {
    this.frameSize = frameSize;
  }

  /**
   * Push new audio data. Returns an array of complete frames.
   */
  push(data: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, data]);
    const frames: Buffer[] = [];

    while (this.buffer.length >= this.frameSize) {
      frames.push(this.buffer.subarray(0, this.frameSize));
      this.buffer = this.buffer.subarray(this.frameSize);
    }

    return frames;
  }

  /** Flush remaining data (padded to frame size if needed). */
  flush(): Buffer | null {
    if (this.buffer.length === 0) return null;
    const padded = Buffer.alloc(this.frameSize);
    this.buffer.copy(padded);
    this.buffer = Buffer.alloc(0);
    return padded;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
