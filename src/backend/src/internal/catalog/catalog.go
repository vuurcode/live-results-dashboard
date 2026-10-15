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
	"github.com/vuurcode/live-results-experiment/backend/internal/source"
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

// maxCacheAge caps how long venues and competitions are kept before they are fetched again, whatever the TTL says.
const maxCacheAge = time.Hour

// Catalog merges the competitions of the upstreams of a source set. Per upstream it fetches the venues at most once an
// hour and the competitions at most once per TTL (never more than an hour), both lazily on first use. A failed
// refresh keeps serving the old data.
type Catalog struct {
	set        *source.Set
	upstreams  []*upstream
	country    string
	discipline string
	ttl        time.Duration
	retention  time.Duration // see competition.expired
	ua         UserAgent
	client     *http.Client
	now        func() time.Time

	liveMu sync.Mutex
	live   map[string]liveState // what the data source said last, per competition id

	mu           sync.Mutex
	competitions []*competition
	known        map[string]*competition // every competition of the venues, also those no longer listed
	fetchedAt    time.Time
	lastFailed   time.Time
}

// upstream is what the catalog holds of one upstream; a failed fetch leaves it as it was.
type upstream struct {
	base         *url.URL
	venues       map[string]venue
	venuesAt     time.Time
	competitions []*competition // every competition of the venues
}

const retryAfterFailure = 30 * time.Second

// liveTTL is how long what the data source said about a competition is reused, so the list costs the data source at
// most one request per competition per period however often it is asked for.
const liveTTL = 30 * time.Second

type liveState struct {
	live bool
	at   time.Time
}

// New returns a catalog for the competitions lists of the set's upstreams.
func New(cfg config.Config, set *source.Set, ua UserAgent) (*Catalog, error) {
	c := &Catalog{
		set: set, country: cfg.VenueCountry, discipline: cfg.VenueDiscipline, ttl: min(cfg.CatalogTTL, maxCacheAge), retention: cfg.DataRetention,
		ua: ua, client: &http.Client{}, now: time.Now, live: map[string]liveState{},
	}
	for _, u := range set.Upstreams() {
		base, err := url.Parse(u.CatalogURL)
		if err != nil || base.Scheme == "" || base.Host == "" {
			return nil, fmt.Errorf("invalid match info base URL %q", u.CatalogURL)
		}
		c.upstreams = append(c.upstreams, &upstream{base: base})
	}
	set.SetLister(c.refresh)
	return c, nil
}

func (c *Catalog) getJSON(ctx context.Context, base *url.URL, path string, out any) error {
	u := *base
	u.Path = strings.TrimRight(u.Path, "/") + path
	return c.getURL(ctx, u.String(), path, out)
}

// getURL decodes the JSON at target; what names the request in errors.
func (c *Catalog) getURL(ctx context.Context, target, what string, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
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
		return fmt.Errorf("%s: HTTP %d", what, resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxBodyBytes)).Decode(out); err != nil {
		return fmt.Errorf("%s: decode: %w", what, err)
	}
	return nil
}

func (c *Catalog) loadVenues(ctx context.Context, u *upstream) error {
	var raw []rawVenue
	if err := c.getJSON(ctx, u.base, "/api/venues", &raw); err != nil {
		return err
	}
	venues := map[string]venue{}
	for _, v := range raw {
		if v.Code != "" && v.Address.CountryCode == c.country && v.Discipline == c.discipline {
			venues[v.Code] = venue{Code: v.Code, Name: v.Name, City: v.Address.City}
		}
	}
	u.venues = venues
	u.venuesAt = c.now()
	slog.Info("Venues loaded", "upstream", u.base.Host, "venues", len(venues), "country", c.country, "discipline", c.discipline)
	return nil
}

func (c *Catalog) loadCompetitions(ctx context.Context, u *upstream) error {
	var raw []rawCompetition
	if err := c.getJSON(ctx, u.base, "/api/competitions", &raw); err != nil {
		return err
	}
	var competitions []*competition
	for i := range raw {
		r := &raw[i]
		v, ok := u.venues[r.Venue.Code]
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
		competitions = append(competitions, m)
	}
	u.competitions = competitions
	slog.Info("Competitions loaded", "upstream", u.base.Host, "competitions", len(competitions), "of", len(raw))
	return nil
}

// refresh brings the cache up to date if needed. Callers hold no lock.
func (c *Catalog) refresh(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if !c.fetchedAt.IsZero() && now.Sub(c.fetchedAt) < c.ttl {
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

// reload refreshes every upstream and merges their competitions; an upstream that fails keeps what it had. It fails
// when none could be refreshed.
func (c *Catalog) reload(ctx context.Context) error {
	var errs []error
	for _, u := range c.upstreams {
		err := c.loadUpstream(ctx, u)
		if err != nil {
			slog.Error("Upstream refresh failed", "upstream", u.base.Host, "err", err)
			errs = append(errs, err)
		}
	}
	if len(errs) == len(c.upstreams) {
		return errors.Join(errs...)
	}
	c.merge()
	return nil
}

func (c *Catalog) loadUpstream(ctx context.Context, u *upstream) error {
	if u.venues == nil || c.now().Sub(u.venuesAt) >= maxCacheAge {
		if err := c.loadVenues(ctx, u); err != nil {
			if u.venues == nil {
				return err
			}
			slog.Warn("Venues refresh failed, keeping the earlier ones", "upstream", u.base.Host, "err", err)
		}
	}
	return c.loadCompetitions(ctx, u)
}

// merge combines the competitions of the upstreams, the first upstream winning when two list the same id, and tells the
// source set which upstream lists what.
func (c *Catalog) merge() {
	now := c.now()
	known := map[string]*competition{}
	owner := map[string]int{}
	var listed []*competition
	for i, u := range c.upstreams {
		for _, m := range u.competitions {
			if _, dup := known[m.ID]; dup {
				continue
			}
			known[m.ID] = m
			owner[m.ID] = i
			if m.active(now) {
				listed = append(listed, m)
			}
		}
	}
	sort.Slice(listed, func(i, j int) bool { return listed[i].from.Before(listed[j].from) })
	c.competitions = listed
	c.known = known
	c.fetchedAt = now
	c.set.SetOwners(owner)
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

// isLive asks the data source whether the competition is live: it answers and does not say otherwise. A failed
// request counts as not live. The answer is reused for liveTTL.
func (c *Catalog) isLive(ctx context.Context, id string) bool {
	c.liveMu.Lock()
	st, ok := c.live[id]
	c.liveMu.Unlock()
	if ok && c.now().Sub(st.at) < liveTTL {
		return st.live
	}
	live := c.probe(ctx, id)
	c.liveMu.Lock()
	c.live[id] = liveState{live: live, at: c.now()}
	c.liveMu.Unlock()
	return live
}

func (c *Catalog) probe(ctx context.Context, id string) bool {
	feed, err := c.set.FeedURL(id)
	if err != nil {
		return false
	}
	var raw struct {
		Success *bool `json:"success"` // false when the competition is not live; absent in older payloads
	}
	if err := c.getURL(ctx, feed, "live results", &raw); err != nil {
		return false
	}
	return raw.Success == nil || *raw.Success
}

// listed is a competition of the list with what the data source says about it.
type listed struct {
	*competition
	Live bool `json:"live"`
}

// ServeToday answers with the competitions of today, each saying whether it is live.
func (c *Catalog) ServeToday(w http.ResponseWriter, r *http.Request) {
	list, err := c.Today(r.Context())
	if err != nil {
		http.Error(w, "competition list unavailable", http.StatusBadGateway)
		return
	}
	out := make([]listed, len(list))
	var wg sync.WaitGroup
	for i, m := range list {
		out[i].competition = m
		wg.Add(1)
		go func() {
			defer wg.Done()
			out[i].Live = c.isLive(r.Context(), m.ID)
		}()
	}
	wg.Wait()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=30")
	_ = json.NewEncoder(w).Encode(out)
}

// Watch checks every `every` whether the list of today, or which of its competitions are live, changed since the
// previous check, and calls changed when it did. It only looks while active reports clients, so that nobody is
// polled for no one. It returns when ctx ends.
func (c *Catalog) Watch(ctx context.Context, every time.Duration, active func() int, changed func()) {
	t := time.NewTicker(every)
	defer t.Stop()
	var last string
	seen := false
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if active() == 0 {
			seen = false // what was seen before nobody was there says nothing about what changed since
			continue
		}
		list, err := c.Today(ctx)
		if err != nil {
			continue
		}
		var sig strings.Builder
		for _, m := range list {
			fmt.Fprintf(&sig, "%s:%t,", m.ID, c.isLive(ctx, m.ID))
		}
		if seen && sig.String() != last {
			changed()
		}
		last, seen = sig.String(), true
	}
}
