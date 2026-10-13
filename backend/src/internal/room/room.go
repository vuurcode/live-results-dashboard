// Package room holds everything for one followed competition: its cached state and the clients receiving it.
package room

import (
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/vuurcode/live-results-experiment/backend/internal/results"
	"github.com/vuurcode/live-results-experiment/backend/internal/store"
	"github.com/vuurcode/live-results-experiment/backend/internal/wire"
)

const queueSlack = 512 // headroom above the replay size before a client counts as too slow

// maxLog is how many of the latest live messages a room keeps for clients that reconnect: a whole competition has
// a few hundred updates, so this covers it, and a longer one only loses the oldest. The log is cut back to this
// once it has grown to twice as much, so that the copying is not done on every broadcast.
const maxLog = 2000

// Resume is where a reconnecting client left off: the room incarnation (Epoch from the status message) and the
// number of the last live message it processed.
type Resume struct {
	Epoch string
	Seq   uint64
}

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
	epoch   string      // identifies this incarnation of the room; the numbers of a room opened anew mean something else
	log     [][]byte    // the latest live messages, the last of them numbered seq, for clients that reconnect
	seq     uint64      // number of the last message broadcast; a client's replay is the state as of this number
	feed    *feedStatus // what the data source says about the competition; nil until the first answer
	st      *store.Store
	clients map[*Client]struct{}
	closed  *CloseInfo // why the room disconnected its clients; nil while it is open
}

// New creates an empty room for a competition fetched from url every interval seconds. cancel stops the polling loop.
func New(id, url string, interval float64, cancel func()) *Room {
	log := slog.With("competition", id)
	return &Room{
		epoch: strconv.FormatInt(time.Now().UnixNano(), 36),
		ID:    id, url: url, interval: interval, Cancel: cancel,
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
	if res.Reset { // what came before the reset is no use to a client that catches up
		clear(r.log)
		r.log = r.log[:0]
	}
	r.broadcastLocked(res.Messages)
	// one summary line per update, however many competitors changed
	r.Log.Info("Update", "competitors", len(res.CompUpdates), "new_laps", res.NewLaps, "distances", res.DistUpdates, "reset", res.Reset)
}

// broadcastLocked numbers the messages and sends them to every client. Replays carry no number: the status message
// tells a joining client which number its replay stands for, and the live messages that follow count on from it. The
// numbers start again at 0 when the room is opened anew.
func (r *Room) broadcastLocked(msgs [][]byte) {
	stamped := make([][]byte, len(msgs))
	for i, m := range msgs {
		r.seq++
		stamped[i] = wire.Stamp(m, r.seq)
		r.log = append(r.log, stamped[i])
	}
	if len(r.log) > 2*maxLog {
		n := copy(r.log, r.log[len(r.log)-maxLog:])
		clear(r.log[n:])
		r.log = r.log[:n]
	}
	msgs = stamped
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

// catchUpLocked returns the logged messages a client that stopped at from missed, and whether the log still holds
// all of them. A client of another incarnation, or one ahead of the room, cannot be caught up.
func (r *Room) catchUpLocked(from *Resume) ([][]byte, bool) {
	if from == nil || from.Epoch != r.epoch || from.Seq > r.seq {
		return nil, false
	}
	// the log is contiguous and ends at seq, so what the client missed is its tail
	missed := r.seq - from.Seq
	if missed > uint64(len(r.log)) {
		return nil, false
	}
	return r.log[len(r.log)-int(missed):], true
}

// Register adds a client whose queue is pre-loaded with the status message followed by the latest state: a replay,
// or, for a client that says where it left off (from) and can be brought up to date from the log, only what it
// missed, with the numbers the messages were sent under.
func (r *Room) Register(from *Resume) *Client {
	r.mu.Lock()
	defer r.mu.Unlock()

	replay, caughtUp := r.catchUpLocked(from)
	if !caughtUp {
		replay = r.st.Replay()
	}
	following := len(replay) // the messages after status that bring the client up to date, so it knows when it has them all
	if r.feed != nil {
		following++
	}
	c := &Client{Send: make(chan []byte, len(replay)+2+queueSlack)}
	c.Send <- wire.Wrap("status", wire.Marshal(map[string]any{
		"following":            following,
		"competition_id":       r.ID,
		"data_source_url":      r.url,
		"data_source_interval": r.interval,
		"seq":                  r.seq,
		"epoch":                r.epoch,
	}))
	// after a catch-up the current state wins over the older feed_status messages in it
	if caughtUp {
		for _, m := range replay {
			c.Send <- m
		}
	}
	if r.feed != nil {
		c.Send <- wire.Wrap("feed_status", wire.Marshal(*r.feed))
	}
	if !caughtUp {
		for _, m := range replay {
			c.Send <- m
		}
	}
	r.clients[c] = struct{}{}
	r.Log.Info("Client connected", "active", len(r.clients), "sent", len(replay), "caught_up", caughtUp)
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
