package main

import (
	"context"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"testing"
)

type nameContacts struct {
	store.NoopStore
	names map[types.JID]types.ContactInfo
}

func (s *nameContacts) GetContact(_ context.Context, id types.JID) (types.ContactInfo, error) {
	return s.names[id], nil
}
func TestSenderNamesUseVerifiedAliasesAndRefreshExistingMessages(t *testing.T) {
	a := fixture(t)
	a.cli.Store.LIDs = sqlstore.NewWithDB(a.db, "sqlite3", waLog.Noop).LIDMap
	pn, _ := types.ParseJID(testChat)
	lid := types.NewJID("888888888", types.HiddenUserServer)
	c := &nameContacts{names: map[types.JID]types.ContactInfo{lid: {PushName: "Profile"}, pn: {FullName: "Saved Contact"}}}
	a.cli.Store.Contacts = c
	if err := a.cli.Store.LIDs.PutLIDMapping(context.Background(), lid, pn); err != nil {
		t.Fatal(err)
	}
	e := textEvent("123-456@g.us", "NAME", "message", 1000)
	e.Info.Sender = lid
	if err := a.ingest(e); err != nil {
		t.Fatal(err)
	}
	read := func() message {
		t.Helper()
		page, err := a.messages(args{Chat: e.Info.Chat.String()})
		if err != nil {
			t.Fatal(err)
		}
		return page.(map[string]any)["items"].([]message)[0]
	}
	m := read()
	if m.AuthorDisplayName != "Saved Contact" || m.Sender != lid.String() {
		t.Fatal(m)
	}
	c.names[pn] = types.ContactInfo{FirstName: "Saved First"}
	if m = read(); m.AuthorDisplayName != "Saved First" {
		t.Fatal(m)
	}
	delete(c.names, pn)
	if m = read(); m.AuthorDisplayName != "Profile" {
		t.Fatal(m)
	}
	delete(c.names, lid)
	if m = read(); m.AuthorDisplayName != "+123456789" {
		t.Fatal(m)
	}
	unknown := types.NewJID("123456789", types.HiddenUserServer)
	if got := a.senderName(unknown.String()); got != unknown.String() {
		t.Fatal("guessed phone", got)
	}
	before := 0
	a.db.QueryRow("SELECT count(*) FROM sb_changes").Scan(&before)
	a.event(&events.Contact{JID: pn})
	after := 0
	a.db.QueryRow("SELECT count(*) FROM sb_changes").Scan(&after)
	if after <= before {
		t.Fatal("no name invalidation")
	}
	exact, err := a.getMessage(e.Info.Chat.String(), "NAME")
	if err != nil || exact.AuthorDisplayName != "+123456789" {
		t.Fatal(exact, err)
	}
}
