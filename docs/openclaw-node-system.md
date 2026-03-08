# OpenClaw Node 系统工作原理

## 一、整体架构

```
                          OpenClaw Gateway (中枢)
                         ┌─────────────────────────┐
  Operator (浏览器/CLI)  │  NodeRegistry            │  Node (远程设备)
  ┌──────┐   WS req     │  ┌───────────────────┐   │   WS event      ┌──────────┐
  │ Agent│──────────────▶│  │ sessions[]        │   │───────────────▶│ macOS    │
  │ Web  │               │  │ pending invokes   │   │  invoke.request │ iOS      │
  │ CLI  │◀──────────────│  │ command allowlist  │   │◀───────────────│ Android  │
  └──────┘   WS res      │  └───────────────────┘   │  invoke.result  │ Linux    │
                         │  Plugins (webrtc等)       │                 │ RTC Node │
                         └─────────────────────────┘                 └──────────┘
```

Node 是 OpenClaw 的**远程执行端**。Gateway 是中枢大脑，负责 AI 对话和决策；Node 是手脚，负责在具体设备上执行操作（运行命令、拍照、获取位置、WebRTC 通话等）。

---

## 二、Node 的身份与连接

### 1. 连接握手

Node 通过 WebSocket 以 `role: "node"` 连接 Gateway，必须提供 **Ed25519 设备身份**（不能像 operator 那样仅用 token 跳过）：

```
Node                              Gateway
 │                                   │
 │◀── event: connect.challenge ──────│  (含随机 nonce)
 │                                   │
 │── req: connect ──────────────────▶│
 │   {                               │
 │     role: "node",                 │
 │     client: { id: "node-host" },  │
 │     caps: ["system", "browser"],  │
 │     commands: ["system.run", ...],│
 │     device: {                     │
 │       id: sha256(publicKey),      │
 │       publicKey: base64url,       │
 │       signature: ed25519Sign(     │  ← v3|deviceId|clientId|mode|role|...|nonce|
 │         "v3|...|nonce|platform|"  │
 │       ),                          │
 │     }                             │
 │   }                               │
 │                                   │
 │◀── res: hello-ok ────────────────│  (含 deviceToken)
```

签名 payload 格式：`v3|deviceId|node-host|node|node||signedAtMs|token|nonce|platform|`

### 2. 注册到 NodeRegistry

连接成功后，Gateway 的 `NodeRegistry.register()` 记录一个 `NodeSession`：

```typescript
{
  nodeId: "fabaf548b698afe4...",     // = device.id
  connId: "ws-conn-uuid",           // WebSocket 连接 ID
  client: wsClient,                  // WebSocket 引用
  displayName: "RTC Node (Go)",
  platform: "darwin",
  caps: ["webrtc", "audio"],         // 能力声明
  commands: ["rtc.call.accept", ...], // 命令声明
  connectedAtMs: 1741420800000,
}
```

关键：`caps` 和 `commands` 都是 Node **自我声明**的，但 Gateway 会用 **allowlist** 过滤（下面详述）。

---

## 三、命令调用机制 (node.invoke)

这是 Node 系统的核心协议。完整流程：

```
Operator/Agent/Plugin          Gateway                         Node
       │                          │                              │
  ① req: node.invoke             │                              │
  ──────────────────────────────▶│                              │
    { nodeId, command,            │                              │
      params, timeoutMs,          │                              │
      idempotencyKey }            │                              │
                                  │  ② event: node.invoke.request│
                                  │─────────────────────────────▶│
                                  │  { id, nodeId, command,      │
                                  │    paramsJSON, timeoutMs }   │
                                  │                              │
                                  │                              │── ③ 执行命令
                                  │                              │   (system.run /
                                  │                              │    camera.snap /
                                  │                              │    rtc.call.accept)
                                  │                              │
                                  │  ④ req: node.invoke.result   │
                                  │◀─────────────────────────────│
                                  │  { id, nodeId, ok,           │
                                  │    payloadJSON, error }      │
                                  │                              │
  ⑤ res: node.invoke             │                              │
  ◀──────────────────────────────│                              │
    { ok, payload }               │                              │
```

### 关键设计细节

**请求追踪**：每个 invoke 生成唯一 `requestId` (UUID)，存入 `pending` Map。Node 返回结果时带回 `id`，Gateway 据此匹配 Promise 并 resolve。

**超时机制**：默认 30 秒。超时后 Promise reject（错误码 `TIMEOUT`），之后到达的 late response 被静默忽略。

**参数传递**：`params` 序列化为 `paramsJSON` 字符串传给 Node，结果也通过 `payloadJSON` 返回。这样避免 Gateway 需要理解具体命令的参数结构。

**幂等性**：`idempotencyKey` 透传，由 Node 端命令处理器自行去重。

---

## 四、命令权限控制

Gateway 实施**两级检查**，防止 Node 自我声明不安全的命令：

### 1. 平台默认 allowlist

```
macOS/Linux/Windows:  system.run, system.which, browser.proxy,
                      canvas.*, camera.*, location.*, device.*, ...

iOS/Android:          canvas.*, camera.*, location.*, device.*,
                      contacts.*, calendar.*, photos.*, notifications.*
                      (无 system.run — 移动端不允许执行任意命令)

未知平台:              canvas.*, camera.*, location.*, system.notify
```

### 2. 危险命令需显式启用

```
camera.snap, camera.clip, screen.record,
contacts.add, calendar.add, sms.send
```

这些需要在 Gateway 配置 `gateway.nodes.allowCommands` 中明确列出。

### 3. 双重校验

```
isNodeCommandAllowed(command) =
  command ∈ platformAllowlist  AND  command ∈ nodeDeclaredCommands
```

Node 声明了但不在 allowlist 中的命令 → 被静默过滤掉。

---

## 五、Node 的主要类型

### 1. Node Host（标准节点）

OpenClaw 内置的 headless 节点，运行在桌面/服务器上：

```bash
openclaw node host --gateway ws://... --token ...
```

能力：`system.run`（执行 shell 命令）、`system.which`、`browser.proxy`、`canvas.*`

Agent 通过它执行代码、操作文件、运行测试。这是最核心的 Node 类型。

**执行审批机制**：`system.run` 有本地 `exec-approvals.json`，敏感命令需要用户确认。

### 2. Mobile Node（移动节点）

iOS/Android App 作为 Node 连接：

能力：`camera.snap`（拍照）、`location.get`（位置）、`contacts.*`、`calendar.*`、`photos.*`、`notifications.*`

**APNS 唤醒**：如果 Node 不在线，Gateway 通过 Apple Push Notification 唤醒 iOS App，等待重连（先等 3s，不行再等 12s），然后发送命令。

### 3. 自定义 Node（如 RTC Node）

任何程序只要实现 WS 协议 + Ed25519 认证就能作为 Node 接入：

```go
// Go RTC Node 示例
caps: ["webrtc", "audio"]
commands: ["rtc.call.accept", "rtc.call.remote_candidate",
           "rtc.call.hangup", "rtc.call.speak"]
```

Plugin 通过 `nodeRegistry.listConnected().find(n => n.caps.includes("webrtc"))` 找到它。

---

## 六、Plugin 如何使用 Node

Plugin 通过 `context.nodeRegistry`（Gateway 注入）调用 Node：

```typescript
// 1. 发现 Node
const node = nodeRegistry.listConnected()
  .find(n => n.caps.includes("webrtc"));

// 2. 调用命令
const result = await nodeRegistry.invoke({
  nodeId: node.nodeId,
  command: "rtc.call.accept",
  params: { callId, offerSdp, iceServers },
  timeoutMs: 15_000,
  idempotencyKey: crypto.randomUUID(),
});

// 3. 处理结果
if (result.ok) {
  const answer = JSON.parse(result.payloadJSON);
  // answer.answerSdp, answer.candidates
}
```

---

## 七、断开与清理

```typescript
// Node 断开时
nodeRegistry.unregister(connId):
  1. 从 sessions 中移除
  2. 所有 pending invoke Promise → reject("node disconnected")
  3. 清理远程节点信息缓存
  4. 取消所有事件订阅
  5. 更新在线状态
```

---

## 八、核心文件索引

| 文件 | 职责 |
|------|------|
| `src/gateway/node-registry.ts` | NodeSession 管理、invoke 路由、pending 追踪 |
| `src/gateway/server/ws-connection/message-handler.ts` | 连接握手、Node 注册（963-1110 行）|
| `src/gateway/server-methods/nodes.ts` | `node.invoke` 请求处理、APNS 唤醒、allowlist 检查 |
| `src/gateway/server-methods/nodes.handlers.invoke-result.ts` | invoke 结果接收 |
| `src/gateway/node-command-policy.ts` | 平台 allowlist、危险命令策略 |
| `src/node-host/invoke.ts` | Node 端命令执行（system.run 等）|
| `src/node-host/runner.ts` | Headless node host 入口 |
| `src/agents/tools/nodes-tool.ts` | Agent 调用 Node 的工具接口 |

---

## 九、动态加载与卸载

Node 是纯 WebSocket 连接，完全动态，**无需重启 Gateway**：

- **连接即注册**：Node 随时可以 `ws.connect()` → 握手 → 自动加入 `NodeRegistry.sessions[]`
- **断开即卸载**：WebSocket 关闭 → `NodeRegistry.unregister()` → 从 sessions 移除、pending invoke 全部 reject
- **无需预先声明**：Gateway 没有"Node 配置文件"，不需要预先声明有哪些 Node

```
Gateway 运行中...
  t=0   Node-A 连接 → sessions: [A]
  t=5   Node-B 连接 → sessions: [A, B]
  t=10  Node-A 断开 → sessions: [B]，A 的 pending invoke 全部 reject
  t=15  Node-C 连接 → sessions: [B, C]
```

Plugin/Agent 每次调用 `nodeRegistry.listConnected()` 都是实时查询，自动发现新 Node、感知 Node 下线。

移动端 Node 还有更极端的模式：**按需唤醒** — Node 不在线时 Gateway 通过 APNS 推送唤醒 iOS App，等它重连后再发 invoke。

---

## 十、容器化部署：用 Node 访问 Sandbox

Node 架构天然适合容器化场景。Gateway 运行在一个容器中，多个 sandbox 容器各自运行一个 Node 进程连回 Gateway：

```
┌─────────────────────────────────────────────────┐
│  K8s / Docker Compose                           │
│                                                 │
│  ┌───────────────┐     ┌───────────────────┐   │
│  │  Gateway 容器  │◀═WS═│  Node 容器 A      │   │
│  │  :18789       │     │  (代码执行 sandbox)│   │
│  │               │     │  caps: ["system"]  │   │
│  │               │     └───────────────────┘   │
│  │               │                              │
│  │               │     ┌───────────────────┐   │
│  │               │◀═WS═│  Node 容器 B      │   │
│  │               │     │  (GPU 推理)        │   │
│  │               │     │  caps: ["gpu"]     │   │
│  │               │     └───────────────────┘   │
│  │               │                              │
│  │               │     ┌───────────────────┐   │
│  │               │◀═WS═│  Node 容器 C      │   │
│  │               │     │  (Go RTC Node)     │   │
│  │               │     │  caps: ["webrtc"]  │   │
│  └───────────────┘     └───────────────────┘   │
└─────────────────────────────────────────────────┘
```

### 实现方式

**1. Sandbox 容器内运行 Node Host：**

```bash
# 容器启动命令
openclaw node host \
  --gateway ws://gateway-service:18789 \
  --token $GATEWAY_TOKEN
```

或者用自定义轻量 Node（像 Go RTC Node 那样），只需实现 WS 协议 + Ed25519 认证。

**2. 通过 `caps` 区分不同 Sandbox：**

```
Sandbox-Python:  caps: ["system", "python"],  commands: ["system.run"]
Sandbox-Node:    caps: ["system", "nodejs"],   commands: ["system.run"]
Sandbox-GPU:     caps: ["system", "gpu"],      commands: ["system.run", "inference.run"]
```

**3. Plugin/Agent 按能力路由：**

```typescript
// 找 Python sandbox
const pythonNode = nodeRegistry.listConnected()
  .find(n => n.caps.includes("python"));

// 在里面执行代码
await nodeRegistry.invoke({
  nodeId: pythonNode.nodeId,
  command: "system.run",
  params: { command: "python3 script.py" },
});
```

### 优势

| 特性 | 说明 |
|------|------|
| **安全隔离** | 代码在独立容器执行，Gateway 容器不受影响 |
| **动态伸缩** | K8s HPA 按需扩缩 sandbox 容器，连上就可用 |
| **多语言/多环境** | 不同容器装不同运行时，通过 `caps` 区分 |
| **故障隔离** | 一个 sandbox 挂了不影响其他 Node |
| **零配置** | Gateway 不需要知道有多少 sandbox，Node 连上自动发现 |

### 注意事项

- **allowlist 限制**：Gateway 默认按平台过滤命令。容器内一般是 Linux，`system.run` 在 allowlist 内，没问题
- **网络连通性**：sandbox 容器需要能访问 Gateway 的 WS 端口（同 K8s namespace 或 service 暴露）
- **Ed25519 身份**：每个 sandbox 首次连接会自动生成密钥对并持久化到 `~/.openclaw/identity/`。如果容器是临时的（无持久卷），每次重启会生成新 deviceId，Gateway 侧视为新设备 — 功能不受影响，只是日志里 deviceId 会变

---

## 十一、总结

Node 系统的设计哲学是 **"Gateway 是大脑，Node 是终端"**：

- **去中心化执行**：一个 Gateway 可连接多个 Node（桌面、手机、自定义服务），每个 Node 有不同能力
- **能力驱动路由**：通过 `caps` 和 `commands` 声明，Plugin/Agent 按需发现合适的 Node
- **安全隔离**：Gateway 侧 allowlist 限制命令范围，Node 侧 exec-approvals 二次确认
- **协议简洁**：整个 invoke 就是 request → event → result 三步，参数全部 JSON 字符串化透传
- **容错设计**：超时安全、late response 无害、断开自动清理 pending
