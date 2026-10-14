// Mock server for live-results-experiment.
//
// MOCKSERVER_DATA_SAMPLE_DIRECTORY is a base directory with one subdirectory per competition. A
// competition's id is its subdirectory name. The first GET /Competition?competitionId=<id>
// starts that competition's replay: its JSON samples are served in ascending filename
// order, MOCKSERVER_DATA_SAMPLE_INTERVAL seconds apart, holding the last sample at the end.
// A competition whose last sample has been held for MOCKSERVER_DATA_EXPIRE_AFTER seconds (default 300) is dropped,
// so the next request replays it from the start.
// Competitions replay independently of each other.
//
// Three matches, each at its own venue, are generated (see generate.go) when MOCKSERVER_DATA_SAMPLE_DIRECTORY does
// not exist, or when MOCKSERVER_DATA_GENERATE=true; their live data unfolds one lap per interval.
//
//	GET  /api/matches                    ids of the available competitions (also a health check)
//	GET  /api/venues                     synthetic venues (DEV: a Dutch long-track venue that hosts every sample competition, plus distractors)
//	GET  /api/competitions               one competition per competition, running today, plus synthetic ones
//	                                     (tomorrow, last week, other venue) to exercise filtering
//	GET  /Competition?competitionId=<id> current sample of a competition; starts its replay on first use
//	POST /api/reset[?competitionId=<id>] restart one started competition, or all of them
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

var competitionIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

type config struct {
	baseDir     string
	interval    time.Duration
	expireAfter time.Duration // how long the last sample is held before the competition is dropped; 0 never
	listenAddr  string
	generate    bool // serve the generated matches next to the sample directory
	matches     int  // how many of the generated matches are served
}

func loadConfig() config {
	cfg := config{baseDir: "data", interval: 5 * time.Second, expireAfter: 5 * time.Minute, listenAddr: ":8080", matches: maxGeneratedMatches}
	if v := os.Getenv("MOCKSERVER_DATA_SAMPLE_DIRECTORY"); v != "" {
		cfg.baseDir = v
	}
	// Without a sample directory the server is self-contained and generates its own matches.
	_, err := os.Stat(cfg.baseDir) //nolint:gosec // the directory is the operator's own setting
	cfg.generate = err != nil
	if v := os.Getenv("MOCKSERVER_DATA_GENERATE"); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			cfg.generate = b
		} else {
			slog.Warn("Ignoring invalid MOCKSERVER_DATA_GENERATE", "value", v)
		}
	}
	if v := os.Getenv("MOCKSERVER_DATA_GENERATED_MATCHES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= cfg.matches {
			cfg.matches = n
		} else {
			slog.Warn("Ignoring invalid MOCKSERVER_DATA_GENERATED_MATCHES", "value", v, "max", cfg.matches)
		}
	}
	if v := os.Getenv("MOCKSERVER_LISTEN_ADDR"); v != "" {
		cfg.listenAddr = v
	}
	if v := os.Getenv("MOCKSERVER_DATA_SAMPLE_INTERVAL"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 {
			cfg.interval = time.Duration(f * float64(time.Second))
		} else {
			slog.Warn("Ignoring invalid MOCKSERVER_DATA_SAMPLE_INTERVAL", "value", v)
		}
	}
	if v := os.Getenv("MOCKSERVER_DATA_EXPIRE_AFTER"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f >= 0 {
			cfg.expireAfter = time.Duration(f * float64(time.Second))
		} else {
			slog.Warn("Ignoring invalid MOCKSERVER_DATA_EXPIRE_AFTER", "value", v)
		}
	}
	return cfg
}

// replay serves one competition: the current sample, advanced by a background goroutine.
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

	generated map[string]*genMatch // by competition id; empty unless cfg.generate
	genOrder  []*genMatch

	mu      sync.Mutex
	replays map[string]*replay
}

// withGenerated adds the first cfg.matches generated matches to the server.
func (s *server) withGenerated() *server {
	s.generated = map[string]*genMatch{}
	for _, m := range generatedMatches(s.cfg.matches) {
		s.generated[m.id] = m
		s.genOrder = append(s.genOrder, m)
	}
	return s
}

var (
	errUnknownCompetition = errors.New("unknown competition")
	errNoSamples          = errors.New("competition has no valid samples")
)

// sample is one step of a competition's replay.
type sample struct {
	name string
	load func() []byte // nil when the sample is unusable
}

// samples lists a competition's replay steps: the generated frames of a generated match, else the
// JSON files of its sample directory in ascending filename order.
func (s *server) samples(id string) ([]sample, error) {
	if m, ok := s.generated[id]; ok {
		out := make([]sample, len(m.frames))
		for i, f := range m.frames {
			out[i] = sample{name: fmt.Sprintf("frame-%03d", i), load: func() []byte { return f }}
		}
		return out, nil
	}
	files, err := s.sampleFiles(id)
	if err != nil {
		return nil, err
	}
	out := make([]sample, len(files))
	for i, f := range files {
		out[i] = sample{name: filepath.Base(f), load: func() []byte { return readSample(f) }}
	}
	return out, nil
}

// sampleFiles lists a competition's JSON samples in ascending filename order.
func (s *server) sampleFiles(id string) ([]string, error) {
	if !competitionIDRe.MatchString(id) {
		return nil, errUnknownCompetition
	}
	dir := filepath.Join(s.cfg.baseDir, id)
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() { //nolint:gosec // id is validated against competitionIDRe above
		return nil, errUnknownCompetition
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
	b, err := os.ReadFile(path) //nolint:gosec // path comes from a glob under the validated competition directory
	if err != nil || !json.Valid(b) {
		slog.Error("Replay: skipping unparseable sample", "file", filepath.Base(path), "err", err)
		return nil
	}
	return b
}

// start (re)starts a competition's replay. The first valid sample is loaded before
// returning, so the caller can serve it immediately.
func (s *server) start(id string) (*replay, error) {
	files, err := s.samples(id)
	if err != nil {
		return nil, err
	}
	first := -1
	var firstData []byte
	for i, f := range files {
		if firstData = f.load(); firstData != nil {
			first = i
			break
		}
	}
	if first < 0 {
		return nil, errNoSamples
	}

	ctx, cancel := context.WithCancel(s.ctx)
	r := &replay{id: id, cancel: cancel, current: firstData}
	slog.Info("Replay started", "competition", id, "files", len(files), "interval", s.cfg.interval)
	slog.Info("Replay: loaded", "competition", id, "file", files[first].name, "n", first+1, "of", len(files))

	go func() {
		for i := first + 1; i < len(files); i++ {
			select {
			case <-ctx.Done():
				return
			case <-time.After(s.cfg.interval):
			}
			if data := files[i].load(); data != nil {
				r.set(data)
				slog.Info("Replay: loaded", "competition", id, "file", files[i].name, "n", i+1, "of", len(files))
			}
		}
		slog.Info("Replay complete, holding last sample", "competition", id)
		if s.cfg.expireAfter <= 0 {
			return
		}
		select {
		case <-ctx.Done():
		case <-time.After(s.cfg.expireAfter):
			s.expire(id, r)
		}
	}()
	return r, nil
}

// replayFor returns the competition's running replay, starting it on first use.
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

// expire drops a replay that has not changed for a while, unless it was replaced in the meantime;
// the next request for the competition starts it over.
func (s *server) expire(id string, r *replay) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.replays[id] != r {
		return
	}
	r.cancel()
	delete(s.replays, id)
	slog.Info("Replay expired", "competition", id, "after", s.cfg.expireAfter)
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
	slog.Info("Replay reset", "competition", id)
	return nil
}

func fail(w http.ResponseWriter, err error) {
	code := http.StatusInternalServerError
	switch {
	case errors.Is(err, errUnknownCompetition), errors.Is(err, errNoSamples):
		code = http.StatusNotFound
	}
	http.Error(w, err.Error(), code)
}

func (s *server) handleMatches(w http.ResponseWriter, _ *http.Request) {
	entries, _ := os.ReadDir(s.cfg.baseDir)
	ids := []string{}
	for _, m := range s.genOrder {
		ids = append(ids, m.id)
	}
	for _, e := range entries {
		if e.IsDir() && competitionIDRe.MatchString(e.Name()) {
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
	if !competitionIDRe.MatchString(id) {
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

// eventName reads the event name from a competition's samples (the first ones may be error
// responses without a name), falling back to its id.
func (s *server) eventName(id string) string {
	files, _ := s.sampleFiles(id)
	for i, f := range files {
		if i == 10 {
			break
		}
		var head struct {
			Name string `json:"name"`
		}
		if b := readSample(f); b != nil && json.Unmarshal(b, &head) == nil && head.Name != "" {
			return head.Name
		}
	}
	return id
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
	list := []any{
		venue("DEV", "Mock Ice Rink", "Mockville", "NED", "SpeedSkating.LongTrack"),
		venue("DEV", "Mock Inline Track", "Mockville", "NED", "SpeedSkating.Inline"),
		venue("OTH", "Other Rink", "Elsewhere", "GER", "SpeedSkating.LongTrack"),
	}
	for _, m := range s.genOrder {
		list = append(list, venue(m.venue.code, m.venue.name, m.venue.city, "NED", "SpeedSkating.LongTrack"))
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(list)
}

// handleCompetitions lists every available competition as running today, plus a few
// synthetic ones that the backend's filters must drop or keep out of "today".
func (s *server) handleCompetitions(w http.ResponseWriter, _ *http.Request) {
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
	for _, m := range s.genOrder {
		list = append(list, comp(m.id, m.name, m.venue.code, now.Add(-time.Hour), now.Add(3*time.Hour)))
	}
	for _, e := range entries {
		if e.IsDir() && competitionIDRe.MatchString(e.Name()) {
			if files, _ := s.sampleFiles(e.Name()); len(files) > 0 {
				list = append(list, comp(e.Name(), s.eventName(e.Name()), "DEV", now.Add(-time.Hour), now.Add(3*time.Hour)))
			}
		}
	}
	day := 24 * time.Hour
	list = append(list,
		comp("mock-tomorrow", "Mock competition tomorrow", "DEV", now.Add(day), now.Add(day+3*time.Hour)),
		comp("mock-last-week", "Mock competition last week", "DEV", now.Add(-7*day), now.Add(-7*day+3*time.Hour)),
		comp("mock-other-venue", "Mock competition elsewhere", "OTH", now.Add(-time.Hour), now.Add(3*time.Hour)),
	)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(list)
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/venues", s.handleVenues)
	mux.HandleFunc("GET /api/competitions", s.handleCompetitions)
	mux.HandleFunc("GET /api/matches", s.handleMatches)
	mux.HandleFunc("GET /Competition", s.handleData)
	mux.HandleFunc("POST /api/reset", s.handleReset)
	return mux
}

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	cfg := loadConfig()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	s := &server{cfg: cfg, ctx: ctx, replays: map[string]*replay{}}
	if cfg.generate {
		s.withGenerated()
	}
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
