// Live Results Dashboard — Backend
//
// Clients connect to /ws?competitionId=<id>. For each competition that has at
// least one client, the backend fetches raw race data from the live results API on
// each interval (one fetch loop per competition, however many clients follow
// it), processes it (sorting, ranking, heat grouping), then pushes
// per-competitor and per-distance update messages to that competition's clients.
//
// WebSocket message types (backend → frontend):
//
//	status            — sent on connect: { competition_id, data_source_url, data_source_interval }
//	event_name        — { name }
//	reset             — the source restarted; the frontend should drop its state
//	distance_meta     — scalar fields for one distance (sent when any field changes)
//	competitor_update — one message per changed competitor
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
)

const (
	// dataSourcePath is where the live results API serves a competition; LIVE_RESULTS_BASE_URL supplies the part before it.
	dataSourcePath     = "/Competition"
	maxUserAgentLength = 256
	maxBodyBytes       = 64 << 20
	fetchTimeout       = 10 * time.Second
)

type config struct {
	dataSourceURL        string  // may contain `{id}`; otherwise `competitionId=<id>` is added as a query parameter
	dataSourceInterval   float64 // seconds between upstream fetches, per competition
	listenAddr           string
	defaultCompetitionID string        // used when a client does not send competitionId; empty = required
	maxCompetitions      int           // distinct competitions followed at once
	idleGrace            time.Duration // how long an empty competition keeps polling before it is closed
	pingInterval         time.Duration // how often idle websocket clients are pinged, so proxies do not close a quiet connection

	catalogURL      string        // base URL serving /api/venues and /api/competitions
	catalogTTL      time.Duration // how long the competitions list is cached; venues are cached forever
	dataRetention   time.Duration // how long after its start a competition's data is served; 0 = until the day after it ends
	venueCountry    string        // only venues in this country (ISO 3166 alpha-3, as the upstream uses)
	venueDiscipline string        // only venues and competitions of this discipline
}

func (c config) interval() time.Duration {
	return time.Duration(c.dataSourceInterval * float64(time.Second))
}

func loadConfig() config {
	base, baseSet := os.LookupEnv("LIVE_RESULTS_BASE_URL")
	if baseSet && base == "" {
		slog.Error("LIVE_RESULTS_BASE_URL is set but empty; set it to the base URL of the live results API")
		os.Exit(1)
	}
	if !baseSet {
		base = "http://localhost:8080"
	}
	cfg := config{
		dataSourceURL:      strings.TrimRight(base, "/") + dataSourcePath,
		dataSourceInterval: 1,
		listenAddr:         getenv("LISTEN_ADDR", ":5000"),

		defaultCompetitionID: os.Getenv("DEFAULT_COMPETITION_ID"),
		maxCompetitions:      25,
		idleGrace:            30 * time.Second,
		pingInterval:         defaultPingInterval,

		catalogURL:      os.Getenv("MATCH_INFO_BASE_URL"),
		catalogTTL:      15 * time.Minute,
		dataRetention:   12 * time.Hour,
		venueCountry:    getenv("VENUE_COUNTRY_CODE", "NED"),
		venueDiscipline: getenv("VENUE_DISCIPLINE", "SpeedSkating.LongTrack"),
	}
	if cfg.catalogURL == "" {
		cfg.catalogURL = originOf(cfg.dataSourceURL)
	}
	if v := os.Getenv("CATALOG_TTL_SECONDS"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 {
			cfg.catalogTTL = time.Duration(f * float64(time.Second))
		} else {
			slog.Warn("Ignoring invalid CATALOG_TTL_SECONDS", "value", v)
		}
	}
	if v := os.Getenv("DATA_RETENTION_HOURS"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f >= 0 {
			cfg.dataRetention = time.Duration(f * float64(time.Hour))
		} else {
			slog.Warn("Ignoring invalid DATA_RETENTION_HOURS", "value", v)
		}
	}
	if v := os.Getenv("MAX_COMPETITIONS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.maxCompetitions = n
		} else {
			slog.Warn("Ignoring invalid MAX_COMPETITIONS", "value", v)
		}
	}
	if v := os.Getenv("IDLE_GRACE_SECONDS"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f >= 0 {
			cfg.idleGrace = time.Duration(f * float64(time.Second))
		} else {
			slog.Warn("Ignoring invalid IDLE_GRACE_SECONDS", "value", v)
		}
	}
	if v := os.Getenv("LIVE_RESULTS_INTERVAL"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 {
			cfg.dataSourceInterval = f
		} else {
			slog.Warn("Ignoring invalid LIVE_RESULTS_INTERVAL", "value", v)
		}
	}
	return cfg
}

// originOf returns scheme://host of a URL, or "" if it has none.
func originOf(raw string) string {
	u, err := url.Parse(strings.ReplaceAll(raw, "{id}", "x"))
	if err != nil || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// userAgent is the User-Agent sent on outbound fetches: the USER_AGENT setting when given,
// otherwise the most recent inbound User-Agent, mirrored onto outbound
// live results fetches — some upstream data sources apply UA-based bot
// filtering and reject the default Go identifier.
type userAgent struct {
	mu    sync.RWMutex
	ua    string
	fixed string // USER_AGENT: when set it is always sent and nothing is mirrored
}

func (u *userAgent) set(ua string) {
	if u.fixed != "" {
		return
	}
	if s := sanitizeUserAgent(ua); s != "" {
		u.mu.Lock()
		u.ua = s
		u.mu.Unlock()
	}
}

func (u *userAgent) get() string {
	if u.fixed != "" {
		return u.fixed
	}
	u.mu.RLock()
	defer u.mu.RUnlock()
	return u.ua
}

// sanitizeUserAgent strips non-printable characters (CR/LF included) and caps
// the length before an unauthenticated inbound header is reused as an outbound one.
func sanitizeUserAgent(ua string) string {
	out := make([]rune, 0, len(ua))
	for _, r := range ua {
		if unicode.IsPrint(r) {
			out = append(out, r)
			if len(out) == maxUserAgentLength {
				break
			}
		}
	}
	return string(out)
}

func (u *userAgent) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ua := r.Header.Get("User-Agent"); ua != "" {
			u.set(ua)
		}
		next.ServeHTTP(w, r)
	})
}

// fetcher polls the upstream for one competition and feeds its room.
type fetcher struct {
	url      string
	interval time.Duration
	room     *room
	ua       *userAgent
	client   *http.Client
}

func (f *fetcher) fetchOnce(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.url, nil)
	if err != nil {
		return err
	}
	if ua := f.ua.get(); ua != "" {
		req.Header.Set("User-Agent", ua)
	}
	resp, err := f.client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return &statusError{code: resp.StatusCode, retryAfter: parseRetryAfter(resp.Header)}
	}

	var raw rawData
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxBodyBytes)).Decode(&raw); err != nil {
		return fmt.Errorf("decode (content type %q): %w", resp.Header.Get("Content-Type"), err)
	}
	f.room.apply(process(&raw))
	if raw.Success != nil && !*raw.Success {
		f.room.setFeed("not_live", raw.ErrorMessage)
	} else {
		f.room.setFeed("ok", "")
	}
	return nil
}

func (f *fetcher) loop(ctx context.Context) {
	f.room.log.Debug("Fetch loop started", "url", f.url, "interval", f.interval)
	defer f.room.log.Debug("Fetch loop stopped")
	failures := 0
	for {
		var retryAfter time.Duration
		if err := f.fetchOnce(ctx); err == nil {
			failures = 0
		} else if !errors.Is(err, context.Canceled) {
			// a data source that keeps failing is asked less and less often, and its failures are not logged every time
			if failures%logEveryFailures == 0 {
				f.room.log.Error("Error fetching data", "err", err, "failures", failures+1)
			}
			failures++
			var se *statusError
			if errors.As(err, &se) {
				retryAfter = se.retryAfter
			}
			f.room.setFeed("unavailable", "") // details stay in the log: they can name the data source
		}
		wait := time.NewTimer(fetchDelay(f.interval, failures, retryAfter, randomJitter()))
		select {
		case <-ctx.Done():
			wait.Stop()
			return
		case <-wait.C:
		}
	}
}

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	cfg := loadConfig()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	ua := &userAgent{fixed: sanitizeUserAgent(os.Getenv("USER_AGENT"))}
	m := newManager(ctx, cfg, ua)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", m.serveWS)
	if cat, err := newCatalog(cfg, ua); err != nil {
		slog.Error("Competition list disabled", "err", err)
	} else {
		mux.HandleFunc("GET /api/competitions/today", cat.serveToday)
		m.ended = cat.ended
		go m.watchEnded(ctx, time.Minute)
	}
	srv := &http.Server{
		Addr:              cfg.listenAddr,
		Handler:           ua.middleware(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}

	// On SIGTERM the websocket clients are closed first (Shutdown does not wait for hijacked connections), then
	// in-flight requests are given a few seconds; main waits for all of it before returning.
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		m.closeAll()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	slog.Info("Listening", "addr", cfg.listenAddr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("Server failed", "err", err)
		os.Exit(1)
	}
	<-shutdownDone
}
