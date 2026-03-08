package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// DeviceIdentity holds the Ed25519 keypair for Gateway authentication.
type DeviceIdentity struct {
	DeviceID   string `json:"deviceId"`
	PublicKey  ed25519.PublicKey
	PrivateKey ed25519.PrivateKey
}

type identityFile struct {
	Version      int    `json:"version"`
	DeviceID     string `json:"deviceId"`
	PublicKeyB64 string `json:"publicKeyB64"`  // raw 32-byte key, base64url
	PrivateKeyB64 string `json:"privateKeyB64"` // raw 64-byte key, base64url
	CreatedAtMs  int64  `json:"createdAtMs"`
}

func base64URLEncode(data []byte) string {
	return base64.RawURLEncoding.EncodeToString(data)
}

func generateDeviceIdentity() *DeviceIdentity {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		panic(fmt.Sprintf("ed25519 keygen failed: %v", err))
	}
	hash := sha256.Sum256([]byte(pub))
	return &DeviceIdentity{
		DeviceID:   hex.EncodeToString(hash[:]),
		PublicKey:  pub,
		PrivateKey: priv,
	}
}

func loadOrCreateIdentity(filePath string) *DeviceIdentity {
	data, err := os.ReadFile(filePath)
	if err == nil {
		var f identityFile
		if json.Unmarshal(data, &f) == nil && f.Version == 1 && f.DeviceID != "" {
			pub, err1 := base64.RawURLEncoding.DecodeString(f.PublicKeyB64)
			priv, err2 := base64.RawURLEncoding.DecodeString(f.PrivateKeyB64)
			if err1 == nil && err2 == nil && len(pub) == 32 && len(priv) == 64 {
				return &DeviceIdentity{
					DeviceID:   f.DeviceID,
					PublicKey:  ed25519.PublicKey(pub),
					PrivateKey: ed25519.PrivateKey(priv),
				}
			}
		}
	}

	id := generateDeviceIdentity()
	if err := os.MkdirAll(filepath.Dir(filePath), 0o700); err != nil {
		fmt.Fprintf(os.Stderr, "warning: cannot create identity dir: %v\n", err)
		return id
	}

	f := identityFile{
		Version:       1,
		DeviceID:      id.DeviceID,
		PublicKeyB64:  base64URLEncode([]byte(id.PublicKey)),
		PrivateKeyB64: base64URLEncode(id.PrivateKey),
		CreatedAtMs:   timeNowMs(),
	}
	raw, _ := json.MarshalIndent(f, "", "  ")
	if err := os.WriteFile(filePath, raw, 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "warning: cannot save identity: %v\n", err)
	}
	return id
}

// SignPayload signs the v3 auth payload and returns base64url-encoded signature.
func (id *DeviceIdentity) SignPayload(payload string) string {
	sig := ed25519.Sign(id.PrivateKey, []byte(payload))
	return base64URLEncode(sig)
}

// PublicKeyBase64URL returns the raw 32-byte public key as base64url.
func (id *DeviceIdentity) PublicKeyBase64URL() string {
	return base64URLEncode([]byte(id.PublicKey))
}
