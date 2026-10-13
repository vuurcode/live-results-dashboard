package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"runtime"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestCloseAllTellsClientsAndStopsRooms(t *testing.T) {
	tb := newTestBackend(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := tb.dial(t, ctx, "?competitionId=A", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	readUntilCompetitor(t, ctx, conn)

	tb.m.closeAll()
	if tb.m.roomCount() != 0 {
		t.Fatalf("rooms = %d, want none", tb.m.roomCount())
	}
	for { // messages still queued come first
		if _, _, err = conn.Read(ctx); err != nil {
			break
		}
	}
	if websocket.CloseStatus(err) != websocket.StatusGoingAway { // not a policy violation: the page must reconnect
		t.Fatalf("closed with %v, want going away", err)
	}
}

func TestIdleRoomLeavesNothingRunning(t *testing.T) {
	tb := newTestBackend(t, func(c *config) { c.dataSourceInterval = 0.02 })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	time.Sleep(50 * time.Millisecond) // let the server's own goroutines settle
	before := runtime.NumGoroutine()

	conn, _, err := tb.dial(t, ctx, "?competitionId=A", nil)
	if err != nil {
		t.Fatal(err)
	}
	readUntilCompetitor(t, ctx, conn)
	_ = conn.Close(websocket.StatusNormalClosure, "")

	waitFor(t, "the idle room to close", func() bool { return tb.m.roomCount() == 0 })
	hits := tb.hitCount("A")
	time.Sleep(150 * time.Millisecond)
	if got := tb.hitCount("A"); got != hits {
		t.Fatalf("closed room still polls: %d -> %d fetches", hits, got)
	}
	tb.m.client.CloseIdleConnections() // the upstream connections are kept alive for reuse, with a goroutine each
	tb.srv.CloseClientConnections()
	waitFor(t, "the goroutines to end", func() bool { return runtime.NumGoroutine() <= before+4 })
}

func TestRoomRefusesClientsBeyondItsLimit(t *testing.T) {
	tb := newTestBackend(t, func(c *config) { c.maxClientsPerRoom = 2 })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var conns []*websocket.Conn
	for range 2 {
		conn, _, err := tb.dial(t, ctx, "?competitionId=A", nil)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.CloseNow()
		conns = append(conns, conn)
	}
	if _, status, err := tb.dial(t, ctx, "?competitionId=A", nil); err == nil || status != http.StatusServiceUnavailable {
		t.Fatalf("third client: status %d, err %v, want 503", status, err)
	}
	if _, _, err := tb.dial(t, ctx, "?competitionId=B", nil); err != nil {
		t.Fatalf("another competition is not affected: %v", err)
	}
	_ = conns[0].Close(websocket.StatusNormalClosure, "")
	waitFor(t, "a free place", func() bool { return tb.m.rooms["A"].clientCount() < 2 })
	conn, _, err := tb.dial(t, ctx, "?competitionId=A", nil)
	if err != nil {
		t.Fatalf("a place was freed: %v", err)
	}
	conn.CloseNow()
}

func TestServerRefusesClientsBeyondItsTotal(t *testing.T) {
	tb := newTestBackend(t, func(c *config) { c.maxClients = 2 })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var conns []*websocket.Conn
	for _, id := range []string{"A", "B"} {
		conn, _, err := tb.dial(t, ctx, "?competitionId="+id, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.CloseNow()
		conns = append(conns, conn)
	}
	for _, id := range []string{"A", "B"} { // existing rooms and new ones alike
		if _, status, err := tb.dial(t, ctx, "?competitionId="+id, nil); err == nil || status != http.StatusServiceUnavailable {
			t.Fatalf("client %s over the total: status %d, err %v, want 503", id, status, err)
		}
	}
	_ = conns[0].Close(websocket.StatusNormalClosure, "")
	waitFor(t, "a free place", func() bool { return tb.m.roomCount() > 0 && tb.m.rooms["A"].clientCount() == 0 })
	conn, _, err := tb.dial(t, ctx, "?competitionId=A", nil)
	if err != nil {
		t.Fatalf("a place was freed: %v", err)
	}
	conn.CloseNow()
}

func TestHealthcheckIsAnEmpty200(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthcheck", healthcheck)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/healthcheck", nil))
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 {
		t.Fatalf("status %d body %q, want an empty 200", rec.Code, rec.Body.String())
	}
}

func TestConnectionAllowanceRollsOverThirtyDays(t *testing.T) {
	tb := newTestBackend(t, func(c *config) { c.maxClients30Days = 3 })
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	tb.m.now = func() time.Time { return now }
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	connect := func(id string) error {
		conn, _, err := tb.dial(t, ctx, "?competitionId="+id, nil)
		if err == nil {
			_ = conn.Close(websocket.StatusNormalClosure, "")
		}
		return err
	}
	for range 2 {
		if err := connect("A"); err != nil {
			t.Fatal(err)
		}
	}
	now = now.AddDate(0, 0, 10)
	if err := connect("A"); err != nil {
		t.Fatalf("the third connection fits: %v", err)
	}
	if err := connect("A"); err == nil {
		t.Fatal("a fourth connection within 30 days must be refused")
	}
	if err := connect("B"); err == nil {
		t.Fatal("a refused client must not open a new room")
	}
	waitFor(t, "idle rooms to close", func() bool { return tb.m.roomCount() == 0 })

	now = now.AddDate(0, 0, 20) // day 30 after the first two connections: they fall out of the window
	if err := connect("A"); err != nil {
		t.Fatalf("after the window passed the first two: %v", err)
	}
	tb.m.mu.Lock()
	days := len(tb.m.connsPerDay)
	tb.m.mu.Unlock()
	if days > 2 {
		t.Fatalf("days kept = %d, old days must be dropped", days)
	}
}

func TestBakedSettingsAreComplete(t *testing.T) {
	cfg := loadConfig()
	if cfg.maxClients30Days != 50000 || cfg.maxClients <= 0 || cfg.maxClientsPerRoom <= 0 || cfg.maxCompetitions <= 0 ||
		cfg.idleGrace <= 0 || cfg.catalogTTL <= 0 || cfg.dataRetention <= 0 || cfg.dataSourceInterval <= 0 {
		t.Fatalf("limits.conf does not define every setting: %+v", cfg)
	}
	t.Setenv("MAX_CLIENTS", "7")
	t.Setenv("MAX_CLIENTS_PER_ROOM", "junk")
	if got := loadConfig(); got.maxClients != 7 || got.maxClientsPerRoom != cfg.maxClientsPerRoom {
		t.Fatalf("the environment overrides a valid value only: %+v", got)
	}
}
