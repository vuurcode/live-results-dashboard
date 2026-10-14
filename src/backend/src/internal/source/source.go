// Package source describes where the backend reads its competitions from: a primary upstream and, optionally, an extra
// one (such as the demo mockserver) whose competitions are merged into the list.
package source

import (
	"net/url"
	"sync"
)

// Upstream is one service serving a competitions list and the live results of those competitions.
type Upstream struct {
	DataSourceURL string // the live results URL; `competitionId=<id>` is added as a query parameter
	CatalogURL    string // base URL serving /api/venues and /api/competitions
}

// FeedURL builds the live results URL for one competition.
func (u Upstream) FeedURL(id string) (string, error) {
	p, err := url.Parse(u.DataSourceURL)
	if err != nil {
		return "", err
	}
	if p.Path == "" {
		p.Path = "/" // `https://host` and `https://host/` are the same request; send the path explicitly
	}
	q := p.Query()
	q.Set("competitionId", id)
	p.RawQuery = q.Encode()
	return p.String(), nil
}

// Set is the upstreams in priority order and which of them lists which competition. A competition listed by several
// upstreams belongs to the first.
type Set struct {
	upstreams []Upstream

	mu    sync.RWMutex
	owner map[string]int
}

// NewSet returns a set of at least the primary upstream.
func NewSet(upstreams ...Upstream) *Set {
	return &Set{upstreams: upstreams}
}

func (s *Set) Upstreams() []Upstream { return s.upstreams }

// SetOwners replaces the record of which upstream (an index into Upstreams) lists each competition.
func (s *Set) SetOwners(owner map[string]int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.owner = owner
}

// FeedURL builds the live results URL for a competition from the upstream that lists it; a competition nobody has
// listed (yet) is requested from the primary upstream.
func (s *Set) FeedURL(id string) (string, error) {
	s.mu.RLock()
	i := s.owner[id]
	s.mu.RUnlock()
	return s.upstreams[i].FeedURL(id)
}
