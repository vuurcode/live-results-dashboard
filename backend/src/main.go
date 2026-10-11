// Live Results Dashboard — Backend
//
// Clients connect to /ws?competitionId=<id>. For each competition that has at
// least one client, the backend fetches raw race data from DATA_SOURCE_URL on
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

	catalogURL      string        // base URL serving /api/venues and /api/competitions
	catalogTTL      time.Duration // how long the competitions list is cached; venues are cached forever
	venueCountry    string        // only venues in this country (ISO 3166 alpha-3, as the upstream uses)
	venueDiscipline string        // only venues and competitions of this discipline
}

func (c config) interval() time.Duration {
	return time.Duration(c.dataSourceInterval * float64(time.Second))
}

func loadConfig() config {
	if v, ok := os.LookupEnv("DATA_SOURCE_URL"); ok && v == "" {
		slog.Error("DATA_SOURCE_URL is set but empty; set it to the live data source URL")
		os.Exit(1)
	}
	cfg := config{
		dataSourceURL:      getenv("DATA_SOURCE_URL", "http://localhost:8080/api/data"),
		dataSourceInterval: 1,
		listenAddr:         getenv("LISTEN_ADDR", ":5000"),

		defaultCompetitionID: os.Getenv("DEFAULT_COMPETITION_ID"),
		maxCompetitions:      25,
		idleGrace:            30 * time.Second,

		catalogURL:      os.Getenv("CATALOG_URL"),
		catalogTTL:      24 * time.Hour,
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
	if v := os.Getenv("DATA_SOURCE_INTERVAL"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 {
			cfg.dataSourceInterval = f
		} else {
			slog.Warn("Ignoring invalid DATA_SOURCE_INTERVAL", "value", v)
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

// userAgent mirrors the most recent inbound User-Agent onto outbound
// DATA_SOURCE_URL fetches — some upstream data sources apply UA-based bot
// filtering and reject the default Go identifier.
type userAgent struct {
	mu sync.RWMutex
	ua string
}

func (u *userAgent) set(ua string) {
	if s := sanitizeUserAgent(ua); s != "" {
		u.mu.Lock()
		u.ua = s
		u.mu.Unlock()
	}
}

func (u *userAgent) get() string {
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
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	var raw rawData
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxBodyBytes)).Decode(&raw); err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	f.room.apply(process(&raw))
	return nil
}

func (f *fetcher) loop(ctx context.Context) {
	f.room.log.Info("Fetch loop started", "url", f.url, "interval", f.interval)
	defer f.room.log.Info("Fetch loop stopped")
	for {
		if err := f.fetchOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
			f.room.log.Error("Error fetching data", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(f.interval):
		}
	}
}

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	cfg := loadConfig()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	ua := &userAgent{}
	m := newManager(ctx, cfg, ua)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", m.serveWS)
	if cat, err := newCatalog(cfg, ua); err != nil {
		slog.Error("Match list disabled", "err", err)
	} else {
		mux.HandleFunc("GET /api/matches/today", cat.serveToday)
	}
	srv := &http.Server{
		Addr:              cfg.listenAddr,
		Handler:           ua.middleware(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	slog.Info("Listening", "addr", cfg.listenAddr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("Server failed", "err", err)
		os.Exit(1)
	}
}
