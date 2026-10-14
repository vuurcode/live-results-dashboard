package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newGeneratedServer(t *testing.T, interval time.Duration) *httptest.Server {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	s := &server{cfg: config{baseDir: t.TempDir(), interval: interval, matches: maxGeneratedMatches}, ctx: ctx, replays: map[string]*replay{}}
	ts := httptest.NewServer(s.withGenerated().routes())
	t.Cleanup(ts.Close)
	return ts
}

func TestGeneratedMatchesHaveOwnVenuesAndLiveFrames(t *testing.T) {
	matches := generatedMatches(maxGeneratedMatches)
	if len(matches) != 3 {
		t.Fatalf("matches = %d, want 3", len(matches))
	}
	venues := map[string]bool{}
	for _, m := range matches {
		venues[m.venue.code] = true
		if len(m.frames) < 10 {
			t.Errorf("%s: only %d frames", m.id, len(m.frames))
		}
		for i, f := range m.frames {
			if !json.Valid(f) {
				t.Fatalf("%s frame %d is not valid JSON", m.id, i)
			}
		}
		var first, last genDoc
		_ = json.Unmarshal(m.frames[2], &first)
		_ = json.Unmarshal(m.frames[len(m.frames)-1], &last)
		for _, d := range first.Distances {
			for _, r := range d.Races {
				if r.Status != 0 || r.Rank != nil {
					t.Fatalf("%s: first frame already has progress", m.id)
				}
			}
		}
		for _, d := range last.Distances {
			if d.IsLive {
				t.Errorf("%s/%s still live in the last frame", m.id, d.Name)
			}
			seen := map[int]bool{}
			for _, r := range d.Races {
				if r.Status != 4 || r.Rank == nil || (len(r.Laps) == 0 && r.InvalidReason == "") {
					t.Fatalf("%s/%s: race not finished: %+v", m.id, d.Name, r)
				}
				seen[*r.Rank] = true
			}
			if len(seen) != len(d.Races) {
				t.Errorf("%s/%s: ranks are not unique", m.id, d.Name)
			}
		}
	}
	if len(venues) != 3 {
		t.Errorf("venues = %v, want one per match", venues)
	}
}

func TestGeneratedMatchesAreDeterministic(t *testing.T) {
	a, b := generatedMatches(maxGeneratedMatches), generatedMatches(maxGeneratedMatches)
	for i := range a {
		if len(a[i].frames) != len(b[i].frames) || string(a[i].frames[len(a[i].frames)-1]) != string(b[i].frames[len(b[i].frames)-1]) {
			t.Fatalf("%s differs between runs", a[i].id)
		}
	}
}

func TestGeneratedServedOnBothAPIs(t *testing.T) {
	ts := newGeneratedServer(t, 20*time.Millisecond)

	_, body := do(t, "GET", ts.URL+"/api/matches")
	for _, id := range []string{"mock-match-1", "mock-match-2", "mock-match-3"} {
		if !strings.Contains(body, id) {
			t.Errorf("matches %s lacks %s", body, id)
		}
	}
	_, body = do(t, "GET", ts.URL+"/api/venues")
	for _, code := range []string{`"MK1"`, `"MK2"`, `"MK3"`} {
		if !strings.Contains(body, code) {
			t.Errorf("venues lack %s", code)
		}
	}
	_, body = do(t, "GET", ts.URL+"/api/competitions")
	if !strings.Contains(body, `"id":"mock-match-2"`) || !strings.Contains(body, `"venue":{"code":"MK2"}`) {
		t.Errorf("competitions lack the generated match: %s", body)
	}

	code, first := do(t, "GET", ts.URL+"/Competition?competitionId=mock-match-1")
	if code != 200 || !strings.Contains(first, `"success":false`) {
		t.Fatalf("got %d %s, want the not-live answer first", code, first)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		_, now := do(t, "GET", ts.URL+"/Competition?competitionId=mock-match-1")
		if now != first {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("generated live data never advanced")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// The quirks seen in the recorded feeds: errors before the competition is live, a heat reset while running,
// a future heat reporting laps, a finished heat flickering back to not started, skaters who do not start or
// drop out (DNS, DNF, WDR, DQ), a race briefly vanishing, a skater swapped within a race, a corrected time and the assorted remarks.
func TestGeneratedMatchesContainTrackTimingQuirks(t *testing.T) {
	counts := map[string]int{}
	for _, m := range generatedMatches(maxGeneratedMatches) {
		var prev genDoc
		for _, f := range m.frames {
			var doc genDoc
			if err := json.Unmarshal(f, &doc); err != nil {
				t.Fatal(err)
			}
			if !doc.Success {
				counts["error"]++
				continue
			}
			for di, d := range doc.Distances {
				if len(prev.Distances) > 0 && len(prev.Distances[di].Races) != len(d.Races) {
					counts["vanish"]++
				}
				running := 1 << 30
				for _, r := range d.Races {
					if r.Status != 4 && r.Heat < running {
						running = r.Heat
					}
				}
				for ri, r := range d.Races {
					if r.Status == 0 && len(r.Laps) > 0 && r.Heat > running {
						counts["stray"]++
					}
					if r.InvalidReason != "" {
						counts[r.InvalidReason]++
					}
					if r.Remark != nil {
						counts["remark "+*r.Remark]++
					}
					if len(prev.Distances) > 0 && len(prev.Distances[di].Races) == len(d.Races) {
						p := prev.Distances[di].Races[ri]
						if p.ID == r.ID && p.Competitor.ID != r.Competitor.ID {
							counts["swap"]++
						}
						if p.Status == 4 && r.Status == 4 && *p.Time != *r.Time {
							counts["retime"]++
						}
						if len(r.Laps) < len(p.Laps) && r.Status == 0 && p.Status == 0 {
							counts["reset"]++
						}
						if p.Status == 4 && r.Status == 0 && len(r.Laps) == len(p.Laps) {
							counts["flicker"]++
						}
					}
				}
			}
			prev = doc
		}
	}
	for _, k := range []string{"error", "stray", "DNS", "DNF", "WDR", "DQ", "reset", "flicker", "vanish", "swap", "retime", "remark PR", "remark FL", "remark MT", "remark TRC", "remark NR TR", "remark TR TRC PR"} {
		if counts[k] == 0 {
			t.Errorf("no %s quirk in the generated frames: %v", k, counts)
		}
	}
}

func TestGeneratedMatchCountIsConfigurable(t *testing.T) {
	t.Setenv("MOCKSERVER_DATA_GENERATED_MATCHES", "1")
	cfg := loadConfig()
	s := (&server{cfg: cfg, replays: map[string]*replay{}}).withGenerated()
	if len(s.genOrder) != 1 || s.genOrder[0].id != "mock-match-1" {
		t.Fatalf("want only mock-match-1, got %d matches", len(s.genOrder))
	}
	t.Setenv("MOCKSERVER_DATA_GENERATED_MATCHES", "9")
	if got := loadConfig().matches; got != maxGeneratedMatches {
		t.Errorf("an out of range count is ignored: %d", got)
	}
}

// clockMillis reads a feed time (hh:mm:ss.fffffff) as whole milliseconds.
func clockMillis(t *testing.T, s string) int {
	t.Helper()
	var h, m, sec, ms int
	if _, err := fmt.Sscanf(s, "%d:%d:%d.%03d", &h, &m, &sec, &ms); err != nil {
		t.Fatalf("time %q: %v", s, err)
	}
	return ((h*60+m)*60+sec)*1000 + ms
}

func TestGeneratedFinishedRacesHaveEveryLapAddingUpToTheTotal(t *testing.T) {
	for _, m := range generatedMatches(maxGeneratedMatches) {
		for fi, f := range m.frames {
			var doc genDoc
			if err := json.Unmarshal(f, &doc); err != nil {
				t.Fatal(err)
			}
			for di, d := range doc.Distances {
				meters := m.distances[di].meters
				for _, r := range d.Races {
					if r.Status != 4 || r.InvalidReason != "" || r.Time == nil || *r.Time == "00:00:00" {
						continue
					}
					if m.distances[di].massLaps == 0 && len(r.Laps) != len(segmentLengths(meters)) {
						t.Fatalf("%s frame %d %s heat %d: %d laps for %dm", m.id, fi, d.Name, r.Heat, len(r.Laps), meters)
					}
					sum := 0
					for _, l := range r.Laps {
						sum += clockMillis(t, l.LapTime)
					}
					if total := clockMillis(t, *r.Time); sum != total || clockMillis(t, r.Laps[len(r.Laps)-1].Time) != total {
						t.Fatalf("%s frame %d %s heat %d: lap times add up to %d ms, total %d ms", m.id, fi, d.Name, r.Heat, sum, total)
					}
				}
			}
		}
	}
}
