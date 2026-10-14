// Package ratelimit limits how often, and how many at once, one client may connect.
package ratelimit

import (
	"sync"
	"time"
)

const (
	// maxKeys bounds the memory a flood of distinct clients can take; further clients share one entry until others expire.
	maxKeys = 100_000
	// overflowKey is the shared entry of clients that do not fit in the table, so a flood cannot switch the limit off.
	overflowKey = "\x00overflow"
	// pruneEvery is how often entries that have fully recovered are dropped.
	pruneEvery = time.Minute
	// busyRetry is the advice given to a client that holds its maximum number of connections.
	busyRetry = 5 * time.Second
)

// Limiter gives every key (a client address) a token bucket of connection attempts and a cap on connections held at once.
type Limiter struct {
	perSecond float64 // tokens added per second
	burst     float64 // bucket size: attempts allowed back to back
	maxOpen   int

	// Now is the clock; tests replace it.
	Now func() time.Time

	mu        sync.Mutex
	entries   map[string]*entry
	lastPrune time.Time
}

type entry struct {
	tokens float64
	at     time.Time // when tokens was last brought up to date
	open   int
}

// New returns a limiter that allows perMinute attempts per key on average, burst back to back, and maxOpen open at once.
func New(perMinute float64, burst, maxOpen int) *Limiter {
	return &Limiter{perSecond: perMinute / 60, burst: float64(burst), maxOpen: maxOpen, Now: time.Now, entries: map[string]*entry{}}
}

// Acquire books an attempt for key. When it is allowed, the returned function must be called once the connection ends.
// Otherwise retryAfter says how long to wait.
func (l *Limiter) Acquire(key string) (release func(), retryAfter time.Duration, ok bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.Now()
	l.pruneLocked(now)

	e, found := l.entries[key]
	if !found {
		if len(l.entries) >= maxKeys {
			key = overflowKey
			e, found = l.entries[key]
		}
		if !found {
			e = &entry{tokens: l.burst, at: now}
			l.entries[key] = e
		}
	}
	e.tokens = min(l.burst, e.tokens+now.Sub(e.at).Seconds()*l.perSecond)
	e.at = now

	if e.tokens < 1 {
		return nil, time.Duration((1 - e.tokens) / l.perSecond * float64(time.Second)), false
	}
	e.tokens-- // attempts that are then refused for being too many at once still use up a token
	if e.open >= l.maxOpen {
		return nil, busyRetry, false
	}
	e.open++
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			e.open--
		})
	}, 0, true
}

// pruneLocked drops entries that hold no connection and whose bucket is full again, as a new entry would be.
func (l *Limiter) pruneLocked(now time.Time) {
	if now.Sub(l.lastPrune) < pruneEvery {
		return
	}
	l.lastPrune = now
	for key, e := range l.entries {
		if e.open == 0 && e.tokens+now.Sub(e.at).Seconds()*l.perSecond >= l.burst {
			delete(l.entries, key)
		}
	}
}

// Len is the number of keys currently tracked.
func (l *Limiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.entries)
}
