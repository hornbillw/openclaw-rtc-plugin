package main

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// AcceptCallParams is the input for rtc.call.accept.
type AcceptCallParams struct {
	CallID     string      `json:"callId"`
	OfferSDP   string      `json:"offerSdp"`
	ICEServers []ICEServer `json:"iceServers"`
}

type ICEServer struct {
	URLs       interface{} `json:"urls"` // string or []string
	Username   string      `json:"username,omitempty"`
	Credential string      `json:"credential,omitempty"`
}

// AcceptCallResult is returned from rtc.call.accept.
type AcceptCallResult struct {
	AnswerSDP  string             `json:"answerSdp"`
	Candidates []ICECandidateJSON `json:"candidates"`
}

type ICECandidateJSON struct {
	Candidate     string  `json:"candidate"`
	SDPMid        *string `json:"sdpMid,omitempty"`
	SDPMLineIndex *uint16 `json:"sdpMLineIndex,omitempty"`
}

// RemoteCandidateParams is the input for rtc.call.remote_candidate.
type RemoteCandidateParams struct {
	CallID    string `json:"callId"`
	Candidate struct {
		Candidate     string  `json:"candidate"`
		SDPMid        *string `json:"sdpMid,omitempty"`
		SDPMLineIndex *uint16 `json:"sdpMLineIndex,omitempty"`
	} `json:"candidate"`
}

// HangupParams is the input for rtc.call.hangup.
type HangupParams struct {
	CallID string `json:"callId"`
	Reason string `json:"reason"`
}

type peerEntry struct {
	pc         *webrtc.PeerConnection
	localTrack *webrtc.TrackLocalStaticRTP
	loopback   *LoopbackState
	cancelFunc func()
}

// PeerManager manages WebRTC PeerConnections via pion/webrtc.
type PeerManager struct {
	loopbackSec int
	peers       map[string]*peerEntry
	mu          sync.Mutex
}

func NewPeerManager(loopbackSec int) *PeerManager {
	return &PeerManager{
		loopbackSec: loopbackSec,
		peers:       make(map[string]*peerEntry),
	}
}

func (pm *PeerManager) AcceptCall(params AcceptCallParams) (*AcceptCallResult, error) {
	callTag := params.CallID[:8]
	log := func(msg string, args ...interface{}) {
		logInfo("[peer:%s] "+msg, append([]interface{}{callTag}, args...)...)
	}

	// Build ICE server config
	iceServers := []webrtc.ICEServer{
		{URLs: []string{"stun:stun.l.google.com:19302"}},
	}
	for _, s := range params.ICEServers {
		is := webrtc.ICEServer{Username: s.Username, Credential: s.Credential}
		switch v := s.URLs.(type) {
		case string:
			is.URLs = []string{v}
		case []interface{}:
			for _, u := range v {
				if us, ok := u.(string); ok {
					is.URLs = append(is.URLs, us)
				}
			}
		}
		if len(is.URLs) > 0 {
			iceServers = append(iceServers, is)
		}
	}

	// Create PeerConnection with SettingEngine for reliability
	se := webrtc.SettingEngine{}
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	// Use DTLSRoleServer (passive) so browser initiates DTLS after receiving our answer.
	// Default DTLSRoleClient (active) causes pion to send ClientHello before the browser
	// has our answer SDP, leading to intermittent DTLS handshake failures.
	se.SetAnsweringDTLSRole(webrtc.DTLSRoleServer)

	api := webrtc.NewAPI(webrtc.WithSettingEngine(se))
	pc, err := api.NewPeerConnection(webrtc.Configuration{
		ICEServers: iceServers,
	})
	if err != nil {
		return nil, fmt.Errorf("new PeerConnection: %w", err)
	}

	// Create output track + AddTrack BEFORE SetRemoteDescription (reflect pattern)
	outputTrack, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus},
		"audio", "pion",
	)
	if err != nil {
		pc.Close()
		return nil, fmt.Errorf("new local track: %w", err)
	}

	rtpSender, err := pc.AddTrack(outputTrack)
	if err != nil {
		pc.Close()
		return nil, fmt.Errorf("add track: %w", err)
	}

	// RTCP drain
	go func() {
		rtcpBuf := make([]byte, 1500)
		for {
			if _, _, rtcpErr := rtpSender.Read(rtcpBuf); rtcpErr != nil {
				return
			}
		}
	}()

	// SetRemoteDescription AFTER AddTrack (reflect pattern)
	offerSDP := params.OfferSDP
	if len(offerSDP) > 0 && offerSDP[len(offerSDP)-1] != '\n' {
		offerSDP += "\r\n"
	}
	log("setting remote offer (%d bytes)", len(offerSDP))
	if err = pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  offerSDP,
	}); err != nil {
		pc.Close()
		return nil, fmt.Errorf("set remote description: %w", err)
	}
	log("remote description set OK")

	entry := &peerEntry{
		pc:         pc,
		localTrack: outputTrack,
	}

	// OnTrack handler
	pc.OnTrack(func(remoteTrack *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		log("onTrack: kind=%s codec=%s ssrc=%d", remoteTrack.Kind(), remoteTrack.Codec().MimeType, remoteTrack.SSRC())

		if pm.loopbackSec == 0 {
			go echoTrack(remoteTrack, outputTrack, log)
		} else {
			lb := NewLoopbackState(pm.loopbackSec)
			pm.mu.Lock()
			if e, ok := pm.peers[params.CallID]; ok {
				e.loopback = lb
			}
			pm.mu.Unlock()
			go loopbackTrack(remoteTrack, outputTrack, lb, log)
		}
	})

	// Connection state handlers
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log("connectionState: %s", state.String())
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			pm.ClosePeer(params.CallID)
		}
	})

	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		log("iceConnectionState: %s", state.String())
	})

	// Collect ICE candidates
	var candidatesMu sync.Mutex
	var candidates []ICECandidateJSON
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		candidatesMu.Lock()
		candidates = append(candidates, ICECandidateJSON{
			Candidate:     c.ToJSON().Candidate,
			SDPMid:        c.ToJSON().SDPMid,
			SDPMLineIndex: c.ToJSON().SDPMLineIndex,
		})
		candidatesMu.Unlock()
	})

	// CreateAnswer
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		pc.Close()
		return nil, fmt.Errorf("create answer: %w", err)
	}
	log("answer created OK")

	// SetLocalDescription + wait for ICE gathering
	gatherComplete := webrtc.GatheringCompletePromise(pc)
	if err = pc.SetLocalDescription(answer); err != nil {
		pc.Close()
		return nil, fmt.Errorf("set local description: %w", err)
	}
	<-gatherComplete

	// Store peer
	pm.mu.Lock()
	pm.peers[params.CallID] = entry
	pm.mu.Unlock()

	answerSDP := pc.LocalDescription().SDP
	log("answer SDP ready (%d bytes)", len(answerSDP))

	// Collect gathered candidates
	candidatesMu.Lock()
	collectedCandidates := candidates
	candidatesMu.Unlock()
	log("collected %d ICE candidates", len(collectedCandidates))

	result := &AcceptCallResult{
		AnswerSDP:  answerSDP,
		Candidates: collectedCandidates,
	}

	return result, nil
}

func (pm *PeerManager) AddRemoteCandidate(params RemoteCandidateParams) error {
	pm.mu.Lock()
	entry, ok := pm.peers[params.CallID]
	pm.mu.Unlock()
	if !ok {
		return fmt.Errorf("no peer for call: %s", params.CallID)
	}

	init := webrtc.ICECandidateInit{
		Candidate:     params.Candidate.Candidate,
		SDPMid:        params.Candidate.SDPMid,
		SDPMLineIndex: params.Candidate.SDPMLineIndex,
	}
	return entry.pc.AddICECandidate(init)
}

func (pm *PeerManager) Hangup(callID string) {
	pm.ClosePeer(callID)
}

func (pm *PeerManager) ClosePeer(callID string) {
	pm.mu.Lock()
	entry, ok := pm.peers[callID]
	if ok {
		delete(pm.peers, callID)
	}
	pm.mu.Unlock()

	if !ok {
		return
	}

	if entry.loopback != nil {
		entry.loopback.Stop()
	}
	if entry.pc != nil {
		entry.pc.Close()
	}
	logInfo("[peer:%s] closed", callID[:min(8, len(callID))])
}

func (pm *PeerManager) HandleCommand(command string, raw json.RawMessage) (interface{}, error) {
	switch command {
	case "rtc.call.accept":
		var p AcceptCallParams
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("parse accept params: %w", err)
		}
		return pm.AcceptCall(p)

	case "rtc.call.remote_candidate":
		var p RemoteCandidateParams
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("parse candidate params: %w", err)
		}
		return map[string]bool{"ok": true}, pm.AddRemoteCandidate(p)

	case "rtc.call.hangup":
		var p HangupParams
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("parse hangup params: %w", err)
		}
		pm.Hangup(p.CallID)
		return map[string]bool{"ok": true}, nil

	default:
		return nil, fmt.Errorf("unknown command: %s", command)
	}
}

// echoTrack reads RTP from remote and writes to local (immediate echo).
func echoTrack(remote *webrtc.TrackRemote, local *webrtc.TrackLocalStaticRTP, log func(string, ...interface{})) {
	log("echo started")
	var count int
	start := time.Now()
	for {
		pkt, _, err := remote.ReadRTP()
		if err != nil {
			log("echo read error after %d packets (%.1fs): %v", count, time.Since(start).Seconds(), err)
			return
		}
		if err := local.WriteRTP(pkt); err != nil {
			log("echo write error after %d packets: %v", count, err)
			return
		}
		count++
		if count == 1 {
			log("first RTP packet echoed")
		}
		if count%250 == 0 {
			log("echo: %d packets (%.1fs)", count, time.Since(start).Seconds())
		}
	}
}

// LoopbackState holds the state for delayed recording + replay.
type LoopbackState struct {
	seconds int
	buffer  []*rtp.Packet
	bufMu   sync.Mutex
	stopped bool
	stopCh  chan struct{}
}

func NewLoopbackState(seconds int) *LoopbackState {
	return &LoopbackState{
		seconds: seconds,
		stopCh:  make(chan struct{}),
	}
}

func (lb *LoopbackState) Stop() {
	lb.bufMu.Lock()
	defer lb.bufMu.Unlock()
	if !lb.stopped {
		lb.stopped = true
		close(lb.stopCh)
	}
}
