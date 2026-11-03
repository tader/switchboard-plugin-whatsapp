package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
)

// The feed contains identifiers only. SQL triggers commit it with cache mutations.
const changesSchema = `
CREATE TABLE IF NOT EXISTS sb_change_meta(id INTEGER PRIMARY KEY CHECK(id=1),instance TEXT NOT NULL,through_seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sb_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,chat TEXT NOT NULL,message_id TEXT NOT NULL,kind TEXT NOT NULL,created INTEGER NOT NULL DEFAULT(unixepoch()));
CREATE INDEX IF NOT EXISTS sb_changes_created ON sb_changes(created);
CREATE TRIGGER IF NOT EXISTS sb_message_insert AFTER INSERT ON sb_messages BEGIN
 INSERT INTO sb_changes(chat,message_id,kind) VALUES(NEW.chat,NEW.id,CASE WHEN NEW.kind='revoked' THEN 'deleted' ELSE 'invalidated' END);
END;
CREATE TRIGGER IF NOT EXISTS sb_message_update AFTER UPDATE ON sb_messages WHEN
 OLD.text IS NOT NEW.text OR OLD.kind IS NOT NEW.kind OR OLD.reply_to IS NOT NEW.reply_to OR OLD.poll IS NOT NEW.poll OR OLD.truncated IS NOT NEW.truncated OR OLD.sender IS NOT NEW.sender OR OLD.from_me IS NOT NEW.from_me OR OLD.ts IS NOT NEW.ts BEGIN
 INSERT INTO sb_changes(chat,message_id,kind) VALUES(NEW.chat,NEW.id,CASE WHEN NEW.kind='revoked' THEN 'deleted' ELSE 'invalidated' END);
END;
CREATE TRIGGER IF NOT EXISTS sb_chat_insert AFTER INSERT ON sb_chats BEGIN
 INSERT INTO sb_changes(chat,message_id,kind) VALUES(NEW.chat,'','invalidated');
END;
CREATE TRIGGER IF NOT EXISTS sb_chat_update AFTER UPDATE ON sb_chats WHEN OLD.name IS NOT NEW.name OR OLD.ts IS NOT NEW.ts BEGIN
 INSERT INTO sb_changes(chat,message_id,kind) VALUES(NEW.chat,'','invalidated');
END;
CREATE TRIGGER IF NOT EXISTS sb_changes_retention AFTER INSERT ON sb_changes BEGIN
 UPDATE sb_change_meta SET through_seq=max(through_seq,coalesce((SELECT max(seq) FROM sb_changes WHERE seq<=NEW.seq-100000 OR created<unixepoch()-604800),0)) WHERE id=1;
 DELETE FROM sb_changes WHERE seq<=NEW.seq-100000 OR created<unixepoch()-604800;
END;
`

func (a *app) initChanges() error {
	a.changesWake = make(chan struct{}, 1)
	if _, err := a.db.Exec(changesSchema); err != nil {
		return err
	}
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return err
	}
	_, err := a.db.Exec("INSERT OR IGNORE INTO sb_change_meta(id,instance) VALUES(1,?)", hex.EncodeToString(id))
	return err
}
func (a *app) notifyChanges() {
	select {
	case a.changesWake <- struct{}{}:
	default:
	}
}

type changeCursor struct {
	Instance string `json:"instance"`
	Seq      int64  `json:"seq"`
}
type change struct {
	Seq       int64  `json:"seq"`
	Chat      string `json:"chat"`
	MessageID string `json:"messageId,omitempty"`
	Kind      string `json:"kind"`
}

func feedCursor(instance string, seq int64) string {
	b, _ := json.Marshal(changeCursor{instance, seq})
	return base64.RawURLEncoding.EncodeToString(b)
}
func (a *app) changes(in args) (any, error) {
	if len(in.Cursor) > 2048 {
		return nil, bad("invalid_cursor", 400)
	}
	n, err := pageLimit(in.Limit)
	if err != nil {
		return nil, err
	}
	tx, err := a.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// Prune even when the receiver resumes after a long idle period without new messages.
	if _, err = tx.Exec(`UPDATE sb_change_meta SET through_seq=max(through_seq,coalesce((SELECT max(seq) FROM sb_changes WHERE created<unixepoch()-604800),0)) WHERE id=1;DELETE FROM sb_changes WHERE created<unixepoch()-604800;`); err != nil {
		return nil, err
	}
	var instance string
	var through, head int64
	if err = tx.QueryRow("SELECT instance,through_seq,max(through_seq,coalesce((SELECT max(seq) FROM sb_changes),0)) FROM sb_change_meta WHERE id=1").Scan(&instance, &through, &head); err != nil {
		return nil, err
	}
	cursor := changeCursor{}
	resync := in.Cursor == ""
	if !resync {
		raw, e := base64.RawURLEncoding.DecodeString(in.Cursor)
		if e != nil || json.Unmarshal(raw, &cursor) != nil {
			return nil, bad("invalid_cursor", 400)
		}
		if cursor.Instance != instance || cursor.Seq < through || cursor.Seq > head || cursor.Seq < 0 {
			resync = true
		}
	}
	items := []change{}
	next := head
	more := false
	if !resync {
		rows, e := tx.Query("SELECT seq,chat,message_id,kind FROM sb_changes WHERE seq>? ORDER BY seq LIMIT ?", cursor.Seq, n+1)
		if e != nil {
			return nil, e
		}
		for rows.Next() {
			var c change
			if e = rows.Scan(&c.Seq, &c.Chat, &c.MessageID, &c.Kind); e != nil {
				rows.Close()
				return nil, e
			}
			items = append(items, c)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		if len(items) > n {
			items = items[:n]
			more = true
		}
		if len(items) > 0 {
			next = items[len(items)-1].Seq
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return map[string]any{"instance": instance, "events": items, "checkpoint": feedCursor(instance, next), "head": next, "resync": resync, "hasMore": more}, nil
}
func (a *app) chat(in args) (any, error) {
	if _, err := parseChat(in.Chat); err != nil {
		return nil, err
	}
	var name string
	var ts int64
	err := a.db.QueryRow("SELECT name,ts FROM sb_chats WHERE chat=?", in.Chat).Scan(&name, &ts)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, bad("chat_not_in_synced_cache", 404)
		}
		return nil, err
	}
	return map[string]any{"id": in.Chat, "name": name, "lastMessageAt": ts, "isGroup": strings.HasSuffix(in.Chat, "@g.us")}, nil
}
