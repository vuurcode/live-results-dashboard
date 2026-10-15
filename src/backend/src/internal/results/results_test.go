package results

import (
	"encoding/json"
	"strings"
	"testing"
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
	raw := &RawData{Name: "Event", Distances: []rawDistance{{
		ID: "d1", Name: "Elimination 3 laps", Races: []rawRace{
			race("1", 1, lap("00:00:09.000", "00:00:09.000"), lap("00:00:19.000", "00:00:10.000"), lap("00:00:29.000", "00:00:10.000"), lap("00:00:39.000", "00:00:10.000")),
			race("2", 1, lap("00:00:09.500", "00:00:09.500"), lap("00:00:19.500", "00:00:10.000")),
			race("3", 1),
		},
	}}}
	p := Process(raw)
	d := p.Distances[0]
	if !d.Meta.IsMassStart || d.Meta.TotalLaps == nil || *d.Meta.TotalLaps != 3 || !d.Meta.AnyFinished {
		t.Fatalf("unexpected meta: %+v", d.Meta)
	}
	if d.Meta.HeatGroups == nil || len(d.Meta.HeatGroups) != 0 {
		t.Errorf("mass start heat_groups must be an empty list, got %#v", d.Meta.HeatGroups)
	}
	ids := []string{d.Competitors[0].ID, d.Competitors[1].ID, d.Competitors[2].ID}
	if strings.Join(ids, ",") != "1,2,3" {
		t.Errorf("order = %v, want 1,2,3 (laps desc, no-time last)", ids)
	}
	first := d.Competitors[0]
	if first.LapsCount != 3 || first.FinishedRank == nil || *first.FinishedRank != 1 || *first.LapsRemaining != 0 {
		t.Errorf("leader wrong: %+v", first)
	}
	if first.Lane != "black" || first.TotalTime != "00:00:39.000" || first.FormattedTotalTime != "39.000" {
		t.Errorf("leader time/lane wrong: %+v", first)
	}
	if rem := d.Competitors[1].LapsRemaining; rem == nil || *rem != 2 || d.Competitors[1].FinishedRank != nil {
		t.Errorf("second place wrong: %+v", d.Competitors[1])
	}
}

func TestProcessIndividualHeats(t *testing.T) {
	a, b := race("1", 2, lap("00:00:20.000", "00:00:20.000")), race("2", 1)
	a.Lane, a.InvalidReason, a.PersonalRecord = "white", "DQ", "00:00:19.123456"
	raw := &RawData{Distances: []rawDistance{{ID: "d1", Name: "500 meter", EventNumber: 2, Races: []rawRace{a, b}}}}
	d := Process(raw).Distances[0]
	if d.Meta.IsMassStart || d.Meta.DistanceMeters == nil || *d.Meta.DistanceMeters != 500 {
		t.Fatalf("unexpected meta: %+v", d.Meta)
	}
	if len(d.Meta.HeatGroups) != 2 || d.Meta.HeatGroups[0].Heat != 1 {
		t.Errorf("heat groups not sorted by heat: %+v", d.Meta.HeatGroups)
	}
	c := d.Competitors[0]
	if c.Lane != "white" || c.InvalidReason == nil || *c.InvalidReason != "DQ" || c.PersonalRecord == nil || *c.PersonalRecord != "19.123" {
		t.Errorf("competitor wrong: %+v", c)
	}
	if d.Competitors[1].Lane != "black" || d.Competitors[1].Remark != nil {
		t.Errorf("empty lane/remark handling wrong: %+v", d.Competitors[1])
	}
}

func TestTimesOfRacesThatMustNotShowThemAreNotSent(t *testing.T) {
	for _, code := range []string{"DNS", "DQ", "WDR", "dq"} {
		for _, inInvalid := range []bool{true, false} {
			r := race("1", 1, lap("00:00:10.000", "00:00:10.000"), lap("00:00:20.000", "00:00:10.000"))
			if inInvalid {
				r.InvalidReason = code
			} else {
				r.Remark = "PR " + code
			}
			raw := &RawData{Distances: []rawDistance{{ID: "d1", Name: "1000 meter", Races: []rawRace{r, race("2", 1)}}}}
			c := Process(raw).Distances[0].Competitors
			for _, comp := range c {
				if comp.ID == r.ID && (comp.LapsCount != 0 || len(comp.LapTimes) != 0 || comp.TotalTime != "" || comp.FormattedTotalTime != "") {
					t.Errorf("%s (invalid reason: %v): times were sent: %+v", code, inInvalid, comp)
				}
			}
		}
	}
	shown := race("1", 1, lap("00:00:10.000", "00:00:10.000"))
	shown.Remark = "DNF"
	if c := Process(&RawData{Distances: []rawDistance{{ID: "d1", Name: "1000 meter", Races: []rawRace{shown, race("2", 1)}}}}).Distances[0].Competitors[0]; c.LapsCount != 1 {
		t.Errorf("a did-not-finish keeps its times: %+v", c)
	}
}

func TestStartNumberAcceptsNumbers(t *testing.T) {
	var r rawRace
	if err := json.Unmarshal([]byte(`{"competitor":{"startNumber":12}}`), &r); err != nil || r.Competitor.StartNumber != "12" {
		t.Fatalf("got %q, err %v", r.Competitor.StartNumber, err)
	}
}

func TestProcessReadsTheDistanceOfAPairedEventFromItsFirstNumber(t *testing.T) {
	for name, want := range map[string]int{"500 meter - omloop 1": 500, "500 bij 1000 meter": 500, "1500 meter": 1500, "100m": 100} {
		raw := &RawData{Distances: []rawDistance{{ID: "d1", Name: name, Races: []rawRace{race("1", 1), race("2", 1)}}}}
		got := Process(raw).Distances[0].Meta.DistanceMeters
		if got == nil || *got != want {
			t.Errorf("%q: distance %v, want %d", name, got, want)
		}
	}
}
