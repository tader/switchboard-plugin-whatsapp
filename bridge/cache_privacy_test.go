package main

import (
	"bytes"
	"fmt"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
	"strings"
	"testing"
)

func privateReply() *waE2E.Message {
	return &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
		Text:        proto.String("ordinary reply"),
		ContextInfo: &waE2E.ContextInfo{StanzaID: proto.String("ORIGINAL"), QuotedMessage: &waE2E.Message{ViewOnceMessage: &waE2E.FutureProofMessage{Message: &waE2E.Message{Conversation: proto.String("restricted-quote-fixture")}}}},
	}, ViewOnceMessage: &waE2E.FutureProofMessage{Message: &waE2E.Message{Conversation: proto.String("unrelated-variant-fixture")}}}
}

func TestCacheRetainsReplyIdentityWithoutNestedPrivateBodies(t *testing.T) {
	e := textEvent(testChat, "REPLY", "", 1000)
	e.Message = privateReply()
	m, err := normalize(e)
	if err != nil {
		t.Fatal(err)
	}
	if m.Text != "ordinary reply" || m.ReplyTo != "ORIGINAL" {
		t.Fatal("reply metadata changed", m)
	}
	for _, hidden := range []string{"restricted-quote-fixture", "unrelated-variant-fixture"} {
		if bytes.Contains(m.raw, []byte(hidden)) {
			t.Fatal("private body retained", hidden)
		}
	}
	a := fixture(t)
	if err = a.ingest(e); err != nil {
		t.Fatal(err)
	}
	quote, err := a.build(t.Context(), "send", args{Chat: testChat, Text: "second reply", ReplyTo: "REPLY"})
	if err != nil {
		t.Fatal(err)
	}
	context := quote.GetExtendedTextMessage().GetContextInfo()
	if context.GetStanzaID() != "REPLY" || context.GetParticipant() != testChat || context.GetQuotedMessage().GetExtendedTextMessage().GetText() != "ordinary reply" {
		t.Fatal("normal quoting changed", quote)
	}
	if e.Message.GetExtendedTextMessage().GetContextInfo() == nil {
		t.Fatal("provider message was mutated")
	}
}

func TestLegacyQuoteCacheScrubIsBoundedAndPreservesPublicRows(t *testing.T) {
	a := fixture(t)
	raw, _ := proto.Marshal(privateReply())
	if _, err := a.db.Exec("DELETE FROM sb_meta WHERE key='quote-cache-privacy-v1'"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 205; i++ {
		e := textEvent(testChat, fmt.Sprintf("LEGACY%03d", i), "", 1000)
		e.Message = privateReply()
		if err := a.ingest(e); err != nil {
			t.Fatal(err)
		}
	}
	// Populate the old raw representation after ingest, as on an existing install.
	if _, err := a.db.Exec("UPDATE sb_messages SET raw=?", raw); err != nil {
		t.Fatal(err)
	}
	var before int
	a.db.QueryRow("SELECT count(*) FROM sb_messages").Scan(&before)
	if before != 205 {
		t.Fatal("fixture row count", before)
	}
	if err := a.initCache(); err != nil {
		t.Fatal(err)
	}
	var after int
	a.db.QueryRow("SELECT count(*) FROM sb_messages").Scan(&after)
	if after != before {
		t.Fatal("messages removed")
	}
	rows, err := a.db.Query("SELECT text,reply_to,raw FROM sb_messages")
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var text, reply string
		var data []byte
		if err = rows.Scan(&text, &reply, &data); err != nil {
			t.Fatal(err)
		}
		if text != "ordinary reply" || reply != "ORIGINAL" || bytes.Contains(data, []byte("restricted-quote-fixture")) {
			t.Fatal("legacy cache was not scrubbed without changing metadata")
		}
	}
	rows.Close()
	if err = a.initCache(); err != nil {
		t.Fatal("idempotent startup", err)
	}
}

func TestSafePollQuoteKeepsSupportedPollAndTruncatedTextHasNoRawCopy(t *testing.T) {
	for _, variant := range []int{1, 2, 3} {
		p := &waE2E.PollCreationMessage{Name: proto.String("Poll"), SelectableOptionsCount: proto.Uint32(1), Options: []*waE2E.PollCreationMessage_Option{{OptionName: proto.String("One")}}, ContextInfo: privateReply().GetExtendedTextMessage().GetContextInfo()}
		source := &waE2E.Message{}
		switch variant {
		case 1:
			source.PollCreationMessage = p
		case 2:
			source.PollCreationMessageV2 = p
		case 3:
			source.PollCreationMessageV3 = p
		}
		clean := &waE2E.Message{}
		if err := proto.Unmarshal(safeQuote(source, "poll"), clean); err != nil {
			t.Fatal(err)
		}
		poll := pollMessage(clean)
		if poll.GetName() != "Poll" || poll.GetOptions()[0].GetOptionName() != "One" || poll.GetContextInfo() != nil {
			t.Fatal("poll quote changed")
		}
	}
	m, err := normalize(textEvent(testChat, "TRUNCATED", strings.Repeat("x", 16001), 1000))
	if err != nil {
		t.Fatal(err)
	}
	if !m.Truncated || len(m.raw) != 0 {
		t.Fatal("truncated raw body retained")
	}
}
