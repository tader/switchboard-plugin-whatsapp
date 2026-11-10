package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

var chatRE = regexp.MustCompile(`^[0-9]+(?:-[0-9]+)?@(s\.whatsapp\.net|g\.us|lid)$`)
var phoneRE = regexp.MustCompile(`^[1-9][0-9]{6,14}$`)
var idRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func parseChat(s string) (types.JID, error) {
	if len(s) > 256 || !chatRE.MatchString(s) {
		return types.EmptyJID, bad("invalid_chat", 400)
	}
	return types.ParseJID(s)
}

type poll struct {
	Name            string   `json:"name"`
	Options         []string `json:"options"`
	SelectableCount int      `json:"selectableCount"`
}
type reaction struct {
	Emoji         string         `json:"emoji"`
	Count         *int           `json:"count"`
	Me            *bool          `json:"me"`
	Users         []reactionUser `json:"users"`
	UsersComplete bool           `json:"usersComplete"`
}
type reactionUser struct {
	ID          string  `json:"id"`
	DisplayName *string `json:"displayName"`
}

type message struct {
	Chat              string     `json:"chat"`
	ID                string     `json:"id"`
	Sender            string     `json:"sender"`
	AuthorDisplayName string     `json:"authorDisplayName,omitempty"`
	FromMe            bool       `json:"fromMe"`
	Timestamp         int64      `json:"timestamp"`
	Text              string     `json:"text"`
	Type              string     `json:"type"`
	ReplyTo           string     `json:"replyTo,omitempty"`
	Poll              *poll      `json:"poll,omitempty"`
	Truncated         bool       `json:"textTruncated,omitempty"`
	Reactions         []reaction `json:"reactions"`
	raw               []byte
	revision          int64
}

func (m message) public() message { m.raw = nil; return m }
func trimText(text string) string {
	if utf8.RuneCountInString(text) > 16000 {
		return string([]rune(text)[:16000])
	}
	return text
}
func pollMessage(m *waE2E.Message) *waE2E.PollCreationMessage {
	if x := m.GetPollCreationMessage(); x != nil {
		return x
	}
	if x := m.GetPollCreationMessageV2(); x != nil {
		return x
	}
	return m.GetPollCreationMessageV3()
}
func normalize(e *events.Message) (message, error) {
	if e == nil || e.Message == nil {
		return message{}, bad("invalid_message", 400)
	}
	if _, err := parseChat(e.Info.Chat.String()); err != nil {
		return message{}, err
	}
	m := message{Chat: e.Info.Chat.String(), ID: e.Info.ID, Sender: e.Info.Sender.ToNonAD().String(), FromMe: e.Info.IsFromMe, Timestamp: e.Info.Timestamp.UnixMilli(), Type: "unsupported", revision: e.Info.Timestamp.UnixMilli()}
	if !idRE.MatchString(m.ID) {
		return m, bad("invalid_message_id", 400)
	}
	if e.IsViewOnce || e.IsViewOnceV2 || e.IsViewOnceV2Extension || e.IsEphemeral {
		m.Type = "restricted"
		return m, nil
	}
	p := e.Message
	switch {
	case p.GetProtocolMessage().GetType() == waE2E.ProtocolMessage_REVOKE && p.GetProtocolMessage().GetKey().GetID() != "":
		m.ID = p.GetProtocolMessage().GetKey().GetID()
		m.Type = "revoked"
	case p.GetConversation() != "":
		m.Text = p.GetConversation()
		m.Type = "text"
	case p.GetExtendedTextMessage() != nil:
		m.Text = p.GetExtendedTextMessage().GetText()
		m.Type = "text"
		m.ReplyTo = p.GetExtendedTextMessage().GetContextInfo().GetStanzaID()
	case pollMessage(p) != nil:
		x := pollMessage(p)
		m.Type = "poll"
		m.Poll = &poll{Name: x.GetName(), SelectableCount: int(x.GetSelectableOptionsCount())}
		for _, o := range x.GetOptions() {
			m.Poll.Options = append(m.Poll.Options, o.GetOptionName())
		}
	case p.GetImageMessage() != nil:
		m.Type = "image"
		m.Text = p.GetImageMessage().GetCaption()
	case p.GetVideoMessage() != nil:
		m.Type = "video"
		m.Text = p.GetVideoMessage().GetCaption()
	case p.GetDocumentMessage() != nil:
		m.Type = "document"
		m.Text = p.GetDocumentMessage().GetCaption()
	case p.GetAudioMessage() != nil:
		m.Type = "audio"
	case p.GetReactionMessage() != nil:
		m.Type = "reaction"
		m.ReplyTo = p.GetReactionMessage().GetKey().GetID()
		m.Text = p.GetReactionMessage().GetText()
	case p.GetPollUpdateMessage() != nil:
		m.Type = "poll_vote"
		m.ReplyTo = p.GetPollUpdateMessage().GetPollCreationMessageKey().GetID()
	}
	original := m.Text
	m.Text = trimText(m.Text)
	m.Truncated = original != m.Text
	// Only text and polls need protobuf context for quoting/voting. Media keys are not archived.
	if !m.Truncated && (m.Type == "text" || m.Type == "poll") {
		m.raw = safeQuote(p, m.Type)
	}
	return m, nil
}
func (a *app) initCache() error {
	_, err := a.db.Exec(`CREATE TABLE IF NOT EXISTS sb_chats(chat TEXT PRIMARY KEY,name TEXT NOT NULL DEFAULT '',ts INTEGER NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS sb_messages(chat TEXT NOT NULL,id TEXT NOT NULL,sender TEXT NOT NULL,from_me INTEGER NOT NULL,ts INTEGER NOT NULL,text TEXT NOT NULL,kind TEXT NOT NULL,reply_to TEXT NOT NULL,poll TEXT NOT NULL,truncated INTEGER NOT NULL,raw BLOB,revision INTEGER NOT NULL,PRIMARY KEY(chat,id));CREATE INDEX IF NOT EXISTS sb_message_page ON sb_messages(chat,ts DESC,id DESC);CREATE TABLE IF NOT EXISTS sb_meta(key TEXT PRIMARY KEY,value INTEGER);`)
	if err != nil {
		return err
	}
	if err = a.scrubQuoteCache(); err != nil {
		return err
	}
	return a.initChanges()
}
func (a *app) ingest(e *events.Message) error {
	m, err := normalize(e)
	if err != nil {
		return nil
	}
	if m.Type == "unsupported" {
		return nil
	}
	p, _ := json.Marshal(m.Poll)
	tx, err := a.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.Exec(`INSERT INTO sb_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chat,id) DO UPDATE SET text=excluded.text,kind=excluded.kind,reply_to=excluded.reply_to,poll=excluded.poll,truncated=excluded.truncated,raw=excluded.raw,revision=excluded.revision WHERE excluded.revision>=sb_messages.revision`, m.Chat, m.ID, m.Sender, m.FromMe, m.Timestamp, m.Text, m.Type, m.ReplyTo, string(p), m.Truncated, m.raw, m.revision)
	if err != nil {
		return err
	}
	name := ""
	if !e.Info.IsGroup && !e.Info.IsFromMe {
		name = e.Info.PushName
	}
	_, err = tx.Exec(`INSERT INTO sb_chats(chat,name,ts) VALUES(?,?,?) ON CONFLICT(chat) DO UPDATE SET ts=max(sb_chats.ts,excluded.ts),name=CASE WHEN sb_chats.name='' THEN excluded.name ELSE sb_chats.name END`, m.Chat, name, m.Timestamp)
	if err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	a.notifyChanges()
	return nil
}

const columns = "chat,id,sender,from_me,ts,text,kind,reply_to,poll,truncated,raw,revision"

func scanMessage(row interface{ Scan(...any) error }) (message, error) {
	var m message
	var p string
	err := row.Scan(&m.Chat, &m.ID, &m.Sender, &m.FromMe, &m.Timestamp, &m.Text, &m.Type, &m.ReplyTo, &p, &m.Truncated, &m.raw, &m.revision)
	if err == sql.ErrNoRows {
		return m, bad("message_not_in_synced_cache", 404)
	}
	if err != nil {
		return m, err
	}
	if err = json.Unmarshal([]byte(p), &m.Poll); err != nil {
		return m, err
	}
	return m, nil
}

// chatAlias resolves only authenticated account metadata or the library's persisted
// PN/LID map. Never infer identity from names or matching numeric JID components.
// Keep stored IDs and client cursors intact; read both aliases under the requested ID.
func (a *app) chatAlias(chat string) (string, error) {
	jid, err := parseChat(chat)
	if err != nil {
		return "", err
	}
	if jid.Server == types.GroupServer {
		return chat, nil
	}
	device := a.cli.Store
	if device.ID != nil && !device.LID.IsEmpty() {
		pn, lid := device.ID.ToNonAD(), device.LID.ToNonAD()
		if jid == pn {
			return lid.String(), nil
		}
		if jid == lid {
			return pn.String(), nil
		}
	}
	if device.LIDs == nil {
		return chat, nil
	}
	var alias types.JID
	if jid.Server == types.HiddenUserServer {
		alias, err = device.LIDs.GetPNForLID(context.Background(), jid)
	} else {
		alias, err = device.LIDs.GetLIDForPN(context.Background(), jid)
	}
	if err != nil {
		return "", err
	}
	if alias.IsEmpty() {
		return chat, nil
	}
	return alias.ToNonAD().String(), nil
}

// A late revoke/edit under the other alias supersedes the original. Dedupe before
// applying pagination so the same remote message cannot appear on two pages.
const aliasMessages = `WITH ranked AS (
 SELECT ` + columns + `,row_number() OVER (PARTITION BY id ORDER BY revision DESC,
 CASE WHEN kind='revoked' THEN 0 ELSE 1 END,ts DESC,chat) AS rank
 FROM sb_messages WHERE chat IN (?,?)
) SELECT ` + columns + ` FROM ranked WHERE rank=1`

// History is only a partial synced cache: counts and unobserved own state
// remain unknown. Empty reaction text is a removal and wins by timestamp.
func (a *app) messageReactions(chat, alias, id string) ([]reaction, error) {
	rows, err := a.db.Query(`WITH ranked AS (SELECT text,from_me,sender,row_number() OVER (PARTITION BY CASE WHEN from_me=1 THEN '__self__' ELSE sender END ORDER BY revision DESC,id DESC) AS n FROM sb_messages WHERE chat IN (?,?) AND kind='reaction' AND reply_to=?) SELECT text,from_me,sender FROM ranked WHERE n=1 AND text!=''`, chat, alias, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	found := map[string]*reaction{}
	for rows.Next() {
		var emoji, sender string
		var own bool
		if err = rows.Scan(&emoji, &own, &sender); err != nil {
			return nil, err
		}
		if found[emoji] == nil {
			found[emoji] = &reaction{Emoji: emoji, Users: []reactionUser{}}
		}
		if sender != "" && len(sender) <= 2048 && len(found[emoji].Users) < 100 {
			found[emoji].Users = append(found[emoji].Users, reactionUser{ID: sender})
		}
		if own {
			v := true
			found[emoji].Me = &v
		}
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	// Name resolution can access the same single-connection database.
	if err = rows.Close(); err != nil {
		return nil, err
	}
	result := make([]reaction, 0, len(found))
	for _, v := range found {
		for i := range v.Users {
			name := a.senderName(v.Users[i].ID)
			if name != "" && name != v.Users[i].ID {
				v.Users[i].DisplayName = &name
			}
		}
		result = append(result, *v)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Emoji < result[j].Emoji })
	return result, nil
}

func (a *app) getMessage(chat, id string) (message, error) {
	if _, err := parseChat(chat); err != nil {
		return message{}, err
	}
	if !idRE.MatchString(id) {
		return message{}, bad("invalid_message_id", 400)
	}
	alias, err := a.chatAlias(chat)
	if err != nil {
		return message{}, err
	}
	m, err := scanMessage(a.db.QueryRow(aliasMessages+" AND id=?", chat, alias, id))
	if err == nil {
		m.AuthorDisplayName = a.senderName(m.Sender)
		m.Reactions, err = a.messageReactions(chat, alias, id)
	}
	return m, err
}

type cursor struct {
	Kind string `json:"k"`
	Chat string `json:"c"`
	Type string `json:"f"`
	Time int64  `json:"t"`
	ID   string `json:"i"`
}

func encodeCursor(c cursor) string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}
func decodeCursor(s, kind, chat, filter string) (cursor, error) {
	if len(s) > 2048 {
		return cursor{}, bad("invalid_cursor", 400)
	}
	if s == "" {
		return cursor{Kind: kind, Chat: chat, Type: filter, Time: 1 << 62}, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return cursor{}, bad("invalid_cursor", 400)
	}
	var c cursor
	if json.Unmarshal(b, &c) != nil || c.Kind != kind || c.Chat != chat || c.Type != filter || c.Time < 0 || len(c.ID) > 200 {
		return cursor{}, bad("invalid_cursor", 400)
	}
	return c, nil
}
func pageLimit(n int) (int, error) {
	if n == 0 {
		return 50, nil
	}
	if n < 1 || n > 100 {
		return 0, bad("invalid_limit", 400)
	}
	return n, nil
}
func (a *app) messages(in args) (any, error) {
	if _, err := parseChat(in.Chat); err != nil {
		return nil, err
	}
	n, err := pageLimit(in.Limit)
	if err != nil {
		return nil, err
	}
	c, err := decodeCursor(in.Cursor, "messages", in.Chat, "")
	if err != nil {
		return nil, err
	}
	alias, err := a.chatAlias(in.Chat)
	if err != nil {
		return nil, err
	}
	rows, err := a.db.Query(aliasMessages+" AND kind!='reaction' AND (ts<? OR (ts=? AND id<?)) ORDER BY ts DESC,id DESC LIMIT ?", in.Chat, alias, c.Time, c.Time, c.ID, n+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []message{}
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		m.Chat = in.Chat // Contract rows retain the requested conversation identity.
		items = append(items, m.public())
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	// Contact lookups share this one-connection database; release rows first.
	if err = rows.Close(); err != nil {
		return nil, err
	}
	for i := range items {
		items[i].AuthorDisplayName = a.senderName(items[i].Sender)
		items[i].Reactions, err = a.messageReactions(in.Chat, alias, items[i].ID)
		if err != nil {
			return nil, err
		}
	}
	var next any
	if len(items) > n {
		items = items[:n]
		last := items[n-1]
		next = encodeCursor(cursor{Kind: "messages", Chat: in.Chat, Time: last.Timestamp, ID: last.ID})
	}
	return map[string]any{"items": items, "nextCursor": next, "hasMore": next != nil, "coverage": "synced_cache_only"}, nil
}
func (a *app) chats(in args) (any, error) {
	n, err := pageLimit(in.Limit)
	if err != nil {
		return nil, err
	}
	if in.Type == "" {
		in.Type = "all"
	}
	if in.Type != "all" && in.Type != "direct" && in.Type != "group" {
		return nil, bad("invalid_chat_type", 400)
	}
	c, err := decodeCursor(in.Cursor, "chats", "", in.Type)
	if err != nil {
		return nil, err
	}
	filter := ""
	if in.Type == "group" {
		filter = " AND chat LIKE '%@g.us'"
	} else if in.Type == "direct" {
		filter = " AND chat NOT LIKE '%@g.us'"
	}
	rows, err := a.db.Query("SELECT chat,name,ts FROM sb_chats WHERE (ts<? OR (ts=? AND chat<?))"+filter+" ORDER BY ts DESC,chat DESC LIMIT ?", c.Time, c.Time, c.ID, n+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, name string
		var ts int64
		if err = rows.Scan(&id, &name, &ts); err != nil {
			return nil, err
		}
		items = append(items, map[string]any{"id": id, "name": name, "lastMessageAt": ts, "isGroup": strings.HasSuffix(id, "@g.us")})
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	var next any
	if len(items) > n {
		items = items[:n]
		last := items[n-1]
		next = encodeCursor(cursor{Kind: "chats", Type: in.Type, Time: last["lastMessageAt"].(int64), ID: last["id"].(string)})
	}
	return map[string]any{"items": items, "nextCursor": next, "hasMore": next != nil, "coverage": "synced_cache_only"}, nil
}
