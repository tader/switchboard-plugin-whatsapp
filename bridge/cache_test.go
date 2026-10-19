package main

import (
	"bytes"
	"context"
	"encoding/json"
	"go.mau.fi/whatsmeow/proto/waAdv"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const testChat = "123456789@s.whatsapp.net"

func fixture(t *testing.T) *app {
	t.Helper()
	a, cleanup, err := openApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cleanup)
	return a
}
func textEvent(chat, id, text string, ts int64) *events.Message {
	jid, _ := types.ParseJID(chat)
	return &events.Message{Info: types.MessageInfo{MessageSource: types.MessageSource{Chat: jid, Sender: jid, IsGroup: jid.Server == types.GroupServer}, ID: id, Timestamp: time.UnixMilli(ts), PushName: "Fixture"}, Message: &waE2E.Message{Conversation: proto.String(text)}}
}
func TestSessionPrivateAndExclusive(t *testing.T) {
	dir := t.TempDir()
	_, close, err := openApp(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer close()
	if _, _, err = openApp(dir); err == nil {
		t.Fatal("shared session opened twice")
	}
	s, _ := os.Stat(filepath.Join(dir, "session.db"))
	if s.Mode().Perm() != 0600 {
		t.Fatal(s.Mode())
	}
	d, _ := os.Stat(dir)
	if d.Mode().Perm() != 0700 {
		t.Fatal(d.Mode())
	}
}
func TestCachePaginationFiltersAndRestart(t *testing.T) {
	dir := t.TempDir()
	a, close, err := openApp(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range []*events.Message{textEvent(testChat, "A", "first", 1000), textEvent(testChat, "B", "second", 1000), textEvent("123-456@g.us", "C", "group", 2000)} {
		if err = a.ingest(e); err != nil {
			t.Fatal(err)
		}
	}
	page, err := a.messages(args{Chat: testChat, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	p := page.(map[string]any)
	if p["items"].([]message)[0].ID != "B" || !p["hasMore"].(bool) {
		t.Fatal(p)
	}
	next, err := a.messages(args{Chat: testChat, Limit: 1, Cursor: p["nextCursor"].(string)})
	if err != nil {
		t.Fatal(err)
	}
	if next.(map[string]any)["items"].([]message)[0].ID != "A" {
		t.Fatal(next)
	}
	if _, err = a.messages(args{Chat: "999999999@s.whatsapp.net", Cursor: p["nextCursor"].(string)}); err == nil {
		t.Fatal("cross-chat cursor accepted")
	}
	groups, err := a.chats(args{Type: "group", Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(groups.(map[string]any)["items"].([]map[string]any)) != 1 {
		t.Fatal(groups)
	}
	close()
	a, close, err = openApp(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer close()
	m, err := a.getMessage(testChat, "A")
	if err != nil || m.Text != "first" {
		t.Fatal(m, err)
	}
}
func TestRestrictedMediaAndRevoke(t *testing.T) {
	a := fixture(t)
	e := textEvent(testChat, "A", "private view once", 1000)
	e.IsViewOnce = true
	if err := a.ingest(e); err != nil {
		t.Fatal(err)
	}
	m, _ := a.getMessage(testChat, "A")
	if m.Text != "" || m.Type != "restricted" || len(m.raw) != 0 {
		t.Fatal("restricted content archived")
	}
	e = textEvent(testChat, "B", "original", 1000)
	a.ingest(e)
	key := a.cli.BuildMessageKey(e.Info.Chat, e.Info.Sender, "B")
	revoke := textEvent(testChat, "REVOKE", "", 2000)
	revoke.Message = &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{Type: waE2E.ProtocolMessage_REVOKE.Enum(), Key: key}}
	a.ingest(revoke)
	a.ingest(e)
	m, _ = a.getMessage(testChat, "B")
	if m.Type != "revoked" || m.Text != "" || len(m.raw) != 0 {
		t.Fatal(m)
	}
}
func TestRepliesAndReactionsUseOriginalSenderAndChat(t *testing.T) {
	a := fixture(t)
	e := textEvent(testChat, "A", "original", 1000)
	a.ingest(e)
	reply, err := a.build(context.Background(), "send", args{Chat: testChat, Text: "reply", ReplyTo: "A"})
	if err != nil {
		t.Fatal(err)
	}
	ctx := reply.GetExtendedTextMessage().GetContextInfo()
	if ctx.GetStanzaID() != "A" || ctx.GetParticipant() != testChat || ctx.GetQuotedMessage().GetConversation() != "original" {
		t.Fatal(ctx)
	}
	reaction, err := a.build(context.Background(), "react", args{Chat: testChat, MessageID: "A", Emoji: "👍"})
	if err != nil {
		t.Fatal(err)
	}
	if reaction.GetReactionMessage().GetKey().GetID() != "A" || reaction.GetReactionMessage().GetText() != "👍" {
		t.Fatal(reaction)
	}
	removed, _ := a.build(context.Background(), "react", args{Chat: testChat, MessageID: "A", Emoji: ""})
	if removed.GetReactionMessage().GetText() != "" {
		t.Fatal(removed)
	}
	if _, err = a.build(context.Background(), "send", args{Chat: "999999999@s.whatsapp.net", Text: "reply", ReplyTo: "A"}); err == nil {
		t.Fatal("cross-chat reply accepted")
	}
}
func TestPollOptionsAndEncryptedVotes(t *testing.T) {
	a := fixture(t)
	own := types.NewJID("999999999", types.DefaultUserServer)
	a.cli.Store.ID = &own
	a.cli.Store.Account = &waAdv.ADVSignedDeviceIdentity{Details: []byte{}, AccountSignature: make([]byte, 64), AccountSignatureKey: make([]byte, 32), DeviceSignature: make([]byte, 64)}
	if err := a.cli.Store.Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	e := textEvent(testChat, "POLL", "", 1000)
	e.Message = a.cli.BuildPollCreation("Lunch?", []string{"Soup", "Salad"}, 1)
	a.ingest(e)
	poll, _ := a.getMessage(testChat, "POLL")
	if poll.Poll == nil || poll.Poll.Options[1] != "Salad" {
		t.Fatal(poll)
	}
	for _, options := range [][]string{{"Wrong"}, {"Soup", "Salad"}, {"Soup", "Soup"}} {
		if err := validateVote(poll.Poll, options); err == nil {
			t.Fatal(options)
		}
	}
	if _, err := a.build(context.Background(), "vote", args{Chat: testChat, MessageID: "POLL", Options: []string{"Soup"}}); err == nil {
		t.Fatal("missing poll key accepted")
	}
	if err := a.cli.Store.MsgSecrets.PutMessageSecret(context.Background(), e.Info.Chat, e.Info.Sender, e.Info.ID, e.Message.GetMessageContextInfo().GetMessageSecret()); err != nil {
		t.Fatal(err)
	}
	for _, options := range [][]string{{"Soup"}, {}} {
		vote, err := a.build(context.Background(), "vote", args{Chat: testChat, MessageID: "POLL", Options: options})
		if err != nil {
			t.Fatal(err)
		}
		if len(vote.GetPollUpdateMessage().GetVote().GetEncPayload()) == 0 {
			t.Fatal("vote not encrypted")
		}
	}
}
func TestStrictPrivateIPC(t *testing.T) {
	a := fixture(t)
	input := bytes.NewBufferString("{\"id\":\"fixture\",\"method\":\"version\",\"args\":{}}\n{\"id\":\"invalid\",\"method\":\"status\",\"args\":{\"rawToken\":\"not-allowed\"}}\n")
	out := new(bytes.Buffer)
	serve(input, out, a)
	decoder := json.NewDecoder(out)
	var result response
	if err := decoder.Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.Error != nil {
		t.Fatal(result.Error)
	}
	if err := decoder.Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.Error == nil || result.Error.Code != "invalid_arguments" {
		t.Fatal(result)
	}
}

func TestRevokedDeviceRequiresNewNativeClient(t *testing.T) {
	a := fixture(t)
	a.cli.Store.Deleted = true
	_, err := a.start(context.Background(), args{Phone: "123456789", ExpectedAccount: testChat})
	if f, ok := err.(*fault); !ok || f.Code != "session_revoked" {
		t.Fatal(err)
	}
}
