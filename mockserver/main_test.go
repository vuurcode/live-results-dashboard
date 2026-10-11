package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeSamples(t *testing.T, base, match string, samples ...string) {
	t.Helper()
	dir := filepath.Join(base, match)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for i, s := range samples {
		name := filepath.Join(dir, fmt.Sprintf("%03d.json", i))
		if err := os.WriteFile(name, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func newTestServer(t *testing.T, interval time.Duration) (*httptest.Server, string) {
	t.Helper()
	base := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	s := &server{cfg: config{baseDir: base, interval: interval}, ctx: ctx, replays: map[string]*replay{}}
	ts := httptest.NewServer(s.routes())
	t.Cleanup(ts.Close)
	return ts, base
}

func do(t *testing.T, method, url string) (int, string) {
	t.Helper()
	req, _ := http.NewRequestWithContext(t.Context(), method, url, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, strings.TrimSpace(string(b))
}

func waitForBody(t *testing.T, url, want string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, body := do(t, "GET", url); body == want {
			return
		}
		if time.Now().After(deadline) {
			_, body := do(t, "GET", url)
			t.Fatalf("timed out waiting for %q, last body %q", want, body)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestReplayStartsOnFirstRequestAndAdvances(t *testing.T) {
	ts, base := newTestServer(t, 30*time.Millisecond)
	writeSamples(t, base, "m1", `{"s":1}`, `{"s":2}`, `{"s":3}`)

	if code, body := do(t, "GET", ts.URL+"/Competition?competitionId=m1"); code != 200 || body != `{"s":1}` {
		t.Fatalf("first request: %d %q, want the first sample", code, body)
	}
	waitForBody(t, ts.URL+"/Competition?competitionId=m1", `{"s":3}`)
	time.Sleep(100 * time.Millisecond)
	if _, body := do(t, "GET", ts.URL+"/Competition?competitionId=m1"); body != `{"s":3}` {
		t.Errorf("last sample not held: %q", body)
	}
}

func TestMatchesReplayIndependently(t *testing.T) {
	ts, base := newTestServer(t, time.Hour)
	writeSamples(t, base, "a", `{"m":"a1"}`, `{"m":"a2"}`)
	writeSamples(t, base, "b", `{"m":"b1"}`)

	// Nothing is replayed until a match is requested; others stay idle.
	if _, body := do(t, "GET", ts.URL+"/Competition?competitionId=a"); body != `{"m":"a1"}` {
		t.Errorf("a: %q", body)
	}
	if _, body := do(t, "GET", ts.URL+"/Competition?competitionId=b"); body != `{"m":"b1"}` {
		t.Errorf("b: %q", body)
	}
	if _, body := do(t, "GET", ts.URL+"/api/matches"); body != `["a","b"]` {
		t.Errorf("matches: %q", body)
	}
}

func TestRejectsBadAndUnknownMatches(t *testing.T) {
	ts, base := newTestServer(t, time.Hour)
	writeSamples(t, base, "ok", `{}`)
	if err := os.MkdirAll(filepath.Join(base, "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	cases := map[string]int{
		"":                         400,
		"?competitionId=":          400,
		"?competitionId=..":        400,
		"?competitionId=a/b":       400,
		"?competitionId=%2e%2e%2f": 400,
		"?competitionId=nope":      404,
		"?competitionId=empty":     404,
		"?competitionId=ok":        200,
	}
	for q, want := range cases {
		if code, _ := do(t, "GET", ts.URL+"/Competition"+q); code != want {
			t.Errorf("%q: %d, want %d", q, code, want)
		}
	}
	if _, body := do(t, "GET", ts.URL+"/api/matches"); body != `["ok"]` {
		t.Errorf("matches should list only matches with samples: %q", body)
	}
}

func TestSkipsUnparseableSamples(t *testing.T) {
	ts, base := newTestServer(t, 20*time.Millisecond)
	writeSamples(t, base, "m", `not json`, `{"ok":1}`, `{broken`, `{"ok":2}`)
	if _, body := do(t, "GET", ts.URL+"/Competition?competitionId=m"); body != `{"ok":1}` {
		t.Errorf("first valid sample = %q", body)
	}
	waitForBody(t, ts.URL+"/Competition?competitionId=m", `{"ok":2}`)
}

func TestReset(t *testing.T) {
	ts, base := newTestServer(t, 20*time.Millisecond)
	writeSamples(t, base, "m", `{"s":1}`, `{"s":2}`)
	do(t, "GET", ts.URL+"/Competition?competitionId=m")
	waitForBody(t, ts.URL+"/Competition?competitionId=m", `{"s":2}`)

	if code, body := do(t, "POST", ts.URL+"/api/reset?competitionId=m"); code != 200 || !strings.Contains(body, `"reset":true`) {
		t.Fatalf("reset: %d %q", code, body)
	}
	if _, body := do(t, "GET", ts.URL+"/Competition?competitionId=m"); body != `{"s":1}` {
		t.Errorf("after reset: %q, want the first sample", body)
	}
	if code, _ := do(t, "POST", ts.URL+"/api/reset"); code != 200 {
		t.Errorf("reset all: %d", code)
	}
	if code, _ := do(t, "POST", ts.URL+"/api/reset?competitionId=nope"); code != 404 {
		t.Errorf("reset unknown: %d, want 404", code)
	}
}

func TestCatalogEndpoints(t *testing.T) {
	ts, base := newTestServer(t, time.Hour)
	writeSamples(t, base, "m1", `{"name":"Event One"}`)
	_ = os.MkdirAll(filepath.Join(base, "empty"), 0o755) // no samples: not listed

	code, body := do(t, "GET", ts.URL+"/api/venues")
	if code != 200 || !strings.Contains(body, `"SpeedSkating.LongTrack"`) || !strings.Contains(body, `"NED"`) {
		t.Fatalf("venues: %d %s", code, body)
	}
	code, body = do(t, "GET", ts.URL+"/api/competitions")
	if code != 200 {
		t.Fatalf("competitions: %d %s", code, body)
	}
	for _, want := range []string{`"id":"m1"`, `"name":"Event One"`, `"code":"DEV"`, `"id":"mock-tomorrow"`, `"id":"mock-last-week"`, `"id":"mock-other-venue"`} {
		if !strings.Contains(body, want) {
			t.Errorf("competitions missing %s", want)
		}
	}
	if strings.Contains(body, `"id":"empty"`) {
		t.Error("competition without samples must not be listed")
	}
}
