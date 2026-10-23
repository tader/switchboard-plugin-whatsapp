package main

import (
	"database/sql"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// Replies require the selected text/poll, never its nested quoted message or
// unrelated message variants. Poll encryption secrets stay in whatsmeow's store.
func safeQuote(source *waE2E.Message, kind string) []byte {
	clean := &waE2E.Message{}
	switch {
	case kind == "text" && source.GetConversation() != "":
		clean.Conversation = source.Conversation
	case kind == "text" && source.ExtendedTextMessage != nil:
		clean.ExtendedTextMessage = proto.Clone(source.ExtendedTextMessage).(*waE2E.ExtendedTextMessage)
		clean.ExtendedTextMessage.ContextInfo = nil
	case kind == "poll" && source.PollCreationMessage != nil:
		clean.PollCreationMessage = proto.Clone(source.PollCreationMessage).(*waE2E.PollCreationMessage)
		clean.PollCreationMessage.ContextInfo = nil
	case kind == "poll" && source.PollCreationMessageV2 != nil:
		clean.PollCreationMessageV2 = proto.Clone(source.PollCreationMessageV2).(*waE2E.PollCreationMessage)
		clean.PollCreationMessageV2.ContextInfo = nil
	case kind == "poll" && source.PollCreationMessageV3 != nil:
		clean.PollCreationMessageV3 = proto.Clone(source.PollCreationMessageV3).(*waE2E.PollCreationMessage)
		clean.PollCreationMessageV3.ContextInfo = nil
	default:
		return nil
	}
	// Unknown protobuf fields are unnecessary to the supported quote operation.
	clearUnknown(clean.ProtoReflect())
	data, err := proto.Marshal(clean)
	if err != nil {
		return nil
	}
	return data
}

// Upgrade existing rows in bounded batches. No messages or durable receipts are
// removed; raw quote data is reconstructed from the supported message variant.
func (a *app) scrubQuoteCache() error {
	if _, err := a.db.Exec("PRAGMA secure_delete=ON"); err != nil {
		return err
	}
	var done int
	err := a.db.QueryRow("SELECT value FROM sb_meta WHERE key='quote-cache-privacy-v1'").Scan(&done)
	if err == nil && done == 1 {
		return nil
	}
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	chat, id := "", ""
	for {
		rows, err := a.db.Query("SELECT chat,id,kind,truncated,raw FROM sb_messages WHERE (chat,id)>(?,?) ORDER BY chat,id LIMIT 100", chat, id)
		if err != nil {
			return err
		}
		type update struct {
			chat, id string
			raw      []byte
		}
		batch := []update{}
		for rows.Next() {
			var kind string
			var truncated bool
			var raw []byte
			if err = rows.Scan(&chat, &id, &kind, &truncated, &raw); err != nil {
				rows.Close()
				return err
			}
			var clean []byte
			if !truncated && len(raw) > 0 {
				original := &waE2E.Message{}
				if proto.Unmarshal(raw, original) == nil {
					clean = safeQuote(original, kind)
				}
			}
			batch = append(batch, update{chat, id, clean})
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if len(batch) == 0 {
			break
		}
		tx, err := a.db.Begin()
		if err != nil {
			return err
		}
		for _, item := range batch {
			if _, err = tx.Exec("UPDATE sb_messages SET raw=? WHERE chat=? AND id=?", item.raw, item.chat, item.id); err != nil {
				tx.Rollback()
				return err
			}
		}
		if err = tx.Commit(); err != nil {
			return err
		}
	}
	_, err = a.db.Exec("INSERT OR REPLACE INTO sb_meta(key,value) VALUES('quote-cache-privacy-v1',1)")
	return err
}

func clearUnknown(message protoreflect.Message) {
	message.SetUnknown(nil)
	message.Range(func(field protoreflect.FieldDescriptor, value protoreflect.Value) bool {
		if field.IsList() && field.Message() != nil {
			list := value.List()
			for i := 0; i < list.Len(); i++ {
				clearUnknown(list.Get(i).Message())
			}
		}
		if !field.IsList() && !field.IsMap() && field.Message() != nil {
			clearUnknown(value.Message())
		}
		return true
	})
}
