// Package useragent decides which User-Agent the backend sends to the data source.
package useragent

import (
	"net/http"
	"sync"
	"unicode"
)

const maxLength = 256

// Mirror is the User-Agent sent on outbound fetches: the BACKEND_USER_AGENT setting when given,
// otherwise the most recent inbound User-Agent, mirrored onto outbound
// live results fetches — some upstream data sources apply UA-based bot
// filtering and reject the default Go identifier.
type Mirror struct {
	mu    sync.RWMutex
	ua    string
	fixed string // BACKEND_USER_AGENT: when set it is always sent and nothing is mirrored
}

// New returns a Mirror that always sends fixed when it is not empty (BACKEND_USER_AGENT).
func New(fixed string) *Mirror { return &Mirror{fixed: Sanitize(fixed)} }

// Set records an inbound User-Agent to mirror, unless a fixed one is configured.
func (u *Mirror) Set(ua string) {
	if u.fixed != "" {
		return
	}
	if s := Sanitize(ua); s != "" {
		u.mu.Lock()
		u.ua = s
		u.mu.Unlock()
	}
}

// Get is the User-Agent to send on outbound requests; empty when none is known yet.
func (u *Mirror) Get() string {
	if u.fixed != "" {
		return u.fixed
	}
	u.mu.RLock()
	defer u.mu.RUnlock()
	return u.ua
}

// Sanitize strips non-printable characters (CR/LF included) and caps
// the length before an unauthenticated inbound header is reused as an outbound one.
func Sanitize(ua string) string {
	out := make([]rune, 0, len(ua))
	for _, r := range ua {
		if unicode.IsPrint(r) {
			out = append(out, r)
			if len(out) == maxLength {
				break
			}
		}
	}
	return string(out)
}

// Middleware mirrors the User-Agent of every inbound request.
func (u *Mirror) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ua := r.Header.Get("User-Agent"); ua != "" {
			u.Set(ua)
		}
		next.ServeHTTP(w, r)
	})
}
