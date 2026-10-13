package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/vuurcode/live-results-experiment/backend/internal/config"
	"github.com/vuurcode/live-results-experiment/backend/internal/hub"
	"github.com/vuurcode/live-results-experiment/backend/internal/ratelimit"
	"github.com/vuurcode/live-results-experiment/backend/internal/useragent"
)

// testBackend runs a backend against a fake upstream that counts requests per competitionId.
type testBackend struct {
	m      *hub.Hub
	srv    *httptest.Server
	mu     sync.Mutex
	hits   map[string]int
	agents map[string]string
	body   string // when set, the upstream answers with this instead of the sample competition
	status int    // when set, the upstream answers with this HTTP status
}

func newTestBackend(t *testing.T, mutate func(*config.Config)) *testBackend {
	t.Helper()
	tb := &testBackend{hits: map[string]int{}, agents: map[string]string{}}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("competitionId")
		tb.mu.Lock()
		tb.hits[id]++
		tb.agents[id] = r.Header.Get("User-Agent")
		body, status := tb.body, tb.status
		tb.mu.Unlock()
		if status != 0 {
			w.WriteHeader(status)
			return
		}
		if body != "" {
			_, _ = w.Write([]byte(body))
			return
		}
		_, _ = w.Write([]byte(`{"name":"Event ` + id + `","distances":[{"id":"d1","name":"500 meter","eventNumber":1,"races":[
			{"id":"r1","heat":1,"lane":"white","competitor":{"name":"A","startNumber":"7"},"laps":[{"time":"00:00:40.000","lapTime":"00:00:40.000"}]}]}]}`))
	}))
	t.Cleanup(upstream.Close)

	cfg := config.Config{
		DataSourceURL: upstream.URL, DataSourceInterval: 3600, // one fetch per room: the test controls timing
		MaxCompetitions: 2, MaxClientsPerRoom: 100, MaxClients: 1000, MaxClients30Days: 100000, IdleGrace: 50 * time.Millisecond, PingInterval: time.Hour,
	}
	if mutate != nil {
		mutate(&cfg)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	ua := useragent.New("")
	tb.m = hub.New(ctx, cfg, ua)
	opts := Options{PingInterval: cfg.PingInterval}
	if cfg.MaxClientsPerIP > 0 {
		opts.Limiter = ratelimit.New(cfg.ConnectsPerMinute, cfg.ConnectBurst, cfg.MaxClientsPerIP)
	}
	tb.srv = httptest.NewServer(New(tb.m, opts).Handler(ua, nil))
	t.Cleanup(tb.srv.Close)
	return tb
}

func (tb *testBackend) hitCount(id string) int {
	tb.mu.Lock()
	defer tb.mu.Unlock()
	return tb.hits[id]
}

// dial opens a WebSocket; on a failed handshake it also returns the HTTP status.
func (tb *testBackend) dial(t *testing.T, ctx context.Context, query string, header http.Header) (*websocket.Conn, int, error) {
	t.Helper()
	conn, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(tb.srv.URL, "http")+"/ws"+query, &websocket.DialOptions{HTTPHeader: header}) //nolint:bodyclose // websocket.Dial already closes the handshake response body
	status := 0
	if resp != nil {
		status = resp.StatusCode
	}
	return conn, status, err
}

// readTypes reads messages until the competitor_update (the last message of a replay or live batch).
func readUntilCompetitor(t *testing.T, ctx context.Context, conn *websocket.Conn) (types []string, eventName string) {
	t.Helper()
	for {
		_, b, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v (got %v)", err, types)
		}
		var v struct {
			Type string
			Data struct{ Name string }
		}
		_ = json.Unmarshal(b, &v)
		types = append(types, v.Type)
		if v.Type == "event_name" {
			eventName = v.Data.Name
		}
		if v.Type == "competitor_update" {
			return
		}
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestClientsShareOneFetchLoopPerCompetition(t *testing.T) {
	tb := newTestBackend(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Three clients follow A (the first sets the upstream User-Agent), one follows B.
	var conns []*websocket.Conn
	for _, q := range []string{"?competitionId=A", "?competitionId=A", "?competitionId=A", "?competitionId=B"} {
		conn, _, err := tb.dial(t, ctx, q, http.Header{"User-Agent": []string{"test-agent/1.0"}})
		if err != nil {
			t.Fatal(err)
		}
		defer conn.CloseNow()
		conns = append(conns, conn)
	}

	for i, conn := range conns {
		types, name := readUntilCompetitor(t, ctx, conn)
		want := "Event A"
		if i == 3 {
			want = "Event B"
		}
		if name != want {
			t.Errorf("client %d got %q, want %q", i, name, want)
		}
		if types[0] != "status" {
			t.Errorf("client %d first message %q, want status", i, types[0])
		}
	}
	if a, b := tb.hitCount("A"), tb.hitCount("B"); a != 1 || b != 1 {
		t.Errorf("upstream hits A=%d B=%d, want exactly 1 each", a, b)
	}
	if got := tb.m.RoomCount(); got != 2 {
		t.Errorf("rooms = %d, want 2", got)
	}
	if tb.agents["A"] != "test-agent/1.0" {
		t.Errorf("upstream saw User-Agent %q", tb.agents["A"])
	}

	// A late joiner gets the replay without causing another upstream request.
	late, _, err := tb.dial(t, ctx, "?competitionId=A", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer late.CloseNow()
	types, _ := readUntilCompetitor(t, ctx, late)
	if strings.Join(types, ",") != "status,feed_status,event_name,distance_meta,competitor_update" {
		t.Errorf("late joiner replay = %v", types)
	}
	if tb.hitCount("A") != 1 {
		t.Errorf("late joiner caused an extra upstream fetch")
	}
}

func TestRoomClosesWhenLastClientLeaves(t *testing.T) {
	tb := newTestBackend(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := tb.dial(t, ctx, "?competitionId=A", nil)
	if err != nil {
		t.Fatal(err)
	}
	readUntilCompetitor(t, ctx, conn)
	conn.Close(websocket.StatusNormalClosure, "")
	waitFor(t, "room to close after the grace period", func() bool { return tb.m.RoomCount() == 0 })

	// Rejoining starts a fresh room (and a fresh fetch).
	conn2, _, err := tb.dial(t, ctx, "?competitionId=A", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn2.CloseNow()
	readUntilCompetitor(t, ctx, conn2)
	if tb.hitCount("A") != 2 {
		t.Errorf("hits = %d, want 2", tb.hitCount("A"))
	}
}

func TestRejoinWithinGraceKeepsRoom(t *testing.T) {
	tb := newTestBackend(t, func(c *config.Config) { c.IdleGrace = time.Hour })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, _ := tb.dial(t, ctx, "?competitionId=A", nil)
	readUntilCompetitor(t, ctx, conn)
	conn.Close(websocket.StatusNormalClosure, "")
	waitFor(t, "client to leave", func() bool {
		r := tb.m.Room("A")
		return r != nil && r.ClientCount() == 0
	})
	conn2, _, _ := tb.dial(t, ctx, "?competitionId=A", nil)
	defer conn2.CloseNow()
	readUntilCompetitor(t, ctx, conn2)
	if tb.hitCount("A") != 1 {
		t.Errorf("rejoin within the grace period refetched: hits = %d", tb.hitCount("A"))
	}
}

func TestIdleClientIsPingedAndStaysConnected(t *testing.T) {
	tb := newTestBackend(t, func(c *config.Config) { c.PingInterval = 20 * time.Millisecond })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, _ := tb.dial(t, ctx, "?competitionId=A", nil)
	defer conn.CloseNow()
	readUntilCompetitor(t, ctx, conn)

	// Nothing more is sent, so the reads below only see pings (answered by the client library).
	// A server that gave up on the client would close the connection instead of letting the read time out.
	idle, stop := context.WithTimeout(ctx, 300*time.Millisecond)
	defer stop()
	var err error
	for err == nil {
		_, _, err = conn.Read(idle)
	}
	if idle.Err() == nil || websocket.CloseStatus(err) != -1 {
		t.Errorf("idle read ended early with %v, want it to run until the deadline with the connection intact", err)
	}
}

func TestRejectedCompetitionIDs(t *testing.T) {
	tb := newTestBackend(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	status := func(query string) int {
		_, code, err := tb.dial(t, ctx, query, nil)
		if err == nil {
			t.Fatalf("%q: expected the handshake to fail", query)
		}
		return code
	}
	for _, q := range []string{"", "?competitionId=", "?competitionId=a/b", "?competitionId=a%0d%0ab", "?competitionId=" + strings.Repeat("x", 65), "?competitionId=a.b"} {
		conn, _, err := tb.dial(t, ctx, q, nil)
		if err != nil {
			t.Fatalf("%q: %v", q, err)
		}
		_, _, err = conn.Read(ctx)
		if got := websocket.CloseStatus(err); got != websocket.StatusPolicyViolation {
			t.Errorf("%q: close status %d, want %d", q, got, websocket.StatusPolicyViolation)
		}
		conn.CloseNow()
	}

	// MaxCompetitions = 2: a third distinct competition is refused, existing ones still accept clients.
	for _, id := range []string{"A", "B"} {
		c, _, err := tb.dial(t, ctx, "?competitionId="+id, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer c.CloseNow()
	}
	if got := status("?competitionId=C"); got != http.StatusServiceUnavailable {
		t.Errorf("third competition: status %d, want 503", got)
	}
	c, _, err := tb.dial(t, ctx, "?competitionId=A", nil)
	if err != nil {
		t.Fatalf("existing competition refused: %v", err)
	}
	c.CloseNow()
	if tb.hitCount("C") != 0 {
		t.Errorf("rejected competition reached the upstream")
	}
}

func TestDefaultCompetitionID(t *testing.T) {
	tb := newTestBackend(t, func(c *config.Config) { c.DefaultCompetitionID = "dflt" })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := tb.dial(t, ctx, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if _, name := readUntilCompetitor(t, ctx, conn); name != "Event dflt" {
		t.Errorf("got %q", name)
	}
}

// readFeedStatus reads messages until a feed_status arrives and returns it.
func readFeedStatus(t *testing.T, ctx context.Context, conn *websocket.Conn) FeedStatus {
	t.Helper()
	for {
		_, b, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		var v struct {
			Type string
			Data FeedStatus
		}
		_ = json.Unmarshal(b, &v)
		if v.Type == "feed_status" {
			return v.Data
		}
	}
}

func TestFeedStatusTellsClientsWhenTheCompetitionIsNotLive(t *testing.T) {
	tb := newTestBackend(t, nil)
	tb.body = `{"success":false,"errorMessage":"Not live right now","name":"Event X","errorMode":2}`
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := tb.dial(t, ctx, "?competitionId=x", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.CloseNow() }()
	if got := readFeedStatus(t, ctx, conn); got.State != "not_live" || got.Message != "Not live right now" {
		t.Fatalf("got %+v", got)
	}
	// a client joining later is told straight away
	late, _, err := tb.dial(t, ctx, "?competitionId=x", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = late.CloseNow() }()
	if got := readFeedStatus(t, ctx, late); got.State != "not_live" {
		t.Fatalf("late client got %+v", got)
	}
}

func TestFeedStatusUnavailableHidesDetailsAndOkOnData(t *testing.T) {
	tb := newTestBackend(t, nil)
	tb.status = http.StatusBadGateway
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := tb.dial(t, ctx, "?competitionId=y", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.CloseNow() }()
	if got := readFeedStatus(t, ctx, conn); got.State != "unavailable" || got.Message != "" {
		t.Fatalf("got %+v", got)
	}

	tb2 := newTestBackend(t, nil)
	c2, _, err := tb2.dial(t, ctx, "?competitionId=z", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c2.CloseNow() }()
	if got := readFeedStatus(t, ctx, c2); got.State != "ok" {
		t.Fatalf("got %+v", got)
	}
}

func TestClosesRoomsOfEndedCompetitions(t *testing.T) {
	tb := newTestBackend(t, nil)
	var ended atomic.Bool
	tb.m.Ended = func(string) bool { return ended.Load() }
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := tb.dial(t, ctx, "?competitionId=A", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	readUntilCompetitor(t, ctx, conn)
	tb.m.CloseEnded()
	if tb.m.RoomCount() != 1 {
		t.Fatal("a competition that is not over keeps its room")
	}

	ended.Store(true)
	tb.m.CloseEnded()
	if tb.m.RoomCount() != 0 {
		t.Fatalf("rooms = %d, want the room closed", tb.m.RoomCount())
	}
	for { // the client is told, with the code the page reads as "no competition to follow"
		if _, _, err := conn.Read(ctx); err != nil {
			if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
				t.Fatalf("closed with %v, want a policy violation", err)
			}
			break
		}
	}

	conn2, _, err := tb.dial(t, ctx, "?competitionId=A", nil)
	if err == nil {
		defer conn2.CloseNow()
		if _, _, err = conn2.Read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
			t.Fatalf("rejoin after the end: %v, want a policy violation", err)
		}
	}
	if tb.m.RoomCount() != 0 {
		t.Fatal("an ended competition must not get a new room")
	}
}

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

	tb.m.CloseAll()
	if tb.m.RoomCount() != 0 {
		t.Fatalf("rooms = %d, want none", tb.m.RoomCount())
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
	tb := newTestBackend(t, func(c *config.Config) { c.DataSourceInterval = 0.02 })
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

	waitFor(t, "the idle room to close", func() bool { return tb.m.RoomCount() == 0 })
	hits := tb.hitCount("A")
	time.Sleep(150 * time.Millisecond)
	if got := tb.hitCount("A"); got != hits {
		t.Fatalf("closed room still polls: %d -> %d fetches", hits, got)
	}
	tb.m.CloseIdleConnections() // the upstream connections are kept alive for reuse, with a goroutine each
	tb.srv.CloseClientConnections()
	waitFor(t, "the goroutines to end", func() bool { return runtime.NumGoroutine() <= before+4 })
}

func TestRoomRefusesClientsBeyondItsLimit(t *testing.T) {
	tb := newTestBackend(t, func(c *config.Config) { c.MaxClientsPerRoom = 2 })
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
	waitFor(t, "a free place", func() bool { return tb.m.Room("A").ClientCount() < 2 })
	conn, _, err := tb.dial(t, ctx, "?competitionId=A", nil)
	if err != nil {
		t.Fatalf("a place was freed: %v", err)
	}
	conn.CloseNow()
}

func TestServerRefusesClientsBeyondItsTotal(t *testing.T) {
	tb := newTestBackend(t, func(c *config.Config) { c.MaxClients = 2 })
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
	waitFor(t, "a free place", func() bool { return tb.m.RoomCount() > 0 && tb.m.Room("A").ClientCount() == 0 })
	conn, _, err := tb.dial(t, ctx, "?competitionId=A", nil)
	if err != nil {
		t.Fatalf("a place was freed: %v", err)
	}
	conn.CloseNow()
}

func TestHealthcheckIsAnEmpty200(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthcheck", Healthcheck)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/healthcheck", nil))
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 {
		t.Fatalf("status %d body %q, want an empty 200", rec.Code, rec.Body.String())
	}
}

func TestFailingDataSourceIsAskedLessOften(t *testing.T) {
	tb := newTestBackend(t, func(c *config.Config) { c.DataSourceInterval = 0.05 })
	tb.mu.Lock()
	tb.status = http.StatusServiceUnavailable
	tb.mu.Unlock()
	conn, _, err := tb.dial(t, t.Context(), "?competitionId=slow", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.CloseNow() }()
	time.Sleep(2 * time.Second)
	// at the plain 50 ms interval this would be about 40 requests; doubling gives 0, 50, 100, 200, 400, 800 ms: about 6
	if hits := tb.hitCount("slow"); hits > 10 {
		t.Fatalf("%d requests in 2s to a failing data source, expected it to back off", hits)
	}
}

// FeedStatus mirrors the feed_status message.
type FeedStatus struct {
	State   string
	Message string
}

func TestConnectionAllowanceRollsOverThirtyDays(t *testing.T) {
	tb := newTestBackend(t, func(c *config.Config) { c.MaxClients30Days = 3 })
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	tb.m.Now = func() time.Time { return now }
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
	waitFor(t, "idle rooms to close", func() bool { return tb.m.RoomCount() == 0 })

	now = now.AddDate(0, 0, 20) // day 30 after the first two connections: they fall out of the window
	if err := connect("A"); err != nil {
		t.Fatalf("after the window passed the first two: %v", err)
	}
}

func TestClientAddressIsLimited(t *testing.T) {
	tb := newTestBackend(t, func(c *config.Config) {
		c.MaxClientsPerIP, c.ConnectsPerMinute, c.ConnectBurst = 2, 60, 10
		c.MaxClients30Days = 2
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var open []*websocket.Conn
	for range 2 {
		conn, _, err := tb.dial(t, ctx, "?competitionId=A", nil)
		if err != nil {
			t.Fatal(err)
		}
		open = append(open, conn)
	}
	_, status, err := tb.dial(t, ctx, "?competitionId=A", nil)
	if err == nil || status != http.StatusTooManyRequests {
		t.Fatalf("status %d, err %v; want 429 for a third open connection", status, err)
	}

	// the refusal did not use up the allowance of 2 connections, and a freed place can be used again
	if got := tb.m.Room("A").ClientCount(); got != 2 {
		t.Fatalf("clients = %d, want 2", got)
	}
	_ = open[0].Close(websocket.StatusNormalClosure, "")
	waitFor(t, "a place to free up", func() bool { return tb.m.Room("A").ClientCount() == 1 })
	if _, status, err := tb.dial(t, ctx, "?competitionId=A", nil); err == nil || status != http.StatusServiceUnavailable {
		t.Fatalf("status %d, err %v; want the connection allowance (503), not the address limit", status, err)
	}
}
