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
	if len(matches) != 4 {
		t.Fatalf("matches = %d, want 4", len(matches))
	}
	venues := map[string]bool{}
	for _, m := range matches {
		venues[m.venue.code] = true
		if len(m.frames) < 8 {
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
	if len(venues) != 4 {
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
	for _, id := range []string{"mock-match-1", "mock-match-2", "mock-match-3", "mock-match-4"} {
		if !strings.Contains(body, id) {
			t.Errorf("matches %s lacks %s", body, id)
		}
	}
	_, body = do(t, "GET", ts.URL+"/api/venues")
	for _, code := range []string{`"MK1"`, `"MK2"`, `"MK3"`, `"MK4"`} {
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

// The match list needs competitions that are not live yet: the later matches answer "not live" for longer.
func TestLaterGeneratedMatchesStayNotLiveLonger(t *testing.T) {
	notLiveSteps := func(m *genMatch) int {
		n := 0
		for _, f := range m.frames {
			var doc genDoc
			if err := json.Unmarshal(f, &doc); err != nil {
				t.Fatal(err)
			}
			if doc.Success {
				break
			}
			n++
		}
		return n
	}
	ms := generatedMatches(maxGeneratedMatches)
	if a, b, c := notLiveSteps(ms[0]), notLiveSteps(ms[1]), notLiveSteps(ms[2]); a <= 0 || a >= b || b >= c {
		t.Fatalf("not-live steps %d, %d, %d: want them to grow per match", a, b, c)
	}
}

// In a mass start the lead changes hands a few times, and the field spreads out lap after lap until only a few
// skaters remain in the lead group.
func TestGeneratedMassStartChangesLeaderAndSpreadsTheField(t *testing.T) {
	for _, m := range generatedMatches(maxGeneratedMatches) {
		for di, d := range m.distances {
			if d.massLaps == 0 {
				continue
			}
			var doc genDoc
			if err := json.Unmarshal(m.frames[len(m.frames)-1], &doc); err != nil {
				t.Fatal(err)
			}
			races := doc.Distances[di].Races
			var leaders []string
			var firstSpread, lastSpread float64
			for lap := range d.massLaps {
				best, worst, name := -1, 0, ""
				for _, r := range races {
					ms := clockMillis(t, r.Laps[lap].Time)
					if best < 0 || ms < best {
						best, name = ms, r.Competitor.Name
					}
					worst = max(worst, ms)
				}
				if len(leaders) == 0 || leaders[len(leaders)-1] != name {
					leaders = append(leaders, name)
				}
				if lap == 1 {
					firstSpread = float64(worst-best) / 1000
				}
				lastSpread = float64(worst-best) / 1000
			}
			last := d.massLaps - 1
			bestEnd := -1
			for _, r := range races {
				if ms := clockMillis(t, r.Laps[last].Time); bestEnd < 0 || ms < bestEnd {
					bestEnd = ms
				}
			}
			var near int
			for _, r := range races {
				if clockMillis(t, r.Laps[last].Time)-bestEnd <= 10_000 {
					near++
				}
			}
			if near*10 < len(races)*7 {
				t.Errorf("%s %s: %d of %d skaters finish within 10 s of the leader, want most of them", m.id, d.name, near, len(races))
			}
			if len(leaders)-1 < 3 {
				t.Errorf("%s %s: the lead changed %d times, want at least 3", m.id, d.name, len(leaders)-1)
			}
			if lastSpread < 3*firstSpread {
				t.Errorf("%s %s: the field spread %.1f s after 2 laps and %.1f s at the end", m.id, d.name, firstSpread, lastSpread)
			}
		}
	}
}

// A mass start updates one skater at a time, as they pass the line, on the race clock: in real time, or scaled so that
// the leader takes the lap interval for the first lap.
func TestGeneratedMassStartUpdatesFollowTheRaceClock(t *testing.T) {
	s := &server{cfg: config{interval: time.Second, lapInterval: 10 * time.Second}, generated: map[string]*genMatch{}}
	for _, m := range generatedMatches(maxGeneratedMatches) {
		s.generated[m.id] = m
	}
	var updates int
	var first, longest time.Duration
	for _, sm := range mustSamples(t, s, "mock-match-4") {
		if sm.wait == 0 {
			continue
		}
		if updates == 0 {
			first = sm.wait
		}
		updates++
		longest = max(longest, sm.wait)
	}
	if updates != 20*16 {
		t.Errorf("%d updates, want one per skater per lap", updates)
	}
	if first < 9*time.Second || first > 11*time.Second {
		t.Errorf("the leader's first lap takes %v, want about 10 s", first)
	}
	if longest > 10*time.Second {
		t.Errorf("%v until the next update, want at most 10 s", longest)
	}
}

func TestGeneratedMassStartReplaysInRealTimeByDefault(t *testing.T) {
	s := &server{cfg: config{interval: time.Second}, generated: map[string]*genMatch{}}
	for _, m := range generatedMatches(maxGeneratedMatches) {
		s.generated[m.id] = m
	}
	var first, total time.Duration
	for _, sm := range mustSamples(t, s, "mock-match-4") {
		if sm.wait == 0 {
			continue
		}
		if total == 0 {
			first = sm.wait
		}
		total += sm.wait
	}
	if first < 25*time.Second || first > 35*time.Second {
		t.Errorf("the leader's first lap takes %v, want a real lap of about 30 s", first)
	}
	if total < 7*time.Minute {
		t.Errorf("the race takes %v, want 16 real laps", total)
	}
}

func TestGeneratedMassStartOpeningTheDayIsLiveFromTheFirstFrame(t *testing.T) {
	for _, m := range generatedMatches(maxGeneratedMatches) {
		if m.distances[0].massLaps == 0 {
			continue
		}
		var doc genDoc
		if err := json.Unmarshal(m.frames[m.notLiveFrames], &doc); err != nil {
			t.Fatal(err)
		}
		if !doc.Distances[0].IsLive {
			t.Errorf("%s: the mass start is not live in its first frame", m.id)
		}
	}
}

func mustSamples(t *testing.T, s *server, id string) []sample {
	t.Helper()
	out, err := s.samples(id)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// The demo match skates its long distances in heats of four and its sprints (100 and 500 meter) in pairs.
func TestDemoMatchHasHeatsOfFourExceptTheSprints(t *testing.T) {
	var doc genDoc
	if err := json.Unmarshal(generatedMatches(1)[0].frames[0], &doc); err != nil {
		t.Fatal(err)
	}
	want := map[string]int{"1000 meter": 4, "1500 meter": 4, "100 meter": 2, "500 meter": 2, "5000 meter": 4, "10000 meter": 4}
	for _, d := range doc.Distances {
		lanes := map[string]bool{}
		for _, r := range d.Races {
			lanes[r.Lane] = true
		}
		key := strings.SplitN(d.Name, " - ", 2)[0]
		if len(lanes) != want[key] {
			t.Errorf("%s has %d lanes, want %d", d.Name, len(lanes), want[key])
		}
	}
}

// The demo match has one or two personal records per distance and a single track record, in the 500 meter.
func TestDemoMatchHasFewPersonalRecordsAndOneTrackRecord(t *testing.T) {
	var doc genDoc
	frames := generatedMatches(1)[0].frames
	if err := json.Unmarshal(frames[len(frames)-1], &doc); err != nil {
		t.Fatal(err)
	}
	records := 0
	for _, d := range doc.Distances {
		pbs, faster := 0, 0
		for _, r := range d.Races {
			if r.Time != nil && *r.Time < r.PersonalRecord {
				faster++
			}
			if r.Remark == nil {
				continue
			}
			for _, code := range strings.Fields(*r.Remark) {
				switch code {
				case "PR":
					pbs++
				case "WR", "NR", "TR", "TRC":
					records++
					if !strings.HasPrefix(d.Name, "500 meter") {
						t.Errorf("%s has the record code %s", d.Name, code)
					}
				}
			}
		}
		if faster != pbs {
			t.Errorf("%s: %d skaters finish under their personal record but %d are marked", d.Name, faster, pbs)
		}
		if pbs < 1 || pbs > 2 {
			t.Errorf("%s has %d personal records, want 1 or 2", d.Name, pbs)
		}
	}
	if records == 0 || records > 2 {
		t.Errorf("%d record codes, want one record remark", records)
	}
}

// A frame that only announces the next heat or distance is replayed after a fraction of the sample interval,
// the laps after the whole interval.
func TestAnnouncingFramesAreReplayedSooner(t *testing.T) {
	m := generatedMatches(1)[0]
	s := &server{cfg: config{interval: 8 * time.Second}, generated: map[string]*genMatch{"m": m}}
	out, err := s.samples("m")
	if err != nil {
		t.Fatal(err)
	}
	short, full := 0, 0
	for i, smp := range out {
		switch {
		case m.massPass[i].short && smp.wait == 2*time.Second:
			short++
		case !m.massPass[i].short && smp.wait == 0:
			full++
		default:
			t.Fatalf("frame %d (short %v) waits %s", i, m.massPass[i].short, smp.wait)
		}
	}
	if short == 0 || full == 0 {
		t.Errorf("%d announcing and %d lap frames, want both", short, full)
	}
}
