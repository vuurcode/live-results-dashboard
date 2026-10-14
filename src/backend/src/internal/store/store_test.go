package store

import (
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/vuurcode/live-results-experiment/backend/internal/results"
)

// snapshot is a distance with two competitors; the first has the given number of laps when withTime is set.
func snapshot(laps int, withTime bool) *results.Processed {
	first := results.Competitor{ID: "1", Name: "C1", DistanceID: "d1", Heat: 1, Lane: "white"}
	if withTime {
		first.LapsCount = laps
		first.TotalTime = "00:00:10.000"
	}
	return &results.Processed{Name: "E", Distances: []results.Distance{{
		Meta:        results.DistanceMeta{ID: "d1", Name: "1000 meter"},
		Competitors: []results.Competitor{first, {ID: "2", Name: "C2", DistanceID: "d1", Heat: 1, Lane: "white"}},
	}}}
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

func TestSettingNoTimeStatusDoesNotResetTheCache(t *testing.T) {
	s := New(slog.Default())
	s.Update(snapshot(2, true))
	curr := snapshot(0, false)
	remark := "DQ"
	curr.Distances[0].Competitors[0].Remark = &remark
	res := s.Update(curr)
	if res.Reset {
		t.Error("a race that stops showing its times is not a reset")
	}
	if len(res.CompUpdates) != 1 || res.CompUpdates[0].LapsCount != 0 {
		t.Errorf("expected one update without laps, got %+v", res.CompUpdates)
	}
}

func TestStoreDiff(t *testing.T) {
	s := New(slog.Default())

	res := s.Update(snapshot(0, false))
	if got := types(res.Messages); got != "event_name,distance_meta,competitor_update,competitor_update" {
		t.Fatalf("first update = %s (start list must be sent even without times)", got)
	}
	if res := s.Update(snapshot(0, false)); len(res.Messages) != 0 {
		t.Errorf("unchanged data produced %s", types(res.Messages))
	}

	res = s.Update(snapshot(1, true))
	if got := types(res.Messages); got != "competitor_update" {
		t.Errorf("lap update = %s, want one competitor_update", got)
	}

	// Replay carries every competitor, with their latest state.
	replay := s.Replay()
	if got := types(replay); got != "event_name,distance_meta,competitor_update,competitor_update" {
		t.Errorf("replay = %s", got)
	}
	if !strings.Contains(string(replay[2]), `"laps_count":1`) {
		t.Errorf("replay is stale: %s", replay[2])
	}

	// Laps going backwards means the source restarted.
	res = s.Update(snapshot(0, false))
	if !res.Reset || types(res.Messages) != "reset,event_name,distance_meta,competitor_update,competitor_update" {
		t.Errorf("reset update = %v %s", res.Reset, types(res.Messages))
	}
}

func TestSuppressNoTimeUpdates(t *testing.T) {
	s := New(slog.Default())
	s.Update(snapshot(0, false))
	changed := snapshot(0, false)
	changed.Distances[0].Competitors[0].Heat = 9 // changes, but still has no time
	if res := s.Update(changed); len(res.CompUpdates) != 0 {
		t.Errorf("no-time change was broadcast")
	}
	if got := len(s.Replay()); got != 4 {
		t.Errorf("suppressed competitor dropped from replay: %d messages", got)
	}
}
