package fetch

import (
	"fmt"
	"math/rand/v2"
	"net/http"
	"strconv"
	"time"
)

const (
	// maxFetchBackoff caps the wait between fetches while the data source keeps failing.
	maxFetchBackoff = time.Minute
	// maxRetryAfter caps how long a Retry-After from the data source is obeyed.
	maxRetryAfter = 5 * time.Minute
	// logEveryFailures: of a run of failed fetches, the first and every n-th is logged.
	logEveryFailures = 10
)

// statusError is a fetch answered with an HTTP status other than 200.
type statusError struct {
	code       int
	retryAfter time.Duration // from the Retry-After header; 0 when absent
}

func (e *statusError) Error() string { return fmt.Sprintf("HTTP %d", e.code) }

// parseRetryAfter reads a Retry-After given in seconds; dates and junk count as absent.
func parseRetryAfter(h http.Header) time.Duration {
	secs, err := strconv.Atoi(h.Get("Retry-After"))
	if err != nil || secs <= 0 {
		return 0
	}
	return min(time.Duration(secs)*time.Second, maxRetryAfter)
}

// fetchDelay is the wait before the next fetch: the normal interval after a success, doubled for every failure in a row
// (up to maxFetchBackoff), and never shorter than what the data source asked for. The jitter, a factor around 1 (see
// randomJitter), keeps the competitions from polling the data source in step.
func fetchDelay(interval time.Duration, failures int, retryAfter time.Duration, jitter float64) time.Duration {
	delay := interval
	for i := 0; i < failures && delay < maxFetchBackoff; i++ {
		delay *= 2
	}
	delay = min(delay, max(maxFetchBackoff, interval))
	delay = max(delay, retryAfter)
	return time.Duration(float64(delay) * jitter)
}

// randomJitter returns a factor in [0.75, 1.25).
func randomJitter() float64 { return 0.75 + 0.5*rand.Float64() }
