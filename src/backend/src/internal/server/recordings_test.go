package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vuurcode/live-results-experiment/backend/internal/ratelimit"
	"github.com/vuurcode/live-results-experiment/backend/internal/recorder"
)

func recordingsServer(t *testing.T, limiter *ratelimit.Limiter) (*httptest.Server, string) {
	t.Helper()
	store, err := recorder.New(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	store.Open("m1").Add([]byte(`{"a":1}`))
	infos, _ := store.List()
	name := infos[0].ID
	mux := http.NewServeMux()
	(&RecordingsAPI{Store: store, Key: "secret", Limiter: limiter}).register(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts, name
}

func call(t *testing.T, method, url, key string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest(method, url, nil)
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b)
}

func TestRecordingsNeedTheKey(t *testing.T) {
	ts, name := recordingsServer(t, nil)
	for _, key := range []string{"", "wrong", "secre", "secret2"} {
		if resp, _ := call(t, "GET", ts.URL+"/api/recordings", key); resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("key %q: status %d", key, resp.StatusCode)
		}
	}
	if resp, _ := call(t, "DELETE", ts.URL+"/api/recordings/"+name, "wrong"); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestRecordingsListDownloadDelete(t *testing.T) {
	ts, name := recordingsServer(t, nil)
	resp, body := call(t, "GET", ts.URL+"/api/recordings", "secret")
	if resp.StatusCode != 200 || !strings.Contains(body, `"id":"`+name+`"`) || !strings.Contains(body, `"state":"recording"`) {
		t.Fatalf("list: %d %s", resp.StatusCode, body)
	}
	resp, body = call(t, "GET", ts.URL+"/api/recordings/"+name, "secret")
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "application/gzip" || len(body) == 0 {
		t.Fatalf("download: %d %v", resp.StatusCode, resp.Header)
	}
	if resp, _ = call(t, "GET", ts.URL+"/api/recordings/nope_2026-03-08", "secret"); resp.StatusCode != 404 {
		t.Fatalf("unknown: %d", resp.StatusCode)
	}
	if resp, _ = call(t, "GET", ts.URL+"/api/recordings/a.b", "secret"); resp.StatusCode != 400 {
		t.Fatalf("bad id: %d", resp.StatusCode)
	}
	if resp, _ = call(t, "DELETE", ts.URL+"/api/recordings/"+name, "secret"); resp.StatusCode != 204 {
		t.Fatalf("delete: %d", resp.StatusCode)
	}
	if _, body = call(t, "GET", ts.URL+"/api/recordings", "secret"); strings.TrimSpace(body) != "[]" {
		t.Fatalf("after delete: %s", body)
	}
}

func TestRecordingsAreRateLimitedEvenWithAWrongKey(t *testing.T) {
	ts, _ := recordingsServer(t, ratelimit.New(1, 3, 2))
	var last int
	for range 5 {
		resp, _ := call(t, "GET", ts.URL+"/api/recordings", "wrong")
		last = resp.StatusCode
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("status %d after a burst of wrong keys", last)
	}
}

func TestRecordingsAreOffWithoutAKey(t *testing.T) {
	store, _ := recorder.New(t.TempDir(), 0)
	mux := http.NewServeMux()
	(&RecordingsAPI{Store: store}).register(mux)
	ts := httptest.NewServer(mux)
	defer ts.Close()
	if resp, _ := call(t, "GET", ts.URL+"/api/recordings", ""); resp.StatusCode != 404 {
		t.Fatalf("status %d", resp.StatusCode)
	}
}
