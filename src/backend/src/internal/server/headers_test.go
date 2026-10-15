package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

var ok = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })

func do(h http.Handler, method, origin string, extra map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequestWithContext(context.Background(), method, "/api/competitions/today", nil)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestSecurityHeadersOnEveryResponse(t *testing.T) {
	h := do(securityHeaders(ok), "GET", "", nil).Header()
	for k, want := range map[string]string{
		"X-Content-Type-Options":  "nosniff",
		"X-Frame-Options":         "DENY",
		"Referrer-Policy":         "no-referrer",
		"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
	} {
		if got := h.Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	if h.Get("Permissions-Policy") == "" {
		t.Error("Permissions-Policy missing")
	}
}

func TestCORSEmptyListAddsNothing(t *testing.T) {
	if got := do(cors(nil, ok), "GET", "https://a.example", nil).Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("Access-Control-Allow-Origin = %q", got)
	}
}

func TestCORSAllowedOriginIsEchoed(t *testing.T) {
	h := cors([]string{"https://a.example"}, ok)
	rec := do(h, "GET", "https://a.example", nil)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://a.example" {
		t.Errorf("Access-Control-Allow-Origin = %q", got)
	}
	if rec.Header().Get("Vary") != "Origin" {
		t.Errorf("Vary = %q", rec.Header().Get("Vary"))
	}
	for _, origin := range []string{"https://b.example", ""} {
		if got := do(h, "GET", origin, nil).Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("origin %q got Access-Control-Allow-Origin %q", origin, got)
		}
	}
}

func TestCORSWildcard(t *testing.T) {
	rec := do(cors([]string{"*"}, ok), "GET", "https://any.example", nil)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q", got)
	}
}

func TestCORSPreflight(t *testing.T) {
	h := cors([]string{"https://a.example"}, ok)
	rec := do(h, "OPTIONS", "https://a.example", map[string]string{"Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-test"})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Methods") != "GET, OPTIONS" || rec.Header().Get("Access-Control-Allow-Headers") != "x-test" {
		t.Errorf("headers = %v", rec.Header())
	}
	if rec := do(h, "OPTIONS", "https://b.example", map[string]string{"Access-Control-Request-Method": "GET"}); rec.Code != http.StatusOK || rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Errorf("disallowed preflight: %d %v", rec.Code, rec.Header())
	}
}

func TestOriginPatterns(t *testing.T) {
	cases := map[string][]string{
		"empty":    nil,
		"wildcard": {"https://a.example", "*"},
	}
	for name, in := range cases {
		if got := originPatterns(in); len(got) != 1 || got[0] != "*" {
			t.Errorf("%s: %v, want [*]", name, got)
		}
	}
	got := originPatterns([]string{"https://a.example", "b.example:8080"})
	if len(got) != 2 || got[0] != "a.example" || got[1] != "b.example:8080" {
		t.Errorf("hosts: %v", got)
	}
}

func TestSecretHeader(t *testing.T) {
	for _, name := range []string{"Cookie", "Authorization", "X-Api-Key", "Cf-Access-Jwt-Assertion", "X-Auth-Token"} {
		if !secretHeader(name) {
			t.Errorf("%s is logged", name)
		}
	}
	for _, name := range []string{"Do-Connecting-Ip", "X-Forwarded-For", "Origin", "User-Agent"} {
		if secretHeader(name) {
			t.Errorf("%s is hidden", name)
		}
	}
}

func TestLogFirstRequestHidesSecretsAndPassesOn(t *testing.T) {
	rec := do(logFirstRequest(ok), http.MethodGet, "", map[string]string{"Cookie": "a=b", "Do-Connecting-Ip": "203.0.113.9"})
	if rec.Code != http.StatusOK {
		t.Errorf("status %d", rec.Code)
	}
}
