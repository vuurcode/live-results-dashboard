package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const writeTimeout = 10 * time.Second

var (
	errBadCompetitionID = errors.New("invalid or missing competitionId")
	errTooManyRooms     = errors.New("too many competitions are being followed")

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

	mu    sync.Mutex
	rooms map[string]*room
}

func newManager(ctx context.Context, cfg config, ua *userAgent) *manager {
	return &manager{cfg: cfg, ua: ua, client: &http.Client{}, ctx: ctx, rooms: map[string]*room{}}
}

// upstreamURL builds the data source URL for one competition: `{id}` in
// DATA_SOURCE_URL is substituted, otherwise a competitionId query parameter is added.
func (c config) upstreamURL(id string) (string, error) {
	if strings.Contains(c.dataSourceURL, "{id}") {
		return strings.ReplaceAll(c.dataSourceURL, "{id}", url.PathEscape(id)), nil
	}
	u, err := url.Parse(c.dataSourceURL)
	if err != nil {
		return "", err
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

func (m *manager) roomCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.rooms)
}

func (m *manager) serveWS(w http.ResponseWriter, req *http.Request) {
	r, c, err := m.join(req.URL.Query().Get("competitionId"))
	if err != nil {
		code := http.StatusBadRequest
		if errors.Is(err, errTooManyRooms) {
			code = http.StatusServiceUnavailable
		}
		http.Error(w, err.Error(), code)
		return
	}
	defer m.leave(r, c)

	// Any origin is accepted, as before: the frontend reaches us through a proxy.
	conn, err := websocket.Accept(w, req, &websocket.AcceptOptions{OriginPatterns: []string{"*"}})
	if err != nil {
		slog.Warn("WebSocket accept failed", "err", err)
		return
	}
	defer func() { _ = conn.CloseNow() }()

	// The frontend never sends; CloseRead handles control frames and cancels ctx on close.
	ctx := conn.CloseRead(req.Context())
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-c.send:
			if !ok {
				_ = conn.Close(websocket.StatusPolicyViolation, "client too slow")
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
