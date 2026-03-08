/**
 * Browser-side RTCPeerConnection manager.
 * Handles getUserMedia, SDP negotiation, and ICE exchange.
 */
export class RtcPeer {
  /** @type {RTCPeerConnection|null} */
  #pc = null;
  /** @type {MediaStream|null} */
  #localStream = null;
  #callbacks;

  constructor(callbacks) {
    this.#callbacks = callbacks;
  }

  /**
   * Create an offer: get user media, create PeerConnection, generate SDP offer.
   */
  async createOffer(iceServers) {
    this.#localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48000,
      },
      video: false,
    });

    this.#pc = new RTCPeerConnection({
      iceServers: iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }],
    });

    for (const track of this.#localStream.getAudioTracks()) {
      this.#pc.addTrack(track, this.#localStream);
    }

    this.#pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.#callbacks.onIceCandidate(event.candidate.toJSON());
      }
    };

    this.#pc.ontrack = (event) => {
      this.#callbacks.onTrack(event);
    };

    this.#pc.onconnectionstatechange = () => {
      if (this.#pc) {
        this.#callbacks.onConnectionStateChange(this.#pc.connectionState);
      }
    };

    const offer = await this.#pc.createOffer();
    await this.#pc.setLocalDescription(offer);
    return offer.sdp;
  }

  async handleAnswer(sdp) {
    if (!this.#pc) throw new Error("No PeerConnection");
    await this.#pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp }));
  }

  async addIceCandidate(candidate) {
    if (!this.#pc) throw new Error("No PeerConnection");
    await this.#pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  hangup() {
    if (this.#localStream) {
      for (const track of this.#localStream.getTracks()) track.stop();
      this.#localStream = null;
    }
    if (this.#pc) {
      this.#pc.close();
      this.#pc = null;
    }
  }

  get connectionState() {
    return this.#pc?.connectionState ?? null;
  }
}
