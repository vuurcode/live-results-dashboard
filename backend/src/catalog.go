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
	"sort"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // the scratch container has no zoneinfo; competitions carry their own time zone
)

// A venue is kept by code only; venue codes repeat across disciplines, so the
// discipline filter is what makes the code unique.
type venue struct {
	Code string `json:"code"`
	Name string `json:"name"`
	City string `json:"city"`
}

// match is one competition as shown to clients. Only these fields are decoded
// from the upstream, so nothing else (contacts, payment settings) is ever held.
type match struct {
	ID              string `json:"id"`
	Code            string `json:"code"`
	Name            string `json:"name"`
	Start           string `json:"start"`
	End             string `json:"end,omitempty"`
	Extra           string `json:"extra,omitempty"`
	AllowToSendLive bool   `json:"allowToSendLive"`
	Venue           venue  `json:"venue"`

	zone *time.Location
	from time.Time
	to   time.Time
}

type rawVenue struct {
	Address struct {
		City        string `json:"city"`
		CountryCode string `json:"countryCode"`
	} `json:"address"`
	Name       string `json:"name"`
	Code       string `json:"code"`
	Discipline string `json:"discipline"`
}

type rawCompetition struct {
	Venue struct {
		Code string `json:"code"`
	} `json:"venue"`
	Code            string    `json:"code"`
	ID              string    `json:"id"`
	Name            string    `json:"name"`
	Extra           *string   `json:"extra"`
	AllowToSendLive bool      `json:"allowToSendLive"`
	Discipline      string    `json:"discipline"`
	TimeZone        string    `json:"timeZone"`
	Starts          time.Time `json:"starts"`
	Ends            time.Time `json:"ends"`
}

// windowsZones maps the Windows zone names the upstream uses to IANA names.
// Names that are already IANA ids load directly.
var windowsZones = map[string]string{
	"UTC":                            "UTC",
	"GMT Standard Time":              "Europe/London",
	"W. Europe Standard Time":        "Europe/Amsterdam",
	"Central Europe Standard Time":   "Europe/Budapest",
	"Central European Standard Time": "Europe/Warsaw",
	"Romance Standard Time":          "Europe/Paris",
	"E. Europe Standard Time":        "Europe/Chisinau",
	"FLE Standard Time":              "Europe/Kiev",
	"GTB Standard Time":              "Europe/Bucharest",
	"Russian Standard Time":          "Europe/Moscow",
	"Mountain Standard Time":         "America/Denver",
	"Central Standard Time":          "America/Chicago",
	"Eastern Standard Time":          "America/New_York",
	"Pacific Standard Time":          "America/Los_Angeles",
}

func loadZone(competition, name string) *time.Location {
	if iana, ok := windowsZones[name]; ok {
		name = iana
	} else if name == "undefined" || strings.HasPrefix(name, "W. Europe") {
		// the upstream sends the text "undefined" for some competitions and may name the Dutch zone with another suffix;
		// the dashboard only lists Dutch venues
		name = "Europe/Amsterdam"
	}
	if loc, err := time.LoadLocation(name); err == nil && name != "" {
		return loc
	}
	slog.Warn("Unknown time zone, using UTC", "competition", competition, "zone", name)
	return time.UTC
}

func (m *match) active(now time.Time) bool {
	return m.window(now) != windowPast
}

type window int

const (
	windowPast   window = iota // more than a day after the match ended
	windowAfter                // the day after the match ended (still kept)
	windowToday                // a day of the match
	windowFuture               // before the match
)

// window places the match relative to now in the match's own time zone. A match
// is kept until the local day after it ends, then dropped.
func (m *match) window(now time.Time) window {
	y, mo, d := now.In(m.zone).Date()
	today := time.Date(y, mo, d, 0, 0, 0, 0, time.UTC)
	first := localDay(m.from, m.zone)
	last := localDay(m.to, m.zone)
	switch {
	case today.After(last.AddDate(0, 0, 1)):
		return windowPast
	case today.After(last):
		return windowAfter
	case today.Before(first):
		return windowFuture
	default:
		return windowToday
	}
}

func localDay(t time.Time, loc *time.Location) time.Time {
	y, mo, d := t.In(loc).Date()
	return time.Date(y, mo, d, 0, 0, 0, 0, time.UTC)
}

// catalog fetches venues once (kept forever) and competitions at most once per
// TTL, both lazily on first use. A failed refresh keeps serving the old data.
type catalog struct {
	base       *url.URL
	country    string
	discipline string
	ttl        time.Duration
	ua         *userAgent
	client     *http.Client
	now        func() time.Time

	mu         sync.Mutex
	venues     map[string]venue
	matches    []*match
	known      map[string]*match // every match of the venues, also those no longer listed
	fetchedAt  time.Time
	lastFailed time.Time
}

const retryAfterFailure = 30 * time.Second

func newCatalog(cfg config, ua *userAgent) (*catalog, error) {
	base, err := url.Parse(cfg.catalogURL)
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil, fmt.Errorf("invalid MATCH_INFO_BASE_URL %q", cfg.catalogURL)
	}
	return &catalog{
		base: base, country: cfg.venueCountry, discipline: cfg.venueDiscipline, ttl: cfg.catalogTTL,
		ua: ua, client: &http.Client{}, now: time.Now,
	}, nil
}

func (c *catalog) getJSON(ctx context.Context, path string, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	u := *c.base
	u.Path = strings.TrimRight(u.Path, "/") + path
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	if ua := c.ua.get(); ua != "" {
		req.Header.Set("User-Agent", ua)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: HTTP %d", path, resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxBodyBytes)).Decode(out); err != nil {
		return fmt.Errorf("%s: decode: %w", path, err)
	}
	return nil
}

func (c *catalog) loadVenues(ctx context.Context) error {
	var raw []rawVenue
	if err := c.getJSON(ctx, "/api/venues", &raw); err != nil {
		return err
	}
	venues := map[string]venue{}
	for _, v := range raw {
		if v.Code != "" && v.Address.CountryCode == c.country && v.Discipline == c.discipline {
			venues[v.Code] = venue{Code: v.Code, Name: v.Name, City: v.Address.City}
		}
	}
	c.venues = venues
	slog.Info("Venues loaded", "venues", len(venues), "country", c.country, "discipline", c.discipline)
	return nil
}

func (c *catalog) loadMatches(ctx context.Context) error {
	var raw []rawCompetition
	if err := c.getJSON(ctx, "/api/competitions", &raw); err != nil {
		return err
	}
	now := c.now()
	var matches []*match
	known := map[string]*match{}
	for i := range raw {
		r := &raw[i]
		v, ok := c.venues[r.Venue.Code]
		if !ok || r.Discipline != c.discipline || !competitionIDRe.MatchString(r.ID) {
			continue
		}
		m := &match{
			ID: r.ID, Code: r.Code, Name: r.Name, AllowToSendLive: r.AllowToSendLive, Venue: v,
			Start: r.Starts.UTC().Format(time.RFC3339), zone: loadZone(r.ID, r.TimeZone), from: r.Starts, to: r.Ends,
		}
		if r.Extra != nil {
			m.Extra = *r.Extra
		}
		if !r.Ends.IsZero() {
			m.End = r.Ends.UTC().Format(time.RFC3339)
		} else {
			m.to = r.Starts
		}
		known[m.ID] = m
		if m.active(now) {
			matches = append(matches, m)
		}
	}
	sort.Slice(matches, func(i, j int) bool { return matches[i].from.Before(matches[j].from) })
	c.matches = matches
	c.known = known
	c.fetchedAt = now
	slog.Info("Competitions loaded", "listed", len(matches), "of", len(raw))
	return nil
}

// refresh brings the cache up to date if needed. Callers hold no lock.
func (c *catalog) refresh(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if c.venues != nil && !c.fetchedAt.IsZero() && now.Sub(c.fetchedAt) < c.ttl {
		return nil
	}
	if !c.lastFailed.IsZero() && now.Sub(c.lastFailed) < retryAfterFailure {
		if c.fetchedAt.IsZero() {
			return errors.New("catalog unavailable, retrying shortly")
		}
		return nil // stale data is better than none
	}
	// the fetch is shared by every waiting caller, so one caller disconnecting must not cancel it
	err := c.reload(context.WithoutCancel(ctx))
	if err != nil {
		c.lastFailed = now
		slog.Error("Catalog refresh failed", "err", err)
		if c.fetchedAt.IsZero() {
			return err
		}
		return nil
	}
	c.lastFailed = time.Time{}
	return nil
}

func (c *catalog) reload(ctx context.Context) error {
	if c.venues == nil {
		if err := c.loadVenues(ctx); err != nil {
			return err
		}
	}
	return c.loadMatches(ctx)
}

// ended reports whether id is a match that is over for good (more than a day after it ended). An id the catalog has
// never seen is not ended: it may be a competition the list does not carry.
func (c *catalog) ended(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	m, ok := c.known[id]
	return ok && m.window(c.now()) == windowPast
}

// today lists the matches whose local days include today, including those that have not started yet.
func (c *catalog) today(ctx context.Context) ([]*match, error) {
	if err := c.refresh(ctx); err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	out := []*match{}
	for _, m := range c.matches {
		if m.window(now) == windowToday {
			out = append(out, m)
		}
	}
	return out, nil
}

func (c *catalog) serveToday(w http.ResponseWriter, r *http.Request) {
	list, err := c.today(r.Context())
	if err != nil {
		http.Error(w, "match list unavailable", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=60")
	_ = json.NewEncoder(w).Encode(list)
}
