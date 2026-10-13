package main

import (
	"net/http"
	"testing"
	"time"
)

func TestFetchDelay(t *testing.T) {
	const second = time.Second
	cases := []struct {
		name       string
		interval   time.Duration
		failures   int
		retryAfter time.Duration
		jitter     float64
		want       time.Duration
	}{
		{"a success waits the interval", 5 * second, 0, 0, 1, 5 * second},
		{"a success is spread by the jitter too", 4 * second, 0, 0, 1.25, 5 * second},
		{"every failure doubles the wait", 5 * second, 3, 0, 1, 40 * second},
		{"the wait stops growing at the cap", 5 * second, 20, 0, 1, time.Minute},
		{"an interval above the cap is not shortened", 2 * time.Minute, 4, 0, 1, 2 * time.Minute},
		{"the data source's Retry-After is the minimum", 5 * second, 1, 90 * second, 1, 90 * second},
		{"a shorter Retry-After changes nothing", 5 * second, 3, 10 * second, 1, 40 * second},
		{"jitter spreads the retries", 10 * second, 1, 0, 0.8, 16 * second},
	}
	for _, c := range cases {
		if got := fetchDelay(c.interval, c.failures, c.retryAfter, c.jitter); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestRandomJitterRange(t *testing.T) {
	for range 1000 {
		if j := randomJitter(); j < 0.75 || j >= 1.25 {
			t.Fatalf("jitter %v outside [0.75, 1.25)", j)
		}
	}
}

func TestParseRetryAfter(t *testing.T) {
	for header, want := range map[string]time.Duration{
		"":                              0,
		"30":                            30 * time.Second,
		"0":                             0,
		"-5":                            0,
		"soon":                          0,
		"Wed, 21 Oct 2026 07:28:00 GMT": 0,
		"99999":                         maxRetryAfter,
	} {
		h := http.Header{}
		if header != "" {
			h.Set("Retry-After", header)
		}
		if got := parseRetryAfter(h); got != want {
			t.Errorf("Retry-After %q: got %v, want %v", header, got, want)
		}
	}
}

func TestFailingDataSourceIsAskedLessOften(t *testing.T) {
	tb := newTestBackend(t, func(c *config) { c.dataSourceInterval = 0.05 })
	tb.mu.Lock()
	tb.status = http.StatusServiceUnavailable
	tb.mu.Unlock()
	conn, _, err := tb.dial(t, t.Context(), "?competitionId=slow", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.CloseNow() }()
	time.Sleep(2 * time.Second)
	// at the plain 50 ms interval this would be about 40 requests; doubling gives 0, 50, 100, 200, 400, 800 ms: about 6
	if hits := tb.hitCount("slow"); hits > 10 {
		t.Fatalf("%d requests in 2s to a failing data source, expected it to back off", hits)
	}
}
