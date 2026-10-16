// Package server serves the websocket endpoint, the healthcheck and the competitions list over HTTP.
package server

import (
	"context"
	"errors"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/coder/websocket"

	"github.com/vuurcode/live-results-experiment/backend/internal/config"
	"github.com/vuurcode/live-results-experiment/backend/internal/hub"
	"github.com/vuurcode/live-results-experiment/backend/internal/ratelimit"
	"github.com/vuurcode/live-results-experiment/backend/internal/room"
	"github.com/vuurcode/live-results-experiment/backend/internal/useragent"
)

const writeTimeout = 10 * time.Second

// Options tune a server.
type Options struct {
	// PingInterval is how often idle clients are pinged; config.DefaultPingInterval when not positive.
	PingInterval time.Duration
	// Limiter limits connections per client address; nil means no limit.
	Limiter *ratelimit.Limiter
	// ClientIPHeader names the request header that carries the client address behind a proxy; see clientKey.
	ClientIPHeader string
	// CORSAllowedOrigins are the origins whose pages may call the HTTP API from the browser; "*" allows all, empty none.
	CORSAllowedOrigins []string
	// WebSocketOrigins are the origins whose pages may open the websocket, next to the host the request is made to; "*" or empty allows all.
	WebSocketOrigins []string
	// Recordings serves the stored recordings under /api/recordings; nil leaves the routes out.
	Recordings *RecordingsAPI
}

// Server connects websocket clients to the rooms of a hub.
type Server struct {
	hub  *hub.Hub
	opts Options
}

// New returns a server for the rooms of h.
func New(h *hub.Hub, opts Options) *Server {
	if opts.PingInterval <= 0 {
		opts.PingInterval = config.DefaultPingInterval
	}
	return &Server{hub: h, opts: opts}
}

// Handler routes the endpoints. today serves the competitions list and may be nil, which leaves the route out.
func (s *Server) Handler(ua *useragent.Mirror, today http.HandlerFunc) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.ServeWS)
	mux.HandleFunc("GET /healthcheck", Healthcheck)
	if today != nil {
		mux.HandleFunc("GET /api/competitions/today", today)
	}
	s.opts.Recordings.register(mux)
	return ua.Middleware(securityHeaders(cors(s.opts.CORSAllowedOrigins, mux)))
}

// Healthcheck answers an empty 200, for the hosting platform's health check.
func Healthcheck(http.ResponseWriter, *http.Request) {}

// ServeWS follows one competition (the competitionId query parameter) until the client or the room ends.
func (s *Server) ServeWS(w http.ResponseWriter, req *http.Request) {
	// Before a room is joined, so that an abusive client neither uses up the connection allowance nor opens rooms.
	if s.opts.Limiter != nil {
		release, wait, ok := s.opts.Limiter.Acquire(clientKey(req, s.opts.ClientIPHeader))
		if !ok {
			w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(wait.Seconds()))))
			http.Error(w, "too many connections from this address", http.StatusTooManyRequests)
			return
		}
		defer release()
	}
	q := req.URL.Query()
	r, c, err := s.hub.Join(q.Get("competitionId"), resumeFrom(q))
	if errors.Is(err, hub.ErrBadCompetitionID) || errors.Is(err, hub.ErrCompetitionEnded) {
		// A browser cannot read the status of a failed handshake and would retry forever, so the
		// refusal is a close frame it can recognise.
		if conn, acceptErr := websocket.Accept(w, req, &websocket.AcceptOptions{OriginPatterns: originPatterns(s.opts.WebSocketOrigins)}); acceptErr == nil {
			_ = conn.Close(websocket.StatusPolicyViolation, err.Error())
		}
		return
	}
	if err != nil {
		code := http.StatusBadRequest
		if errors.Is(err, hub.ErrTooManyRooms) || errors.Is(err, hub.ErrRoomFull) || errors.Is(err, hub.ErrServerFull) || errors.Is(err, hub.ErrQuotaReached) {
			code = http.StatusServiceUnavailable
		}
		http.Error(w, err.Error(), code)
		return
	}
	defer s.hub.Leave(r, c)
	s.serve(w, req, r, c)
}

// resumeFrom reads where a reconnecting client left off (the epoch and lastSeq query parameters); nil when it says nothing usable.
func resumeFrom(q url.Values) *room.Resume {
	seq, err := strconv.ParseUint(q.Get("lastSeq"), 10, 64)
	epoch := q.Get("epoch")
	if err != nil || epoch == "" {
		return nil
	}
	return &room.Resume{Epoch: epoch, Seq: seq}
}

func (s *Server) serve(w http.ResponseWriter, req *http.Request, r *room.Room, c *room.Client) {
	// The messages are repetitive JSON: compressing
	// them with a window shared across messages cuts the traffic by about 80% (browsers without support get them plain).
	conn, err := websocket.Accept(w, req, &websocket.AcceptOptions{OriginPatterns: originPatterns(s.opts.WebSocketOrigins), CompressionMode: websocket.CompressionContextTakeover})
	if err != nil {
		r.Log.Warn("WebSocket accept failed", "err", err)
		return
	}
	defer func() { _ = conn.CloseNow() }()

	// The frontend never sends; CloseRead handles control frames and cancels ctx on close.
	ctx := conn.CloseRead(req.Context())
	ping := time.NewTicker(s.opts.PingInterval)
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
				r.Log.Warn("Ping failed, dropping client", "err", err)
				return
			}
		case msg, ok := <-c.Send:
			if !ok {
				code, reason := websocket.StatusTryAgainLater, "client too slow"
				if info := r.Closed(); info != nil {
					code, reason = websocket.StatusCode(info.Code), info.Reason
				}
				_ = conn.Close(code, reason)
				return
			}
			wctx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := conn.Write(wctx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				r.Log.Warn("Send failed, dropping client", "err", err)
				return
			}
		}
	}
}
