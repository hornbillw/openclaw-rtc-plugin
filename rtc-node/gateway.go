package main

import (
	"encoding/json"
	"fmt"
	"runtime"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// Frame types for the Gateway WS protocol.

type requestFrame struct {
	Type   string      `json:"type"`
	ID     string      `json:"id"`
	Method string      `json:"method"`
	Params interface{} `json:"params,omitempty"`
}

type responseFrame struct {
	Type    string           `json:"type"`
	ID      string           `json:"id"`
	OK      bool             `json:"ok"`
	Payload *json.RawMessage `json:"payload,omitempty"`
	Error   *frameError      `json:"error,omitempty"`
}

type frameError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type eventFrame struct {
	Type    string           `json:"type"`
	Event   string           `json:"event"`
	Payload *json.RawMessage `json:"payload,omitempty"`
}

// genericFrame is used for initial JSON dispatch by "type" field.
type genericFrame struct {
	Type string `json:"type"`
}

// InvokeHandler is called for each node.invoke.request from Gateway.
type InvokeHandler func(command string, params json.RawMessage) (interface{}, error)

// GatewayClient manages the WebSocket connection to an OpenClaw Gateway.
type GatewayClient struct {
	url         string
	token       string
	identity    *DeviceIdentity
	displayName string
	caps        []string
	commands    []string
	onInvoke    InvokeHandler
	loopbackSec int

	conn      *websocket.Conn
	connMu    sync.Mutex
	pending   map[string]chan *responseFrame
	pendingMu sync.Mutex
	closed    bool
	done      chan struct{}
}

type GatewayClientConfig struct {
	URL         string
	Token       string
	Identity    *DeviceIdentity
	DisplayName string
	Caps        []string
	Commands    []string
	OnInvoke    InvokeHandler
	LoopbackSec int
}

func NewGatewayClient(cfg GatewayClientConfig) *GatewayClient {
	return &GatewayClient{
		url:         cfg.URL,
		token:       cfg.Token,
		identity:    cfg.Identity,
		displayName: cfg.DisplayName,
		caps:        cfg.Caps,
		commands:    cfg.Commands,
		onInvoke:    cfg.OnInvoke,
		loopbackSec: cfg.LoopbackSec,
		pending:     make(map[string]chan *responseFrame),
		done:        make(chan struct{}),
	}
}

func (g *GatewayClient) Connect() error {
	conn, _, err := websocket.DefaultDialer.Dial(g.url, nil)
	if err != nil {
		return fmt.Errorf("websocket dial: %w", err)
	}
	g.conn = conn

	// Read the first message — should be connect.challenge event
	// Then send connect request and read response, all before starting read loop
	if err := g.handshake(); err != nil {
		conn.Close()
		return err
	}

	// Start read loop
	go g.readLoop()

	return nil
}

func (g *GatewayClient) Close() {
	g.closed = true
	if g.conn != nil {
		g.conn.Close()
	}
	close(g.done)

	g.pendingMu.Lock()
	for id, ch := range g.pending {
		close(ch)
		delete(g.pending, id)
	}
	g.pendingMu.Unlock()
}

func (g *GatewayClient) Done() <-chan struct{} {
	return g.done
}

// sendRequest sends a request and waits for the correlated response.
func (g *GatewayClient) sendRequest(method string, params interface{}) (*responseFrame, error) {
	id := uuid.New().String()
	frame := requestFrame{Type: "req", ID: id, Method: method, Params: params}

	ch := make(chan *responseFrame, 1)
	g.pendingMu.Lock()
	g.pending[id] = ch
	g.pendingMu.Unlock()

	data, err := json.Marshal(frame)
	if err != nil {
		return nil, err
	}

	g.connMu.Lock()
	err = g.conn.WriteMessage(websocket.TextMessage, data)
	g.connMu.Unlock()
	if err != nil {
		g.pendingMu.Lock()
		delete(g.pending, id)
		g.pendingMu.Unlock()
		return nil, fmt.Errorf("write: %w", err)
	}

	select {
	case resp, ok := <-ch:
		if !ok {
			return nil, fmt.Errorf("connection closed")
		}
		return resp, nil
	case <-time.After(15 * time.Second):
		g.pendingMu.Lock()
		delete(g.pending, id)
		g.pendingMu.Unlock()
		return nil, fmt.Errorf("request timeout: %s", method)
	}
}

func (g *GatewayClient) handshake() error {
	// Step 1: Read connect.challenge event
	_, data, err := g.conn.ReadMessage()
	if err != nil {
		return fmt.Errorf("read challenge: %w", err)
	}

	var ev eventFrame
	if err := json.Unmarshal(data, &ev); err != nil {
		return fmt.Errorf("parse challenge: %w", err)
	}
	if ev.Event != "connect.challenge" {
		return fmt.Errorf("expected connect.challenge, got %q", ev.Event)
	}

	var challenge struct {
		Nonce string `json:"nonce"`
	}
	if err := json.Unmarshal(*ev.Payload, &challenge); err != nil {
		return fmt.Errorf("parse challenge payload: %w", err)
	}

	// Step 2: Build and send connect request
	signedAtMs := timeNowMs()
	role := "node"
	clientID := "node-host"
	clientMode := "node"

	authPayload := fmt.Sprintf("v3|%s|%s|%s|%s||%d|%s|%s|%s|",
		g.identity.DeviceID, clientID, clientMode, role,
		signedAtMs, g.token, challenge.Nonce, runtime.GOOS,
	)
	signature := g.identity.SignPayload(authPayload)

	params := map[string]interface{}{
		"minProtocol": 3,
		"maxProtocol": 3,
		"client": map[string]interface{}{
			"id":          clientID,
			"displayName": g.displayName,
			"version":     "2026.3.8",
			"platform":    runtime.GOOS,
			"mode":        clientMode,
		},
		"role":     role,
		"caps":     g.caps,
		"commands": g.commands,
		"device": map[string]interface{}{
			"id":        g.identity.DeviceID,
			"publicKey": g.identity.PublicKeyBase64URL(),
			"signature": signature,
			"signedAt":  signedAtMs,
			"nonce":     challenge.Nonce,
		},
	}
	if g.token != "" {
		params["auth"] = map[string]string{"token": g.token}
	}

	reqID := uuid.New().String()
	frame := requestFrame{Type: "req", ID: reqID, Method: "connect", Params: params}
	frameData, err := json.Marshal(frame)
	if err != nil {
		return fmt.Errorf("marshal connect: %w", err)
	}
	if err := g.conn.WriteMessage(websocket.TextMessage, frameData); err != nil {
		return fmt.Errorf("write connect: %w", err)
	}

	// Step 3: Read connect response directly (read loop not started yet)
	_, respData, err := g.conn.ReadMessage()
	if err != nil {
		return fmt.Errorf("read connect response: %w", err)
	}

	var resp responseFrame
	if err := json.Unmarshal(respData, &resp); err != nil {
		return fmt.Errorf("parse connect response: %w", err)
	}
	if !resp.OK {
		msg := "unknown error"
		if resp.Error != nil {
			msg = resp.Error.Message
		}
		return fmt.Errorf("connect rejected: %s", msg)
	}

	logInfo("connected to gateway")
	return nil
}

func (g *GatewayClient) readLoop() {
	defer func() {
		if !g.closed {
			g.closed = true
			close(g.done)
		}
	}()

	for {
		_, data, err := g.conn.ReadMessage()
		if err != nil {
			if !g.closed {
				logInfo("gateway connection lost: %v", err)
			}
			return
		}

		var gf genericFrame
		if json.Unmarshal(data, &gf) != nil {
			continue
		}

		switch gf.Type {
		case "res":
			var resp responseFrame
			if json.Unmarshal(data, &resp) == nil {
				g.handleResponse(&resp)
			}
		case "event":
			var ev eventFrame
			if json.Unmarshal(data, &ev) == nil {
				g.handleEvent(&ev)
			}
		}
	}
}

func (g *GatewayClient) handleResponse(resp *responseFrame) {
	g.pendingMu.Lock()
	ch, ok := g.pending[resp.ID]
	if ok {
		delete(g.pending, resp.ID)
	}
	g.pendingMu.Unlock()

	if ok {
		ch <- resp
	}
}

func (g *GatewayClient) handleEvent(ev *eventFrame) {
	if ev.Event == "node.invoke.request" && ev.Payload != nil {
		go g.handleInvokeRequest(*ev.Payload)
	}
}

func (g *GatewayClient) handleInvokeRequest(raw json.RawMessage) {
	var req struct {
		ID         string `json:"id"`
		Command    string `json:"command"`
		ParamsJSON string `json:"paramsJSON"`
	}
	if err := json.Unmarshal(raw, &req); err != nil || req.ID == "" || req.Command == "" {
		return
	}

	var params json.RawMessage
	if req.ParamsJSON != "" {
		params = json.RawMessage(req.ParamsJSON)
	}

	result, err := g.onInvoke(req.Command, params)

	ok := err == nil
	var payloadJSON string
	if err != nil {
		logInfo("invoke %s failed: %v", req.Command, err)
		errObj, _ := json.Marshal(map[string]string{"error": err.Error()})
		payloadJSON = string(errObj)
	} else {
		data, _ := json.Marshal(result)
		payloadJSON = string(data)
		logInfo("invoke %s OK, sending result (%d bytes)", req.Command, len(payloadJSON))
	}

	// Send result as fire-and-forget (don't block waiting for Gateway ack)
	g.sendFireAndForget("node.invoke.result", map[string]interface{}{
		"id":          req.ID,
		"nodeId":      g.identity.DeviceID,
		"ok":          ok,
		"payloadJSON": payloadJSON,
	})
}

// sendFireAndForget sends a request without waiting for a response.
func (g *GatewayClient) sendFireAndForget(method string, params interface{}) {
	id := uuid.New().String()
	frame := requestFrame{Type: "req", ID: id, Method: method, Params: params}
	data, err := json.Marshal(frame)
	if err != nil {
		logInfo("marshal error for %s: %v", method, err)
		return
	}

	g.connMu.Lock()
	err = g.conn.WriteMessage(websocket.TextMessage, data)
	g.connMu.Unlock()
	if err != nil {
		logInfo("send error for %s: %v", method, err)
	}
}

func timeNowMs() int64 {
	return time.Now().UnixMilli()
}

func logInfo(format string, args ...interface{}) {
	fmt.Printf("[rtc-node] "+format+"\n", args...)
}
