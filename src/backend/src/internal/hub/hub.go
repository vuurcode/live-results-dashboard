// Package hub owns one room per followed competition and decides which clients are let in.
package hub

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/vuurcode/live-results-experiment/backend/internal/catalog"
	"github.com/vuurcode/live-results-experiment/backend/internal/config"
	"github.com/vuurcode/live-results-experiment/backend/internal/fetch"
	"github.com/vuurcode/live-results-experiment/backend/internal/room"
	"github.com/vuurcode/live-results-experiment/backend/internal/source"
)

var (
	ErrBadCompetitionID = errors.New("invalid or missing competitionId")
	ErrTooManyRooms     = errors.New("too many competitions are being followed")
	ErrQuotaReached     = errors.New("the connection allowance for this period is used up")
	ErrServerFull       = errors.New("too many clients are connected")
	ErrRoomFull         = errors.New("too many clients are following this competition")
	ErrCompetitionEnded = errors.New("the competition is over")
)

// Hub owns one room per competition. A room is created when its first
// client arrives, polls the upstream exactly once per interval no matter how
// many clients follow it, and is torn down shortly after its last client leaves.
type Hub struct {
	cfg    config.Config
	set    *source.Set
	ua     fetch.UserAgent
	client *http.Client
	ctx    context.Context

	// Ended says whether a competition is over for good; nil means no competition ever is. Set it before the hub is used.
	Ended func(id string) bool

	// Now is the clock the connection allowance is counted by.
	Now func() time.Time

	mu    sync.Mutex
	rooms map[string]*room.Room

	// Connections accepted per UTC day over the last quotaDays days, kept in memory only.
	connsPerDay map[string]int
	quotaFull   bool // whether the last connection was refused for the quota, so that is logged once per period
}

// quotaDays is the length of the rolling window that MaxClients30Days applies to.
const quotaDays = 30

// New returns a hub whose rooms stop fetching when ctx ends.
func New(ctx context.Context, cfg config.Config, set *source.Set, ua fetch.UserAgent) *Hub {
	return &Hub{cfg: cfg, set: set, ua: ua, client: &http.Client{}, ctx: ctx, Now: time.Now, rooms: map[string]*room.Room{}, connsPerDay: map[string]int{}}
}

// Join returns the room for id (creating it and its polling loop if needed)
// with a client already registered in it; from says where a reconnecting client left off, or is nil.
func (m *Hub) Join(id string, from *room.Resume) (*room.Room, *room.Client, error) {
	if id == "" {
		id = m.cfg.DefaultCompetitionID
	}
	if !catalog.ValidID(id) {
		return nil, nil, ErrBadCompetitionID
	}
	if m.Ended != nil && m.Ended(id) {
		return nil, nil, ErrCompetitionEnded
	}

	m.set.Prepare(m.ctx, id) // outside the lock: it may fetch the competition lists

	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.allowanceLeftLocked() { // before a room is opened for the client
		return nil, nil, ErrQuotaReached
	}
	if m.clientTotalLocked() >= m.cfg.MaxClients {
		return nil, nil, ErrServerFull
	}
	r, ok := m.rooms[id]
	if !ok {
		if len(m.rooms) >= m.cfg.MaxCompetitions {
			return nil, nil, ErrTooManyRooms
		}
		upstream, err := m.set.FeedURL(id)
		if err != nil {
			return nil, nil, err
		}
		ctx, cancel := context.WithCancel(m.ctx)
		r = room.New(id, upstream, m.cfg.DataSourceIntervals, cancel)
		m.rooms[id] = r
		go (&fetch.Fetcher{URL: upstream, Sink: r, UA: m.ua, Client: m.client, Interval: r.Interval, Log: r.Log}).Run(ctx)
		slog.Info("Competition opened", "competition", id, "open", len(m.rooms))
	}
	if r.ClientCount() >= m.cfg.MaxClientsPerRoom {
		return nil, nil, ErrRoomFull
	}
	if r.IdleTime != nil {
		r.IdleTime.Stop()
		r.IdleTime = nil
	}
	m.countConnectionLocked()
	return r, r.Register(from), nil
}

// allowanceLeftLocked reports whether the rolling allowance of connections has room for one more. It keeps a
// long-running instance within the bandwidth of its plan.
func (m *Hub) allowanceLeftLocked() bool {
	now := m.Now().UTC()
	oldest := now.AddDate(0, 0, -(quotaDays - 1)).Format(time.DateOnly)
	total := 0
	for day, n := range m.connsPerDay {
		if day < oldest {
			delete(m.connsPerDay, day)
			continue
		}
		total += n
	}
	if total >= m.cfg.MaxClients30Days {
		if !m.quotaFull {
			slog.Warn("Connection allowance used up, refusing clients", "limit", m.cfg.MaxClients30Days, "days", quotaDays)
		}
		m.quotaFull = true
		return false
	}
	m.quotaFull = false
	return true
}

// countConnectionLocked books an accepted connection against today.
func (m *Hub) countConnectionLocked() {
	m.connsPerDay[m.Now().UTC().Format(time.DateOnly)]++
}

// clientTotalLocked counts the clients of all rooms.
func (m *Hub) clientTotalLocked() int {
	n := 0
	for _, r := range m.rooms {
		n += r.ClientCount()
	}
	return n
}

// ClientCount is the number of clients of all rooms.
func (m *Hub) ClientCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.clientTotalLocked()
}

// Announce sends a message that is not about one competition to every client of every room.
func (m *Hub) Announce(msg []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.rooms {
		r.Notify(msg)
	}
}

// Leave unregisters a client and, once the room is empty, schedules its teardown.
func (m *Hub) Leave(r *room.Room, c *room.Client) {
	r.Unregister(c)

	m.mu.Lock()
	defer m.mu.Unlock()
	if r.ClientCount() > 0 || r.IdleTime != nil {
		return
	}
	r.IdleTime = time.AfterFunc(m.cfg.IdleGrace, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.rooms[r.ID] != r || r.ClientCount() > 0 {
			return
		}
		delete(m.rooms, r.ID)
		r.Cancel()
		slog.Info("Competition closed (no clients)", "competition", r.ID, "open", len(m.rooms))
	})
}

// CloseEnded closes the rooms of competitions that are over, together with their polling loops and clients.
func (m *Hub) CloseEnded() {
	if m.Ended == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, r := range m.rooms {
		if !m.Ended(id) {
			continue
		}
		m.closeLocked(id, r, websocket.StatusPolicyViolation, ErrCompetitionEnded.Error())
		slog.Info("Competition closed (competition over)", "competition", id, "open", len(m.rooms))
	}
}

// closeLocked removes a room, stops its polling loop and disconnects its clients with the given reason.
func (m *Hub) closeLocked(id string, r *room.Room, code websocket.StatusCode, reason string) {
	delete(m.rooms, id)
	if r.IdleTime != nil {
		r.IdleTime.Stop()
		r.IdleTime = nil
	}
	r.Cancel()
	r.End(int(code), reason)
}

// CloseAll closes every room, so that its clients get a close frame and their handlers return.
func (m *Hub) CloseAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, r := range m.rooms {
		m.closeLocked(id, r, websocket.StatusGoingAway, "the server is shutting down")
	}
	m.CloseIdleConnections()
}

// WatchEnded checks every `every` whether open rooms belong to competitions that are over, until ctx ends.
func (m *Hub) WatchEnded(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.CloseEnded()
		}
	}
}

// Room returns the room of a competition, or nil when it is not being followed.
func (m *Hub) Room(id string) *room.Room {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.rooms[id]
}

// CloseIdleConnections closes the kept-alive connections to the data source.
func (m *Hub) CloseIdleConnections() { m.client.CloseIdleConnections() }

// RoomCount is the number of competitions being followed.
func (m *Hub) RoomCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.rooms)
}
