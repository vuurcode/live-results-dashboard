// Package room holds everything for one followed competition: its cached state and the clients receiving it.
package room

import (
	"log/slog"
	"sync"
	"time"

	"github.com/vuurcode/live-results-experiment/backend/internal/results"
	"github.com/vuurcode/live-results-experiment/backend/internal/store"
	"github.com/vuurcode/live-results-experiment/backend/internal/wire"
)

const queueSlack = 512 // headroom above the replay size before a client counts as too slow

// Client is one follower of a room; its messages arrive on Send, which is closed when the client is dropped.
type Client struct {
	Send chan []byte
}

// Room is everything for one competition: its cached state, the clients
// following it, and (via the manager) one polling loop shared by all of them.
//
// State updates and broadcasts happen under one lock, so a client that joins
// either sees a change in its replay or receives it live — never both, never neither.
type Room struct {
	ID  string
	Log *slog.Logger

	url      string
	interval float64 // seconds between upstream fetches, reported to clients

	Cancel   func()      // stops the polling loop
	IdleTime *time.Timer // set while the room is empty and waiting to be closed; guarded by the hub

	mu      sync.Mutex
	feed    *feedStatus // what the data source says about the competition; nil until the first answer
	st      *store.Store
	clients map[*Client]struct{}
	closed  *CloseInfo // why the room disconnected its clients; nil while it is open
}

// New creates an empty room for a competition fetched from url every interval seconds. cancel stops the polling loop.
func New(id, url string, interval float64, cancel func()) *Room {
	log := slog.With("competition", id)
	return &Room{
		ID: id, url: url, interval: interval, Cancel: cancel,
		Log:     log,
		st:      store.New(log),
		clients: map[*Client]struct{}{},
	}
}

// feedStatus tells clients why there may be no data: the data source says the competition is not live,
// or cannot be reached. The message is the data source's own text (not localised).
type feedStatus struct {
	State   string `json:"state"` // "ok", "not_live" or "unavailable"
	Message string `json:"message,omitempty"`
}

// SetFeed records the state of the data source and tells the clients when it changes.
func (r *Room) SetFeed(state, message string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	next := feedStatus{State: state, Message: message}
	if r.feed != nil && *r.feed == next {
		return
	}
	r.feed = &next
	r.Log.Info("Feed status", "state", state)
	r.broadcastLocked([][]byte{wire.Wrap("feed_status", wire.Marshal(next))})
}

// Apply diffs freshly processed data and broadcasts the changes.
func (r *Room) Apply(curr *results.Processed) {
	r.mu.Lock()
	defer r.mu.Unlock()

	res := r.st.Update(curr)
	if len(res.Messages) == 0 {
		return
	}
	r.broadcastLocked(res.Messages)
	// one summary line per update, however many competitors changed
	r.Log.Info("Update", "competitors", len(res.CompUpdates), "new_laps", res.NewLaps, "distances", res.DistUpdates, "reset", res.Reset)
}

func (r *Room) broadcastLocked(msgs [][]byte) {
	for c := range r.clients {
	send:
		for _, m := range msgs {
			select {
			case c.Send <- m:
			default:
				r.Log.Warn("Client too slow, dropping")
				r.dropLocked(c)
				break send
			}
		}
	}
}

func (r *Room) dropLocked(c *Client) {
	if _, ok := r.clients[c]; ok {
		delete(r.clients, c)
		close(c.Send)
	}
}

// Register adds a client whose queue is pre-loaded with the status message
// followed by a replay of the latest state.
func (r *Room) Register() *Client {
	r.mu.Lock()
	defer r.mu.Unlock()

	replay := r.st.Replay()
	c := &Client{Send: make(chan []byte, len(replay)+2+queueSlack)}
	c.Send <- wire.Wrap("status", wire.Marshal(map[string]any{
		"competition_id":       r.ID,
		"data_source_url":      r.url,
		"data_source_interval": r.interval,
	}))
	if r.feed != nil {
		c.Send <- wire.Wrap("feed_status", wire.Marshal(*r.feed))
	}
	for _, m := range replay {
		c.Send <- m
	}
	r.clients[c] = struct{}{}
	r.Log.Info("Client connected", "active", len(r.clients), "replayed", len(replay))
	return c
}

// Unregister removes a client.
func (r *Room) Unregister(c *Client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.dropLocked(c)
	r.Log.Info("Client disconnected", "active", len(r.clients))
}

// ClientCount is the number of clients following the room.
func (r *Room) ClientCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.clients)
}

// CloseInfo is the close frame sent to clients whose room ends. Code is a websocket status code.
type CloseInfo struct {
	Code   int
	Reason string
}

// End disconnects every client, telling them why. Pages treat the policy violation status (1008) as "nothing to follow here" and do
// not come back, so it is only for a competition that is over; other endings let them reconnect.
func (r *Room) End(code int, reason string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = &CloseInfo{code, reason}
	for c := range r.clients {
		r.dropLocked(c)
	}
}

// Closed is what End was given, or nil if the room has not been ended.
func (r *Room) Closed() *CloseInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.closed
}
