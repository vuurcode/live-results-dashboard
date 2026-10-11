package main

import (
	"bytes"
	"encoding/json"
	"log/slog"
)

// wrap builds a `{"type":...,"data":...}` WebSocket message around pre-encoded data.
func wrap(typ string, data []byte) []byte {
	var b bytes.Buffer
	b.WriteString(`{"type":`)
	t, _ := json.Marshal(typ)
	b.Write(t)
	if data != nil {
		b.WriteString(`,"data":`)
		b.Write(data)
	}
	b.WriteByte('}')
	return b.Bytes()
}

// marshal encodes v as JSON without HTML escaping.
func marshal(v any) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		panic(err) // only plain structs are encoded; cannot fail
	}
	return bytes.TrimRight(b.Bytes(), "\n")
}

type distEntry struct {
	data []byte
	msg  []byte
}

type compEntry struct {
	comp Competitor
	data []byte
	msg  []byte
}

// store holds the last broadcast state per distance and race, diffs new data
// against it, and replays it to newly connected clients. Not safe for
// concurrent use; the hub serialises access.
type store struct {
	eventName *string
	dists     map[string]distEntry
	comps     map[string]compEntry
	distOrder []string
	raceOrder []string
}

func newStore() *store {
	s := &store{}
	s.clear()
	return s
}

func (s *store) clear() {
	s.eventName = nil
	s.dists = map[string]distEntry{}
	s.comps = map[string]compEntry{}
	s.distOrder = nil
	s.raceOrder = nil
}

type diffResult struct {
	reset       bool
	nameChanged bool
	distUpdates int
	newLaps     int // laps completed since the previous update, over all changed competitors
	compUpdates []Competitor
	messages    [][]byte // in broadcast order: reset, event_name, distance_meta..., competitor_update...
}

// update diffs curr against the cached state, updates the cache, and returns
// the messages to broadcast.
//
// A reset is detected when any competitor's lap count is lower than the cached
// value — laps never go backwards in a normal race.
func (s *store) update(curr *processedData) diffResult {
	var res diffResult

reset:
	for _, d := range curr.distances {
		for _, c := range d.competitors {
			if prev, ok := s.comps[c.ID]; ok && c.LapsCount < prev.comp.LapsCount {
				slog.Warn("Reset detected, clearing cache", "name", c.Name, "from", prev.comp.LapsCount, "to", c.LapsCount)
				res.reset = true
				break reset
			}
		}
	}
	if res.reset {
		s.clear()
		res.messages = append(res.messages, wrap("reset", nil))
	}

	if s.eventName == nil || *s.eventName != curr.name {
		name := curr.name
		s.eventName = &name
		res.nameChanged = true
		res.messages = append(res.messages, wrap("event_name", marshal(map[string]string{"name": name})))
	}

	var compMessages [][]byte
	distOrder := make([]string, 0, len(curr.distances))
	raceOrder := make([]string, 0, len(s.raceOrder))

	for _, d := range curr.distances {
		distOrder = append(distOrder, d.meta.ID)
		data := marshal(d.meta)
		if prev, ok := s.dists[d.meta.ID]; !ok || !bytes.Equal(prev.data, data) {
			entry := distEntry{data: data, msg: wrap("distance_meta", data)}
			s.dists[d.meta.ID] = entry
			res.messages = append(res.messages, entry.msg)
			res.distUpdates++
		}

		for _, c := range d.competitors {
			data := marshal(c)
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
			entry := compEntry{comp: c, data: data, msg: wrap("competitor_update", data)}
			res.newLaps += c.LapsCount
			if seen {
				res.newLaps -= prev.comp.LapsCount
			}
			s.comps[c.ID] = entry
			compMessages = append(compMessages, entry.msg)
			res.compUpdates = append(res.compUpdates, c)
			raceOrder = append(raceOrder, c.ID)
		}
	}

	s.distOrder = distOrder
	s.raceOrder = raceOrder
	res.messages = append(res.messages, compMessages...)
	return res
}

// replay returns the latest state as messages: event_name, one distance_meta per
// distance, then every competitor_update including those without a total time.
func (s *store) replay() [][]byte {
	if s.eventName == nil {
		return nil
	}
	msgs := [][]byte{wrap("event_name", marshal(map[string]string{"name": *s.eventName}))}
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
