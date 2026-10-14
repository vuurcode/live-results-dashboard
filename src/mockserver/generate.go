package main

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand/v2"
	"sort"
)

// Generated competitions: each match has its own venue and a live results feed that unfolds heat by
// heat, one frame per lap. Names, categories and clubs follow the anonymized samples; nothing here
// refers to real people or clubs.

const lapLength = 400

var (
	generatedNames = []string{
		"Airborne Anna", "Alpine Arjen", "Blade Bas", "Blazing Bram", "Breezy Bella", "Clever Carla",
		"Crisp Cees", "Daring Daan", "Drifting Demi", "Eager Eva", "Electric Erik", "Endless Emma",
		"Fierce Femke", "Frosty Floris", "Gliding Gijs", "Grand Greta", "Gutsy Guus", "Hasty Hanna",
		"Humble Henk", "Hurtling Hugo", "Jaunty Jaap", "Jet Julia", "Jolly Joost", "Kicking Kim",
		"Kingly Koen", "Lean Lotte", "Lively Luuk", "Magnificent Maud", "Mellow Milo", "Nonstop Nina",
		"Northern Niels", "Onward Olivia", "Open Oscar", "Pacing Petra", "Plucky Pim", "Roaring Rik",
		"Rocket Roos", "Smooth Sanne", "Steady Sven", "Tough Tess", "Twisting Tom", "Velocity Vera",
		"Vigorous Victor", "Winter Wendy", "Wiry Wout",
	}
	generatedCategories = []string{"DA1", "DB1", "DB2", "DN1", "DN2", "DSA", "HA1", "HA2", "HB1", "HB2", "HN1", "HN2", "HSA", "H40", "D40"}
	generatedClubs      = []string{"CLF4", "SKS4", "FGI4", "SNO4", "SSK5", "IFX5", "FPD5", "IHK4", "BRU5", "NWD5", "PBR5", "WWO5", "GLC5"}
	// Seconds per meter, so a skater's time scales with the distance.
	generatedPace = map[int]float64{100: 0.100, 500: 0.080, 1000: 0.075, 1500: 0.078, 3000: 0.082, 5000: 0.086, 10000: 0.090}
	// A mass start is skated faster than a time trial over the same meters.
	massStartPace = 0.075
)

type genDistance struct {
	name     string
	meters   int
	skaters  int
	massLaps int // > 0: all skaters start together and skate this many laps

	// Track timing quirks the consumer must survive.
	resetHeat int  // > 0: this heat is reset after two laps and then skated again from the start
	strayLaps bool // a heat that has not started briefly reports a lap and a time
	flicker   bool // a finished heat briefly reports not started again, keeping its laps
	scratches bool // skaters with an invalid result (DNS, DNF, WDR, DQ), a replacement, and assorted remarks
	retime    bool // a finished result is corrected by a few hundredths
	inPlace   bool // a skater is swapped for another within the same race
	vanish    bool // a race of a later heat briefly disappears from the distance
}

type genMatch struct {
	id, name   string
	venue      genVenue
	distances  []genDistance
	frames     [][]byte
	firstNames int // offset into generatedNames, so the matches have different fields
}

type genVenue struct{ code, name, city string }

// maxGeneratedMatches is how many matches generatedMatches defines.
const maxGeneratedMatches = 3

// generatedMatches returns the first count generated matches.
func generatedMatches(count int) []*genMatch {
	matches := []*genMatch{
		{
			id: "mock-match-1", name: "PROD DEMO Mock Sprint Day", firstNames: 0,
			venue: genVenue{"MK1", "Mock Ice Rink One", "Mockville"},
			distances: []genDistance{
				{name: "100 meter", meters: 100, skaters: 8},
				{name: "500 meter", meters: 500, skaters: 8},
				{name: "1000 meter", meters: 1000, skaters: 8, resetHeat: 2, flicker: true, retime: true},
				{name: "5000 meter", meters: 5000, skaters: 8},
				{name: "10000 meter", meters: 10000, skaters: 8},
			},
		},
		{
			id: "mock-match-2", name: "Mock Distance Cup", firstNames: 12,
			venue: genVenue{"MK2", "Mock Ice Rink Two", "Mockdam"},
			distances: []genDistance{
				{name: "1500 meter", meters: 1500, skaters: 8, strayLaps: true, scratches: true, inPlace: true, vanish: true},
				{name: "3000 meter", meters: 3000, skaters: 6},
				{name: "Massastart 6 ronden", meters: 2400, skaters: 8, massLaps: 6},
			},
		},
		{
			id: "mock-match-3", name: "Mock Club Championship", firstNames: 24,
			venue: genVenue{"MK3", "Mock Ice Rink Three", "Mockburg"},
			distances: []genDistance{
				{name: "1000 meter", meters: 1000, skaters: 6},
				{name: "1500 meter", meters: 1500, skaters: 8, resetHeat: 1, strayLaps: true, flicker: true, retime: true, scratches: true, inPlace: true, vanish: true},
				{name: "3000 meter", meters: 3000, skaters: 4},
			},
		},
	}
	matches = matches[:count]
	for i, m := range matches {
		m.frames = m.generate(uint64(i + 1))
	}
	return matches
}

type genLap struct {
	Time    string `json:"time"`
	LapTime string `json:"lapTime"`
}

type genCompetitor struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	StartNumber string `json:"startNumber"`
	Category    string `json:"category"`
	Nationality string `json:"nationality"`
	ClubCode    string `json:"clubCode"`
}

type genRace struct {
	ID             string        `json:"id"`
	Competitor     genCompetitor `json:"competitor"`
	Heat           int           `json:"heat"`
	Lane           string        `json:"lane"`
	Points         *float64      `json:"points"`
	Rank           *int          `json:"rank"`
	Remark         *string       `json:"remark"`
	InvalidReason  string        `json:"invalidReason"`
	Status         int           `json:"status"`
	Time           *string       `json:"time"`
	PersonalRecord string        `json:"personalRecord"`
	Laps           []genLap      `json:"laps"`

	segments  []float64 // seconds per lap, not serialized
	prSeconds float64
}

type genDistanceDoc struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	EventNumber float64   `json:"eventNumber"`
	IsLive      bool      `json:"isLive"`
	Races       []genRace `json:"races"`
}

type genDoc struct {
	ID              *string          `json:"id"`
	Name            string           `json:"name"`
	IsInternational bool             `json:"isInternational"`
	Distances       []genDistanceDoc `json:"distances"`
	Success         bool             `json:"success"`
	ErrorMessage    *string          `json:"errorMessage"`
	ErrorMode       int              `json:"errorMode"`
	ResultURL       *string          `json:"resultUrl"`
}

// clock formats seconds the way the live results feed does: hh:mm:ss.fffffff.
func clock(sec float64) string {
	ms := int(math.Round(sec * 1000))
	return fmt.Sprintf("%02d:%02d:%02d.%03d0000", ms/3600000, ms/60000%60, ms/1000%60, ms%1000)
}

func uuid(rng *rand.Rand) string {
	return fmt.Sprintf("%08x-%04x-4%03x-8%03x-%012x", rng.Uint32(), rng.Uint32()&0xffff, rng.Uint32()&0xfff, rng.Uint32()&0xfff, rng.Uint64()&0xffffffffffff)
}

// segmentLengths splits a distance into laps; the first one takes the remainder (a 500 starts with 100 m).
func segmentLengths(meters int) []int {
	n := (meters + lapLength - 1) / lapLength
	segs := make([]int, n)
	for i := range segs {
		segs[i] = lapLength
	}
	segs[0] = meters - (n-1)*lapLength
	return segs
}

// generate builds the match's frames: one for the initial startlist, then per heat one frame when it
// starts and one per completed lap; the distance is marked no longer live in a frame of its own, so the last frame has every race finished.
func (m *genMatch) generate(seed uint64) [][]byte {
	rng := rand.New(rand.NewPCG(seed, 0x6d6f636b)) //nolint:gosec // deterministic mock data, not security-sensitive
	doc := genDoc{Name: m.name, Success: true}
	names := make([]string, 0, len(generatedNames))
	for i := range generatedNames {
		names = append(names, generatedNames[(m.firstNames+i)%len(generatedNames)])
	}

	for di, d := range m.distances {
		pace := generatedPace[d.meters]
		if d.massLaps > 0 {
			pace = massStartPace
		}
		segs := segmentLengths(d.meters)
		dd := genDistanceDoc{ID: uuid(rng), Name: d.name, EventNumber: float64(di + 1)}
		for si := range d.skaters {
			c := genCompetitor{
				ID: uuid(rng), Name: names[(di*3+si)%len(names)], StartNumber: fmt.Sprint(si + 1),
				Category: generatedCategories[rng.IntN(len(generatedCategories))], Nationality: "NED",
				ClubCode: generatedClubs[rng.IntN(len(generatedClubs))],
			}
			skill := 0.94 + rng.Float64()*0.12
			prSeconds := float64(d.meters) * pace * skill * (0.97 + rng.Float64()*0.06)
			r := genRace{
				ID: uuid(rng), Competitor: c, Heat: si/2 + 1, Lane: [2]string{"white", "red"}[si%2],
				PersonalRecord: clock(prSeconds),
				prSeconds:      prSeconds,
			}
			if d.massLaps > 0 {
				r.Heat = 1
				r.Lane = ""
			}
			zero := "00:00:00"
			r.Time = &zero
			for _, l := range segs {
				// whole milliseconds, so that the lap times add up to the total exactly as the feed prints them
				r.segments = append(r.segments, math.Round(float64(l)*pace*skill*(0.98+rng.Float64()*0.04)*1000)/1000)
			}
			dd.Races = append(dd.Races, r)
		}
		doc.Distances = append(doc.Distances, dd)
	}

	var frames [][]byte
	snapshot := func() {
		b, err := json.Marshal(doc)
		if err != nil {
			panic(err) // the document only holds plain values
		}
		frames = append(frames, b)
	}
	// Before the competition is live the feed answers with an error and no data.
	notLive, _ := json.Marshal(map[string]any{
		"id": nil, "name": nil, "isInternational": false, "distances": []any{}, "success": false,
		"errorMessage": "Deze wedstrijd is op (nog) niet live.", "errorMode": 0, "resultUrl": nil,
	})
	frames = append(frames, notLive, notLive)
	snapshot()

	for di := range doc.Distances {
		dd := &doc.Distances[di]
		dd.IsLive = true
		heats := map[int][]int{}
		var order []int
		for i, r := range dd.Races {
			if _, ok := heats[r.Heat]; !ok {
				order = append(order, r.Heat)
			}
			heats[r.Heat] = append(heats[r.Heat], i)
		}
		d := m.distances[di]
		if d.strayLaps && len(order) > 2 {
			strayLap(dd, heats[order[len(order)-1]], snapshot)
		}
		for n, h := range order {
			q := heatQuirks{
				flicker: d.flicker && n == 0, retime: d.retime && n == 0, inPlace: d.inPlace && n == 0,
				replaced: d.scratches && n == len(order)-1 && n > 2,
			}
			if d.scratches && (n == 1 || n == 2) && len(order) > n {
				q.invalid = [2]string{"DNS", "DNF"}
				if n == 2 {
					q.invalid = [2]string{"WDR", "DQ"}
				}
			}
			if h == d.resetHeat {
				q.resetAfter = 2
			}
			if d.vanish && n == 0 && len(order) > 2 {
				vanishRace(dd, heats[order[len(order)-1]], snapshot)
			}
			skate(dd, heats[h], q, rng, snapshot)
		}
		dd.IsLive = false
		snapshot()
	}
	return frames
}

// strayLap makes a heat that has not started report a lap and a time for one frame.
func strayLap(dd *genDistanceDoc, idx []int, snapshot func()) {
	r := &dd.Races[idx[0]]
	t := clock(r.segments[0])
	r.Laps = []genLap{{Time: t, LapTime: t}}
	r.Time = &t
	snapshot()
	clearRace(r)
	snapshot()
}

func clearRace(r *genRace) {
	zero := "00:00:00"
	r.Status, r.Rank, r.Laps, r.Time, r.InvalidReason, r.Remark = 0, nil, nil, &zero, "", nil
}

// heatQuirks are the track timing oddities applied to one heat.
type heatQuirks struct {
	resetAfter int       // > 0: reset to not started after this many laps, then skated again
	flicker    bool      // after finishing, briefly report not started again
	invalid    [2]string // reasons for the first skater (never starts) and the second (stops after a lap)
	replaced   bool      // second skater is replaced by another before the heat
	retime     bool      // first finisher's time is corrected after the finish
	inPlace    bool      // first skater is swapped for another within the same race
}

// skate runs one heat: a frame announces it, then every frame completes a lap, and the races finish together
// with the last lap. As in the live feed, a running race keeps status 0 and only gets its laps; the status
// becomes 4 on finish. A skater who does not start or drops out finishes with status 4 and an invalid reason.
func skate(dd *genDistanceDoc, idx []int, q heatQuirks, rng *rand.Rand, snapshot func()) {
	if q.replaced && len(idx) > 1 {
		r := &dd.Races[idx[1]]
		r.ID = uuid(rng)
		r.Competitor.ID = uuid(rng)
		r.Competitor.Name = generatedNames[rng.IntN(len(generatedNames))] + " Jr"
	}
	snapshot()
	if q.inPlace {
		r := &dd.Races[idx[0]]
		r.Competitor.ID = uuid(rng)
		r.Competitor.Name = generatedNames[rng.IntN(len(generatedNames))]
		snapshot()
	}
	laps := len(dd.Races[idx[0]].segments)
	for l := 0; l < laps; l++ {
		if q.resetAfter > 0 && l == q.resetAfter {
			for _, i := range idx {
				clearRace(&dd.Races[i])
			}
			snapshot()
			q.resetAfter = 0
			l = -1
			snapshot()
			continue
		}
		for n, i := range idx {
			r := &dd.Races[i]
			if r.Status == 4 {
				continue
			}
			if q.invalid[0] != "" && n < 2 && l >= n {
				r.Status = 4
				r.InvalidReason = q.invalid[n]
				continue
			}
			var total float64
			for _, s := range r.segments[:l+1] {
				total += s
			}
			r.Laps = append(r.Laps, genLap{Time: clock(total), LapTime: clock(r.segments[l])})
			if l == laps-1 {
				t := clock(total)
				r.Time = &t
				r.Status = 4
				r.Remark = remarkFor(total < r.prSeconds, rng)
			}
		}
		rank(dd)
		snapshot()
	}
	if q.retime {
		r := &dd.Races[idx[len(idx)-1]]
		if r.Status == 4 && r.InvalidReason == "" {
			last := len(r.segments) - 1
			r.segments[last] += 0.01
			var total float64
			for _, s := range r.segments {
				total += s
			}
			t := clock(total)
			r.Time = &t
			r.Laps[last] = genLap{Time: t, LapTime: clock(r.segments[last])}
			rank(dd)
			snapshot()
		}
	}
	if q.flicker {
		for _, i := range idx {
			dd.Races[i].Status, dd.Races[i].Rank = 0, nil
		}
		snapshot()
		for _, i := range idx {
			dd.Races[i].Status = 4
		}
		rank(dd)
		snapshot()
	}
}

// rank orders the finished races of a distance by time; skaters with an invalid result rank last.
func rank(dd *genDistanceDoc) {
	var done []int
	for i, r := range dd.Races {
		if r.Status == 4 {
			done = append(done, i)
		}
	}
	sort.SliceStable(done, func(a, b int) bool {
		ra, rb := dd.Races[done[a]], dd.Races[done[b]]
		if (ra.InvalidReason == "") != (rb.InvalidReason == "") {
			return ra.InvalidReason == ""
		}
		return *ra.Time < *rb.Time // fixed-width strings sort chronologically
	})
	for pos, i := range done {
		p := pos + 1
		dd.Races[i].Rank = &p
	}
}

// remarkFor picks the remark of a finished race: a personal record (sometimes also a track record), or one
// of the other remarks the feed uses, or none.
func remarkFor(personalRecord bool, rng *rand.Rand) *string {
	var r string
	if personalRecord {
		r = [3]string{"PR", "PR", "TR TRC PR"}[rng.IntN(3)]
	} else {
		r = []string{"", "", "FL", "MT", "TRC", "NR TR"}[rng.IntN(6)]
	}
	if r == "" {
		return nil
	}
	return &r
}

// vanishRace removes the last race of a heat from the distance for one frame.
func vanishRace(dd *genDistanceDoc, idx []int, snapshot func()) {
	at := idx[len(idx)-1]
	gone := dd.Races[at]
	dd.Races = append(dd.Races[:at:at], dd.Races[at+1:]...)
	snapshot()
	dd.Races = append(dd.Races[:at:at], append([]genRace{gone}, dd.Races[at:]...)...)
	snapshot()
}
