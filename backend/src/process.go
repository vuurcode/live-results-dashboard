package main

import (
	"encoding/json"
	"math"
	"regexp"
	"sort"
	"strconv"
)

// ── raw source data ───────────────────────────────────────────────────────────

type rawData struct {
	Success      *bool         `json:"success"` // false when the match is not live; absent in older payloads
	ErrorMessage string        `json:"errorMessage"`
	Name         string        `json:"name"`
	Distances    []rawDistance `json:"distances"`
}

type rawDistance struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	EventNumber float64   `json:"eventNumber"`
	IsLive      bool      `json:"isLive"`
	Races       []rawRace `json:"races"`
}

type rawRace struct {
	ID             string        `json:"id"`
	Heat           int           `json:"heat"`
	Lane           string        `json:"lane"`
	Competitor     rawCompetitor `json:"competitor"`
	Laps           []rawLap      `json:"laps"`
	PersonalRecord string        `json:"personalRecord"`
	InvalidReason  string        `json:"invalidReason"`
	Remark         string        `json:"remark"`
}

type rawCompetitor struct {
	Name        string     `json:"name"`
	StartNumber flexString `json:"startNumber"`
	Category    string     `json:"category"`
}

type rawLap struct {
	Time    string `json:"time"`
	LapTime string `json:"lapTime"`
}

// flexString accepts a JSON string or number (start numbers are strings today).
type flexString string

func (f *flexString) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		return nil
	}
	if len(b) > 0 && b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*f = flexString(s)
		return nil
	}
	var n json.Number
	if err := json.Unmarshal(b, &n); err != nil {
		return err
	}
	*f = flexString(n.String())
	return nil
}

// ── processed state (sent to the frontend) ────────────────────────────────────

type HeatGroup struct {
	Heat    int      `json:"heat"`
	RaceIDs []string `json:"race_ids"`
}

type DistanceMeta struct {
	ID             string      `json:"id"`
	Name           string      `json:"name"`
	EventNumber    float64     `json:"event_number"`
	IsLive         bool        `json:"is_live"`
	IsMassStart    bool        `json:"is_mass_start"`
	DistanceMeters *int        `json:"distance_meters"`
	TotalLaps      *int        `json:"total_laps"`
	AnyFinished    bool        `json:"any_finished"`
	HeatGroups     []HeatGroup `json:"heat_groups"`
}

type Competitor struct {
	StartNumber        string   `json:"start_number"`
	Name               string   `json:"name"`
	LapsCount          int      `json:"laps_count"`
	TotalTime          string   `json:"total_time"`
	ID                 string   `json:"id"`
	DistanceID         string   `json:"distance_id"`
	Category           *string  `json:"category"`
	Heat               int      `json:"heat"`
	Lane               string   `json:"lane"`
	FormattedTotalTime string   `json:"formatted_total_time"`
	LapTimes           []string `json:"lap_times"`
	PersonalRecord     *string  `json:"personal_record"`
	LapsRemaining      *int     `json:"laps_remaining"`
	FinishedRank       *int     `json:"finished_rank"`
	InvalidReason      *string  `json:"invalid_reason"`
	Remark             *string  `json:"remark"`
}

type processedDistance struct {
	meta        DistanceMeta
	competitors []Competitor // stable broadcast order: laps desc, time asc, no-time last
}

type processedData struct {
	name      string
	distances []processedDistance
}

var (
	lapsRe   = regexp.MustCompile(`(?i)(\d+)\s*(?:laps?|ronden?|rondes?)`)
	metersRe = regexp.MustCompile(`(?i)(\d+)\s*(?:m\b|meter)`)
)

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func extractInt(re *regexp.Regexp, s string) *int {
	m := re.FindStringSubmatch(s)
	if m == nil {
		return nil
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return nil
	}
	return &n
}

// process turns raw source data into fully computed dashboard state.
func process(raw *rawData) *processedData {
	out := &processedData{name: raw.Name}

	for _, dist := range raw.Distances {
		races := dist.Races

		heats := make(map[int]struct{})
		for _, r := range races {
			heats[r.Heat] = struct{}{}
		}
		isMassStart := len(races) > 2 && len(heats) == 1

		var totalLaps, distanceMeters *int
		if isMassStart {
			totalLaps = extractInt(lapsRe, dist.Name)
		} else {
			distanceMeters = extractInt(metersRe, dist.Name)
		}

		type sortable struct {
			comp Competitor
			secs float64
		}
		processed := make([]sortable, 0, len(races))
		for _, race := range races {
			laps := race.Laps
			if isMassStart && len(laps) > 0 {
				laps = laps[1:] // omit warmup
			}

			totalTime, formattedTotal := "", ""
			if len(laps) > 0 {
				best, bestSecs := 0, parseSeconds(laps[0].Time)
				for i := 1; i < len(laps); i++ {
					if s := parseSeconds(laps[i].Time); s > bestSecs {
						best, bestSecs = i, s
					}
				}
				totalTime = laps[best].Time
				formattedTotal = formatTime(totalTime)
			}

			lane := "black"
			if !isMassStart && race.Lane != "" {
				lane = race.Lane
			}

			lapTimes := make([]string, len(laps))
			for i, lap := range laps {
				lapTimes[i] = formatTime(lap.LapTime)
			}

			var personalRecord *string
			if race.PersonalRecord != "" {
				pr := formatTime(race.PersonalRecord)
				personalRecord = &pr
			}

			secs := math.Inf(1)
			if totalTime != "" {
				secs = parseSeconds(totalTime)
			}

			processed = append(processed, sortable{
				comp: Competitor{
					StartNumber:        string(race.Competitor.StartNumber),
					Name:               race.Competitor.Name,
					LapsCount:          len(laps),
					TotalTime:          totalTime,
					ID:                 race.ID,
					DistanceID:         dist.ID,
					Category:           strPtr(race.Competitor.Category),
					Heat:               race.Heat,
					Lane:               lane,
					FormattedTotalTime: formattedTotal,
					LapTimes:           lapTimes,
					PersonalRecord:     personalRecord,
					InvalidReason:      strPtr(race.InvalidReason),
					Remark:             strPtr(race.Remark),
				},
				secs: secs,
			})
		}

		// Stable ordering for the broadcast sequence only; the frontend computes positions itself.
		sort.SliceStable(processed, func(i, j int) bool {
			a, b := processed[i], processed[j]
			if a.comp.LapsCount != b.comp.LapsCount {
				return a.comp.LapsCount > b.comp.LapsCount
			}
			return a.secs < b.secs
		})

		comps := make([]Competitor, len(processed))
		for i := range processed {
			comps[i] = processed[i].comp
		}

		anyFinished := false
		if isMassStart && totalLaps != nil && *totalLaps != 0 {
			rank := 1
			for i := range comps {
				remaining := max(0, *totalLaps-comps[i].LapsCount)
				comps[i].LapsRemaining = &remaining
				if remaining == 0 {
					r := rank
					comps[i].FinishedRank = &r
					rank++
					anyFinished = true
				}
			}
		}

		heatGroups := []HeatGroup{}
		if !isMassStart {
			byHeat := make(map[int][]string)
			for _, c := range comps {
				byHeat[c.Heat] = append(byHeat[c.Heat], c.ID)
			}
			keys := make([]int, 0, len(byHeat))
			for h := range byHeat {
				keys = append(keys, h)
			}
			sort.Ints(keys)
			for _, h := range keys {
				heatGroups = append(heatGroups, HeatGroup{Heat: h, RaceIDs: byHeat[h]})
			}
		}

		out.distances = append(out.distances, processedDistance{
			meta: DistanceMeta{
				ID:             dist.ID,
				Name:           dist.Name,
				EventNumber:    dist.EventNumber,
				IsLive:         dist.IsLive,
				IsMassStart:    isMassStart,
				DistanceMeters: distanceMeters,
				TotalLaps:      totalLaps,
				AnyFinished:    anyFinished,
				HeatGroups:     heatGroups,
			},
			competitors: comps,
		})
	}
	return out
}
