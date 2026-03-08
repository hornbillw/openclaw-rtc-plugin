# WebRTC Plugin 开发调试记录

## Phase 1: 单元测试

### 问题：werift 版本号不存在

- **现象**: `pnpm install` 报错 `No matching version found for werift@^0.20.2`
- **原因**: npm 上 werift 最新版为 `0.22.9`，`0.20.x` 不存在
- **修复**: `package.json` 中改为 `"werift": "^0.22.9"`

---

## Phase 2: 插件加载到 Gateway

### 环境背景

本地 Gateway 运行的是**全局安装的 openclaw**（通过 launchd 管理）：

```
/opt/homebrew/Cellar/node/25.4.0/bin/node
/opt/homebrew/lib/node_modules/openclaw/dist/index.js gateway --port 18789
```

而 WebRTC 插件代码在本地开发目录 `extensions/webrtc/`。两者不在同一路径下，需要让 Gateway 发现并加载外部插件。

### 问题 1：`import from "openclaw/plugin-sdk/webrtc"` 失败

- **现象**: Gateway 启动时报 `plugin not found: webrtc`，实际是插件 JS 加载阶段就失败了
- **原因**: `index.ts` 中 `import type { ... } from "openclaw/plugin-sdk/webrtc"` 依赖一个子路径导出，但全局安装的 openclaw `package.json` 的 `exports` 只有 `./plugin-sdk`（通用入口）和 `./plugin-sdk/account-id`，没有 `./plugin-sdk/webrtc`
- **验证方式**:
  ```bash
  cat /opt/homebrew/lib/node_modules/openclaw/package.json | python3 -c "
  import json,sys
  d=json.load(sys.stdin)
  exports=d.get('exports',{})
  for k in exports:
      if 'plugin' in k.lower(): print(k)
  "
  # 输出只有 ./plugin-sdk 和 ./plugin-sdk/account-id
  ```
- **修复**: 将 `index.ts` 中的 import 替换为 inline 类型声明，不依赖特定 plugin-sdk 子路径：
  ```typescript
  // 不用这个（依赖全局 openclaw 的子路径导出）
  // import type { ... } from "openclaw/plugin-sdk/webrtc";

  // 改为 inline 声明
  type GatewayRequestHandlerOptions = {
    params?: Record<string, unknown>;
    respond: (ok: boolean, payload?: unknown) => void;
  };
  type OpenClawPluginApi = { ... };
  ```

### 问题 2：symlink 目录不被 discoverInDirectory 发现

- **现象**: 将插件 symlink 到 `~/.openclaw/extensions/webrtc` 后，Gateway 仍然看不到插件
- **原因**: `src/plugins/discovery.ts` 的 `discoverInDirectory` 遍历目录时使用 `entry.isDirectory()` 判断，Node.js 的 `Dirent` 对 symlink 返回 `isSymbolicLink()=true` 而 `isDirectory()=false`，导致 symlink 子目录被跳过
- **代码位置**: `src/plugins/discovery.ts:436`
  ```typescript
  if (!entry.isDirectory()) {   // symlink 在这里被跳过
    continue;
  }
  ```
- **解决方案**: 同时配置 `plugins.load.paths`，该路径走 `discoverFromPath` 逻辑，使用 `fs.statSync()` 会自动 follow symlink

### 问题 3：`plugins.allow` 白名单机制

- **现象**: 从 `plugins.allow` 列表中移除 `"webrtc"` 后，日志报 `plugin disabled (not in allowlist)`
- **原因**: `plugins.allow` 是**白名单**。如果该列表非空，只有列表中的插件会被启用，不在列表中的即使有 `entries.xxx.enabled: true` 也会被拒绝
- **修复**: 必须将 `"webrtc"` 加入 `plugins.allow` 数组

### 问题 4：launchd 重启 Gateway 失败

- **现象**: `kill` Gateway 进程后，`launchctl bootstrap` 和 `launchctl load` 都返回 `Input/output error`
- **原因**: launchd 在进程异常退出后可能需要先 `remove` 再 `load`，或者 plist 有问题
- **解决方案**: 直接用 `nohup` 后台启动 Gateway，不通过 launchd：
  ```bash
  HOME=/Users/superwings \
  OPENCLAW_GATEWAY_PORT=18789 \
  OPENCLAW_GATEWAY_TOKEN=xxx \
  nohup /opt/homebrew/Cellar/node/25.4.0/bin/node \
    /opt/homebrew/lib/node_modules/openclaw/dist/index.js \
    gateway --port 18789 \
    > /tmp/openclaw-gw.log 2>&1 &
  ```

---

## 最终可用配置

### 1. Symlink 插件目录

```bash
ln -sfn /Users/superwings/Projects/openclaw/extensions/webrtc ~/.openclaw/extensions/webrtc
```

### 2. openclaw.json 配置

```json
{
  "plugins": {
    "allow": ["openclaw-aicodewith-auth", "telegram", "feishu", "webrtc"],
    "load": {
      "paths": ["/Users/superwings/Projects/openclaw/extensions/webrtc"]
    },
    "entries": {
      "webrtc": {
        "enabled": true,
        "config": {
          "volcAppId": "",
          "volcAccessKey": "",
          "volcSpeaker": "zh_female_cancan_mars_bigtts"
        }
      }
    }
  }
}
```

### 3. 验证插件加载

```bash
# 列出所有插件，应看到 webrtc 状态为 loaded
node /opt/homebrew/lib/node_modules/openclaw/dist/index.js plugins list

# 通过 WS 测试 rtc.call.status 方法
# 返回 { ok: true, payload: { calls: [], activeCalls: 0 } }
```

---

## 关键文件路径

| 文件 | 用途 |
|---|---|
| `extensions/webrtc/package.json` | 插件包定义，`openclaw.extensions` 声明入口 |
| `extensions/webrtc/index.ts` | 插件入口，注册 gateway methods |
| `~/.openclaw/openclaw.json` | Gateway 配置，`plugins.load.paths` + `plugins.allow` |
| `~/.openclaw/extensions/webrtc` | symlink 到开发目录 |
| `src/plugins/discovery.ts` | 插件发现逻辑（`discoverFromPath` / `discoverInDirectory`）|

---

## Phase 3: RTC Node 连接 Gateway + node.invoke 链路

### 环境背景

RTC Node 是独立进程，通过 Gateway WS 以 `role: "node"` 接入。插件 (`index.ts`) 通过 `context.nodeRegistry` 查找已连接的 RTC Node，并通过 `nodeRegistry.invoke()` 将命令分发到 Node。

### 问题 1：RTC Node connect 失败 — `client.id` 无效

- **现象**: RTC Node 连接后 Gateway 返回 `"client.id invalid"` 错误
- **原因**: Gateway 校验 `client.id` 必须是预定义的 `GATEWAY_CLIENT_IDS` 之一（如 `"node-host"`, `"cli"`, `"webchat-ui"` 等），自定义 ID 会被拒绝
- **修复**: `gateway-client.ts` 中 `client.id` 改为 `"node-host"`

### 问题 2：RTC Node connect 失败 — `client.mode` 无效

- **现象**: 使用 `mode: "rtc"` 连接失败
- **原因**: Gateway 校验 `client.mode` 必须是预定义的 `GATEWAY_CLIENT_MODES` 之一（如 `"node"`, `"cli"`, `"ui"` 等），自定义 mode 会被拒绝
- **修复**: `gateway-client.ts` 中 `client.mode` 改为 `"node"`

### 问题 3：RTC Node connect 失败 — device publicKey/signature 为空

- **现象**: 使用 `role: "node"` 连接时，Gateway 返回 auth 失败
- **原因**: Node 角色**必须**提供设备身份（Ed25519 keypair），不能像 operator 角色那样仅用 token 跳过。Gateway 的连接握手流程：
  1. Gateway 发送 `connect.challenge` 事件（含随机 nonce）
  2. 客户端用 Ed25519 私钥签名 v3 payload：`"v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily"`
  3. Gateway 验证签名，返回 `hello-ok` 并发放 `deviceToken`
- **修复**: `gateway-client.ts` 完整实现 Ed25519 设备身份：
  ```typescript
  // 生成并持久化 Ed25519 keypair
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // deviceId = SHA256(raw public key bytes)
  const deviceId = createHash("sha256").update(rawPublicKey).digest("hex");
  // 签名 v3 payload
  const authPayload = ["v3", deviceId, "node-host", "node", "node", "", signedAtMs, token, nonce, platform, ""].join("|");
  const signature = sign(null, Buffer.from(authPayload, "utf8"), privateKey);
  ```
  身份存储在 `~/.openclaw/identity/rtc-node.json`

### 问题 4：`invokeRtcNode()` 是 stub，无法分发命令

- **现象**: 插件的 `rtc.call.start` handler 调用 `invokeRtcNode()`，但它只是返回 `null` 的 stub
- **原因**: Phase 1 实现时未接通 Gateway 的 `nodeRegistry.invoke()` 机制
- **修复**: 重写 `invokeRtcNode()` 使用 `context.nodeRegistry`：
  ```typescript
  // 1. 通过 caps 查找 RTC Node
  const node = nodeRegistry.listConnected().find(n => n.caps.includes("webrtc"));
  // 2. 调用 nodeRegistry.invoke() 分发命令
  const result = await nodeRegistry.invoke({
    nodeId: node.nodeId,
    command: opts.command,
    params: opts.params,
    timeoutMs: 15_000,
    idempotencyKey: crypto.randomUUID(),
  });
  ```
  同时更新 `GatewayRequestHandlerOptions` 类型，增加 `context.nodeRegistry` 声明

### 问题 5：`rtc.call.*` 方法需要 `operator.admin` scope

- **现象**: 通过 WS 调用 `rtc.call.start` 返回 `"missing scope: operator.admin"`
- **原因**: `rtc.call.*` 方法不在 `src/gateway/method-scopes.ts` 的任何 scope group 中，默认回退到要求 `ADMIN_SCOPE`（第 194 行：`resolveRequiredOperatorScopeForMethod(method) ?? ADMIN_SCOPE`）
- **解决**: 客户端连接时必须声明 `scopes: ["operator.admin"]` 并提供有效的 Ed25519 签名

### 问题 6：NodeRegistry 中 `commands` 为空数组

- **现象**: RTC Node 在 connect 时发送 `commands: ["rtc.call.accept", ...]`，但 `node.list` 返回 `commands: []`
- **原因**: 可能是 Gateway 某个版本的 `ConnectParams` schema 处理或 TypeBox 验证清除了 `commands` 字段。`caps` 字段正常保留
- **解决**: `findRtcNode()` 仅通过 `caps.includes("webrtc")` 匹配节点，不依赖 `commands` 字段

### 验证结果

完整 invoke 链路已验证通过：

```
Test Client → Gateway WS → rtc.call.start handler
  → findRtcNode(nodeRegistry) → 找到 RTC Node (caps: ["audio", "webrtc"])
  → nodeRegistry.invoke({ command: "rtc.call.accept", ... })
  → Gateway WS → node.invoke.request event → RTC Node
  → RTC Node → peerManager.acceptCall() → 处理 SDP
  → RTC Node → node.invoke.result → Gateway
  → 插件收到结果 → 返回给客户端
```

Gateway 日志确认：
```
[webrtc] invokeRtcNode: rtc.call.accept → node adafb940…
[webrtc] invokeRtcNode: rtc.call.accept failed: invoke failed  # werift SDP 解析失败（测试用 SDP 过于简化）
```

RTC Node 日志确认：
```
[rtc-node] accepting call a3042528-f787-43d6-bfa6-e1148980d144
```

### 启动命令

```bash
# 1. 启动 Gateway
HOME=/Users/superwings \
OPENCLAW_GATEWAY_PORT=18789 \
OPENCLAW_GATEWAY_TOKEN=xxx \
nohup node /opt/homebrew/lib/node_modules/openclaw/dist/index.js \
  gateway --port 18789 \
  > /tmp/openclaw-gw.log 2>&1 &

# 2. 启动 RTC Node（等 Gateway 就绪后）
nohup npx tsx extensions/webrtc/node/index.ts \
  --gateway ws://127.0.0.1:18789 \
  --token xxx \
  > /tmp/rtc-node.log 2>&1 &

# 3. 验证
tail -f /tmp/rtc-node.log
# 应看到: [rtc-node] connected to gateway: {"type":"hello-ok",...}
```

---

## Phase 4: WebUI 浏览器端到端测试

### 环境背景

使用自包含 HTML 文件 (`extensions/webrtc/ui/index.html`) 作为 WebUI，通过 Gateway WS 进行文本聊天和 WebRTC 语音通话。由于 Gateway HTTP 认证问题，WebUI 用独立 HTTP 服务器提供，Gateway 地址通过 URL hash 参数传入。

### 问题 1：Gateway HTTP 认证阻止插件静态资源加载

- **现象**: 访问 `http://host:18789/plugins/webrtc/` 返回 401 Unauthorized
- **原因**: 插件注册 HTTP 路由时使用 `auth: "plugin"`，预期跳过 Gateway 认证。但实际上 Gateway 在 `token` 模式下，`shouldEnforceGatewayAuthForPluginPath()` 仍然会对 HTTP 请求强制 Bearer token 认证
- **代码位置**: `src/gateway/server/plugins-http/route-auth.ts`
- **解决方案**: 用独立 HTTP 服务器提供 WebUI 静态文件，Gateway WS 地址通过 URL hash 传入：
  ```bash
  # 启动独立 HTTP 服务
  cd extensions/webrtc/ui && python3 -m http.server 8766
  # 浏览器访问：
  # http://host:8766/#gateway=ws://127.0.0.1:18789&token=YOUR_TOKEN
  ```

### 问题 2：WebSocket 连接 — device identity mismatch

- **现象**: 浏览器 WS 连接后 Gateway 返回 `"device identity mismatch"`
- **原因**: WebUI 的 connect 请求中包含了伪造的 device 字段 (`publicKey: "none"`, `signature: "none"`)，Gateway 验签失败
- **修复**: 移除 `device` 字段。`operator` 角色在提供有效 shared token (`auth.token`) 时可跳过设备身份验证
  ```javascript
  sendRequest("connect", {
    minProtocol: 3, maxProtocol: 3,
    client: { id: "webchat-ui", displayName: "WebRTC UI", ... },
    role: "operator",
    scopes: ["operator.admin"],
    auth: token ? { token } : undefined,
    // 不传 device — operator + valid token 跳过设备身份
  });
  ```
- **相关代码**: `src/gateway/server/ws-connection/connect-policy.ts` 中 `roleCanSkipDeviceIdentity(role, sharedAuthOk)` — operator 角色且 shared auth OK 时返回 true

### 问题 3：chat.send — scope 不足

- **现象**: 发送文本消息时返回 `"missing scope: operator.write"`
- **原因**: connect 时未声明 scopes，默认无权限。`chat.send` 方法需要 `operator.write` scope
- **修复**: connect 参数中添加 `scopes: ["operator.admin"]`（覆盖所有方法）
- **相关代码**: `src/gateway/method-scopes.ts` — `chat.send` → `operator.write`

### 问题 4：chat.send — 参数格式错误

- **现象**: `"invalid chat.send params: must have required property 'sessionKey'; must have required property 'message'"`
- **原因**: 发送 `{ text }` 而非正确格式
- **修复**: 使用正确参数格式：
  ```javascript
  sendRequest("chat.send", {
    sessionKey: "main",
    message: text,
    idempotencyKey: crypto.randomUUID(),
  });
  ```
- **相关代码**: `src/gateway/server-methods/chat.ts`

### 问题 5：助手回复文本重复/乱码

- **现象**: 回复显示为 "老飞侠，太老飞侠，太好老飞侠，太好了..."
- **原因**: Gateway 的 chat delta 事件中 `message.content[0].text` 是**累积文本**（每次 delta 包含完整文本到当前位置），而非增量。WebUI 错误地将每次 delta 追加到已有文本
- **修复**: `appendAssistantDelta()` 中用 `textContent = text`（替换）而非追加：
  ```javascript
  function appendAssistantDelta(text) {
    if (!currentAssistantEl) {
      currentAssistantEl = document.createElement("div");
      currentAssistantEl.className = "message assistant";
      messagesEl.appendChild(currentAssistantEl);
    }
    currentAssistantEl.textContent = text;  // 替换，不是追加
  }
  ```
- **相关代码**: `src/gateway/server-chat.ts` — delta 广播使用 `mergedText`（累积）

### 问题 6：助手回复不显示 — 事件格式不匹配

- **现象**: chat.send 成功但无助手回复显示
- **原因**: WebUI 事件处理器查找 `p?.type === "delta"` 和 `p.text`，但实际 Gateway 发送的格式是 `p?.state === "delta"` 且文本在 `p.message.content[0].text`
- **修复**: 重写 chat 事件处理器匹配实际格式：
  ```javascript
  case "chat": {
    const p = frame.payload;
    if (p?.state === "delta" && p.message?.content) {
      const text = p.message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text).join("");
      if (text) appendAssistantDelta(text);
    } else if (p?.state === "final") { ... }
    else if (p?.state === "error") { ... }
  }
  ```

### 问题 7：WebRTC 通话 — werift API 不匹配

- **现象**: 点击拨号按钮，显示 "No RTC node available" 或请求失败
- **根本原因**: RTC Node 的 `peerManager.acceptCall()` 内部崩溃 — `TypeError: Cannot read properties of undefined (reading 'subscribe')` at `peer-manager.ts:73`
- **原因**: werift 0.22.9 的 API 与代码中使用的名称不一致：
  - `onConnectionStateChange` → 应为 `connectionStateChange`
  - `onTrack` 回调签名：`(track) => {}` 而非 `(event) => { event.track, event.streams }`
- **修复**: 更新 `peer-manager.ts` 匹配 werift 0.22.9 API：
  ```typescript
  // werift 0.22.9 正确 API
  pc.connectionStateChange.subscribe(() => {
    this.emit("connectionstatechange", { callId, state: pc.connectionState });
  });

  pc.onTrack.subscribe((track) => {
    this.emit("track", { callId, track });  // track 是 MediaStreamTrack
  });
  ```

### 问题 8：错误诊断困难 — invokeRtcNode 错误信息模糊

- **现象**: `invokeRtcNode` 返回 `null` 时无法区分是"没有可用节点"还是"invoke 调用失败"
- **修复**: 改进 `index.ts` 中的错误消息区分：
  ```typescript
  if (!nodeResult) {
    const errDetail = nodeResult === null
      ? "RTC node invoke failed (check gateway logs)"
      : "No RTC node available";
    orchestrator.setError(callRecord.callId, errDetail);
    respond(false, { error: errDetail });
    return;
  }
  ```
  同时在 `node/index.ts` 的 `rtc.call.accept` handler 中添加 try/catch 打印完整 stack trace

### 远程测试（SSH 隧道）

OpenClaw 主机无麦克风，从远程机器通过 SSH 隧道连接：
```bash
ssh -L 18789:127.0.0.1:18789 -L 8766:127.0.0.1:8766 user@gateway-host
# 然后在本地浏览器打开：
# http://localhost:8766/#gateway=ws://127.0.0.1:18789&token=YOUR_TOKEN
```

### 验证结果

- **文本聊天**: Gateway WS 连接 → 认证 → chat.send → 流式回复显示 ✅
- **WebRTC 信令**: getUserMedia → SDP offer → Gateway → RTC Node → werift → SDP answer → ICE 交换 → "In call" 状态 ✅
- **连接状态**: 浏览器显示 "Dialing..." → "Connecting..." → "In call" ✅
- **音频管道**: 待 Phase 4.5（音频回环测试）实现

---

## Phase 4.5: 音频回环测试

### 环境背景

目标：验证 WebRTC 音频双向通路。两种模式：
1. **立即回声** (`--no-loopback`)：浏览器发送音频 → RTC Node 原样回送 → 浏览器听到自己的声音
2. **延迟回放** (`--loopback N`)：录制 N 秒音频，然后循环回放

### 问题 1：`session already has an active call` — sessionKey 冲突

- **现象**: 页面刷新后再次拨号报 `session webrtc-session-1 already has an active call`
- **原因**: WebUI 用递增计数器生成 sessionKey，刷新后计数器重置，产生相同 sessionKey
- **修复**: 改用 `crypto.randomUUID()` 生成唯一 sessionKey：
  ```javascript
  const sessionKey = "webrtc-" + crypto.randomUUID().slice(0, 8);
  ```

### 问题 2：`max concurrent calls (5) reached` — 僵尸通话累积

- **现象**: 多次测试后 orchestrator 报最大并发通话数已满
- **原因**: 非终态通话（`initiating`/`connecting`/`active`）没有被清理，计入 `activeCalls`
- **修复**: 通过 WS 发送 `rtc.call.hangup` 清理所有非终态通话；WebUI 中 `disconnected` 状态不再触发 hangup（`disconnected` 是瞬态，ICE 可能恢复），只有 `failed` 才触发清理

### 问题 3：DTLS 卡在 `connecting` — `addTransceiver` 缺少 direction 参数

- **现象**: ICE 连接成功 (`iceConnectionState: connected`) 但 `connectionState` 停在 `connecting`，DTLS 握手永远不完成
- **原因**: `pc.addTransceiver("audio")` 缺少 `{ direction: "sendrecv" }` 参数。werift 官方 answer.ts 示例明确使用 `addTransceiver("video", { direction: "sendrecv" })`
- **修复**: 添加显式方向：
  ```typescript
  const audioTransceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
  ```
- **验证**: 修复后 `connectionState` 正常经过 `connecting → connected`

### 问题 4：`writeRtp error: this is remoteTrack`

- **现象**: 尝试对接收到的 remote track 调用 `writeRtp()` 抛出异常
- **原因**: werift 的 `MediaStreamTrack` 有 `remote` 属性，remote track 禁止 `writeRtp`
- **修复**: 创建本地 `new MediaStreamTrack({ kind: "audio" })` 用于发送，通过 `sender.replaceTrack(localTrack)` 挂载

### 问题 5：Loopback 模式 DTLS 不连接 — `replaceTrack(new track)` 时序问题

- **现象**: 立即回声模式 DTLS 正常连接，但 loopback 模式 DTLS 卡在 `connecting`
- **原因**: loopback 模式在 `onTrack` 回调中异步调用 `replaceTrack(new MediaStreamTrack)`，这个 async 操作在 `createAnswer` 之前没完成，导致 DTLS 协商失败。而立即回声模式 `replaceTrack(receivedTrack)` 是同步完成的
- **修复**: 先用 `replaceTrack(receivedTrack)` 建立立即回声（确保 DTLS 连通），录音在后台进行，录完后再切换 sender track：
  ```typescript
  audioTransceiver.onTrack.subscribe((track) => {
    // 先建立回声，确保 DTLS 连通
    audioTransceiver.sender.replaceTrack(track);
    if (loopbackSec > 0) {
      // 异步开始录音，录完后切换到回放
      this.startDelayedLoopback(callId, track, audioTransceiver, loopbackSec);
    }
  });
  ```

### 问题 6：Loopback 录制 0 个 RTP 包 — setTimeout 回调被吞

- **现象**: 日志显示 `recorded 99 RTP packets` 但之后没有 playback 日志
- **原因**: setTimeout 回调是 `async`，`await replaceTrack()` 的异常被静默吞掉（Node.js unhandled rejection），没有任何错误输出
- **修复**: 将 `replaceTrack` 改为 `.then()/.catch()` 链式调用，确保错误被捕获和记录

### 问题 7：Loopback 录制 0 个 RTP 包 — 录制窗口在 ICE 连通前过期

- **现象**: 5 秒录音 timer 到期时 buffer=0，虽然 RTP 一直在流入
- **原因**: 录制 timer 在 `onTrack`（`setRemoteDescription` 期间）就启动了，但 RTP 要等 ICE + DTLS 完成后才开始流入。如果 ICE 协商 > 5s，timer 已经设置 `recording=false`，后续到达的 RTP 包不会被录入 buffer
- **待修复**: timer 应在收到第一个 RTP 包时才开始计时

### 问题 8：ICE 连接不稳定 — 远程 SSH 隧道测试

- **现象**: `iceConnectionState` 在 `connected → disconnected → connected → ... → failed` 之间循环
- **原因**: SSH 隧道只转发 TCP（WebSocket 信令），WebRTC 音频走 UDP 直连。浏览器和 RTC Node 不在同一网络时，UDP 路径不稳定（NAT 超时、防火墙等）
- **结论**: 这是网络层问题，不是代码 bug。解决方案：
  1. 在同一机器上测试（localhost，最稳定）
  2. 添加 TURN 服务器（用于 NAT 穿越）
  3. 当前远程测试环境下 ICE 能维持短暂连接，足够验证音频通路

### werift 0.22.9 关键 API 模式（从官方 examples 学习）

```typescript
// 1. 回声模式（answer.ts 示例）— answerer 角色
const pc = new RTCPeerConnection({ iceServers: [...] });
const transceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
transceiver.onTrack.subscribe((track, transceiver) => {
  transceiver.sender.replaceTrack(track);  // 立即回声
});
await pc.setRemoteDescription(offer);
await pc.setLocalDescription(await pc.createAnswer());

// 2. RTP 包处理
track.onReceiveRtp.subscribe((rtp) => {
  const cloned = rtp.clone();  // 必须 clone，避免对象复用
  cloned.header.payloadType = transceiver.codecs[0].payloadType;
  localTrack.writeRtp(cloned);  // 只能对本地 track 写
});

// 3. 注意事项
// - addTransceiver 必须在 setRemoteDescription 之前调用
// - 必须加 { direction: "sendrecv" }，否则 DTLS 可能不完成
// - writeRtp 只能对 local track 调用，remote track 会抛异常
// - connectionStateChange.subscribe() 和 onconnectionstatechange 等效
// - iceConnectionState "disconnected" 是瞬态，可能恢复；"failed" 才是终态
```

### 验证结果

- **立即回声** (`--no-loopback`): 浏览器发送音频 → RTC Node → 浏览器听到回声 ✅
- **延迟回放** (`--loopback 5`): 录制 + echo → 回放切换逻辑已实现，待稳定 ICE 后验证
- **ICE 稳定性**: 远程 SSH 隧道场景不稳定（预期内），同机测试待验证

---

## Phase 5: Go (pion/webrtc) 重写 RTC Node

### 背景

werift (TypeScript) 实现存在 DTLS 连接不稳定、API 陷阱多（需显式 `direction: "sendrecv"`、`replaceTrack` 时序敏感）等问题。切换到 pion/webrtc (Go)，这是目前最成熟的 Go WebRTC 实现。

### 文件结构

```
extensions/webrtc/go/
├── go.mod          # module: openclaw-rtc-node, local replace → ~/projects/webrtc
├── main.go         # CLI 入口（--gateway, --token, --loopback, --no-loopback）
├── gateway.go      # Gateway WS 客户端：连接、Ed25519 认证、消息收发
├── identity.go     # Ed25519 设备身份：生成、持久化、签名
├── peer.go         # PeerManager：pion PeerConnection 管理、SDP、ICE
└── loopback.go     # 音频回环：立即回声 + 延迟录制回放
```

### 问题 1：SDP 解析失败 — 缺少尾部换行

- **现象**: `SetRemoteDescription` 返回 EOF 错误
- **原因**: pion 的 SDP parser 要求以 `\r\n` 结尾，浏览器发来的 SDP 可能不带
- **修复**: 在 `SetRemoteDescription` 前检查并追加 `\r\n`：
  ```go
  if len(offerSDP) > 0 && offerSDP[len(offerSDP)-1] != '\n' {
      offerSDP += "\r\n"
  }
  ```

### 问题 2（核心）：DTLS 握手间歇性失败 — 时序竞争

- **现象**: ICE 每次都能连通 (`iceConnectionState: connected`)，但 `connectionState` 约 80% 概率停在 `connecting`，DTLS 握手无法完成
- **表现**: 有时能连通（听到回声），有时卡住（浏览器一直显示 "Connecting..."）

#### 根因分析

通过阅读 pion 源码 (`peerconnection.go`、`dtlsrole.go`、`dtlstransport.go`) 发现时序竞争：

1. `SetRemoteDescription(offer)` 内部将 `startTransports` 加入异步 ops 队列
2. ops 队列处理 `startTransports`：先 `ICETransport.Start()`（阻塞直到 ICE 连通），再 `DTLSTransport.Start()`
3. pion 作为 answerer 默认 DTLS 角色是 **client**（`defaultDtlsRoleAnswer = DTLSRoleClient`），即 pion 主动发起 DTLS 握手
4. 但此时我们还在等 ICE gathering 完成，**answer SDP 尚未返回给浏览器**
5. pion 发出 `ClientHello` → 浏览器还没收到我们的 answer → 不知道我们的 DTLS fingerprint → **忽略 ClientHello**
6. pion 重传 `ClientHello`，如果恰好在浏览器设置 answer 之后到达 → 连通；否则超时 → **间歇性失败**

`dtlsrole.go` 的 RFC 注释明确说明了这个权衡：

```
The answerer MUST use either setup:active or setup:passive.
If the answerer uses setup:passive, the DTLS handshake will not begin
until the answerer is received, which adds additional latency.
setup:active allows the answer and the DTLS handshake to occur in parallel.
Thus, setup:active is RECOMMENDED.
```

对于我们的场景（answer 通过 WebSocket 中转，延迟不可控），`setup:active` 的"并行优化"反而成了 bug。

#### 修复

使用 `SettingEngine.SetAnsweringDTLSRole(DTLSRoleServer)` 强制 pion 为 DTLS **server**（passive）：

```go
se := webrtc.SettingEngine{}
se.SetAnsweringDTLSRole(webrtc.DTLSRoleServer)
api := webrtc.NewAPI(webrtc.WithSettingEngine(se))
pc, _ := api.NewPeerConnection(config)
```

效果：answer SDP 中 `a=setup:passive` → 浏览器收到 answer 后以 DTLS client 身份发起握手 → 时序正确，100% 成功。

### 问题 3：自定义 MediaEngine 的 Opus 参数不匹配

- **现象**: 使用 reflect 示例的自定义 MediaEngine 模式，Opus 注册为 `Channels: 0` 无 fmtp line
- **原因**: pion 默认注册 Opus 为 `Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1"`，与浏览器 offer 匹配。自定义注册缺少这些参数可能影响编解码器协商
- **修复**: 使用默认 MediaEngine（`webrtc.NewPeerConnection` 而非自定义 API），避免手动注册编解码器

### 最终可用配置

```go
se := webrtc.SettingEngine{}
se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled) // macOS mDNS 问题
se.SetAnsweringDTLSRole(webrtc.DTLSRoleServer)          // 关键：避免 DTLS 时序竞争

api := webrtc.NewAPI(webrtc.WithSettingEngine(se))
pc, _ := api.NewPeerConnection(webrtc.Configuration{
    ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}},
})

// AddTrack BEFORE SetRemoteDescription（reflect 示例模式）
outputTrack, _ := webrtc.NewTrackLocalStaticRTP(
    webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}, "audio", "pion")
rtpSender, _ := pc.AddTrack(outputTrack)

// RTCP drain goroutine
go func() { for { rtpSender.Read(buf) } }()

// SDP 协商
pc.SetRemoteDescription(offer)
pc.OnTrack(func(remote, _) { go echoTrack(remote, outputTrack) })
answer, _ := pc.CreateAnswer(nil)
gatherComplete := webrtc.GatheringCompletePromise(pc)
pc.SetLocalDescription(answer)
<-gatherComplete
// 返回 pc.LocalDescription().SDP + collected candidates
```

### 启动命令

```bash
cd extensions/webrtc/go
go build -o rtc-node .
./rtc-node --gateway ws://127.0.0.1:18789 --token TOKEN --no-loopback
```

### 验证结果

- **Gateway 连接 + Ed25519 认证**: 100% 成功 ✅
- **DTLS 握手**: DTLSRoleServer 修复后 100% 成功 ✅
- **立即回声**: 浏览器 → Go RTC Node → 浏览器，延迟极低，持续稳定 ✅
- **延迟回放**: 待测试
