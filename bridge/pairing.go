package main

import (
	"context"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
)

type pairingState struct {
	mode        string
	qrCode      string
	qrExpiresAt int64
	code        string
	err         *fault
	complete    bool
}

func pairingAccountAllowed(mode, phone, expected string, jid types.JID) bool {
	if expected == "" && mode == "phone" {
		expected = phone + "@s.whatsapp.net"
	}
	return expected == "" || jid.ToNonAD().String() == expected
}

// Called under the application's lock; authentication material never goes to logs.
func (p *pairingState) update(item whatsmeow.QRChannelItem) {
	switch item.Event {
	case "code":
		if p.mode == "qr" && !p.complete && p.err == nil {
			p.qrCode, p.qrExpiresAt = item.Code, time.Now().Add(item.Timeout).UnixMilli()
		}
	case "success":
		p.complete = true
		p.qrCode, p.qrExpiresAt, p.code = "", 0, ""
	default:
		p.qrCode, p.qrExpiresAt, p.code = "", 0, ""
		if p.err == nil {
			if item.Event == "timeout" {
				p.err = bad("pairing_expired", 401)
			} else {
				p.err = bad("pairing_failed", 503)
			}
		}
	}
}

// Pairing data is available only through the private authentication RPC, never
// the public status operation used by connection-scoped API callers.
func (a *app) pairingStatus() map[string]any {
	result := a.status()
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.pairing != nil {
		if a.pairing.qrExpiresAt > time.Now().UnixMilli() {
			result["qrCode"], result["qrExpiresAt"] = a.pairing.qrCode, a.pairing.qrExpiresAt
		}
		if a.pairing.code != "" {
			result["code"] = a.pairing.code
		}
		if a.pairing.err != nil {
			result["pairingError"] = a.pairing.err.Code
		}
	}
	return result
}

func (a *app) start(ctx context.Context, in args) (any, error) {
	if a.cli.Store.Deleted {
		return nil, bad("session_revoked", 401)
	}
	if a.cli.Store.ID != nil && in.ExpectedAccount != "" && a.cli.Store.ID.ToNonAD().String() != in.ExpectedAccount {
		return nil, bad("account_mismatch", 403)
	}
	if a.cli.IsConnected() {
		if a.cli.Store.ID != nil && !a.cli.IsLoggedIn() && !a.cli.WaitForConnection(30*time.Second) {
			return nil, bad("connection_failed", 503)
		}
		return a.pairingStatus(), nil
	}
	a.mu.Lock()
	started := a.started
	if !started {
		a.started = true
	}
	a.mu.Unlock()
	if started {
		return a.pairingStatus(), nil
	}
	reset := func() { a.mu.Lock(); a.started = false; a.mu.Unlock() }
	if a.cli.Store.ID != nil {
		if err := a.cli.Connect(); err != nil {
			reset()
			return nil, bad("connection_failed", 503)
		}
		// A socket can connect before authentication completes. Reconnect returns a real
		// readiness result, rather than inventing a pairing code for a paired device.
		if !a.cli.WaitForConnection(30 * time.Second) {
			reset()
			a.cli.Disconnect()
			return nil, bad("connection_failed", 503)
		}
		return a.pairingStatus(), nil
	}
	mode := in.PairingMode
	if mode == "" {
		mode = "phone"
	}
	if mode != "phone" && mode != "qr" {
		reset()
		return nil, bad("invalid_arguments", 400)
	}
	if mode == "phone" && !phoneRE.MatchString(in.Phone) {
		reset()
		return nil, bad("international_phone_number_required", 400)
	}
	pair := &pairingState{mode: mode}
	a.mu.Lock()
	a.pairing = pair
	a.mu.Unlock()
	a.cli.PrePairCallback = func(jid types.JID, platform, businessName string) bool {
		allowed := pairingAccountAllowed(mode, in.Phone, in.ExpectedAccount, jid)
		if !allowed {
			a.mu.Lock()
			pair.err = bad("account_mismatch", 403)
			a.mu.Unlock()
		}
		return allowed
	}
	// The QR listener outlives this RPC, but never the bounded pairing attempt.
	pairingCtx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	qr, err := a.cli.GetQRChannel(pairingCtx)
	if err != nil {
		cancel()
		reset()
		return nil, bad("pairing_failed", 503)
	}
	if err = a.cli.Connect(); err != nil {
		cancel()
		reset()
		return nil, bad("connection_failed", 503)
	}
	var first whatsmeow.QRChannelItem
	select {
	case first = <-qr:
		if first.Event != "code" {
			cancel()
			reset()
			return nil, bad("pairing_failed", 503)
		}
	case <-ctx.Done():
		cancel()
		a.cli.Disconnect()
		reset()
		return nil, bad("pairing_timeout", 503)
	}
	a.mu.Lock()
	pair.update(first)
	a.mu.Unlock()
	if mode == "phone" {
		code, err := a.cli.PairPhone(ctx, in.Phone, false, whatsmeow.PairClientChrome, "Chrome (Linux)")
		if err != nil {
			cancel()
			a.cli.Disconnect()
			reset()
			return nil, bad("pairing_failed", 503)
		}
		a.mu.Lock()
		pair.code = code
		a.mu.Unlock()
	}
	go func() {
		defer cancel()
		for item := range qr {
			a.mu.Lock()
			if a.pairing == pair {
				pair.update(item)
			}
			a.mu.Unlock()
		}
		a.mu.Lock()
		if a.pairing == pair {
			if !pair.complete && pair.err == nil {
				pair.update(whatsmeow.QRChannelTimeout)
			}
			a.started = false
		}
		a.mu.Unlock()
	}()
	return a.pairingStatus(), nil
}
