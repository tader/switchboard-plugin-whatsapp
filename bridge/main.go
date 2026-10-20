package main

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
	_ "modernc.org/sqlite"
)

var version = "1.0.0" // x-release-please-version

type fault struct {
	Code       string `json:"code"`
	Status     int    `json:"status"`
	Definitive bool   `json:"definitive"`
}

func (f *fault) Error() string           { return f.Code }
func bad(code string, status int) *fault { return &fault{code, status, true} }

type request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Args   json.RawMessage `json:"args"`
}
type response struct {
	ID     string `json:"id"`
	Result any    `json:"result,omitempty"`
	Error  *fault `json:"error,omitempty"`
}
type args struct {
	Phone           string   `json:"phone"`
	ExpectedAccount string   `json:"expectedAccount"`
	Chat            string   `json:"chat"`
	MessageID       string   `json:"messageId"`
	BeforeMessageID string   `json:"beforeMessageId"`
	ReplyTo         string   `json:"replyTo"`
	Text            string   `json:"text"`
	Emoji           string   `json:"emoji"`
	Options         []string `json:"options"`
	Limit           int      `json:"limit"`
	Count           int      `json:"count"`
	Cursor          string   `json:"cursor"`
	Type            string   `json:"type"`
	SendID          string   `json:"sendId"`
	IdempotencyKey  string   `json:"idempotencyKey"`
}
type app struct {
	cli         *whatsmeow.Client
	db          *sql.DB
	mu          sync.Mutex
	started     bool
	account     string
	syncAt      int64
	syncBatches int
	cacheFailed bool
}

func openApp(dir string) (*app, func(), error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, nil, err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return nil, nil, err
	}
	lock, err := os.OpenFile(filepath.Join(dir, "session.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, nil, err
	}
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		return nil, nil, bad("session_already_open", 503)
	}
	file := filepath.Join(dir, "session.db")
	f, err := os.OpenFile(file, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		lock.Close()
		return nil, nil, err
	}
	f.Close()
	os.Chmod(file, 0600)
	db, err := sql.Open("sqlite", file+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)")
	if err != nil {
		lock.Close()
		return nil, nil, err
	}
	db.SetMaxOpenConns(1)
	cleanup := func() { db.Close(); lock.Close() }
	container := sqlstore.NewWithDB(db, "sqlite3", waLog.Noop)
	if err = container.Upgrade(context.Background()); err != nil {
		cleanup()
		return nil, nil, err
	}
	device, err := container.GetFirstDevice(context.Background())
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	a := &app{db: db, cli: whatsmeow.NewClient(device, waLog.Noop)}
	if err = a.initCache(); err != nil {
		cleanup()
		return nil, nil, err
	}
	a.cli.AddEventHandler(a.event)
	return a, func() { a.cli.Disconnect(); cleanup() }, nil
}
func (a *app) status() map[string]any {
	account := ""
	if a.cli.Store.ID != nil {
		account = a.cli.Store.ID.ToNonAD().String()
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return map[string]any{"ready": a.cli.IsConnected() && a.cli.IsLoggedIn(), "paired": account != "", "account": account, "historyCoverage": "synced_cache_only", "lastHistorySync": a.syncAt, "historySyncBatches": a.syncBatches, "cacheHealthy": !a.cacheFailed}
}
func (a *app) start(ctx context.Context, in args) (any, error) {
	if a.cli.Store.Deleted {
		return nil, bad("session_revoked", 401)
	}
	if a.cli.Store.ID != nil && in.ExpectedAccount != "" && a.cli.Store.ID.ToNonAD().String() != in.ExpectedAccount {
		return nil, bad("account_mismatch", 403)
	}
	if a.cli.IsConnected() {
		return a.status(), nil
	}
	a.mu.Lock()
	started := a.started
	if !started {
		a.started = true
	}
	a.mu.Unlock()
	if started {
		return a.status(), nil
	}
	reset := func() { a.mu.Lock(); a.started = false; a.mu.Unlock() }
	if a.cli.Store.ID != nil {
		if err := a.cli.Connect(); err != nil {
			reset()
			return nil, bad("connection_failed", 503)
		}
		return a.status(), nil
	}
	if !phoneRE.MatchString(in.Phone) {
		reset()
		return nil, bad("international_phone_number_required", 400)
	}
	a.cli.PrePairCallback = func(jid types.JID, platform, businessName string) bool {
		expected := in.ExpectedAccount
		if expected == "" {
			expected = in.Phone + "@s.whatsapp.net"
		}
		return jid.ToNonAD().String() == expected
	}
	qr, err := a.cli.GetQRChannel(context.Background())
	if err != nil {
		reset()
		return nil, bad("pairing_failed", 503)
	}
	if err = a.cli.Connect(); err != nil {
		reset()
		return nil, bad("connection_failed", 503)
	}
	select {
	case item := <-qr:
		if item.Event != "code" {
			reset()
			return nil, bad("pairing_failed", 503)
		}
	case <-ctx.Done():
		reset()
		return nil, bad("pairing_timeout", 503)
	}
	code, err := a.cli.PairPhone(ctx, in.Phone, false, whatsmeow.PairClientChrome, "Chrome (Linux)")
	if err != nil {
		a.cli.Disconnect()
		reset()
		return nil, bad("pairing_failed", 503)
	}
	// Drain QR rotation events without logging authentication material.
	go func() {
		for range qr {
		}
	}()
	return map[string]any{"ready": false, "code": code}, nil
}
func (a *app) event(evt any) {
	switch e := evt.(type) {
	case *events.Message:
		if err := a.ingest(e); err != nil {
			a.mu.Lock()
			a.cacheFailed = true
			a.mu.Unlock()
		}
	case *events.HistorySync:
		for _, c := range e.Data.GetConversations() {
			chat, err := parseChat(c.GetID())
			if err != nil {
				continue
			}
			a.db.Exec("INSERT INTO sb_chats(chat,name,ts) VALUES(?,?,0) ON CONFLICT(chat) DO UPDATE SET name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE sb_chats.name END", chat.String(), c.GetName())
			for _, m := range c.GetMessages() {
				event, err := a.cli.ParseWebMessage(chat, m.GetMessage())
				if err == nil && event != nil {
					if err = a.ingest(event); err != nil {
						a.mu.Lock()
						a.cacheFailed = true
						a.mu.Unlock()
					}
				}
			}
		}
		a.mu.Lock()
		a.syncAt = time.Now().Unix()
		a.syncBatches++
		a.mu.Unlock()
	case *events.LoggedOut:
		a.mu.Lock()
		a.started = false
		a.mu.Unlock()
	case events.PermanentDisconnect:
		a.mu.Lock()
		a.started = false
		a.mu.Unlock()
	}
}
func (a *app) dispatch(ctx context.Context, method string, in args) (any, error) {
	if method == "version" {
		return map[string]any{"version": version, "protocol": 1}, nil
	}
	if method == "start" {
		return a.start(ctx, in)
	}
	if method == "status" {
		return a.status(), nil
	}
	switch method {
	case "chats":
		return a.chats(in)
	case "messages":
		return a.messages(in)
	case "message":
		m, err := a.getMessage(in.Chat, in.MessageID)
		if err != nil {
			return nil, err
		}
		return m.public(), nil
	case "send", "react", "vote":
		if !a.cli.IsConnected() || !a.cli.IsLoggedIn() {
			return nil, bad("signin_required", 401)
		}
		return a.write(ctx, method, in)
	case "history":
		return a.history(ctx, in)
	default:
		return nil, bad("unsupported_method", 400)
	}
}
func serve(input io.Reader, output io.Writer, a *app) {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 128*1024)
	encoder := json.NewEncoder(output)
	for scanner.Scan() {
		var r request
		decoder := json.NewDecoder(bytes.NewReader(scanner.Bytes()))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&r) != nil || len(r.ID) > 128 || r.ID == "" {
			encoder.Encode(response{ID: r.ID, Error: bad("invalid_request", 400)})
			continue
		}
		var in args
		decoder = json.NewDecoder(bytes.NewReader(r.Args))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&in) != nil {
			encoder.Encode(response{ID: r.ID, Error: bad("invalid_arguments", 400)})
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 85*time.Second)
		result, err := a.dispatch(ctx, r.Method, in)
		cancel()
		reply := response{ID: r.ID, Result: result}
		if err != nil {
			var f *fault
			if !errors.As(err, &f) {
				f = &fault{"operation_failed", 502, false}
			}
			reply.Result = nil
			reply.Error = f
		}
		if encoder.Encode(reply) != nil {
			return
		}
	}
}
func main() {
	store.SetOSInfo("Switchboard", [3]uint32{1, 0, 0})
	store.DeviceProps.RequireFullSync = proto.Bool(true)
	syscall.Umask(0077)
	dir := flag.String("data-dir", "", "Private session directory")
	flag.Parse()
	if *dir == "" || !filepath.IsAbs(*dir) {
		fmt.Fprintln(os.Stderr, "data directory required")
		os.Exit(2)
	}
	a, cleanup, err := openApp(*dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "could not open WhatsApp session")
		os.Exit(1)
	}
	defer cleanup()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	go func() { <-signals; os.Stdin.Close(); a.cli.Disconnect() }()
	serve(os.Stdin, os.Stdout, a)
}
