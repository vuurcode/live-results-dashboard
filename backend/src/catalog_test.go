package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testVenues = `[
 {"address":{"city":"Deventer","countryCode":"NED"},"name":"Scheg","code":"DEV","discipline":"SpeedSkating.LongTrack"},
 {"address":{"city":"Deventer","countryCode":"NED"},"name":"Skeelerbaan","code":"DEV","discipline":"SpeedSkating.Inline"},
 {"address":{"city":"Berlin","countryCode":"GER"},"name":"Berlin","code":"BER","discipline":"SpeedSkating.LongTrack"}
]`

func comp(id, venue, discipline, starts, ends string) string {
	return `{"id":"` + id + `","code":"C-` + id + `","name":"Match ` + id + `","venue":{"code":"` + venue + `"},
	 "discipline":"` + discipline + `","timeZone":"W. Europe Standard Time","extra":"note","allowToSendLive":true,
	 "starts":"` + starts + `","ends":"` + ends + `","settings":{"paymentProviderKey":"SECRET","contact":{"email":"a@b.c"}}}`
}

type catalogEnv struct {
	cat                 *catalog
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
	cfg := config{catalogURL: srv.URL, catalogTTL: time.Hour, venueCountry: "NED", venueDiscipline: "SpeedSkating.LongTrack"}
	cat, err := newCatalog(cfg, &userAgent{})
	if err != nil {
		t.Fatal(err)
	}
	cat.now = func() time.Time { return e.now }
	e.cat = cat
	return e
}

func ids(list []*match) []string {
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
	got, err := e.cat.today(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// today-late ends 00:30 local on the 25th, so it spans today and tomorrow: listed today too.
	if want := []string{"today-evening", "today-late"}; strings.Join(ids(got), ",") != strings.Join(want, ",") {
		t.Fatalf("today = %v, want %v", ids(got), want)
	}
	// kept (not listed) until the day after: yesterday stays cached, old is dropped, tomorrow is cached
	cached := map[string]bool{}
	for _, m := range e.cat.matches {
		cached[m.ID] = true
	}
	for id, want := range map[string]bool{"yesterday": true, "tomorrow": true, "old": false, "inline": false, "berlin": false} {
		if cached[id] != want {
			t.Errorf("cached[%s] = %v, want %v", id, cached[id], want)
		}
	}
	if m := got[0]; m.Venue != (venue{Code: "DEV", Name: "Scheg", City: "Deventer"}) || m.Extra != "note" || !m.AllowToSendLive {
		t.Errorf("unexpected match fields: %+v", m)
	}
}

func TestCatalogBeforeStartListedAndNoSecrets(t *testing.T) {
	e := newCatalogEnv(t, comp("later", "DEV", "SpeedSkating.LongTrack", "2026-10-24T20:00:00Z", "2026-10-24T21:00:00Z"))
	e.now = time.Date(2026, 10, 24, 5, 0, 0, 0, time.UTC)
	rec := httptest.NewRecorder()
	e.cat.serveToday(rec, httptest.NewRequest(http.MethodGet, "/api/matches/today", nil))
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
		if _, err := e.cat.today(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if e.venueHits.Load() != 1 || e.compHits.Load() != 1 {
		t.Fatalf("hits venues=%d competitions=%d, want 1/1", e.venueHits.Load(), e.compHits.Load())
	}
	e.now = e.now.Add(25 * time.Hour)
	if _, err := e.cat.today(context.Background()); err != nil {
		t.Fatal(err)
	}
	if e.venueHits.Load() != 1 || e.compHits.Load() != 2 {
		t.Fatalf("after TTL hits venues=%d competitions=%d, want 1/2", e.venueHits.Load(), e.compHits.Load())
	}
}

func TestCatalogKeepsStaleDataOnFailure(t *testing.T) {
	e := newCatalogEnv(t, comp("m", "DEV", "SpeedSkating.LongTrack", "2026-10-24T15:30:00Z", "2026-10-24T19:00:00Z"))
	if _, err := e.cat.today(context.Background()); err != nil {
		t.Fatal(err)
	}
	e.cat.base.Host = "127.0.0.1:1" // unreachable
	e.now = e.now.Add(25 * time.Hour)
	if _, err := e.cat.today(context.Background()); err != nil {
		t.Fatalf("stale data should be served on refresh failure: %v", err)
	}
}

func TestOriginOfAndZones(t *testing.T) {
	if got := originOf("https://example.test/api/data?x=1"); got != "https://example.test" {
		t.Errorf("originOf = %q", got)
	}
	for _, in := range []string{"https://example.test", "https://example.test/", "https://example.test:8443/x/"} {
		if got := originOf(in); !strings.HasPrefix(in, got) || strings.Count(got, "/") != 2 {
			t.Errorf("originOf(%q) = %q", in, got)
		}
	}
	if got := originOf("https://example.test/Competition/{id}"); got != "https://example.test" {
		t.Errorf("originOf with {id} = %q", got)
	}
	if got := loadZone("W. Europe Standard Time").String(); got != "Europe/Amsterdam" {
		t.Errorf("zone = %q", got)
	}
	if got := loadZone("Europe/Berlin").String(); got != "Europe/Berlin" {
		t.Errorf("iana zone = %q", got)
	}
	if got := loadZone("Nowhere Standard Time"); got != time.UTC {
		t.Errorf("unknown zone = %v", got)
	}
}

func TestCatalogBaseWithAndWithoutTrailingSlash(t *testing.T) {
	for _, suffix := range []string{"", "/"} {
		e := newCatalogEnv(t, comp("m", "DEV", "SpeedSkating.LongTrack", "2026-10-24T15:30:00Z", "2026-10-24T19:00:00Z"))
		cfg := config{catalogURL: e.cat.base.String() + suffix, catalogTTL: time.Hour, venueCountry: "NED", venueDiscipline: "SpeedSkating.LongTrack"}
		cat, err := newCatalog(cfg, &userAgent{})
		if err != nil {
			t.Fatal(err)
		}
		cat.now = func() time.Time { return e.now }
		if list, err := cat.today(context.Background()); err != nil || len(list) != 1 {
			t.Errorf("catalog URL suffix %q: %v, %v", suffix, ids(list), err)
		}
	}
}
