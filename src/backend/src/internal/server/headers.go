package server

import (
	"net/http"
	"slices"
)

// securityHeaders marks every response as data that is neither rendered, framed nor leaked through the referrer: the
// backend serves JSON and websockets only.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
		next.ServeHTTP(w, req)
	})
}

// cors lets pages from the allowed origins call the API from the browser; "*" allows every origin. An empty list adds
// nothing, which keeps the API to its own origin. The websocket does not go through the browser's CORS check.
func cors(allowed []string, next http.Handler) http.Handler {
	if len(allowed) == 0 {
		return next
	}
	allOrigins := slices.Contains(allowed, "*")
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		h := w.Header()
		if !allOrigins {
			h.Add("Vary", "Origin")
		}
		origin := req.Header.Get("Origin")
		if origin == "" || (!allOrigins && !slices.Contains(allowed, origin)) {
			next.ServeHTTP(w, req)
			return
		}
		if allOrigins {
			h.Set("Access-Control-Allow-Origin", "*")
		} else {
			h.Set("Access-Control-Allow-Origin", origin)
		}
		if req.Method == http.MethodOptions && req.Header.Get("Access-Control-Request-Method") != "" {
			h.Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			if reqHeaders := req.Header.Get("Access-Control-Request-Headers"); reqHeaders != "" {
				h.Set("Access-Control-Allow-Headers", reqHeaders)
				h.Add("Vary", "Access-Control-Request-Headers")
			}
			h.Set("Access-Control-Max-Age", "86400")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, req)
	})
}
