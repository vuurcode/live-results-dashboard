// Package fetch polls the live results API for one competition and hands what it gets to a sink.
package fetch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/vuurcode/live-results-experiment/backend/internal/results"
)

const (
	maxBodyBytes = 64 << 20
	timeout      = 10 * time.Second
)

// Sink receives the data a fetcher gets; a room is one.
type Sink interface {
	Apply(*results.Processed)
	// SetFeed reports what the data source says: "ok", "not_live" or "unavailable".
	SetFeed(state, message string)
}

// UserAgent supplies the User-Agent header for outbound requests; an empty string sends none.
type UserAgent interface {
	Get() string
}

// Fetcher polls the upstream for one competition and feeds its sink.
type Fetcher struct {
	URL      string
	Interval time.Duration
	Sink     Sink
	UA       UserAgent
	Client   *http.Client
	Log      *slog.Logger
}

func (f *Fetcher) once(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.URL, nil)
	if err != nil {
		return err
	}
	if ua := f.UA.Get(); ua != "" {
		req.Header.Set("User-Agent", ua)
	}
	resp, err := f.Client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return &statusError{code: resp.StatusCode, retryAfter: parseRetryAfter(resp.Header)}
	}

	var raw results.RawData
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxBodyBytes)).Decode(&raw); err != nil {
		return fmt.Errorf("decode (content type %q): %w", resp.Header.Get("Content-Type"), err)
	}
	f.Sink.Apply(results.Process(&raw))
	if raw.Success != nil && !*raw.Success {
		f.Sink.SetFeed("not_live", raw.ErrorMessage)
	} else {
		f.Sink.SetFeed("ok", "")
	}
	return nil
}

// Run fetches until ctx ends, waiting Interval between fetches and longer while the data source keeps failing.
func (f *Fetcher) Run(ctx context.Context) {
	f.Log.Debug("Fetch loop started", "url", f.URL, "interval", f.Interval)
	defer f.Log.Debug("Fetch loop stopped")
	failures := 0
	for {
		var retryAfter time.Duration
		if err := f.once(ctx); err == nil {
			failures = 0
		} else if !errors.Is(err, context.Canceled) {
			// a data source that keeps failing is asked less and less often, and its failures are not logged every time
			if failures%logEveryFailures == 0 {
				f.Log.Error("Error fetching data", "err", err, "failures", failures+1)
			}
			failures++
			var se *statusError
			if errors.As(err, &se) {
				retryAfter = se.retryAfter
			}
			f.Sink.SetFeed("unavailable", "") // details stay in the log: they can name the data source
		}
		wait := time.NewTimer(fetchDelay(f.Interval, failures, retryAfter, randomJitter()))
		select {
		case <-ctx.Done():
			wait.Stop()
			return
		case <-wait.C:
		}
	}
}
