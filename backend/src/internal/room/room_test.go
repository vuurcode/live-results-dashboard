package room

import (
	"encoding/json"
	"testing"

	"github.com/vuurcode/live-results-experiment/backend/internal/results"
)

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
	r := New("A", "http://x", 1, func() {})
	r.Apply(processed(0)) // event_name, distance_meta, competitor_update: seq 3

	c := r.Register()
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
