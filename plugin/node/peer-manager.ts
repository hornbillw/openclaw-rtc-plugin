import { EventEmitter } from "node:events";

export type PeerManagerOptions = {
  iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }>;
  /** Enable audio loopback: record N seconds then loop back to browser. 0 = immediate echo. */
  loopbackSec?: number;
};

export type CreatePeerResult = {
  answerSdp: string;
  candidates: Array<{
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  }>;
};

/**
 * Manages WebRTC PeerConnection instances via werift.
 * Each active call gets its own PeerConnection.
 */
export class RtcPeerManager extends EventEmitter {
  private peers = new Map<string, unknown>(); // callId → werift PeerConnection
  private loopbacks = new Map<string, { timer?: ReturnType<typeof setTimeout> }>(); // callId → loopback state
  private options: PeerManagerOptions;

  constructor(options?: PeerManagerOptions) {
    super();
    this.options = options ?? {};

    // Auto-cleanup peers when they disconnect/fail
    this.on("peerclose", ({ callId }: { callId: string }) => {
      void this.closePeer(callId);
    });
  }

  /**
   * Accept an incoming call: create PeerConnection, set remote offer, create answer.
   */
  async acceptCall(
    callId: string,
    offerSdp: string,
    iceServers?: PeerManagerOptions["iceServers"],
  ): Promise<CreatePeerResult> {
    const { RTCPeerConnection, RTCSessionDescription } = await import("werift");
    const log = (msg: string) => console.log(`[peer:${callId.slice(0, 8)}] ${msg}`);

    const pc = new RTCPeerConnection({
      iceServers: (iceServers ?? this.options.iceServers ?? []).map((s) => ({
        urls: s.urls,
        username: s.username,
        credential: s.credential,
      })),
    });

    // Add audio transceiver — werift answer.ts pattern: explicit sendrecv direction
    const audioTransceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
    log("created audio transceiver (sendrecv)");

    const loopbackSec = this.options.loopbackSec ?? 0;

    // Wire up audio echo/loopback on the transceiver's onTrack
    audioTransceiver.onTrack.subscribe((track) => {
      log(`onTrack: kind=${track.kind} ssrc=${track.ssrc}`);
      this.emit("track", { callId, track });

      // Always start with immediate echo so DTLS completes (replaceTrack with
      // received track is the canonical werift pattern that ensures DTLS connects).
      audioTransceiver.sender.replaceTrack(track);
      log("replaceTrack(received track) on sender — echo active");

      if (loopbackSec > 0) {
        // After DTLS connects, switch to delayed loopback mode
        this.startDelayedLoopback(callId, track, audioTransceiver, loopbackSec);
      }
    });

    // Collect ICE candidates
    const candidates: CreatePeerResult["candidates"] = [];
    pc.onIceCandidate.subscribe((candidate) => {
      if (candidate) {
        log(`local ICE: ${candidate.candidate}`);
        const init = {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid ?? null,
          sdpMLineIndex: candidate.sdpMLineIndex ?? null,
        };
        candidates.push(init);
        this.emit("icecandidate", { callId, candidate: init });
      }
    });

    pc.connectionStateChange.subscribe(() => {
      log(`connectionState: ${pc.connectionState}`);
      this.emit("connectionstatechange", { callId, state: pc.connectionState });
      if (
        pc.connectionState === "disconnected" ||
        pc.connectionState === "failed" ||
        pc.connectionState === "closed"
      ) {
        this.emit("peerclose", { callId, state: pc.connectionState });
      }
    });

    pc.iceConnectionStateChange?.subscribe?.(() => {
      log(`iceConnectionState: ${pc.iceConnectionState}`);
    });

    // Set remote offer
    log(`setting remote offer SDP (${offerSdp.length} bytes)`);
    await pc.setRemoteDescription(
      new RTCSessionDescription(offerSdp, "offer"),
    );

    // Create answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    const answerSdp = pc.localDescription?.sdp ?? answer.sdp;
    log(`answer SDP ready (${answerSdp.length} bytes)`);
    // Log SDP media lines for debugging
    answerSdp.split("\n").filter((l: string) => l.startsWith("m=") || l.startsWith("a=fingerprint") || l.startsWith("a=setup")).forEach((l: string) => log(`  SDP: ${l.trim()}`));

    this.peers.set(callId, pc);

    return {
      answerSdp,
      candidates,
    };
  }

  /**
   * Delayed loopback: record incoming RTP for N seconds, then loop back via sender track.
   * IMPORTANT: The caller already did replaceTrack(receivedTrack) for immediate echo,
   * ensuring DTLS connects. We record in the background, then switch the sender track
   * to a local track for playback once recording is done.
   */
  private async startDelayedLoopback(
    callId: string,
    incomingTrack: unknown,
    audioTransceiver: unknown,
    seconds: number,
  ): Promise<void> {
    const log = (msg: string) => console.log(`[loopback:${callId.slice(0, 8)}] ${msg}`);
    const { MediaStreamTrack } = await import("werift");

    const track = incomingTrack as {
      onReceiveRtp: { subscribe: (cb: (rtp: unknown) => void) => void };
      kind: string;
    };
    const transceiver = audioTransceiver as {
      sender: { replaceTrack: (t: unknown) => Promise<void> };
      codecs: Array<{ payloadType: number }>;
    };

    // Pre-create a local sender track for playback (created now while we're in async context)
    const senderTrack = new MediaStreamTrack({ kind: "audio" });

    // Get the correct payload type from the transceiver's negotiated codecs
    const payloadType = transceiver.codecs?.[0]?.payloadType;
    log(`codec payloadType: ${payloadType}`);

    // Record incoming RTP packets (echo is active during this phase)
    type RtpPkt = { header: { payloadType: number }; clone: () => unknown };
    const buffer: unknown[] = [];
    let recording = true;
    let rtpCount = 0;
    let lastLogTime = Date.now();

    track.onReceiveRtp.subscribe((rtpPacket: unknown) => {
      rtpCount++;
      const now = Date.now();
      if (now - lastLogTime >= 1000) {
        log(`RTP recv: ${rtpCount} pkts total, buffer=${buffer.length}, recording=${recording}`);
        lastLogTime = now;
      }
      if (recording) {
        const pkt = rtpPacket as RtpPkt;
        buffer.push(pkt.clone());
      }
    });

    const state = { timer: undefined as ReturnType<typeof setTimeout> | undefined };
    this.loopbacks.set(callId, state);
    log(`recording ${seconds}s of audio (echo active during recording)...`);

    state.timer = setTimeout(() => {
      recording = false;
      log(`recorded ${buffer.length} RTP packets in ${seconds}s`);

      if (buffer.length === 0) {
        log("no packets recorded");
        return;
      }

      // Switch sender to local track for playback, then start looping
      transceiver.sender.replaceTrack(senderTrack).then(() => {
        log("sender switched to local track for playback");

        const loopOnce = () => {
          if (!this.loopbacks.has(callId)) return;
          log(`looping ${buffer.length} packets...`);

          let i = 0;
          const playNext = () => {
            if (!this.loopbacks.has(callId) || i >= buffer.length) {
              if (this.loopbacks.has(callId)) {
                state.timer = setTimeout(loopOnce, 20);
              }
              return;
            }

            try {
              const rtp = buffer[i] as RtpPkt;
              if (payloadType != null) {
                rtp.header.payloadType = payloadType;
              }
              senderTrack.writeRtp(rtp as import("werift").RtpPacket);
            } catch (err) {
              log(`writeRtp error at ${i}: ${err instanceof Error ? err.message : String(err)}`);
              return;
            }
            i++;
            state.timer = setTimeout(playNext, 20);
          };

          playNext();
        };

        loopOnce();
      }).catch((err: unknown) => {
        log(`replaceTrack for playback failed: ${err instanceof Error ? (err as Error).message : String(err)}`);
      });
    }, seconds * 1000);
  }

  /**
   * Add a remote ICE candidate to an existing PeerConnection.
   */
  async addRemoteCandidate(
    callId: string,
    candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null },
  ): Promise<void> {
    const pc = this.peers.get(callId) as
      | { addIceCandidate: (c: unknown) => Promise<void> }
      | undefined;
    if (!pc) throw new Error(`No peer for call: ${callId}`);
    const { RTCIceCandidate } = await import("werift");
    await pc.addIceCandidate(
      new RTCIceCandidate({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? undefined,
        sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
      }),
    );
  }

  /**
   * Close and clean up a PeerConnection.
   */
  async closePeer(callId: string): Promise<void> {
    const loopback = this.loopbacks.get(callId);
    if (loopback) {
      if (loopback.timer) clearTimeout(loopback.timer);
      this.loopbacks.delete(callId);
    }

    const pc = this.peers.get(callId) as
      | { close: () => Promise<void> }
      | undefined;
    if (!pc) return;
    this.peers.delete(callId);
    try {
      await pc.close();
    } catch {
      // ignore close errors
    }
  }

  getPeer(callId: string): unknown {
    return this.peers.get(callId);
  }

  async closeAll(): Promise<void> {
    const ids = [...this.peers.keys()];
    await Promise.all(ids.map((id) => this.closePeer(id)));
  }
}
