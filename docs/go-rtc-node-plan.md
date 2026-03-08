# Plan: 用 pion/webrtc (Go) 重写 RTC Node

## Context

当前 RTC Node 用 TypeScript + werift 实现，存在以下问题：
- werift 库不够成熟，DTLS 连接不稳定，API 有诸多陷阱（需要显式 `{ direction: "sendrecv" }`，`replaceTrack` 时序敏感）
- ICE 连接在远程测试时频繁 disconnected → failed
- 音频回环的 RTP 包处理依赖大量 workaround

用户希望切换到 pion/webrtc（Go），这是目前最成熟的 Go WebRTC 库，有丰富的 examples。pion 已 clone 到 `~/projects/webrtc`。

## 目标

在 `extensions/webrtc/go/` 下创建一个独立 Go 程序，功能等价于当前 `extensions/webrtc/node/` 的 TypeScript 实现：
1. 通过 Gateway WebSocket 以 `role: "node"` 接入（含 Ed25519 设备身份认证）
2. 处理 `rtc.call.accept` / `rtc.call.remote_candidate` / `rtc.call.hangup` 命令
3. 用 pion/webrtc 管理 PeerConnection，完成 SDP 协商 + ICE 交换
4. 支持立即回声和延迟回放两种音频回环模式

## 文件结构

```
extensions/webrtc/go/
├── go.mod                  # module: openclaw-rtc-node
├── go.sum
├── main.go                 # CLI 入口，解析参数，启动 GatewayClient
├── gateway.go              # Gateway WS 客户端：连接、认证、消息收发
├── identity.go             # Ed25519 设备身份：生成、持久化、签名
├── peer.go                 # PeerManager：pion PeerConnection 管理、SDP、ICE
└── loopback.go             # 音频回环：立即回声 + 延迟录制回放
```

## 实现细节

### 1. `main.go` — CLI 入口

- 命令行参数（与 TS 版兼容）：
  - `--gateway ws://127.0.0.1:18789`（默认）
  - `--token TOKEN`
  - `--loopback N`（默认 5，0 = 立即回声）
  - `--no-loopback`（等价于 `--loopback 0`）
- 环境变量：`OPENCLAW_GATEWAY_URL`、`OPENCLAW_GATEWAY_TOKEN`
- 启动流程：加载/生成身份 → 连接 Gateway → 注册命令处理器 → 等待退出

### 2. `gateway.go` — Gateway WS 客户端

**消息帧格式（JSON）：**
```go
type RequestFrame struct {
    Type   string      `json:"type"`   // "req"
    ID     string      `json:"id"`     // UUID
    Method string      `json:"method"`
    Params interface{} `json:"params,omitempty"`
}

type ResponseFrame struct {
    Type    string      `json:"type"`    // "res"
    ID      string      `json:"id"`
    OK      bool        `json:"ok"`
    Payload interface{} `json:"payload,omitempty"`
    Error   *FrameError `json:"error,omitempty"`
}

type EventFrame struct {
    Type    string      `json:"type"`    // "event"
    Event   string      `json:"event"`
    Payload interface{} `json:"payload,omitempty"`
}
```

**连接握手流程：**
1. WebSocket 连接 Gateway URL
2. 收到 `event: connect.challenge`（含 `nonce`）
3. 构造 v3 签名 payload：`v3|deviceId|node-host|node|node||signedAtMs|token|nonce|platform|`
4. Ed25519 签名，发送 `req: connect`（含 device.publicKey/signature/signedAt/nonce）
5. 收到 `res: connect` → `hello-ok`

**命令分发：**
- 收到 `event: node.invoke.request` → 解析 `command` + `paramsJSON`
- 调用对应 handler（`rtc.call.accept` → PeerManager）
- 发送 `req: node.invoke.result`（含 `id`/`nodeId`/`ok`/`payloadJSON`）

依赖：`github.com/gorilla/websocket`

### 3. `identity.go` — Ed25519 设备身份

- 密钥对生成：Go 标准库 `crypto/ed25519`
- 持久化路径：`~/.openclaw/identity/rtc-node-go.json`（与 TS 版分开）
- 签名：对 v3 payload UTF-8 字节做 `ed25519.Sign()`
- Public key 编码：raw 32 字节 → base64url（无 padding）
- Signature 编码：64 字节 → base64url（无 padding）
- Device ID：`sha256(rawPublicKey)` → hex

### 4. `peer.go` — PeerManager (pion/webrtc)

**关键 pion API（从 examples/reflect 学习）：**

```go
// 创建 PeerConnection
pc, _ := webrtc.NewPeerConnection(webrtc.Configuration{
    ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}},
})

// 接收浏览器 track → 创建本地 track echo 回去
pc.OnTrack(func(remoteTrack *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
    localTrack, _ := webrtc.NewTrackLocalStaticRTP(
        remoteTrack.Codec().RTPCodecCapability, "audio", "echo",
    )
    pc.AddTrack(localTrack)
    // goroutine: remoteTrack.ReadRTP() → localTrack.WriteRTP()
})

// SDP 协商（answerer 角色）
pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offerSdp})
answer, _ := pc.CreateAnswer(nil)
pc.SetLocalDescription(answer)
// 等 ICE gathering 完成
<-webrtc.GatheringCompletePromise(pc)
```

**acceptCall 流程：**
1. 创建 PeerConnection（含 ICE servers）
2. 注册 OnTrack handler（echo 或 loopback）
3. 注册 OnICECandidate handler（收集候选）
4. 注册 OnConnectionStateChange handler
5. `SetRemoteDescription(offer)`
6. `CreateAnswer()` → `SetLocalDescription(answer)`
7. 等待 ICE gathering 完成（`GatheringCompletePromise`）
8. 返回 `answerSdp` + `candidates`

**与 TS 版的关键区别：**
- pion 不需要先 `addTransceiver`，`OnTrack` 自动触发
- pion 的 `TrackLocalStaticRTP.WriteRTP()` 直接写 RTP 包
- ICE gathering 用 channel 等待，不需要手动收集

### 5. `loopback.go` — 音频回环

**立即回声（loopback=0）：**
```go
// OnTrack 内
go func() {
    for {
        rtp, _, err := remoteTrack.ReadRTP()
        if err != nil { return }
        localTrack.WriteRTP(rtp)
    }
}()
```

**延迟回放（loopback=N）：**
1. 前 N 秒：`ReadRTP()` → 同时 echo + 存入 buffer
2. N 秒后：停止 echo，循环 `WriteRTP(bufferedPackets)` 每 20ms 一包

## 依赖

```
github.com/gorilla/websocket  v1.5.x   — WebSocket 客户端
github.com/pion/webrtc/v4              — WebRTC（本地路径 replace）
github.com/google/uuid                 — UUID 生成
```

`go.mod` 中用 `replace` 指向本地 pion：
```
replace github.com/pion/webrtc/v4 => /Users/superwings/projects/webrtc
```

## 参考文件

| 文件 | 用途 |
|------|------|
| `extensions/webrtc/node/gateway-client.ts` | WS 协议、Ed25519 认证的完整实现 |
| `extensions/webrtc/node/index.ts` | 命令分发逻辑 |
| `extensions/webrtc/node/peer-manager.ts` | PeerConnection 管理 + 回环逻辑 |
| `~/projects/webrtc/examples/reflect/main.go` | pion 回声示例 |
| `~/projects/webrtc/examples/pion-to-pion/answer/main.go` | pion answerer 示例 |

## 验证方式

1. `cd extensions/webrtc/go && go build -o rtc-node .`
2. 启动：`./rtc-node --gateway ws://127.0.0.1:18789 --token TOKEN --loopback 0`
3. 确认 Gateway 日志显示 RTC Node 连接成功（`hello-ok`）
4. 浏览器打开 WebUI，点击通话 → 验证回声
5. 切到 `--loopback 5` 测试延迟回放
