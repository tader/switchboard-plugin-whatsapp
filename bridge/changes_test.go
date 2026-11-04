package main

import (
	"encoding/json"
	"io"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func changePage(t *testing.T, a *app, cursor string) map[string]any {
	t.Helper()
	v, err := a.changes(args{Cursor: cursor, Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	return v.(map[string]any)
}
func TestChangesAtomicDedupMetadataAndRestart(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "profile")
	a, close, err := openApp(dir)
	if err != nil {
		t.Fatal(err)
	}
	initial := changePage(t, a, "")
	cursor := initial["checkpoint"].(string)
	if initial["resync"] != true {
		t.Fatal(initial)
	}
	if err = a.ingest(textEvent(testChat, "A", "PRIVATE-TEXT", 1000)); err != nil {
		t.Fatal(err)
	}
	page := changePage(t, a, cursor)
	if len(page["events"].([]change)) != 2 {
		t.Fatal(page)
	}
	data, _ := json.Marshal(page)
	if strings.Contains(string(data), "PRIVATE") || strings.Contains(string(data), "Fixture") {
		t.Fatal("body/name in feed")
	}
	after := page["checkpoint"].(string)
	if err = a.ingest(textEvent(testChat, "A", "PRIVATE-TEXT", 1000)); err != nil {
		t.Fatal(err)
	}
	if len(changePage(t, a, after)["events"].([]change)) != 0 {
		t.Fatal("duplicate cache delivery emitted changes")
	}
	// A failed chat update rolls back both the message and the trigger's feed row.
	if _, err = a.db.Exec(`CREATE TRIGGER fail_chat BEFORE UPDATE ON sb_chats BEGIN SELECT RAISE(ABORT,'fixture');END;`); err != nil {
		t.Fatal(err)
	}
	if err = a.ingest(textEvent(testChat, "B", "ROLLBACK", 2000)); err == nil {
		t.Fatal("expected rollback")
	}
	if _, err = a.getMessage(testChat, "B"); err == nil {
		t.Fatal("partial cache commit")
	}
	if len(changePage(t, a, after)["events"].([]change)) != 0 {
		t.Fatal("partial feed commit")
	}
	a.db.Exec("DROP TRIGGER fail_chat")
	close()
	a, close, err = openApp(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer close()
	if changePage(t, a, after)["resync"] != false {
		t.Fatal("cursor did not survive restart")
	}
	if err = a.ingest(textEvent(testChat, "C", "NEW", 3000)); err != nil {
		t.Fatal(err)
	}
	if len(changePage(t, a, after)["events"].([]change)) == 0 {
		t.Fatal("missed change after restart")
	}
}
func TestChangesRetentionAndForeignFutureCursors(t *testing.T) {
	a := fixture(t)
	cursor := changePage(t, a, "")["checkpoint"].(string)
	a.ingest(textEvent(testChat, "A", "first", 1000))
	page := changePage(t, a, cursor)
	instance := page["instance"].(string)
	if _, err := a.db.Exec("INSERT INTO sb_changes(seq,chat,message_id,kind) VALUES(100002,?,'Z','invalidated')", testChat); err != nil {
		t.Fatal(err)
	}
	if changePage(t, a, cursor)["resync"] != true {
		t.Fatal("count eviction not detected")
	}
	var count, watermark int64
	a.db.QueryRow("SELECT count(*) FROM sb_changes").Scan(&count)
	a.db.QueryRow("SELECT through_seq FROM sb_change_meta WHERE id=1").Scan(&watermark)
	if count != 1 || watermark < 2 {
		t.Fatalf("retention count=%d watermark=%d", count, watermark)
	}
	for _, c := range []string{feedCursor("foreign", 1), feedCursor(instance, 100003)} {
		if changePage(t, a, c)["resync"] != true {
			t.Fatal("invalid generation/future cursor accepted")
		}
	}
	after := changePage(t, a, "")["checkpoint"].(string)
	a.db.Exec("UPDATE sb_changes SET created=unixepoch()-604801")
	if changePage(t, a, after)["resync"] != false {
		t.Fatal("head cursor should remain valid after deleting its own past")
	}
	if changePage(t, a, feedCursor(instance, 100001))["resync"] != true {
		t.Fatal("aged-out gap not detected")
	}
	if _, err := a.changes(args{Cursor: "not-json"}); err == nil {
		t.Fatal("invalid cursor accepted")
	}
}
func TestChangesPageBoundariesAndChatRename(t *testing.T) {
	a := fixture(t)
	cursor := changePage(t, a, "")["checkpoint"].(string)
	a.ingest(textEvent(testChat, "A", "a", 1000))
	v, err := a.changes(args{Cursor: cursor, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	first := v.(map[string]any)
	if first["hasMore"] != true || len(first["events"].([]change)) != 1 {
		t.Fatal(first)
	}
	second := changePage(t, a, first["checkpoint"].(string))
	if len(second["events"].([]change)) != 1 {
		t.Fatal(second)
	}
	a.db.Exec("UPDATE sb_chats SET name='PRIVATE-RENAME' WHERE chat=?", testChat)
	renamed := changePage(t, a, second["checkpoint"].(string))
	items := renamed["events"].([]change)
	if len(items) != 1 || items[0].MessageID != "" {
		t.Fatal(renamed)
	}
	raw, _ := json.Marshal(renamed)
	if strings.Contains(string(raw), "PRIVATE") {
		t.Fatal("name in metadata feed")
	}
	chat, err := a.chat(args{Chat: testChat})
	if err != nil || chat.(map[string]any)["name"] != "PRIVATE-RENAME" {
		t.Fatal(chat, err)
	}
}
func TestChangesWakeHintsAreCoalescedAndRPCResponsesRemainReadable(t *testing.T) {
	a := fixture(t)
	input, writer := io.Pipe()
	reader, output := io.Pipe()
	defer input.Close()
	defer writer.Close()
	defer reader.Close()
	// Queue the burst before the writer starts so the coalescing assertion is deterministic.
	for i := 0; i < 1000; i++ {
		a.notifyChanges()
	}
	done := make(chan struct{})
	go func() { serve(input, output, a); output.Close(); close(done) }()
	replies := make(chan map[string]any, 32)
	go func() {
		defer close(replies)
		decoder := json.NewDecoder(reader)
		for {
			var msg map[string]any
			if decoder.Decode(&msg) != nil {
				return
			}
			replies <- msg
		}
	}()
	select {
	case msg := <-replies:
		if msg["event"] != "changes" {
			t.Fatal(msg)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("missing wake hint")
	}
	if _, err := io.WriteString(writer, `{"id":"version","method":"version","args":{}}`+"\n"); err != nil {
		t.Fatal(err)
	}
	hints := 1
	deadline := time.After(2 * time.Second)
waiting:
	for {
		select {
		case msg := <-replies:
			if msg["event"] == "changes" {
				hints++
				if hints > 3 {
					t.Fatal("uncoalesced hints")
				}
				continue
			}
			if msg["id"] != "version" {
				t.Fatal(msg)
			}
			break waiting
		case <-deadline:
			t.Fatal("RPC blocked by hint")
		}
	}

	writer.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("serve leaked notifier")
	}
}
