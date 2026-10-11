package main

import (
	"log/slog"
	"sync"
	"time"
)

const queueSlack = 512 // headroom above the replay size before a client counts as too slow

type client struct {
	send chan []byte
}

// room is everything for one competition: its cached state, the clients
// following it, and (via the manager) one polling loop shared by all of them.
//
// State updates and broadcasts happen under one lock, so a client that joins
// either sees a change in its replay or receives it live — never both, never neither.
type room struct {
	id  string
	url string
	cfg config
	log *slog.Logger

	cancel   func() // stops the polling loop
	idleTime *time.Timer

	mu      sync.Mutex
	feed    *feedStatus // what the data source says about the match; nil until the first answer
	st      *store
	clients map[*client]struct{}
	ended   bool // closed because the match is over
}

func newRoom(id, url string, cfg config, cancel func()) *room {
	log := slog.With("competition", id)
	return &room{
		id: id, url: url, cfg: cfg, cancel: cancel,
		log:     log,
		st:      newStore(log),
		clients: map[*client]struct{}{},
	}
}

// feedStatus tells clients why there may be no data: the data source says the match is not live,
// or cannot be reached. The message is the data source's own text (not localised).
type feedStatus struct {
	State   string `json:"state"` // "ok", "not_live" or "unavailable"
	Message string `json:"message,omitempty"`
}

// setFeed records the state of the data source and tells the clients when it changes.
func (r *room) setFeed(state, message string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	next := feedStatus{State: state, Message: message}
	if r.feed != nil && *r.feed == next {
		return
	}
	r.feed = &next
	r.log.Info("Feed status", "state", state)
	r.broadcastLocked([][]byte{wrap("feed_status", marshal(next))})
}

// apply diffs freshly processed data and broadcasts the changes.
func (r *room) apply(curr *processedData) {
	r.mu.Lock()
	defer r.mu.Unlock()

	res := r.st.update(curr)
	if len(res.messages) == 0 {
		return
	}
	r.broadcastLocked(res.messages)
	// one summary line per update, however many competitors changed
	r.log.Info("Update", "competitors", len(res.compUpdates), "new_laps", res.newLaps, "distances", res.distUpdates, "reset", res.reset)
}

func (r *room) broadcastLocked(msgs [][]byte) {
	for c := range r.clients {
	send:
		for _, m := range msgs {
			select {
			case c.send <- m:
			default:
				r.log.Warn("Client too slow, dropping")
				r.dropLocked(c)
				break send
			}
		}
	}
}

func (r *room) dropLocked(c *client) {
	if _, ok := r.clients[c]; ok {
		delete(r.clients, c)
		close(c.send)
	}
}

// register adds a client whose queue is pre-loaded with the status message
// followed by a replay of the latest state.
func (r *room) register() *client {
	r.mu.Lock()
	defer r.mu.Unlock()

	replay := r.st.replay()
	c := &client{send: make(chan []byte, len(replay)+2+queueSlack)}
	c.send <- wrap("status", marshal(map[string]any{
		"competition_id":       r.id,
		"data_source_url":      r.url,
		"data_source_interval": r.cfg.dataSourceInterval,
	}))
	if r.feed != nil {
		c.send <- wrap("feed_status", marshal(*r.feed))
	}
	for _, m := range replay {
		c.send <- m
	}
	r.clients[c] = struct{}{}
	r.log.Info("Client connected", "active", len(r.clients), "replayed", len(replay))
	return c
}

func (r *room) unregister(c *client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.dropLocked(c)
	r.log.Info("Client disconnected", "active", len(r.clients))
}

func (r *room) clientCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.clients)
}

// end disconnects every client because the match is over.
func (r *room) end() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ended = true
	for c := range r.clients {
		r.dropLocked(c)
	}
}

func (r *room) isEnded() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.ended
}
