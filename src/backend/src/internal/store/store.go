// Package store keeps the last state broadcast for one competition, diffs fresh data against it and replays it to
// clients that join.
package store

import (
	"bytes"
	"log/slog"

	"github.com/vuurcode/live-results-experiment/backend/internal/results"
	"github.com/vuurcode/live-results-experiment/backend/internal/wire"
)

type distEntry struct {
	data []byte
	msg  []byte
}

type compEntry struct {
	comp results.Competitor
	data []byte
	msg  []byte
}

// Store holds the last broadcast state per distance and race, diffs new data
// against it, and replays it to newly connected clients. Not safe for
// concurrent use; the hub serialises access.
type Store struct {
	eventName *string
	dists     map[string]distEntry
	comps     map[string]compEntry
	distOrder []string
	raceOrder []string
	log       *slog.Logger // carries the competition the store belongs to
}

func New(log *slog.Logger) *Store {
	s := &Store{log: log}
	s.clear()
	return s
}

func (s *Store) clear() {
	s.eventName = nil
	s.dists = map[string]distEntry{}
	s.comps = map[string]compEntry{}
	s.distOrder = nil
	s.raceOrder = nil
}

// Result is what an update changed.
type Result struct {
	Reset       bool
	NameChanged bool
	DistUpdates int
	NewLaps     int // laps completed since the previous update, over all changed competitors
	CompUpdates []results.Competitor
	Messages    [][]byte // in broadcast order: reset, event_name, distance_meta..., competitor_update...
}

// Update diffs curr against the cached state, updates the cache, and returns
// the messages to broadcast.
//
// A reset is detected when any competitor's lap count is lower than the cached
// value — laps never go backwards in a normal race.
func (s *Store) Update(curr *results.Processed) Result {
	var res Result

reset:
	for _, d := range curr.Distances {
		for _, c := range d.Competitors {
			if prev, ok := s.comps[c.ID]; ok && c.LapsCount < prev.comp.LapsCount && !results.HidesTimes(deref(c.InvalidReason), deref(c.Remark)) {
				s.log.Warn("Reset detected, clearing cache", "name", c.Name, "from", prev.comp.LapsCount, "to", c.LapsCount)
				res.Reset = true
				break reset
			}
		}
	}
	if res.Reset {
		s.clear()
		res.Messages = append(res.Messages, wire.Wrap("reset", nil))
	}

	if s.eventName == nil || *s.eventName != curr.Name {
		name := curr.Name
		s.eventName = &name
		res.NameChanged = true
		res.Messages = append(res.Messages, wire.Wrap("event_name", wire.Marshal(map[string]string{"name": name})))
	}

	var compMessages [][]byte
	distOrder := make([]string, 0, len(curr.Distances))
	raceOrder := make([]string, 0, len(s.raceOrder))

	for _, d := range curr.Distances {
		distOrder = append(distOrder, d.Meta.ID)
		data := wire.Marshal(d.Meta)
		if prev, ok := s.dists[d.Meta.ID]; !ok || !bytes.Equal(prev.data, data) {
			entry := distEntry{data: data, msg: wire.Wrap("distance_meta", data)}
			s.dists[d.Meta.ID] = entry
			res.Messages = append(res.Messages, entry.msg)
			res.DistUpdates++
		}

		for _, c := range d.Competitors {
			data := wire.Marshal(c)
			prev, seen := s.comps[c.ID]
			if seen && bytes.Equal(prev.data, data) {
				raceOrder = append(raceOrder, c.ID) // unchanged — still tracked for replay
				continue
			}
			// Suppress no-time updates after the initial appearance (start list is always sent).
			if seen && c.TotalTime == "" && ptrEq(c.InvalidReason, prev.comp.InvalidReason) && ptrEq(c.Remark, prev.comp.Remark) {
				raceOrder = append(raceOrder, c.ID)
				continue
			}
			entry := compEntry{comp: c, data: data, msg: wire.Wrap("competitor_update", data)}
			res.NewLaps += c.LapsCount
			if seen {
				res.NewLaps -= prev.comp.LapsCount
			}
			s.comps[c.ID] = entry
			compMessages = append(compMessages, entry.msg)
			res.CompUpdates = append(res.CompUpdates, c)
			raceOrder = append(raceOrder, c.ID)
		}
	}

	s.distOrder = distOrder
	s.raceOrder = raceOrder
	res.Messages = append(res.Messages, compMessages...)
	return res
}

// Replay returns the latest state as messages: event_name, one distance_meta per
// distance, then every competitor_update including those without a total time.
func (s *Store) Replay() [][]byte {
	if s.eventName == nil {
		return nil
	}
	msgs := [][]byte{wire.Wrap("event_name", wire.Marshal(map[string]string{"name": *s.eventName}))}
	for _, id := range s.distOrder {
		if d, ok := s.dists[id]; ok {
			msgs = append(msgs, d.msg)
		}
	}
	for _, id := range s.raceOrder {
		if c, ok := s.comps[id]; ok {
			msgs = append(msgs, c.msg)
		}
	}
	return msgs
}

func ptrEq(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
