package main

import (
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
)

func TestQRPairingRotationAndTerminalEvents(t *testing.T) {
	p := &pairingState{mode: "qr"}
	p.update(whatsmeow.QRChannelItem{Event: "code", Code: "first", Timeout: time.Minute})
	firstExpiry := p.qrExpiresAt
	p.update(whatsmeow.QRChannelItem{Event: "code", Code: "second", Timeout: 20 * time.Second})
	if p.qrCode != "second" || p.qrExpiresAt >= firstExpiry {
		t.Fatal("QR did not rotate with its own expiry")
	}
	p.update(whatsmeow.QRChannelSuccess)
	if !p.complete || p.qrCode != "" || p.qrExpiresAt != 0 {
		t.Fatal("successful pairing retained QR material")
	}
	p.update(whatsmeow.QRChannelItem{Event: "code", Code: "late", Timeout: time.Minute})
	if p.qrCode != "" {
		t.Fatal("late code resurrected completed QR")
	}
	for _, item := range []whatsmeow.QRChannelItem{whatsmeow.QRChannelTimeout, whatsmeow.QRChannelClientOutdated, {Event: "error"}} {
		p := &pairingState{mode: "qr", qrCode: "secret", qrExpiresAt: time.Now().Add(time.Minute).UnixMilli()}
		p.update(item)
		if p.qrCode != "" || p.err == nil {
			t.Fatal("terminal event did not clear QR and record an error")
		}
	}
}

func TestQRAccountBindingAndPhoneCodeRemainDistinct(t *testing.T) {
	jid := types.NewJID("123456789", types.DefaultUserServer)
	if !pairingAccountAllowed("qr", "", "", jid) {
		t.Fatal("new QR pairing unexpectedly needs a phone number")
	}
	if pairingAccountAllowed("qr", "", "999999999@s.whatsapp.net", jid) {
		t.Fatal("reconnect accepted a different account")
	}
	if !pairingAccountAllowed("qr", "", jid.String(), jid) {
		t.Fatal("same account was rejected")
	}
	if !pairingAccountAllowed("phone", "123456789", "", jid) || pairingAccountAllowed("phone", "999999999", "", jid) {
		t.Fatal("phone account binding changed")
	}
	p := &pairingState{mode: "phone", code: "PHONE-CODE"}
	p.update(whatsmeow.QRChannelItem{Event: "code", Code: "hidden-QR", Timeout: time.Minute})
	if p.qrCode != "" || p.code != "PHONE-CODE" {
		t.Fatal("phone method exposed or replaced its code with a QR")
	}
}

func TestStatusHidesExpiredQRAndPreservesAccountMismatch(t *testing.T) {
	a := fixture(t)
	a.pairing = &pairingState{mode: "qr", qrCode: "expired", qrExpiresAt: time.Now().Add(-time.Second).UnixMilli(), err: bad("account_mismatch", 403)}
	a.pairing.update(whatsmeow.QRChannelItem{Event: "error"})
	if _, exists := a.pairingStatus()["qrCode"]; exists {
		t.Fatal("status exposed an expired QR")
	}
	if a.pairingStatus()["pairingError"] != "account_mismatch" {
		t.Fatal("pairing error overwrote account binding failure")
	}
}

func TestPublicStatusNeverExposesPairingMaterial(t *testing.T) {
	a := fixture(t)
	a.pairing = &pairingState{mode: "qr", qrCode: "private-pairing-secret", qrExpiresAt: time.Now().Add(time.Minute).UnixMilli(), code: "private-phone-code"}
	if a.pairingStatus()["qrCode"] == nil {
		t.Fatal("private auth RPC has no QR")
	}
	for _, key := range []string{"qrCode", "qrExpiresAt", "code", "pairingError"} {
		if _, exists := a.status()[key]; exists {
			t.Fatalf("public status exposed %s", key)
		}
	}
}
