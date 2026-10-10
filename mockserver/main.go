// Mock server for live-results-dashboard.
//
// DATA_SAMPLE_DIRECTORY is a base directory with one subdirectory per match. A
// match's id is its subdirectory name. The first GET /api/data?competitionId=<id>
// starts that match's replay: its JSON samples are served in ascending filename
// order, DATA_SAMPLE_INTERVAL seconds apart, holding the last sample at the end.
// Matches replay independently of each other.
//
//	GET  /api/matches                    ids of the available matches (also a health check)
//	GET  /api/venues                     synthetic venues (DEV: a Dutch long-track venue that hosts every sample match, plus distractors)
//	GET  /api/competitions               one competition per match, running today, plus synthetic ones
//	                                     (tomorrow, last week, other venue) to exercise filtering
//	GET  /api/data?competitionId=<id>    current sample of a match; starts its replay on first use
//	POST /api/reset[?competitionId=<id>] restart one started match, or all of them
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"syscall"
	"time"
)

var matchIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

type config struct {
	baseDir    string
	interval   time.Duration
	listenAddr string
}

func loadConfig() config {
	cfg := config{baseDir: "data", interval: 5 * time.Second, listenAddr: ":8080"}
	if v := os.Getenv("DATA_SAMPLE_DIRECTORY"); v != "" {
		cfg.baseDir = v
	}
	if v := os.Getenv("LISTEN_ADDR"); v != "" {
		cfg.listenAddr = v
	}
	if v := os.Getenv("DATA_SAMPLE_INTERVAL"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 {
			cfg.interval = time.Duration(f * float64(time.Second))
		} else {
			slog.Warn("Ignoring invalid DATA_SAMPLE_INTERVAL", "value", v)
		}
	}
	return cfg
}

// replay serves one match: the current sample, advanced by a background goroutine.
type replay struct {
	id     string
	cancel context.CancelFunc

	mu      sync.RWMutex
	current []byte
}

func (r *replay) get() []byte {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.current
}

func (r *replay) set(b []byte) {
	r.mu.Lock()
	r.current = b
	r.mu.Unlock()
}

type server struct {
	cfg config
	ctx context.Context

	mu      sync.Mutex
	replays map[string]*replay
}

var (
	errUnknownMatch = errors.New("unknown match")
	errNoSamples    = errors.New("match has no valid samples")
)

// sampleFiles lists a match's JSON samples in ascending filename order.
func (s *server) sampleFiles(id string) ([]string, error) {
	if !matchIDRe.MatchString(id) {
		return nil, errUnknownMatch
	}
	dir := filepath.Join(s.cfg.baseDir, id)
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() { //nolint:gosec // id is validated against matchIDRe above
		return nil, errUnknownMatch
	}
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	return files, nil
}

// readSample returns a file's bytes, or nil if it is unreadable or not valid JSON.
func readSample(path string) []byte {
	b, err := os.ReadFile(path) //nolint:gosec // path comes from a glob under the validated match directory
	if err != nil || !json.Valid(b) {
		slog.Error("Replay: skipping unparseable sample", "file", filepath.Base(path), "err", err)
		return nil
	}
	return b
}

// start (re)starts a match's replay. The first valid sample is loaded before
// returning, so the caller can serve it immediately.
func (s *server) start(id string) (*replay, error) {
	files, err := s.sampleFiles(id)
	if err != nil {
		return nil, err
	}
	first := -1
	var firstData []byte
	for i, f := range files {
		if firstData = readSample(f); firstData != nil {
			first = i
			break
		}
	}
	if first < 0 {
		return nil, errNoSamples
	}

	ctx, cancel := context.WithCancel(s.ctx)
	r := &replay{id: id, cancel: cancel, current: firstData}
	slog.Info("Replay started", "match", id, "files", len(files), "interval", s.cfg.interval)
	slog.Info("Replay: loaded", "match", id, "file", filepath.Base(files[first]), "n", first+1, "of", len(files))

	go func() {
		for i := first + 1; i < len(files); i++ {
			select {
			case <-ctx.Done():
				return
			case <-time.After(s.cfg.interval):
			}
			if data := readSample(files[i]); data != nil {
				r.set(data)
				slog.Info("Replay: loaded", "match", id, "file", filepath.Base(files[i]), "n", i+1, "of", len(files))
			}
		}
		slog.Info("Replay complete, holding last sample", "match", id)
	}()
	return r, nil
}

// replayFor returns the match's running replay, starting it on first use.
func (s *server) replayFor(id string) (*replay, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.replays[id]; ok {
		return r, nil
	}
	r, err := s.start(id)
	if err != nil {
		return nil, err
	}
	s.replays[id] = r
	return r, nil
}

func (s *server) reset(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, ok := s.replays[id]; ok {
		old.cancel()
	}
	r, err := s.start(id)
	if err != nil {
		delete(s.replays, id)
		return err
	}
	s.replays[id] = r
	slog.Info("Replay reset", "match", id)
	return nil
}

func fail(w http.ResponseWriter, err error) {
	code := http.StatusInternalServerError
	switch {
	case errors.Is(err, errUnknownMatch), errors.Is(err, errNoSamples):
		code = http.StatusNotFound
	}
	http.Error(w, err.Error(), code)
}

func (s *server) handleMatches(w http.ResponseWriter, _ *http.Request) {
	entries, _ := os.ReadDir(s.cfg.baseDir)
	ids := []string{}
	for _, e := range entries {
		if e.IsDir() && matchIDRe.MatchString(e.Name()) {
			if files, _ := s.sampleFiles(e.Name()); len(files) > 0 {
				ids = append(ids, e.Name())
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(ids)
}

func (s *server) handleData(w http.ResponseWriter, req *http.Request) {
	id := req.URL.Query().Get("competitionId")
	if !matchIDRe.MatchString(id) {
		http.Error(w, "competitionId is required", http.StatusBadRequest)
		return
	}
	r, err := s.replayFor(id)
	if err != nil {
		fail(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(r.get()) //nolint:gosec // served as application/json, bytes are validated JSON sample files
}

func (s *server) handleReset(w http.ResponseWriter, req *http.Request) {
	var ids []string
	if id := req.URL.Query().Get("competitionId"); id != "" {
		ids = []string{id}
	} else {
		s.mu.Lock()
		for id := range s.replays {
			ids = append(ids, id)
		}
		s.mu.Unlock()
	}
	for _, id := range ids {
		if err := s.reset(id); err != nil {
			fail(w, err)
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"reset": true, "matches": ids})
}

// eventName reads the event name from a match's first sample, falling back to its id.
func (s *server) eventName(id string) string {
	files, err := s.sampleFiles(id)
	if err != nil || len(files) == 0 {
		return id
	}
	b := readSample(files[0])
	var head struct {
		Name string `json:"name"`
	}
	if b == nil || json.Unmarshal(b, &head) != nil || head.Name == "" {
		return id
	}
	return head.Name
}

func (s *server) handleVenues(w http.ResponseWriter, _ *http.Request) {
	venue := func(code, name, city, country, discipline string) map[string]any {
		return map[string]any{
			"address":    map[string]any{"city": city, "countryCode": country},
			"name":       name,
			"code":       code,
			"discipline": discipline,
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode([]any{
		venue("DEV", "Mock Ice Rink", "Mockville", "NED", "SpeedSkating.LongTrack"),
		venue("DEV", "Mock Inline Track", "Mockville", "NED", "SpeedSkating.Inline"),
		venue("OTH", "Other Rink", "Elsewhere", "GER", "SpeedSkating.LongTrack"),
	})
}

// handleCompetitions lists every available match as running today, plus a few
// synthetic ones that the backend's filters must drop or keep out of "today".
func (s *server) handleCompetitions(w http.ResponseWriter, req *http.Request) {
	entries, _ := os.ReadDir(s.cfg.baseDir)
	now := time.Now().UTC()
	comp := func(id, name, venue string, start, end time.Time) map[string]any {
		return map[string]any{
			"id": id, "code": "MOCK-" + id, "name": name,
			"venue":           map[string]any{"code": venue},
			"discipline":      "SpeedSkating.LongTrack",
			"timeZone":        "W. Europe Standard Time",
			"extra":           "Synthetic mock data",
			"allowToSendLive": true,
			"starts":          start.Format(time.RFC3339),
			"ends":            end.Format(time.RFC3339),
			"settings":        map[string]any{"paymentProviderKey": "mock-secret-never-exposed"},
		}
	}
	list := []any{}
	for _, e := range entries {
		if e.IsDir() && matchIDRe.MatchString(e.Name()) {
			if files, _ := s.sampleFiles(e.Name()); len(files) > 0 {
				list = append(list, comp(e.Name(), s.eventName(e.Name()), "DEV", now.Add(-time.Hour), now.Add(3*time.Hour)))
			}
		}
	}
	day := 24 * time.Hour
	list = append(list,
		comp("mock-tomorrow", "Mock match tomorrow", "DEV", now.Add(day), now.Add(day+3*time.Hour)),
		comp("mock-last-week", "Mock match last week", "DEV", now.Add(-7*day), now.Add(-7*day+3*time.Hour)),
		comp("mock-other-venue", "Mock match elsewhere", "OTH", now.Add(-time.Hour), now.Add(3*time.Hour)),
	)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(list)
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/venues", s.handleVenues)
	mux.HandleFunc("GET /api/competitions", s.handleCompetitions)
	mux.HandleFunc("GET /api/matches", s.handleMatches)
	mux.HandleFunc("GET /api/data", s.handleData)
	mux.HandleFunc("POST /api/reset", s.handleReset)
	return mux
}

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	cfg := loadConfig()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	s := &server{cfg: cfg, ctx: ctx, replays: map[string]*replay{}}
	srv := &http.Server{Addr: cfg.listenAddr, Handler: s.routes(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	slog.Info("Listening", "addr", cfg.listenAddr, "dir", cfg.baseDir, "interval", cfg.interval)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("Server failed", "err", err)
		os.Exit(1)
	}
}
