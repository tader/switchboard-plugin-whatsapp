package main

import (
	"context"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
	"strings"
	"time"
	"unicode/utf8"
)

func info(m message) types.MessageInfo {
	chat, _ := types.ParseJID(m.Chat)
	sender, _ := types.ParseJID(m.Sender)
	return types.MessageInfo{MessageSource: types.MessageSource{Chat: chat, Sender: sender, IsFromMe: m.FromMe, IsGroup: chat.Server == types.GroupServer}, ID: m.ID, Timestamp: time.UnixMilli(m.Timestamp)}
}
func validateVote(p *poll, options []string) error {
	if p == nil {
		return bad("not_a_poll", 400)
	}
	max := p.SelectableCount
	if max == 0 {
		max = len(p.Options)
	}
	if len(options) > max {
		return bad("too_many_poll_options", 400)
	}
	seen := map[string]bool{}
	for _, option := range options {
		if seen[option] {
			return bad("duplicate_poll_option", 400)
		}
		seen[option] = true
		found := false
		for _, valid := range p.Options {
			if option == valid {
				found = true
				break
			}
		}
		if !found {
			return bad("unknown_poll_option", 400)
		}
	}
	return nil
}
func (a *app) build(ctx context.Context, method string, in args) (*waE2E.Message, error) {
	switch method {
	case "send":
		if utf8.RuneCountInString(in.Text) < 1 || utf8.RuneCountInString(in.Text) > 4000 {
			return nil, bad("invalid_text", 400)
		}
		if in.ReplyTo == "" {
			return &waE2E.Message{Conversation: proto.String(in.Text)}, nil
		}
		target, err := a.getMessage(in.Chat, in.ReplyTo)
		if err != nil {
			return nil, err
		}
		if len(target.raw) == 0 || target.Truncated {
			return nil, bad("reply_context_unavailable", 409)
		}
		var quote waE2E.Message
		if proto.Unmarshal(target.raw, &quote) != nil {
			return nil, bad("reply_context_unavailable", 409)
		}
		quote.MessageContextInfo = nil
		if quote.ExtendedTextMessage != nil {
			quote.ExtendedTextMessage.ContextInfo = nil
		}
		return &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String(in.Text), ContextInfo: &waE2E.ContextInfo{StanzaID: proto.String(target.ID), Participant: proto.String(target.Sender), QuotedMessage: &quote}}}, nil
	case "react":
		if utf8.RuneCountInString(in.Emoji) > 16 || strings.ContainsAny(in.Emoji, "\r\n") {
			return nil, bad("invalid_reaction", 400)
		}
		target, err := a.getMessage(in.Chat, in.MessageID)
		if err != nil {
			return nil, err
		}
		if target.Type == "revoked" || target.Type == "restricted" {
			return nil, bad("target_unavailable", 409)
		}
		i := info(target)
		return a.cli.BuildReaction(i.Chat, i.Sender, i.ID, in.Emoji), nil
	case "vote":
		target, err := a.getMessage(in.Chat, in.MessageID)
		if err != nil {
			return nil, err
		}
		if err = validateVote(target.Poll, in.Options); err != nil {
			return nil, err
		}
		i := info(target)
		vote, err := a.cli.BuildPollVote(ctx, &i, in.Options)
		if err != nil {
			return nil, bad("poll_key_unavailable", 409)
		}
		return vote, nil
	}
	return nil, bad("unsupported_method", 400)
}
func (a *app) write(ctx context.Context, method string, in args) (any, error) {
	chat, err := parseChat(in.Chat)
	if err != nil {
		return nil, err
	}
	if !idRE.MatchString(in.SendID) {
		return nil, bad("invalid_send_id", 400)
	}
	m, err := a.build(ctx, method, in)
	if err != nil {
		return nil, err
	}
	resp, err := a.cli.SendMessage(ctx, chat, m, whatsmeow.SendRequestExtra{ID: in.SendID, Timeout: 60 * time.Second})
	if err != nil {
		return nil, &fault{"send_uncertain", 502, false}
	}
	own := a.cli.Store.ID.ToNonAD()
	_ = a.ingest(&events.Message{Info: types.MessageInfo{MessageSource: types.MessageSource{Chat: chat, Sender: own, IsFromMe: true, IsGroup: chat.Server == types.GroupServer}, ID: resp.ID, Timestamp: resp.Timestamp}, Message: m})
	return map[string]any{"ok": true, "messageId": resp.ID, "chat": chat.String(), "timestamp": resp.Timestamp.UnixMilli()}, nil
}
func (a *app) history(ctx context.Context, in args) (any, error) {
	if in.Count == 0 {
		in.Count = 50
	}
	if in.Count < 1 || in.Count > 50 {
		return nil, bad("invalid_count", 400)
	}
	m, err := a.getMessage(in.Chat, in.BeforeMessageID)
	if err != nil {
		return nil, err
	}
	i := info(m)
	_, err = a.cli.SendPeerMessage(ctx, a.cli.BuildHistorySyncRequest(&i, in.Count))
	if err != nil {
		return nil, bad("history_request_failed", 503)
	}
	return map[string]any{"requested": true, "coverage": "asynchronous_phone_sync", "count": in.Count}, nil
}
