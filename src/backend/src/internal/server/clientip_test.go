package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientKey(t *testing.T) {
	for _, tc := range []struct {
		name, remote, header, value, want string
	}{
		{"connection address", "192.0.2.1:5555", "", "", "192.0.2.1"},
		{"header ignored when not configured", "192.0.2.1:5555", "", "198.51.100.7", "192.0.2.1"},
		{"last entry of a forwarded list", "10.0.0.1:80", "X-Forwarded-For", "203.0.113.9, 198.51.100.7", "198.51.100.7"},
		{"single-address header", "10.0.0.1:80", "Do-Connecting-Ip", "198.51.100.7", "198.51.100.7"},
		{"missing header falls back", "192.0.2.1:5555", "X-Forwarded-For", "", "192.0.2.1"},
		{"junk falls back", "192.0.2.1:5555", "X-Forwarded-For", "not-an-ip", "192.0.2.1"},
		{"ipv6 shares its /64", "[2001:db8:1:2:aaaa::1]:80", "", "", "2001:db8:1:2::/64"},
		{"mapped ipv4", "[::ffff:192.0.2.1]:80", "", "", "192.0.2.1"},
	} {
		r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/ws", nil)
		r.RemoteAddr = tc.remote
		if tc.header != "" && tc.value != "" {
			r.Header.Set(tc.header, tc.value)
		}
		if got := clientKey(r, tc.header); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}
