package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const writeTimeout = 10 * time.Second

// defaultPingInterval keeps a quiet connection busy enough for proxies (nginx closes after 60s of silence).
const defaultPingInterval = 25 * time.Second

var (
	errBadCompetitionID = errors.New("invalid or missing competitionId")
	errTooManyRooms     = errors.New("too many competitions are being followed")
	errQuotaReached     = errors.New("the connection allowance for this period is used up")
	errServerFull       = errors.New("too many clients are connected")
	errRoomFull         = errors.New("too many clients are following this competition")
	errCompetitionEnded = errors.New("the competition is over")

	// Ids end up in an outbound URL, so only a conservative charset is accepted.
	competitionIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

// manager owns one room per competition. A room is created when its first
// client arrives, polls the upstream exactly once per interval no matter how
// many clients follow it, and is torn down shortly after its last client leaves.
type manager struct {
	cfg    config
	ua     *userAgent
	client *http.Client
	ctx    context.Context

	// ended says whether a competition is over for good; nil means no competition ever is.
	ended func(id string) bool

	now func() time.Time

	mu    sync.Mutex
	rooms map[string]*room

	// Connections accepted per UTC day over the last quotaDays days, kept in memory only.
	connsPerDay map[string]int
	quotaFull   bool // whether the last connection was refused for the quota, so that is logged once per period
}

// quotaDays is the length of the rolling window that cfg.maxClients30Days applies to.
const quotaDays = 30

func newManager(ctx context.Context, cfg config, ua *userAgent) *manager {
	return &manager{cfg: cfg, ua: ua, client: &http.Client{}, ctx: ctx, now: time.Now, rooms: map[string]*room{}, connsPerDay: map[string]int{}}
}

// upstreamURL builds the live results URL for one competition by adding a competitionId query parameter.
func (c config) upstreamURL(id string) (string, error) {
	u, err := url.Parse(c.dataSourceURL)
	if err != nil {
		return "", err
	}
	if u.Path == "" {
		u.Path = "/" // `https://host` and `https://host/` are the same request; send the path explicitly
	}
	q := u.Query()
	q.Set("competitionId", id)
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// join returns the room for id (creating it and its polling loop if needed)
// with a client already registered in it.
func (m *manager) join(id string) (*room, *client, error) {
	if id == "" {
		id = m.cfg.defaultCompetitionID
	}
	if !competitionIDRe.MatchString(id) {
		return nil, nil, errBadCompetitionID
	}
	if m.ended != nil && m.ended(id) {
		return nil, nil, errCompetitionEnded
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.allowanceLeftLocked() { // before a room is opened for the client
		return nil, nil, errQuotaReached
	}
	if m.clientTotalLocked() >= m.cfg.maxClients {
		return nil, nil, errServerFull
	}
	r, ok := m.rooms[id]
	if !ok {
		if len(m.rooms) >= m.cfg.maxCompetitions {
			return nil, nil, errTooManyRooms
		}
		upstream, err := m.cfg.upstreamURL(id)
		if err != nil {
			return nil, nil, err
		}
		ctx, cancel := context.WithCancel(m.ctx)
		r = newRoom(id, upstream, m.cfg, cancel)
		m.rooms[id] = r
		go (&fetcher{url: upstream, room: r, ua: m.ua, client: m.client, interval: m.cfg.interval()}).loop(ctx)
		slog.Info("Competition opened", "competition", id, "open", len(m.rooms))
	}
	if r.clientCount() >= m.cfg.maxClientsPerRoom {
		return nil, nil, errRoomFull
	}
	if r.idleTime != nil {
		r.idleTime.Stop()
		r.idleTime = nil
	}
	m.countConnectionLocked()
	return r, r.register(), nil
}

// allowanceLeftLocked reports whether the rolling allowance of connections has room for one more. It keeps a
// long-running instance within the bandwidth of its plan.
func (m *manager) allowanceLeftLocked() bool {
	now := m.now().UTC()
	oldest := now.AddDate(0, 0, -(quotaDays - 1)).Format(time.DateOnly)
	total := 0
	for day, n := range m.connsPerDay {
		if day < oldest {
			delete(m.connsPerDay, day)
			continue
		}
		total += n
	}
	if total >= m.cfg.maxClients30Days {
		if !m.quotaFull {
			slog.Warn("Connection allowance used up, refusing clients", "limit", m.cfg.maxClients30Days, "days", quotaDays)
		}
		m.quotaFull = true
		return false
	}
	m.quotaFull = false
	return true
}

// countConnectionLocked books an accepted connection against today.
func (m *manager) countConnectionLocked() {
	m.connsPerDay[m.now().UTC().Format(time.DateOnly)]++
}

// clientTotalLocked counts the clients of all rooms.
func (m *manager) clientTotalLocked() int {
	n := 0
	for _, r := range m.rooms {
		n += r.clientCount()
	}
	return n
}

// leave unregisters a client and, once the room is empty, schedules its teardown.
func (m *manager) leave(r *room, c *client) {
	r.unregister(c)

	m.mu.Lock()
	defer m.mu.Unlock()
	if r.clientCount() > 0 || r.idleTime != nil {
		return
	}
	r.idleTime = time.AfterFunc(m.cfg.idleGrace, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.rooms[r.id] != r || r.clientCount() > 0 {
			return
		}
		delete(m.rooms, r.id)
		r.cancel()
		slog.Info("Competition closed (no clients)", "competition", r.id, "open", len(m.rooms))
	})
}

// closeEnded closes the rooms of competitions that are over, together with their polling loops and clients.
func (m *manager) closeEnded() {
	if m.ended == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, r := range m.rooms {
		if !m.ended(id) {
			continue
		}
		m.closeLocked(id, r, websocket.StatusPolicyViolation, errCompetitionEnded.Error())
		slog.Info("Competition closed (competition over)", "competition", id, "open", len(m.rooms))
	}
}

// closeLocked removes a room, stops its polling loop and disconnects its clients with the given reason.
func (m *manager) closeLocked(id string, r *room, code websocket.StatusCode, reason string) {
	delete(m.rooms, id)
	if r.idleTime != nil {
		r.idleTime.Stop()
		r.idleTime = nil
	}
	r.cancel()
	r.end(code, reason)
}

// closeAll closes every room, so that its clients get a close frame and their handlers return.
func (m *manager) closeAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, r := range m.rooms {
		m.closeLocked(id, r, websocket.StatusGoingAway, "the server is shutting down")
	}
	m.client.CloseIdleConnections()
}

// watchEnded checks every `every` whether open rooms belong to competitions that are over, until ctx ends.
func (m *manager) watchEnded(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.closeEnded()
		}
	}
}

func (m *manager) roomCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.rooms)
}

func (m *manager) serveWS(w http.ResponseWriter, req *http.Request) {
	r, c, err := m.join(req.URL.Query().Get("competitionId"))
	if errors.Is(err, errBadCompetitionID) || errors.Is(err, errCompetitionEnded) {
		// A browser cannot read the status of a failed handshake and would retry forever, so the
		// refusal is a close frame it can recognise.
		if conn, acceptErr := websocket.Accept(w, req, &websocket.AcceptOptions{OriginPatterns: []string{"*"}}); acceptErr == nil {
			_ = conn.Close(websocket.StatusPolicyViolation, err.Error())
		}
		return
	}
	if err != nil {
		code := http.StatusBadRequest
		if errors.Is(err, errTooManyRooms) || errors.Is(err, errRoomFull) || errors.Is(err, errServerFull) || errors.Is(err, errQuotaReached) {
			code = http.StatusServiceUnavailable
		}
		http.Error(w, err.Error(), code)
		return
	}
	defer m.leave(r, c)

	// Any origin is accepted: the frontend reaches us through a proxy. The messages are repetitive JSON: compressing
	// them with a window shared across messages cuts the traffic by about 80% (browsers without support get them plain).
	conn, err := websocket.Accept(w, req, &websocket.AcceptOptions{OriginPatterns: []string{"*"}, CompressionMode: websocket.CompressionContextTakeover})
	if err != nil {
		r.log.Warn("WebSocket accept failed", "err", err)
		return
	}
	defer func() { _ = conn.CloseNow() }()

	// The frontend never sends; CloseRead handles control frames and cancels ctx on close.
	ctx := conn.CloseRead(req.Context())
	pingEvery := m.cfg.pingInterval
	if pingEvery <= 0 {
		pingEvery = defaultPingInterval
	}
	ping := time.NewTicker(pingEvery)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ping.C:
			pctx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := conn.Ping(pctx)
			cancel()
			if err != nil {
				r.log.Warn("Ping failed, dropping client", "err", err)
				return
			}
		case msg, ok := <-c.send:
			if !ok {
				info := r.closeInfo()
				if info == nil {
					info = &closeInfo{websocket.StatusTryAgainLater, "client too slow"}
				}
				_ = conn.Close(info.code, info.reason)
				return
			}
			wctx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := conn.Write(wctx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				r.log.Warn("Send failed, dropping client", "err", err)
				return
			}
		}
	}
}
