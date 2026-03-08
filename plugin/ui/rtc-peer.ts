/**
 * Browser-side RTCPeerConnection manager.
 * Handles getUserMedia, SDP negotiation, and ICE exchange.
 */

export type RtcPeerCallbacks = {
  onIceCandidate: (candidate: RTCIceCandidateInit) => void;
  onTrack: (event: RTCTrackEvent) => void;
  onConnectionStateChange: (state: RTCPeerConnectionState) => void;
};

export class RtcPeer {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private callbacks: RtcPeerCallbacks;

  constructor(callbacks: RtcPeerCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Create an offer: get user media, create PeerConnection, generate SDP offer.
   */
  async createOffer(iceServers?: RTCIceServer[]): Promise<string> {
    // Get microphone audio
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48000,
      },
      video: false,
    });

    this.pc = new RTCPeerConnection({
      iceServers: iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }],
    });

    // Add local audio track
    for (const track of this.localStream.getAudioTracks()) {
      this.pc.addTrack(track, this.localStream);
    }

    // ICE candidate handler
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.callbacks.onIceCandidate(event.candidate.toJSON());
      }
    };

    // Remote track handler
    this.pc.ontrack = (event) => {
      this.callbacks.onTrack(event);
    };

    // Connection state change
    this.pc.onconnectionstatechange = () => {
      if (this.pc) {
        this.callbacks.onConnectionStateChange(this.pc.connectionState);
      }
    };

    // Create and set offer
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    return offer.sdp!;
  }

  /**
   * Handle answer SDP from the server.
   */
  async handleAnswer(sdp: string): Promise<void> {
    if (!this.pc) throw new Error("No PeerConnection");
    await this.pc.setRemoteDescription(
      new RTCSessionDescription({ type: "answer", sdp }),
    );
  }

  /**
   * Add a remote ICE candidate.
   */
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc) throw new Error("No PeerConnection");
    await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  /**
   * Close the connection and release media.
   */
  hangup(): void {
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        track.stop();
      }
      this.localStream = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
  }

  get connectionState(): RTCPeerConnectionState | null {
    return this.pc?.connectionState ?? null;
  }
}
