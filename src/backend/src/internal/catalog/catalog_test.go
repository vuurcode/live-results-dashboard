package catalog

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vuurcode/live-results-experiment/backend/internal/config"
	"github.com/vuurcode/live-results-experiment/backend/internal/source"
)

const testVenues = `[
 {"address":{"city":"Deventer","countryCode":"NED"},"name":"Scheg","code":"DEV","discipline":"SpeedSkating.LongTrack"},
 {"address":{"city":"Deventer","countryCode":"NED"},"name":"Skeelerbaan","code":"DEV","discipline":"SpeedSkating.Inline"},
 {"address":{"city":"Berlin","countryCode":"GER"},"name":"Berlin","code":"BER","discipline":"SpeedSkating.LongTrack"}
]`

func comp(id, venue, discipline, starts, ends string) string {
	return `{"id":"` + id + `","code":"C-` + id + `","name":"Competition ` + id + `","venue":{"code":"` + venue + `"},
	 "discipline":"` + discipline + `","timeZone":"W. Europe Standard Time","extra":"note","allowToSendLive":true,
	 "starts":"` + starts + `","ends":"` + ends + `","settings":{"paymentProviderKey":"SECRET","contact":{"email":"a@b.c"}}}`
}

type fakeUA struct{}

func (fakeUA) Get() string { return "" }

type catalogEnv struct {
	cat                 *Catalog
	venueHits, compHits atomic.Int32
	now                 time.Time
}

func newCatalogEnv(t *testing.T, comps ...string) *catalogEnv {
	t.Helper()
	e := &catalogEnv{now: time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/venues", func(w http.ResponseWriter, _ *http.Request) {
		e.venueHits.Add(1)
		_, _ = w.Write([]byte(testVenues))
	})
	mux.HandleFunc("/api/competitions", func(w http.ResponseWriter, _ *http.Request) {
		e.compHits.Add(1)
		_, _ = w.Write([]byte("[" + strings.Join(comps, ",") + "]"))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	cfg := config.Config{CatalogTTL: time.Hour, VenueCountry: "NED", VenueDiscipline: "SpeedSkating.LongTrack"}
	cat, err := New(cfg, source.NewSet(source.Upstream{CatalogURL: srv.URL}), fakeUA{})
	if err != nil {
		t.Fatal(err)
	}
	cat.now = func() time.Time { return e.now }
	e.cat = cat
	return e
}

func ids(list []*competition) []string {
	out := []string{}
	for _, m := range list {
		out = append(out, m.ID)
	}
	return out
}

func TestCatalogFiltersAndToday(t *testing.T) {
	e := newCatalogEnv(t,
		comp("today-evening", "DEV", "SpeedSkating.LongTrack", "2026-10-24T15:30:00Z", "2026-10-24T19:00:00Z"),
		comp("today-late", "DEV", "SpeedSkating.LongTrack", "2026-10-24T21:30:00Z", "2026-10-24T23:30:00Z"), // 23:30 local, ends 01:30 the next day
		comp("tomorrow", "DEV", "SpeedSkating.LongTrack", "2026-10-25T10:00:00Z", "2026-10-25T12:00:00Z"),
		comp("yesterday", "DEV", "SpeedSkating.LongTrack", "2026-10-23T10:00:00Z", "2026-10-23T12:00:00Z"),
		comp("old", "DEV", "SpeedSkating.LongTrack", "2026-10-20T10:00:00Z", "2026-10-20T12:00:00Z"),
		comp("inline", "DEV", "SpeedSkating.Inline", "2026-10-24T10:00:00Z", "2026-10-24T12:00:00Z"),
		comp("berlin", "BER", "SpeedSkating.LongTrack", "2026-10-24T10:00:00Z", "2026-10-24T12:00:00Z"),
		comp("bad id!", "DEV", "SpeedSkating.LongTrack", "2026-10-24T10:00:00Z", "2026-10-24T12:00:00Z"),
	)
	got, err := e.cat.Today(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// today-late ends 00:30 local on the 25th, so it spans today and tomorrow: listed today too.
	if want := []string{"today-evening", "today-late"}; strings.Join(ids(got), ",") != strings.Join(want, ",") {
		t.Fatalf("today = %v, want %v", ids(got), want)
	}
	// kept (not listed) until the day after: yesterday stays cached, old is dropped, tomorrow is cached
	cached := map[string]bool{}
	for _, m := range e.cat.competitions {
		cached[m.ID] = true
	}
	for id, want := range map[string]bool{"yesterday": true, "tomorrow": true, "old": false, "inline": false, "berlin": false} {
		if cached[id] != want {
			t.Errorf("cached[%s] = %v, want %v", id, cached[id], want)
		}
	}
	if m := got[0]; m.Venue != (venue{Code: "DEV", Name: "Scheg", City: "Deventer"}) || m.Extra != "note" || !m.AllowToSendLive {
		t.Errorf("unexpected competition fields: %+v", m)
	}
}

func TestCatalogBeforeStartListedAndNoSecrets(t *testing.T) {
	e := newCatalogEnv(t, comp("later", "DEV", "SpeedSkating.LongTrack", "2026-10-24T20:00:00Z", "2026-10-24T21:00:00Z"))
	e.now = time.Date(2026, 10, 24, 5, 0, 0, 0, time.UTC)
	rec := httptest.NewRecorder()
	e.cat.ServeToday(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/competitions/today", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	body := rec.Body.String()
	for _, secret := range []string{"SECRET", "a@b.c", "settings"} {
		if strings.Contains(body, secret) {
			t.Errorf("response leaks %q: %s", secret, body)
		}
	}
	var list []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil || len(list) != 1 || list[0]["id"] != "later" {
		t.Fatalf("body = %s (%v)", body, err)
	}
}

func TestCatalogCaching(t *testing.T) {
	e := newCatalogEnv(t, comp("m", "DEV", "SpeedSkating.LongTrack", "2026-10-24T15:30:00Z", "2026-10-24T19:00:00Z"))
	for range 3 {
		if _, err := e.cat.Today(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if e.venueHits.Load() != 1 || e.compHits.Load() != 1 {
		t.Fatalf("hits venues=%d competitions=%d, want 1/1", e.venueHits.Load(), e.compHits.Load())
	}
	e.now = e.now.Add(time.Hour)
	if _, err := e.cat.Today(context.Background()); err != nil {
		t.Fatal(err)
	}
	if e.venueHits.Load() != 2 || e.compHits.Load() != 2 {
		t.Fatalf("after an hour hits venues=%d competitions=%d, want 2/2", e.venueHits.Load(), e.compHits.Load())
	}
}

func TestCatalogCacheIsCappedAtAnHour(t *testing.T) {
	cfg := config.Config{CatalogTTL: 24 * time.Hour, VenueCountry: "NED", VenueDiscipline: "SpeedSkating.LongTrack"}
	cat, err := New(cfg, source.NewSet(source.Upstream{CatalogURL: "http://127.0.0.1:1"}), fakeUA{})
	if err != nil {
		t.Fatal(err)
	}
	if cat.ttl != time.Hour {
		t.Fatalf("ttl = %v, want the cap of one hour", cat.ttl)
	}
}

func TestCatalogKeepsStaleDataOnFailure(t *testing.T) {
	e := newCatalogEnv(t, comp("m", "DEV", "SpeedSkating.LongTrack", "2026-10-24T15:30:00Z", "2026-10-24T19:00:00Z"))
	if _, err := e.cat.Today(context.Background()); err != nil {
		t.Fatal(err)
	}
	e.cat.upstreams[0].base.Host = "127.0.0.1:1" // unreachable
	e.now = e.now.Add(25 * time.Hour)
	if _, err := e.cat.Today(context.Background()); err != nil {
		t.Fatalf("stale data should be served on refresh failure: %v", err)
	}
}

func TestZones(t *testing.T) {
	if got := loadZone("test", "W. Europe Standard Time").String(); got != "Europe/Amsterdam" {
		t.Errorf("zone = %q", got)
	}
	for _, name := range []string{"undefined", "W. Europe Daylight Time"} {
		if got := loadZone("test", name).String(); got != "Europe/Amsterdam" {
			t.Errorf("%q -> %q, want Europe/Amsterdam", name, got)
		}
	}
	if got := loadZone("test", "Europe/Berlin").String(); got != "Europe/Berlin" {
		t.Errorf("iana zone = %q", got)
	}
	if got := loadZone("test", "Nowhere Standard Time"); got != time.UTC {
		t.Errorf("unknown zone = %v", got)
	}
}

func TestCatalogBaseWithAndWithoutTrailingSlash(t *testing.T) {
	for _, suffix := range []string{"", "/"} {
		e := newCatalogEnv(t, comp("m", "DEV", "SpeedSkating.LongTrack", "2026-10-24T15:30:00Z", "2026-10-24T19:00:00Z"))
		cfg := config.Config{CatalogTTL: time.Hour, VenueCountry: "NED", VenueDiscipline: "SpeedSkating.LongTrack"}
		cat, err := New(cfg, source.NewSet(source.Upstream{CatalogURL: e.cat.upstreams[0].base.String() + suffix}), fakeUA{})
		if err != nil {
			t.Fatal(err)
		}
		cat.now = func() time.Time { return e.now }
		if list, err := cat.Today(context.Background()); err != nil || len(list) != 1 {
			t.Errorf("catalog URL suffix %q: %v, %v", suffix, ids(list), err)
		}
	}
}

func TestTodayFollowsLocalMidnightWithoutRefetching(t *testing.T) {
	e := newCatalogEnv(t,
		comp("today", "DEV", "SpeedSkating.LongTrack", "2026-10-24T15:30:00Z", "2026-10-24T19:00:00Z"),
		comp("tomorrow", "DEV", "SpeedSkating.LongTrack", "2026-10-25T10:00:00Z", "2026-10-25T12:00:00Z"),
	)
	e.cat.ttl = 48 * time.Hour // the cached list is what has to move on by itself
	list := func() string {
		got, err := e.cat.Today(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		return strings.Join(ids(got), ",")
	}
	if got := list(); got != "today" {
		t.Fatalf("before midnight = %q", got)
	}
	e.now = time.Date(2026, 10, 24, 21, 59, 0, 0, time.UTC) // 23:59 in Amsterdam
	if got := list(); got != "today" {
		t.Fatalf("just before local midnight = %q", got)
	}
	e.now = time.Date(2026, 10, 24, 22, 1, 0, 0, time.UTC) // 00:01 on the 25th in Amsterdam, although still the 24th in UTC
	if got := list(); got != "tomorrow" {
		t.Fatalf("just after local midnight = %q, want tomorrow only", got)
	}
	if e.compHits.Load() != 1 {
		t.Fatalf("the list changed by itself, without refetching: hits = %d", e.compHits.Load())
	}
}

func TestTodayWithoutCompetitionsIsAnEmptyList(t *testing.T) {
	e := newCatalogEnv(t, comp("old", "DEV", "SpeedSkating.LongTrack", "2026-10-20T10:00:00Z", "2026-10-20T12:00:00Z"))
	rec := httptest.NewRecorder()
	e.cat.ServeToday(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/competitions/today", nil))
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("status %d body %q, want 200 and []", rec.Code, rec.Body.String())
	}
}

func TestEndedCompetitionsAreKnownAfterTheyLeaveTheList(t *testing.T) {
	e := newCatalogEnv(t,
		comp("today", "DEV", "SpeedSkating.LongTrack", "2026-10-24T15:30:00Z", "2026-10-24T19:00:00Z"),
		comp("old", "DEV", "SpeedSkating.LongTrack", "2026-10-20T10:00:00Z", "2026-10-20T12:00:00Z"),
	)
	if _, err := e.cat.Today(context.Background()); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]bool{"today": false, "old": true, "never-listed": false} {
		if got := e.cat.Ended(id); got != want {
			t.Errorf("ended(%s) = %v, want %v", id, got, want)
		}
	}
	e.now = time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC) // two days later
	if !e.cat.Ended("today") {
		t.Error("a competition two days after its end is over, without refetching")
	}
}

func TestDataExpiresAfterTheRetentionSinceTheStart(t *testing.T) {
	e := newCatalogEnv(t,
		comp("day", "DEV", "SpeedSkating.LongTrack", "2026-10-24T08:00:00Z", "2026-10-24T17:00:00Z"),
		comp("weekend", "DEV", "SpeedSkating.LongTrack", "2026-10-24T08:00:00Z", "2026-10-25T17:00:00Z"),
	)
	e.cat.retention = 12 * time.Hour
	ids := func() string {
		got, err := e.cat.Today(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, m := range got {
			out = append(out, m.ID)
		}
		return strings.Join(out, ",")
	}
	e.now = time.Date(2026, 10, 24, 19, 0, 0, 0, time.UTC) // 11h after the start
	if e.cat.Ended("day") || ids() != "day,weekend" {
		t.Fatalf("before the retention: ended=%v list=%q", e.cat.Ended("day"), ids())
	}
	e.now = time.Date(2026, 10, 24, 20, 1, 0, 0, time.UTC) // 12h after the start
	if !e.cat.Ended("day") || e.cat.Ended("weekend") || ids() != "weekend" {
		t.Fatalf("after the retention: day ended=%v weekend ended=%v list=%q", e.cat.Ended("day"), e.cat.Ended("weekend"), ids())
	}
	e.now = time.Date(2026, 10, 25, 10, 0, 0, 0, time.UTC) // 12h after the start of the last day (Amsterdam midnight)
	if e.cat.Ended("weekend") {
		t.Fatal("a multi-day competition counts from the start of its last day")
	}
	e.now = time.Date(2026, 10, 25, 23, 0, 0, 0, time.UTC)
	if !e.cat.Ended("weekend") {
		t.Fatal("a multi-day competition expires after its last day")
	}
	e.cat.retention = 0
	e.now = time.Date(2026, 10, 24, 20, 1, 0, 0, time.UTC)
	if e.cat.Ended("day") {
		t.Fatal("no retention keeps the competition until the day after it ends")
	}
}

func TestCatalogMergesUpstreams(t *testing.T) {
	today := func(id string) string {
		return comp(id, "DEV", "SpeedSkating.LongTrack", "2026-10-24T15:30:00Z", "2026-10-24T19:00:00Z")
	}
	primary := newCatalogEnv(t, today("primary-1"), today("shared"))
	demo := newCatalogEnv(t, today("demo-1"), today("shared"))
	set := source.NewSet(
		source.Upstream{DataSourceURL: "http://real/Competition", CatalogURL: primary.cat.upstreams[0].base.String()},
		source.Upstream{DataSourceURL: "http://demo/Competition", CatalogURL: demo.cat.upstreams[0].base.String()},
	)
	cfg := config.Config{CatalogTTL: time.Hour, VenueCountry: "NED", VenueDiscipline: "SpeedSkating.LongTrack"}
	cat, err := New(cfg, set, fakeUA{})
	if err != nil {
		t.Fatal(err)
	}
	cat.now = func() time.Time { return primary.now }
	list, err := cat.Today(context.Background())
	if err != nil || len(list) != 3 {
		t.Fatalf("want the competitions of both upstreams, the shared one once: %v, %v", ids(list), err)
	}
	for id, want := range map[string]string{
		"demo-1":    "http://demo/Competition?competitionId=demo-1",
		"primary-1": "http://real/Competition?competitionId=primary-1",
		"shared":    "http://real/Competition?competitionId=shared",
	} {
		if got, _ := set.FeedURL(id); got != want {
			t.Errorf("%s is fetched from %q, want %q", id, got, want)
		}
	}

	// an upstream that goes away keeps its competitions; the other one still refreshes
	cat.upstreams[1].base.Host = "127.0.0.1:1"
	primary.now = primary.now.Add(2 * time.Hour)
	if list, err = cat.Today(context.Background()); err != nil || len(list) != 3 {
		t.Fatalf("a failing upstream keeps its data: %v, %v", ids(list), err)
	}

	// a competition asked for before anyone listed the competitions is still routed to its own upstream
	set2 := source.NewSet(
		source.Upstream{DataSourceURL: "http://real/Competition", CatalogURL: primary.cat.upstreams[0].base.String()},
		source.Upstream{DataSourceURL: "http://demo/Competition", CatalogURL: demo.cat.upstreams[0].base.String()},
	)
	cat2, err := New(cfg, set2, fakeUA{})
	if err != nil {
		t.Fatal(err)
	}
	cat2.now = func() time.Time { return primary.now }
	set2.Prepare(context.Background(), "demo-1")
	if got, _ := set2.FeedURL("demo-1"); got != "http://demo/Competition?competitionId=demo-1" {
		t.Errorf("demo-1 is fetched from %q before the list was requested", got)
	}
}

func TestServeTodayTellsWhichCompetitionsAreLive(t *testing.T) {
	var feedHits atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/api/venues", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(testVenues)) })
	mux.HandleFunc("/api/competitions", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("[" + comp("on", "DEV", "SpeedSkating.LongTrack", "2026-10-24T10:00:00Z", "2026-10-24T18:00:00Z") + "," +
			comp("off", "DEV", "SpeedSkating.LongTrack", "2026-10-24T11:00:00Z", "2026-10-24T18:00:00Z") + "," +
			comp("down", "DEV", "SpeedSkating.LongTrack", "2026-10-24T12:00:00Z", "2026-10-24T18:00:00Z") + "]"))
	})
	mux.HandleFunc("/feed", func(w http.ResponseWriter, r *http.Request) {
		feedHits.Add(1)
		switch r.URL.Query().Get("competitionId") {
		case "on":
			_, _ = w.Write([]byte(`{"success":true}`))
		case "off":
			_, _ = w.Write([]byte(`{"success":false,"errorMessage":"not live"}`))
		default:
			http.Error(w, "boom", http.StatusInternalServerError)
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	cfg := config.Config{CatalogTTL: time.Hour, VenueCountry: "NED", VenueDiscipline: "SpeedSkating.LongTrack"}
	cat, err := New(cfg, source.NewSet(source.Upstream{CatalogURL: srv.URL, DataSourceURL: srv.URL + "/feed"}), fakeUA{})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	cat.now = func() time.Time { return now }

	serve := func() map[string]bool {
		rec := httptest.NewRecorder()
		cat.ServeToday(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/competitions/today", nil))
		var list []struct {
			ID   string `json:"id"`
			Live bool   `json:"live"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
			t.Fatal(err)
		}
		got := map[string]bool{}
		for _, m := range list {
			got[m.ID] = m.Live
		}
		return got
	}
	got := serve()
	if len(got) != 3 || !got["on"] || got["off"] || got["down"] {
		t.Fatalf("live = %v, want only on", got)
	}
	serve()
	if feedHits.Load() != 3 {
		t.Fatalf("feed hits = %d, want 3 (the answer is reused)", feedHits.Load())
	}
	now = now.Add(liveTTL)
	serve()
	if feedHits.Load() != 6 {
		t.Fatalf("feed hits = %d, want 6 after the answers expired", feedHits.Load())
	}
}

func TestWatchTellsWhenTheListChanges(t *testing.T) {
	var live atomic.Bool
	mux := http.NewServeMux()
	mux.HandleFunc("/api/venues", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(testVenues)) })
	mux.HandleFunc("/api/competitions", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("[" + comp("m", "DEV", "SpeedSkating.LongTrack", "2026-10-24T10:00:00Z", "2026-10-24T18:00:00Z") + "]"))
	})
	mux.HandleFunc("/feed", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"success":` + strconv.FormatBool(live.Load()) + `}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	cfg := config.Config{CatalogTTL: time.Hour, VenueCountry: "NED", VenueDiscipline: "SpeedSkating.LongTrack"}
	cat, err := New(cfg, source.NewSet(source.Upstream{CatalogURL: srv.URL, DataSourceURL: srv.URL + "/feed"}), fakeUA{})
	if err != nil {
		t.Fatal(err)
	}
	var clock atomic.Int64 // seconds past noon; every tick of the watch moves the clock past the answers' lifetime
	base := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	cat.now = func() time.Time { return base.Add(time.Duration(clock.Load()) * time.Second) }

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	changes := make(chan struct{}, 4)
	go cat.Watch(ctx, time.Millisecond, func() int { return 1 }, func() { changes <- struct{}{} })

	step := func() { clock.Add(int64(liveTTL / time.Second)) }
	select {
	case <-changes:
		t.Fatal("told about a change before there was one")
	case <-time.After(50 * time.Millisecond):
	}
	live.Store(true)
	step()
	select {
	case <-changes:
	case <-time.After(2 * time.Second):
		t.Fatal("not told that the competition went live")
	}
}

func TestLiveStateIsAskedOnceForConcurrentCallers(t *testing.T) {
	var hits atomic.Int32
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		<-release
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	t.Cleanup(srv.Close)
	cfg := config.Config{CatalogTTL: time.Hour, VenueCountry: "NED", VenueDiscipline: "SpeedSkating.LongTrack"}
	cat, err := New(cfg, source.NewSet(source.Upstream{CatalogURL: srv.URL, DataSourceURL: srv.URL}), fakeUA{})
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan bool, 5)
	for range 5 {
		go func() { results <- cat.isLive(context.Background(), "m") }()
	}
	time.Sleep(100 * time.Millisecond)
	close(release)
	for range 5 {
		if !<-results {
			t.Fatal("want live")
		}
	}
	if hits.Load() != 1 {
		t.Fatalf("data source asked %d times, want 1", hits.Load())
	}
}
