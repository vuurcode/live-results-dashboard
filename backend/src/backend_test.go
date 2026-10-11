package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestFormatTime(t *testing.T) {
	cases := map[string]string{
		"":                "",
		"00:00:05.123456": "5.123",
		"00:01:05.5":      "1:05.5",
		"0:00:00.000":     "0.000",
		"01:02:03.004":    "1:2:03.004", // inner parts are not re-padded (same as the Python original)
		"12.3456":         "12.345",
		"007":             "7",
	}
	for in, want := range cases {
		if got := formatTime(in); got != want {
			t.Errorf("formatTime(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseSeconds(t *testing.T) {
	cases := map[string]float64{"": 0, "5.5": 5.5, "1:05.5": 65.5, "1:01:05": 3665, "x": 0}
	for in, want := range cases {
		if got := parseSeconds(in); got != want {
			t.Errorf("parseSeconds(%q) = %v, want %v", in, got, want)
		}
	}
}

func lap(total, lapTime string) rawLap { return rawLap{Time: total, LapTime: lapTime} }

func race(id string, heat int, laps ...rawLap) rawRace {
	return rawRace{ID: id, Heat: heat, Competitor: rawCompetitor{Name: "C" + id, StartNumber: flexString(id)}, Laps: laps}
}

func TestProcessMassStart(t *testing.T) {
	raw := &rawData{Name: "Event", Distances: []rawDistance{{
		ID: "d1", Name: "Elimination 3 laps", Races: []rawRace{
			race("1", 1, lap("00:00:09.000", "00:00:09.000"), lap("00:00:19.000", "00:00:10.000"), lap("00:00:29.000", "00:00:10.000"), lap("00:00:39.000", "00:00:10.000")),
			race("2", 1, lap("00:00:09.500", "00:00:09.500"), lap("00:00:19.500", "00:00:10.000")),
			race("3", 1),
		},
	}}}
	p := process(raw)
	d := p.distances[0]
	if !d.meta.IsMassStart || d.meta.TotalLaps == nil || *d.meta.TotalLaps != 3 || !d.meta.AnyFinished {
		t.Fatalf("unexpected meta: %+v", d.meta)
	}
	if d.meta.HeatGroups == nil || len(d.meta.HeatGroups) != 0 {
		t.Errorf("mass start heat_groups must be an empty list, got %#v", d.meta.HeatGroups)
	}
	ids := []string{d.competitors[0].ID, d.competitors[1].ID, d.competitors[2].ID}
	if strings.Join(ids, ",") != "1,2,3" {
		t.Errorf("order = %v, want 1,2,3 (laps desc, no-time last)", ids)
	}
	first := d.competitors[0]
	if first.LapsCount != 3 || first.FinishedRank == nil || *first.FinishedRank != 1 || *first.LapsRemaining != 0 {
		t.Errorf("leader wrong: %+v", first)
	}
	if first.Lane != "black" || first.TotalTime != "00:00:39.000" || first.FormattedTotalTime != "39.000" {
		t.Errorf("leader time/lane wrong: %+v", first)
	}
	if rem := d.competitors[1].LapsRemaining; rem == nil || *rem != 2 || d.competitors[1].FinishedRank != nil {
		t.Errorf("second place wrong: %+v", d.competitors[1])
	}
}

func TestProcessTimedHeats(t *testing.T) {
	a, b := race("1", 2, lap("00:00:20.000", "00:00:20.000")), race("2", 1)
	a.Lane, a.InvalidReason, a.PersonalRecord = "white", "DQ", "00:00:19.123456"
	raw := &rawData{Distances: []rawDistance{{ID: "d1", Name: "500 meter", EventNumber: 2, Races: []rawRace{a, b}}}}
	d := process(raw).distances[0]
	if d.meta.IsMassStart || d.meta.DistanceMeters == nil || *d.meta.DistanceMeters != 500 {
		t.Fatalf("unexpected meta: %+v", d.meta)
	}
	if len(d.meta.HeatGroups) != 2 || d.meta.HeatGroups[0].Heat != 1 {
		t.Errorf("heat groups not sorted by heat: %+v", d.meta.HeatGroups)
	}
	c := d.competitors[0]
	if c.Lane != "white" || c.InvalidReason == nil || *c.InvalidReason != "DQ" || c.PersonalRecord == nil || *c.PersonalRecord != "19.123" {
		t.Errorf("competitor wrong: %+v", c)
	}
	if d.competitors[1].Lane != "black" || d.competitors[1].Remark != nil {
		t.Errorf("empty lane/remark handling wrong: %+v", d.competitors[1])
	}
}

func TestStartNumberAcceptsNumbers(t *testing.T) {
	var r rawRace
	if err := json.Unmarshal([]byte(`{"competitor":{"startNumber":12}}`), &r); err != nil || r.Competitor.StartNumber != "12" {
		t.Fatalf("got %q, err %v", r.Competitor.StartNumber, err)
	}
}

func snapshot(laps int, withTime bool) *processedData {
	r := race("1", 1)
	if withTime {
		for range laps {
			r.Laps = append(r.Laps, lap("00:00:10.000", "00:00:10.000"))
		}
	}
	return process(&rawData{Name: "E", Distances: []rawDistance{{ID: "d1", Name: "1000 meter", Races: []rawRace{r, race("2", 1)}}}})
}

func types(msgs [][]byte) string {
	var out []string
	for _, m := range msgs {
		var v struct{ Type string }
		_ = json.Unmarshal(m, &v)
		out = append(out, v.Type)
	}
	return strings.Join(out, ",")
}

func TestStoreDiff(t *testing.T) {
	s := newStore(slog.Default())

	res := s.update(snapshot(0, false))
	if got := types(res.messages); got != "event_name,distance_meta,competitor_update,competitor_update" {
		t.Fatalf("first update = %s (start list must be sent even without times)", got)
	}
	if res := s.update(snapshot(0, false)); len(res.messages) != 0 {
		t.Errorf("unchanged data produced %s", types(res.messages))
	}

	res = s.update(snapshot(1, true))
	if got := types(res.messages); got != "competitor_update" {
		t.Errorf("lap update = %s, want one competitor_update", got)
	}

	// Replay carries every competitor, with their latest state.
	replay := s.replay()
	if got := types(replay); got != "event_name,distance_meta,competitor_update,competitor_update" {
		t.Errorf("replay = %s", got)
	}
	if !strings.Contains(string(replay[2]), `"laps_count":1`) {
		t.Errorf("replay is stale: %s", replay[2])
	}

	// Laps going backwards means the source restarted.
	res = s.update(snapshot(0, false))
	if !res.reset || types(res.messages) != "reset,event_name,distance_meta,competitor_update,competitor_update" {
		t.Errorf("reset update = %v %s", res.reset, types(res.messages))
	}
}

func TestSuppressNoTimeUpdates(t *testing.T) {
	s := newStore(slog.Default())
	s.update(snapshot(0, false))
	changed := snapshot(0, false)
	changed.distances[0].competitors[0].Heat = 9 // changes, but still has no time
	if res := s.update(changed); len(res.compUpdates) != 0 {
		t.Errorf("no-time change was broadcast")
	}
	if got := len(s.replay()); got != 4 {
		t.Errorf("suppressed competitor dropped from replay: %d messages", got)
	}
}

func TestSanitizeUserAgent(t *testing.T) {
	if got := sanitizeUserAgent("Mozilla/5.0\r\nX-Evil: 1\x00"); got != "Mozilla/5.0X-Evil: 1" {
		t.Errorf("got %q", got)
	}
	if got := sanitizeUserAgent(strings.Repeat("a", 1000)); len(got) != maxUserAgentLength {
		t.Errorf("length %d", len(got))
	}
}

// testBackend runs a backend against a fake upstream that counts requests per competitionId.
type testBackend struct {
	m      *manager
	srv    *httptest.Server
	mu     sync.Mutex
	hits   map[string]int
	agents map[string]string
	body   string // when set, the upstream answers with this instead of the sample match
	status int    // when set, the upstream answers with this HTTP status
}

func newTestBackend(t *testing.T, mutate func(*config)) *testBackend {
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

	cfg := config{
		dataSourceURL: upstream.URL, dataSourceInterval: 3600, // one fetch per room: the test controls timing
		maxCompetitions: 2, idleGrace: 50 * time.Millisecond, pingInterval: time.Hour,
	}
	if mutate != nil {
		mutate(&cfg)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	ua := &userAgent{}
	tb.m = newManager(ctx, cfg, ua)
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", tb.m.serveWS)
	tb.srv = httptest.NewServer(ua.middleware(mux))
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
	if got := tb.m.roomCount(); got != 2 {
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
	waitFor(t, "room to close after the grace period", func() bool { return tb.m.roomCount() == 0 })

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
	tb := newTestBackend(t, func(c *config) { c.idleGrace = time.Hour })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, _ := tb.dial(t, ctx, "?competitionId=A", nil)
	readUntilCompetitor(t, ctx, conn)
	conn.Close(websocket.StatusNormalClosure, "")
	waitFor(t, "client to leave", func() bool {
		r := tb.m.rooms["A"]
		return r != nil && r.clientCount() == 0
	})
	conn2, _, _ := tb.dial(t, ctx, "?competitionId=A", nil)
	defer conn2.CloseNow()
	readUntilCompetitor(t, ctx, conn2)
	if tb.hitCount("A") != 1 {
		t.Errorf("rejoin within the grace period refetched: hits = %d", tb.hitCount("A"))
	}
}

func TestIdleClientIsPingedAndStaysConnected(t *testing.T) {
	tb := newTestBackend(t, func(c *config) { c.pingInterval = 20 * time.Millisecond })
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

	// maxCompetitions = 2: a third distinct competition is refused, existing ones still accept clients.
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
	tb := newTestBackend(t, func(c *config) { c.defaultCompetitionID = "dflt" })
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

func TestUpstreamURL(t *testing.T) {
	cases := []struct{ base, want string }{
		{"http://h/api/data", "http://h/api/data?competitionId=abc"},
		{"http://h/api/data?x=1", "http://h/api/data?competitionId=abc&x=1"},
		{"http://h", "http://h/?competitionId=abc"},
		{"http://h/", "http://h/?competitionId=abc"},
		{"http://h:8080?x=1", "http://h:8080/?competitionId=abc&x=1"},
		{"http://h/api/data/", "http://h/api/data/?competitionId=abc"},
	}
	for _, c := range cases {
		got, err := config{dataSourceURL: c.base}.upstreamURL("abc")
		if err != nil || got != c.want {
			t.Errorf("%s -> %q (%v), want %q", c.base, got, err, c.want)
		}
	}
}

func TestUserAgentFixedOverridesMirroring(t *testing.T) {
	mirror := &userAgent{}
	mirror.set("Browser/1.0")
	if got := mirror.get(); got != "Browser/1.0" {
		t.Errorf("mirrored = %q", got)
	}
	fixed := &userAgent{fixed: sanitizeUserAgent("MyDashboard/1.0\r\n")}
	fixed.set("Browser/1.0")
	if got := fixed.get(); got != "MyDashboard/1.0" {
		t.Errorf("fixed = %q, want MyDashboard/1.0", got)
	}
}

// readFeedStatus reads messages until a feed_status arrives and returns it.
func readFeedStatus(t *testing.T, ctx context.Context, conn *websocket.Conn) feedStatus {
	t.Helper()
	for {
		_, b, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		var v struct {
			Type string
			Data feedStatus
		}
		_ = json.Unmarshal(b, &v)
		if v.Type == "feed_status" {
			return v.Data
		}
	}
}

func TestFeedStatusTellsClientsWhenTheMatchIsNotLive(t *testing.T) {
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

func TestLiveResultsBaseURL(t *testing.T) {
	for _, tc := range []struct{ base, want string }{
		{"https://h.test", "https://h.test/Competition"},
		{"https://h.test/", "https://h.test/Competition"},
	} {
		t.Setenv("LIVE_RESULTS_BASE_URL", tc.base)
		if got := loadConfig().dataSourceURL; got != tc.want {
			t.Errorf("base=%q: got %q, want %q", tc.base, got, tc.want)
		}
	}
}
