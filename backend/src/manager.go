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

	mu    sync.Mutex
	rooms map[string]*room
}

func newManager(ctx context.Context, cfg config, ua *userAgent) *manager {
	return &manager{cfg: cfg, ua: ua, client: &http.Client{}, ctx: ctx, rooms: map[string]*room{}}
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
	if r.idleTime != nil {
		r.idleTime.Stop()
		r.idleTime = nil
	}
	return r, r.register(), nil
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
		delete(m.rooms, id)
		r.cancel()
		r.end()
		slog.Info("Competition closed (competition over)", "competition", id, "open", len(m.rooms))
	}
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
		if errors.Is(err, errTooManyRooms) {
			code = http.StatusServiceUnavailable
		}
		http.Error(w, err.Error(), code)
		return
	}
	defer m.leave(r, c)

	// Any origin is accepted: the frontend reaches us through a proxy.
	conn, err := websocket.Accept(w, req, &websocket.AcceptOptions{OriginPatterns: []string{"*"}})
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
				reason := "client too slow"
				if r.isEnded() {
					reason = errCompetitionEnded.Error()
				}
				_ = conn.Close(websocket.StatusPolicyViolation, reason)
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
