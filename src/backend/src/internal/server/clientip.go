package server

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// clientKey names the client of a request for rate limiting. Behind a proxy the address of the connection is the proxy's,
// so header names the request header that carries the client's. Only its last entry is trusted, as that is the one the
// proxy added; earlier ones can be written by the client. An address that does not parse falls back to the connection's.
// IPv6 clients are told apart by their /64, since one subscriber holds a whole one.
func clientKey(r *http.Request, header string) string {
	var raw string
	if header != "" {
		v := r.Header.Get(header)
		raw = strings.TrimSpace(v[strings.LastIndex(v, ",")+1:])
	}
	addr, err := netip.ParseAddr(raw)
	if err != nil {
		host, _, splitErr := net.SplitHostPort(r.RemoteAddr)
		if splitErr != nil {
			host = r.RemoteAddr
		}
		if addr, err = netip.ParseAddr(host); err != nil {
			return host
		}
	}
	addr = addr.Unmap().WithZone("")
	if addr.Is6() {
		if p, err := addr.Prefix(64); err == nil {
			return p.String()
		}
	}
	return addr.String()
}
