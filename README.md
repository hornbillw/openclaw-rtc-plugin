# OpenClaw RTC Plugin

WebRTC voice communication plugin for [OpenClaw](https://github.com/nicepkg/openclaw). Enables browser-based real-time voice calls through the OpenClaw Gateway.

## Architecture

```
Browser (WebUI)                    OpenClaw Gateway                  RTC Node (Go)
┌──────────────┐                  ┌─────────────────┐              ┌──────────────┐
│  getUserMedia │──── WS ────────▶│  Plugin (TS)     │── WS ──────▶│  pion/webrtc  │
│  RTCPeer      │  rtc.call.start │  Orchestrator    │ node.invoke │  PeerManager  │
│              │◀── answer+ICE ──│  Call routing     │◀── result ──│  Echo/Loopback│
│  Audio I/O   │◀═══ RTP/DTLS ══════════════════════════════════▶│  Audio pipe   │
└──────────────┘     (direct)     └─────────────────┘              └──────────────┘
```

**Three components:**

1. **Plugin** (`plugin/`) — TypeScript extension loaded by OpenClaw Gateway. Registers `rtc.call.*` gateway methods, manages call orchestration, and routes commands to the RTC Node via `node.invoke`.

2. **RTC Node** (`rtc-node/`) — Standalone Go program using [pion/webrtc](https://github.com/pion/webrtc). Connects to Gateway as `role: "node"` with Ed25519 device identity. Handles WebRTC PeerConnection lifecycle: SDP negotiation, ICE exchange, and audio processing.

3. **WebUI** (`plugin/ui/`) — Self-contained HTML/JS frontend. Captures microphone audio, establishes WebRTC connection, displays call state.

## Directory Structure

```
├── plugin/                     # OpenClaw Gateway plugin (TypeScript)
│   ├── index.ts                # Plugin entry — registers gateway methods
│   ├── package.json            # Plugin dependencies (werift, ws, zod)
│   ├── openclaw.plugin.json    # Plugin manifest and config schema
│   ├── src/                    # Orchestration layer
│   │   ├── config.ts           # Configuration parsing and validation
│   │   ├── orchestrator.ts     # Call lifecycle management
│   │   ├── store.ts            # State store
│   │   └── types.ts            # Shared type definitions
│   ├── node/                   # TypeScript RTC Node (legacy, replaced by Go)
│   │   ├── index.ts            # Node entry point
│   │   ├── gateway-client.ts   # Gateway WS client + Ed25519 auth
│   │   ├── peer-manager.ts     # werift PeerConnection manager
│   │   ├── audio-pipeline.ts   # Audio processing pipeline
│   │   └── volc-client.ts      # Volcano Engine TTS integration
│   └── ui/                     # Browser WebUI
│       ├── index.html          # Single-page app entry
│       ├── app.ts / app.js     # App logic (WS connection, call UI)
│       ├── rtc-peer.ts / .js   # WebRTC peer wrapper
│       └── styles.css          # Styling
│
├── rtc-node/                   # Go RTC Node (pion/webrtc)
│   ├── go.mod / go.sum         # Go module (openclaw-rtc-node)
│   ├── main.go                 # CLI entry (--gateway, --token, --loopback)
│   ├── gateway.go              # Gateway WS client, auth handshake, message dispatch
│   ├── identity.go             # Ed25519 device identity (generate, persist, sign)
│   ├── peer.go                 # PeerManager: PeerConnection, SDP, ICE, echo/loopback
│   └── loopback.go             # Audio loopback: immediate echo + delayed replay
│
└── docs/                       # Development documentation
    ├── DEVLOG.md               # Detailed development log (5 phases)
    └── go-rtc-node-plan.md     # Go rewrite technical design
```

## Quick Start

### 1. Start Gateway

```bash
# Ensure OpenClaw gateway is running with the plugin loaded
openclaw gateway run --port 18789
```

### 2. Build & Run RTC Node (Go)

```bash
cd rtc-node
go build -o rtc-node .
./rtc-node \
  --gateway ws://127.0.0.1:18789 \
  --token YOUR_GATEWAY_TOKEN \
  --no-loopback   # immediate echo mode
```

**CLI flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--gateway` | `ws://127.0.0.1:18789` | Gateway WebSocket URL |
| `--token` | (empty) | Gateway auth token |
| `--loopback N` | `5` | Record N seconds then loop playback |
| `--no-loopback` | false | Immediate echo (loopback=0) |

**Environment variables:** `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`

### 3. Open WebUI

```bash
cd plugin/ui
python3 -m http.server 8766

# Open in browser:
# http://localhost:8766/#gateway=ws://127.0.0.1:18789&token=YOUR_TOKEN
```

Click the call button. You should hear your voice echoed back.

## Signaling Flow

```
Browser                   Gateway                   RTC Node
   │                         │                         │
   │── rtc.call.start ──────▶│                         │
   │   (SDP offer)           │── node.invoke ─────────▶│
   │                         │   rtc.call.accept       │
   │                         │   (offer SDP)           │
   │                         │                         │── SetRemoteDescription
   │                         │                         │── CreateAnswer
   │                         │                         │── GatheringComplete
   │                         │◀── invoke.result ───────│
   │◀── answer + candidates ─│   (answer SDP +         │
   │                         │    ICE candidates)      │
   │── rtc.call.ice ────────▶│── node.invoke ─────────▶│── AddICECandidate
   │                         │                         │
   │◀════════ RTP/DTLS (direct P2P) ═════════════════▶│
   │                         │                         │
   │── rtc.call.hangup ─────▶│── node.invoke ─────────▶│── pc.Close()
```

## Key Technical Decisions

### DTLS Role: Server (Passive)

The most critical fix. pion/webrtc as answerer defaults to `DTLSRoleClient` (active), meaning it sends `ClientHello` immediately after ICE connects — before the browser has received the SDP answer. This causes intermittent (~80%) DTLS handshake failures.

**Fix:** `SettingEngine.SetAnsweringDTLSRole(DTLSRoleServer)` makes pion passive. The browser initiates DTLS only after receiving the answer, guaranteeing correct timing.

See [docs/DEVLOG.md — Phase 5, Problem 2](docs/DEVLOG.md) for the full root cause analysis.

### Default MediaEngine (No Custom Codec Registration)

Using `webrtc.NewPeerConnection()` with pion's default MediaEngine instead of custom codec registration. The default properly registers Opus with `Channels: 2` and `SDPFmtpLine: "minptime=10;useinbandfec=1"`, matching browser expectations exactly.

### AddTrack Before SetRemoteDescription

Following pion's [reflect example](https://github.com/pion/webrtc/tree/master/examples/reflect): create the output track and call `AddTrack` before `SetRemoteDescription`. This ensures the answer SDP includes a send direction for the audio track.

## Audio Modes

### Immediate Echo (`--no-loopback`)

Reads RTP packets from the browser's audio track and writes them back immediately. You hear your own voice with ~20ms round-trip delay.

### Delayed Loopback (`--loopback N`)

1. First N seconds: echo audio back while recording all RTP packets to a buffer
2. After N seconds: stop echoing, continuously replay the buffered packets (20ms per packet)

## Development

### Plugin Development

The plugin requires OpenClaw's plugin infrastructure. Install it as an extension:

```bash
# Symlink into OpenClaw extensions directory
ln -sfn /path/to/openclaw-rtc-plugin/plugin ~/.openclaw/extensions/webrtc

# Or configure in openclaw.json
{
  "plugins": {
    "allow": ["webrtc"],
    "load": { "paths": ["/path/to/openclaw-rtc-plugin/plugin"] },
    "entries": { "webrtc": { "enabled": true } }
  }
}
```

### Go RTC Node Development

```bash
cd rtc-node
go build -o rtc-node .

# For local pion development, add replace directive in go.mod:
# replace github.com/pion/webrtc/v4 => /path/to/pion/webrtc
```

### Dependencies

**Go RTC Node:**
- [pion/webrtc v4](https://github.com/pion/webrtc) — WebRTC implementation
- [gorilla/websocket](https://github.com/gorilla/websocket) — WebSocket client
- [google/uuid](https://github.com/google/uuid) — UUID generation
- Go stdlib `crypto/ed25519` — Device identity

**Plugin (TypeScript):**
- [werift](https://github.com/nicepkg/werift) — WebRTC (legacy TS node, being replaced)
- ws — WebSocket
- zod — Schema validation

## Documentation

- [docs/DEVLOG.md](docs/DEVLOG.md) — Detailed development log covering all 5 phases (plugin loading, gateway auth, signaling, WebUI, Go rewrite)
- [docs/go-rtc-node-plan.md](docs/go-rtc-node-plan.md) — Technical design for the Go RTC Node rewrite

## Status

- [x] Gateway plugin: call orchestration, method routing
- [x] Go RTC Node: Gateway auth, SDP negotiation, ICE exchange
- [x] Immediate echo mode (verified stable)
- [x] DTLS reliability fix (DTLSRoleServer)
- [ ] Delayed loopback mode (implemented, needs testing)
- [ ] Volcano Engine TTS integration (Go)
- [ ] Audio file playback
- [ ] TURN server support for NAT traversal

## License

MIT
