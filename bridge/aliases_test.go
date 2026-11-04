package main

import (
	"context"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	waLog "go.mau.fi/whatsmeow/util/log"
	"testing"
)

func TestAliasHistoryDedupePaginationAndRevocation(t *testing.T) {
	a := fixture(t)
	a.cli.Store.LIDs = sqlstore.NewWithDB(a.db, "sqlite3", waLog.Noop).LIDMap
	pn, _ := types.ParseJID(testChat)
	lid := types.NewJID("888888888", types.HiddenUserServer)
	// Simulate pre-existing split history before WhatsApp supplies the mapping.
	for _, e := range []struct {
		chat, id, text string
		ts             int64
	}{
		{testChat, "A", "older", 1000}, {testChat, "B", "original", 2000},
		{lid.String(), "B", "original", 2000}, {lid.String(), "C", "new arrival", 3000},
		{"777777777@s.whatsapp.net", "D", "unrelated", 4000},
	} {
		if err := a.ingest(textEvent(e.chat, e.id, e.text, e.ts)); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.cli.Store.LIDs.PutLIDMapping(context.Background(), lid, pn); err != nil {
		t.Fatal(err)
	}
	for _, chat := range []string{testChat, lid.String()} {
		first, err := a.messages(args{Chat: chat, Limit: 2})
		if err != nil {
			t.Fatal(err)
		}
		page := first.(map[string]any)
		rows := page["items"].([]message)
		if len(rows) != 2 || rows[0].ID != "C" || rows[1].ID != "B" || rows[0].Chat != chat {
			t.Fatal(page)
		}
		second, err := a.messages(args{Chat: chat, Limit: 2, Cursor: page["nextCursor"].(string)})
		if err != nil {
			t.Fatal(err)
		}
		rows = second.(map[string]any)["items"].([]message)
		if len(rows) != 1 || rows[0].ID != "A" {
			t.Fatal(second)
		}
	}
	revoke := textEvent(lid.String(), "REVOKE", "", 5000)
	revoke.Message = &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{Type: waE2E.ProtocolMessage_REVOKE.Enum(), Key: a.cli.BuildMessageKey(lid, lid, "B")}}
	if err := a.ingest(revoke); err != nil {
		t.Fatal(err)
	}
	m, err := a.getMessage(testChat, "B")
	if err != nil || m.Type != "revoked" || m.Text != "" {
		t.Fatal(m, err)
	}
	if _, err = a.getMessage("777777777@s.whatsapp.net", "C"); err == nil {
		t.Fatal("unrelated chat exposed")
	}
	reply, err := a.build(context.Background(), "send", args{Chat: testChat, Text: "reply", ReplyTo: "C"})
	if err != nil || reply.GetExtendedTextMessage().GetContextInfo().GetParticipant() != lid.String() {
		t.Fatal(reply, err)
	}
}

func TestOwnAliasWithoutContactMapping(t *testing.T) {
	a := fixture(t)
	pn, _ := types.ParseJID(testChat)
	lid := types.NewJID("888888888", types.HiddenUserServer)
	a.cli.Store.ID = &pn
	a.cli.Store.LID = lid
	if err := a.ingest(textEvent(lid.String(), "SELF", "phone arrival", 1000)); err != nil {
		t.Fatal(err)
	}
	m, err := a.getMessage(testChat, "SELF")
	if err != nil || m.Text != "phone arrival" {
		t.Fatal(m, err)
	}
	unknown := "888888888@s.whatsapp.net"
	if _, err = a.getMessage(unknown, "SELF"); err == nil {
		t.Fatal("numeric JID guessed as alias")
	}
}
