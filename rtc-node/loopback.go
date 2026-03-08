package main

import (
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// loopbackTrack echoes audio while recording for N seconds, then switches to replay.
func loopbackTrack(
	remote *webrtc.TrackRemote,
	local *webrtc.TrackLocalStaticRTP,
	lb *LoopbackState,
	log func(string, ...interface{}),
) {
	log("loopback started: %ds echo+record, then replay", lb.seconds)

	recording := true
	recordStart := time.Time{}
	var pktCount int

	for {
		pkt, _, err := remote.ReadRTP()
		if err != nil {
			log("loopback read error: %v", err)
			return
		}

		pktCount++

		// Start recording timer from first packet (after ICE connects)
		if recordStart.IsZero() {
			recordStart = time.Now()
			log("first RTP packet, recording started")
		}

		// Echo while recording
		if recording {
			local.WriteRTP(pkt)
		}

		// Buffer for replay
		if recording {
			// Clone packet for buffer
			clone := &rtp.Packet{}
			clone.Header = pkt.Header
			clone.Payload = make([]byte, len(pkt.Payload))
			copy(clone.Payload, pkt.Payload)

			lb.bufMu.Lock()
			lb.buffer = append(lb.buffer, clone)
			lb.bufMu.Unlock()
		}

		// Check if recording window is over
		if recording && !recordStart.IsZero() && time.Since(recordStart) >= time.Duration(lb.seconds)*time.Second {
			recording = false
			lb.bufMu.Lock()
			bufLen := len(lb.buffer)
			lb.bufMu.Unlock()
			log("recorded %d RTP packets in %ds, switching to replay", bufLen, lb.seconds)

			// Start replay in a separate goroutine
			go replayLoop(local, lb, log)
		}

		// Log progress every second
		if pktCount%50 == 0 {
			lb.bufMu.Lock()
			bufLen := len(lb.buffer)
			lb.bufMu.Unlock()
			log("RTP recv: %d pkts, buffer=%d, recording=%v", pktCount, bufLen, recording)
		}
	}
}

// replayLoop continuously loops the recorded buffer, writing one packet every 20ms.
func replayLoop(local *webrtc.TrackLocalStaticRTP, lb *LoopbackState, log func(string, ...interface{})) {
	lb.bufMu.Lock()
	buf := make([]*rtp.Packet, len(lb.buffer))
	copy(buf, lb.buffer)
	lb.bufMu.Unlock()

	if len(buf) == 0 {
		log("replay: no packets to replay")
		return
	}

	loopNum := 0
	for {
		select {
		case <-lb.stopCh:
			log("replay stopped")
			return
		default:
		}

		loopNum++
		log("replaying %d packets (loop #%d)", len(buf), loopNum)

		for _, pkt := range buf {
			select {
			case <-lb.stopCh:
				return
			default:
			}

			if err := local.WriteRTP(pkt); err != nil {
				log("replay write error: %v", err)
				return
			}
			time.Sleep(20 * time.Millisecond) // 20ms per Opus frame
		}
	}
}
