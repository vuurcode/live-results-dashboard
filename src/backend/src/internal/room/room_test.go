package room

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/vuurcode/live-results-experiment/backend/internal/config"
	"github.com/vuurcode/live-results-experiment/backend/internal/results"
)

var testPace = config.Intervals{NotStarted: 15, MassStart: 1, Distance: 5}

func processed(laps int) *results.Processed {
	c := results.Competitor{ID: "1", Name: "C1", DistanceID: "d1", LapsCount: laps}
	if laps > 0 {
		c.TotalTime = "00:00:10.000"
	}
	return &results.Processed{Name: "E", Distances: []results.Distance{{Meta: results.DistanceMeta{ID: "d1", Name: "500 meter"}, Competitors: []results.Competitor{c}}}}
}

func next(t *testing.T, c *Client) (typ string, seq uint64, data json.RawMessage) {
	t.Helper()
	var v struct {
		Type string
		Seq  uint64
		Data json.RawMessage
	}
	if err := json.Unmarshal(<-c.Send, &v); err != nil {
		t.Fatal(err)
	}
	return v.Type, v.Seq, v.Data
}

func TestLiveMessagesCountOnFromTheReplay(t *testing.T) {
	r := New("A", "http://x", testPace, func() {})
	r.Apply(processed(0)) // event_name, distance_meta, competitor_update: seq 3

	c := r.Register(nil)
	typ, _, data := next(t, c)
	var status struct{ Seq uint64 }
	_ = json.Unmarshal(data, &status)
	if typ != "status" || status.Seq != 3 {
		t.Fatalf("got %s with seq %d, want status with seq %d", typ, status.Seq, 3)
	}
	for range 3 { // the replay is not numbered
		if _, seq, _ := next(t, c); seq != 0 {
			t.Fatalf("replay message carries seq %d", seq)
		}
	}

	r.Apply(processed(1))
	if typ, seq, _ := next(t, c); typ != "competitor_update" || seq != 4 {
		t.Fatalf("got %s seq %d, want competitor_update 4", typ, seq)
	}
	r.SetFeed("not_live", "")
	if typ, seq, _ := next(t, c); typ != "feed_status" || seq != 5 {
		t.Fatalf("got %s seq %d, want feed_status 5", typ, seq)
	}
}

// epochOf reads the room incarnation from a client's status message.
func epochOf(t *testing.T, c *Client) string {
	t.Helper()
	_, _, data := next(t, c)
	var status struct{ Epoch string }
	_ = json.Unmarshal(data, &status)
	return status.Epoch
}

func drain(c *Client) (types []string) {
	for {
		select {
		case m := <-c.Send:
			var v struct{ Type string }
			_ = json.Unmarshal(m, &v)
			types = append(types, v.Type)
		default:
			return
		}
	}
}

func TestReconnectingClientGetsOnlyWhatItMissed(t *testing.T) {
	r := New("A", "http://x", testPace, func() {})
	r.Apply(processed(0)) // seq 1-3
	epoch := epochOf(t, r.Register(nil))

	r.Apply(processed(1))     // seq 4
	r.SetFeed("not_live", "") // seq 5

	c := r.Register(&Resume{Epoch: epoch, Seq: 3})
	typ, _, data := next(t, c)
	var status struct{ Seq, Following uint64 }
	_ = json.Unmarshal(data, &status)
	if status.Following != 3 { // the missed competitor_update and feed_status, and the current feed_status
		t.Fatalf("status announces %d messages, want 3", status.Following)
	}
	if typ != "status" || status.Seq != 5 {
		t.Fatalf("got %s with seq %d, want status with seq 5", typ, status.Seq)
	}
	typ, seq, _ := next(t, c)
	if typ != "competitor_update" || seq != 4 {
		t.Fatalf("got %s seq %d, want competitor_update 4", typ, seq)
	}
	typ, seq, _ = next(t, c)
	if typ != "feed_status" || seq != 5 {
		t.Fatalf("got %s seq %d, want feed_status 5", typ, seq)
	}
	if rest := drain(c); len(rest) != 1 || rest[0] != "feed_status" { // the current feed state, last
		t.Fatalf("rest = %v", rest)
	}

	r.Apply(processed(2))
	if typ, seq, _ := next(t, c); typ != "competitor_update" || seq != 6 {
		t.Fatalf("live message after the catch-up: %s seq %d", typ, seq)
	}
}

func TestUpToDateClientGetsNoReplay(t *testing.T) {
	r := New("A", "http://x", testPace, func() {})
	r.Apply(processed(0))
	epoch := epochOf(t, r.Register(nil))
	c := r.Register(&Resume{Epoch: epoch, Seq: 3})
	if got := drain(c); len(got) != 1 || got[0] != "status" {
		t.Fatalf("got %v, want only status", got)
	}
}

func TestClientThatCannotBeCaughtUpGetsTheReplay(t *testing.T) {
	r := New("A", "http://x", testPace, func() {})
	r.Apply(processed(0))
	epoch := epochOf(t, r.Register(nil))
	r.Apply(processed(1))

	full := "status,event_name,distance_meta,competitor_update"
	for name, from := range map[string]*Resume{
		"other incarnation": {Epoch: "other", Seq: 3},
		"ahead of the room": {Epoch: epoch, Seq: 99},
	} {
		if got := strings.Join(drain(r.Register(from)), ","); got != full {
			t.Errorf("%s: got %s, want %s", name, got, full)
		}
	}

	r.log = r.log[2:] // the log starts after what the client needs
	if got := strings.Join(drain(r.Register(&Resume{Epoch: epoch, Seq: 1})), ","); got != full {
		t.Errorf("log too short: got %s, want %s", got, full)
	}
}

func TestLogKeepsTheLatestMessages(t *testing.T) {
	r := New("A", "http://x", testPace, func() {})
	for i := range maxLog + 10 {
		r.Apply(processed(i + 1))
	}
	for i := range 2 * maxLog { // far past the cap
		r.Apply(processed(maxLog + 11 + i))
	}
	if len(r.log) < maxLog || len(r.log) > 2*maxLog {
		t.Fatalf("log holds %d messages", len(r.log))
	}
}

func TestLogStartsAtAReset(t *testing.T) {
	r := New("A", "http://x", testPace, func() {})
	r.Apply(processed(3))
	epoch := epochOf(t, r.Register(nil))
	r.Apply(processed(0)) // fewer laps than before: the source restarted

	if got := strings.Join(drain(r.Register(&Resume{Epoch: epoch, Seq: 3})), ","); !strings.HasPrefix(got, "status,reset") {
		t.Errorf("a client from before the reset got %s, want a catch-up that starts with the reset", got)
	}
	if got := strings.Join(drain(r.Register(&Resume{Epoch: epoch, Seq: 2})), ","); strings.Contains(got, "reset") {
		t.Errorf("a client from before the reset's predecessor should get the replay, got %s", got)
	}
}

func TestIntervalFollowsTheLiveDistance(t *testing.T) {
	r := New("A", "http://x", testPace, func() {})
	want := func(seconds int) {
		t.Helper()
		d := time.Duration(seconds) * time.Second
		t.Helper()
		if got := r.Interval(); got != d {
			t.Fatalf("interval %v, want %v", got, d)
		}
	}
	want(15) // nothing fetched yet
	live := func(mass bool) *results.Processed {
		p := processed(0)
		p.Distances[0].Meta.IsLive, p.Distances[0].Meta.IsMassStart = true, mass
		return p
	}
	r.Apply(live(false))
	want(5)
	r.Apply(live(true))
	want(1)
	r.Apply(processed(1)) // no distance live any more
	want(15)
}

func TestIntervalDropsBackAfterTheLastRace(t *testing.T) {
	r := New("A", "http://x", testPace, func() {})
	p := processed(0) // 500 meter: two laps needed
	p.Distances[0].Meta.IsLive = true
	m := 500
	p.Distances[0].Meta.DistanceMeters = &m
	r.Apply(p)
	if got := r.Interval(); got != 5*time.Second {
		t.Fatalf("interval %v while racing, want 5s", got)
	}
	p = processed(2)
	p.Distances[0].Meta.IsLive, p.Distances[0].Meta.DistanceMeters = true, &m
	r.Apply(p)
	if got := r.Interval(); got != 15*time.Second {
		t.Fatalf("interval %v after the last race, want 15s", got)
	}
}
