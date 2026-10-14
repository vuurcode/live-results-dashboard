// Package catalog lists the venues and competitions of the venue country and discipline, and says which are over.
package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // the scratch container has no zoneinfo; competitions carry their own time zone

	"github.com/vuurcode/live-results-experiment/backend/internal/config"
)

const maxBodyBytes = 64 << 20

// Ids end up in an outbound URL, so only a conservative charset is accepted.
var idRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// ValidID reports whether id may be used as a competition id.
func ValidID(id string) bool { return idRe.MatchString(id) }

// UserAgent supplies the User-Agent header for outbound requests; an empty string sends none.
type UserAgent interface {
	Get() string
}

// A venue is kept by code only; venue codes repeat across disciplines, so the
// discipline filter is what makes the code unique.
type venue struct {
	Code string `json:"code"`
	Name string `json:"name"`
	City string `json:"city"`
}

// competition is one competition as shown to clients. Only these fields are decoded
// from the upstream, so nothing else (contacts, payment settings) is ever held.
type competition struct {
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

// expired reports whether the competition started longer than retention ago, so its data is no longer served. A
// competition of several days counts from the start of its last day. A zero retention never expires.
func (m *competition) expired(now time.Time, retention time.Duration) bool {
	if retention <= 0 || m.from.IsZero() {
		return false
	}
	begin := m.from
	if lastDay := localDay(m.to, m.zone); lastDay.After(localDay(m.from, m.zone)) {
		begin = time.Date(lastDay.Year(), lastDay.Month(), lastDay.Day(), 0, 0, 0, 0, m.zone)
	}
	return now.After(begin.Add(retention))
}

func (m *competition) active(now time.Time) bool {
	return m.window(now) != windowPast
}

type window int

const (
	windowPast   window = iota // more than a day after the competition ended
	windowAfter                // the day after the competition ended (still kept)
	windowToday                // a day of the competition
	windowFuture               // before the competition
)

// window places the competition relative to now in the competition's own time zone. A competition
// is kept until the local day after it ends, then dropped.
func (m *competition) window(now time.Time) window {
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

// Catalog fetches venues once (kept forever) and competitions at most once per
// TTL, both lazily on first use. A failed refresh keeps serving the old data.
type Catalog struct {
	base       *url.URL
	country    string
	discipline string
	ttl        time.Duration
	retention  time.Duration // see competition.expired
	ua         UserAgent
	client     *http.Client
	now        func() time.Time

	mu           sync.Mutex
	venues       map[string]venue
	competitions []*competition
	known        map[string]*competition // every competition of the venues, also those no longer listed
	fetchedAt    time.Time
	lastFailed   time.Time
}

const retryAfterFailure = 30 * time.Second

// New returns a catalog for the competitions list served at cfg.CatalogURL.
func New(cfg config.Config, ua UserAgent) (*Catalog, error) {
	base, err := url.Parse(cfg.CatalogURL)
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil, fmt.Errorf("invalid BACKEND_MATCH_INFO_BASE_URL %q", cfg.CatalogURL)
	}
	return &Catalog{
		base: base, country: cfg.VenueCountry, discipline: cfg.VenueDiscipline, ttl: cfg.CatalogTTL, retention: cfg.DataRetention,
		ua: ua, client: &http.Client{}, now: time.Now,
	}, nil
}

func (c *Catalog) getJSON(ctx context.Context, path string, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	u := *c.base
	u.Path = strings.TrimRight(u.Path, "/") + path
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	if ua := c.ua.Get(); ua != "" {
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

func (c *Catalog) loadVenues(ctx context.Context) error {
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

func (c *Catalog) loadCompetitions(ctx context.Context) error {
	var raw []rawCompetition
	if err := c.getJSON(ctx, "/api/competitions", &raw); err != nil {
		return err
	}
	now := c.now()
	var competitions []*competition
	known := map[string]*competition{}
	for i := range raw {
		r := &raw[i]
		v, ok := c.venues[r.Venue.Code]
		if !ok || r.Discipline != c.discipline || !ValidID(r.ID) {
			continue
		}
		m := &competition{
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
			competitions = append(competitions, m)
		}
	}
	sort.Slice(competitions, func(i, j int) bool { return competitions[i].from.Before(competitions[j].from) })
	c.competitions = competitions
	c.known = known
	c.fetchedAt = now
	slog.Info("Competitions loaded", "listed", len(competitions), "of", len(raw))
	return nil
}

// refresh brings the cache up to date if needed. Callers hold no lock.
func (c *Catalog) refresh(ctx context.Context) error {
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

func (c *Catalog) reload(ctx context.Context) error {
	if c.venues == nil {
		if err := c.loadVenues(ctx); err != nil {
			return err
		}
	}
	return c.loadCompetitions(ctx)
}

// ended reports whether id is a competition that is over for good: it expired (see competition.expired) or ended more
// than a day ago. An id the catalog has never seen is not ended: it may be a competition the list does not carry.
// Ended reports whether a competition is over for good.
func (c *Catalog) Ended(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	m, ok := c.known[id]
	return ok && (m.window(c.now()) == windowPast || m.expired(c.now(), c.retention))
}

// today lists the competitions whose local days include today, including those that have not started yet.
func (c *Catalog) Today(ctx context.Context) ([]*competition, error) {
	if err := c.refresh(ctx); err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	out := []*competition{}
	for _, m := range c.competitions {
		if m.window(now) == windowToday && !m.expired(now, c.retention) {
			out = append(out, m)
		}
	}
	return out, nil
}

// ServeToday answers with the competitions of today.
func (c *Catalog) ServeToday(w http.ResponseWriter, r *http.Request) {
	list, err := c.Today(r.Context())
	if err != nil {
		http.Error(w, "competition list unavailable", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=60")
	_ = json.NewEncoder(w).Encode(list)
}
