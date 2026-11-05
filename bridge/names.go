package main

import (
	"context"
	"go.mau.fi/whatsmeow/types"
	"strings"
	"unicode"
)

func displayName(value string) string {
	value = strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, value))
	if len([]rune(value)) > 512 {
		value = string([]rune(value)[:512])
	}
	return value
}

// Names are presentation only: never rewrite the sender used for quotes or writes.
// The local contact/LID stores are scoped to this linked account.
func (a *app) senderName(sender string) string {
	jid, err := types.ParseJID(sender)
	if err != nil {
		return sender
	}
	jid = jid.ToNonAD()
	aliases := []types.JID{jid}
	if alias, err := a.chatAlias(jid.String()); err == nil && alias != jid.String() {
		if other, err := types.ParseJID(alias); err == nil {
			aliases = append(aliases, other)
		}
	}
	contacts := []types.ContactInfo{}
	for _, id := range aliases {
		if a.cli.Store.Contacts != nil {
			if c, err := a.cli.Store.Contacts.GetContact(context.Background(), id); err == nil {
				contacts = append(contacts, c)
			}
		}
	}
	for _, pick := range []func(types.ContactInfo) string{
		func(c types.ContactInfo) string { return c.FullName },
		func(c types.ContactInfo) string { return c.FirstName },
		func(c types.ContactInfo) string { return c.PushName },
		func(c types.ContactInfo) string { return c.BusinessName },
	} {
		for _, c := range contacts {
			if name := displayName(pick(c)); name != "" {
				return name
			}
		}
	}
	for _, id := range aliases {
		if id.Server == types.DefaultUserServer && phoneRE.MatchString(id.User) {
			return "+" + id.User
		}
	}
	return sender
}

func (a *app) invalidateSender(sender types.JID) {
	alias, err := a.chatAlias(sender.ToNonAD().String())
	if err != nil {
		alias = sender.ToNonAD().String()
	}
	_, err = a.db.Exec(`INSERT INTO sb_changes(chat,message_id,kind) SELECT DISTINCT chat,'','invalidated' FROM sb_messages WHERE sender IN (?,?)`, sender.ToNonAD().String(), alias)
	if err == nil {
		a.notifyChanges()
	}
}
