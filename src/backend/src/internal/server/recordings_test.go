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

func call(t *testing.T, method, url, key string) (int, http.Header, string) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), method, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, string(b)
}

func TestRecordingsNeedTheKey(t *testing.T) {
	ts, name := recordingsServer(t, nil)
	for _, key := range []string{"", "wrong", "secre", "secret2"} {
		if status, _, _ := call(t, "GET", ts.URL+"/api/recordings", key); status != http.StatusUnauthorized {
			t.Fatalf("key %q: status %d", key, status)
		}
	}
	if status, _, _ := call(t, "DELETE", ts.URL+"/api/recordings/"+name, "wrong"); status != http.StatusUnauthorized {
		t.Fatalf("status %d", status)
	}
}

func TestRecordingsListDownloadDelete(t *testing.T) {
	ts, name := recordingsServer(t, nil)
	status, _, body := call(t, "GET", ts.URL+"/api/recordings", "secret")
	if status != http.StatusOK || !strings.Contains(body, `"id":"`+name+`"`) || !strings.Contains(body, `"state":"recording"`) {
		t.Fatalf("list: %d %s", status, body)
	}
	status, header, body := call(t, "GET", ts.URL+"/api/recordings/"+name, "secret")
	if status != http.StatusOK || header.Get("Content-Type") != "application/gzip" || len(body) == 0 {
		t.Fatalf("download: %d %v", status, header)
	}
	if status, _, _ = call(t, "GET", ts.URL+"/api/recordings/nope_2026-03-08", "secret"); status != http.StatusNotFound {
		t.Fatalf("unknown: %d", status)
	}
	if status, _, _ = call(t, "GET", ts.URL+"/api/recordings/a.b", "secret"); status != http.StatusBadRequest {
		t.Fatalf("bad id: %d", status)
	}
	if status, _, _ = call(t, "DELETE", ts.URL+"/api/recordings/"+name, "secret"); status != http.StatusNoContent {
		t.Fatalf("delete: %d", status)
	}
	if _, _, body = call(t, "GET", ts.URL+"/api/recordings", "secret"); strings.TrimSpace(body) != "[]" {
		t.Fatalf("after delete: %s", body)
	}
}

func TestRecordingsAreRateLimitedEvenWithAWrongKey(t *testing.T) {
	ts, _ := recordingsServer(t, ratelimit.New(1, 3, 2))
	var last int
	for range 5 {
		last, _, _ = call(t, "GET", ts.URL+"/api/recordings", "wrong")
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
	if status, _, _ := call(t, "GET", ts.URL+"/api/recordings", ""); status != http.StatusNotFound {
		t.Fatalf("status %d", status)
	}
}
