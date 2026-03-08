import { describe, it, expect } from "vitest";
import {
  resamplePcm,
  downsample48to16,
  upsample24to48,
  chunkPcm,
  AudioFrameAccumulator,
  VOLC_FRAME_BYTES,
} from "./audio-pipeline.js";

describe("audio-pipeline", () => {
  describe("resamplePcm", () => {
    it("returns same buffer when rates are equal", () => {
      const input = Buffer.alloc(100);
      const result = resamplePcm(input, 16000, 16000);
      expect(result).toBe(input);
    });

    it("downsamples 48kHz to 16kHz (3:1)", () => {
      // 6 samples at 48kHz → 2 samples at 16kHz
      const input = Buffer.alloc(12); // 6 int16 samples
      input.writeInt16LE(100, 0);
      input.writeInt16LE(200, 2);
      input.writeInt16LE(300, 4);
      input.writeInt16LE(400, 6);
      input.writeInt16LE(500, 8);
      input.writeInt16LE(600, 10);

      const result = resamplePcm(input, 48000, 16000);
      expect(result.length).toBe(4); // 2 samples * 2 bytes
    });

    it("upsamples 16kHz to 48kHz (1:3)", () => {
      // 2 samples at 16kHz → 6 samples at 48kHz
      const input = Buffer.alloc(4);
      input.writeInt16LE(0, 0);
      input.writeInt16LE(3000, 2);

      const result = resamplePcm(input, 16000, 48000);
      expect(result.length).toBe(12); // 6 samples * 2 bytes
    });

    it("clamps values to int16 range", () => {
      const input = Buffer.alloc(4);
      input.writeInt16LE(32767, 0); // max int16
      input.writeInt16LE(32767, 2);

      const result = resamplePcm(input, 16000, 48000);
      for (let i = 0; i < result.length; i += 2) {
        const sample = result.readInt16LE(i);
        expect(sample).toBeLessThanOrEqual(32767);
        expect(sample).toBeGreaterThanOrEqual(-32768);
      }
    });
  });

  describe("downsample48to16", () => {
    it("converts 48kHz to 16kHz", () => {
      const input = Buffer.alloc(1920); // 960 samples at 48kHz = 20ms
      const result = downsample48to16(input);
      expect(result.length).toBe(640); // 320 samples at 16kHz = 20ms
    });
  });

  describe("upsample24to48", () => {
    it("converts 24kHz to 48kHz", () => {
      const input = Buffer.alloc(960); // 480 samples at 24kHz = 20ms
      const result = upsample24to48(input);
      expect(result.length).toBe(1920); // 960 samples at 48kHz = 20ms
    });
  });

  describe("chunkPcm", () => {
    it("splits buffer into frames", () => {
      const input = Buffer.alloc(VOLC_FRAME_BYTES * 3);
      const chunks = [...chunkPcm(input)];
      expect(chunks).toHaveLength(3);
      for (const chunk of chunks) {
        expect(chunk.length).toBe(VOLC_FRAME_BYTES);
      }
    });

    it("pads last frame if needed", () => {
      const input = Buffer.alloc(VOLC_FRAME_BYTES + 100);
      const chunks = [...chunkPcm(input)];
      expect(chunks).toHaveLength(2);
      expect(chunks[1].length).toBe(VOLC_FRAME_BYTES);
    });

    it("handles empty buffer", () => {
      const chunks = [...chunkPcm(Buffer.alloc(0))];
      expect(chunks).toHaveLength(0);
    });
  });

  describe("AudioFrameAccumulator", () => {
    it("accumulates data and emits complete frames", () => {
      const acc = new AudioFrameAccumulator(640);

      // Push less than one frame
      let frames = acc.push(Buffer.alloc(320));
      expect(frames).toHaveLength(0);

      // Push enough for one frame
      frames = acc.push(Buffer.alloc(320));
      expect(frames).toHaveLength(1);
      expect(frames[0].length).toBe(640);
    });

    it("handles multiple frames in one push", () => {
      const acc = new AudioFrameAccumulator(640);
      const frames = acc.push(Buffer.alloc(640 * 3 + 100));
      expect(frames).toHaveLength(3);
    });

    it("flushes remaining data with padding", () => {
      const acc = new AudioFrameAccumulator(640);
      acc.push(Buffer.alloc(100));
      const flushed = acc.flush();
      expect(flushed).not.toBeNull();
      expect(flushed!.length).toBe(640);
    });

    it("flush returns null when empty", () => {
      const acc = new AudioFrameAccumulator(640);
      expect(acc.flush()).toBeNull();
    });

    it("reset clears buffer", () => {
      const acc = new AudioFrameAccumulator(640);
      acc.push(Buffer.alloc(300));
      acc.reset();
      expect(acc.flush()).toBeNull();
    });
  });
});
