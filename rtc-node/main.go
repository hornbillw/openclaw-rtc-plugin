package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
)

func main() {
	gatewayURL := flag.String("gateway", "ws://127.0.0.1:18789", "Gateway WebSocket URL")
	token := flag.String("token", "", "Gateway auth token")
	loopbackSec := flag.Int("loopback", 5, "Loopback recording seconds (0 = immediate echo)")
	noLoopback := flag.Bool("no-loopback", false, "Disable loopback (immediate echo)")
	flag.Parse()

	// Environment variable overrides
	if v := os.Getenv("OPENCLAW_GATEWAY_URL"); v != "" && *gatewayURL == "ws://127.0.0.1:18789" {
		*gatewayURL = v
	}
	if v := os.Getenv("OPENCLAW_GATEWAY_TOKEN"); v != "" && *token == "" {
		*token = v
	}

	if *noLoopback {
		*loopbackSec = 0
	}

	logInfo("connecting to gateway at %s...", *gatewayURL)
	if *loopbackSec == 0 {
		logInfo("audio mode: immediate echo")
	} else {
		logInfo("audio loopback enabled: %ds record → loop", *loopbackSec)
	}

	// Load or create device identity
	home, _ := os.UserHomeDir()
	identityPath := filepath.Join(home, ".openclaw", "identity", "rtc-node-go.json")
	identity := loadOrCreateIdentity(identityPath)
	logInfo("device ID: %s", identity.DeviceID[:16]+"...")

	// Create peer manager
	peerMgr := NewPeerManager(*loopbackSec)

	// Create gateway client
	client := NewGatewayClient(GatewayClientConfig{
		URL:         *gatewayURL,
		Token:       *token,
		Identity:    identity,
		DisplayName: "RTC Node (Go)",
		Caps:        []string{"webrtc", "audio"},
		Commands:    []string{"rtc.call.accept", "rtc.call.remote_candidate", "rtc.call.hangup", "rtc.call.speak"},
		OnInvoke: func(command string, params json.RawMessage) (interface{}, error) {
			logInfo("invoke: %s", command)
			return peerMgr.HandleCommand(command, params)
		},
		LoopbackSec: *loopbackSec,
	})

	if err := client.Connect(); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}

	// Wait for interrupt or connection close
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case <-sigCh:
		logInfo("shutting down...")
	case <-client.Done():
		logInfo("gateway connection closed")
	}

	client.Close()
}
