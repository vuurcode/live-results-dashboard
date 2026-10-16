package server

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/vuurcode/live-results-experiment/backend/internal/ratelimit"
	"github.com/vuurcode/live-results-experiment/backend/internal/recorder"
)

// RecordingsAPI serves the stored recordings, protected by a bearer key:
//
//	GET    /api/recordings       list: [{id, state, snapshots, bytes, modified}]
//	GET    /api/recordings/{id}  download as a gzipped tar that extracts to <id>/<snapshot>.json
//	DELETE /api/recordings/{id}  delete, also a recording that is still going
type RecordingsAPI struct {
	Store *recorder.Store
	// Key is the bearer token that is required. The API is not served when it is empty.
	Key string
	// Limiter limits requests per client address, whether or not they carry the right key; nil means no limit.
	Limiter *ratelimit.Limiter
	// ClientIPHeader names the request header that carries the client address behind a proxy; see clientKey.
	ClientIPHeader string
}

func (a *RecordingsAPI) register(mux *http.ServeMux) {
	if a == nil || a.Store == nil || a.Key == "" {
		return
	}
	mux.HandleFunc("GET /api/recordings", a.guard(a.list))
	mux.HandleFunc("GET /api/recordings/{id}", a.guard(a.download))
	mux.HandleFunc("DELETE /api/recordings/{id}", a.guard(a.remove))
}

// guard applies the rate limit, then checks the key.
func (a *RecordingsAPI) guard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		if a.Limiter != nil {
			release, wait, ok := a.Limiter.Acquire(clientKey(req, a.ClientIPHeader))
			if !ok {
				w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(wait.Seconds()))))
				http.Error(w, "too many requests", http.StatusTooManyRequests)
				return
			}
			defer release()
		}
		if !a.authorized(req) {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		next(w, req)
	}
}

// authorized compares the bearer token with the key in constant time (over hashes, so the length does not leak).
func (a *RecordingsAPI) authorized(req *http.Request) bool {
	token, ok := strings.CutPrefix(req.Header.Get("Authorization"), "Bearer ")
	if !ok {
		return false
	}
	got, want := sha256.Sum256([]byte(token)), sha256.Sum256([]byte(a.Key))
	return subtle.ConstantTimeCompare(got[:], want[:]) == 1
}

func (a *RecordingsAPI) list(w http.ResponseWriter, _ *http.Request) {
	infos, err := a.Store.List()
	if err != nil {
		http.Error(w, "cannot list the recordings", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(infos)
}

func (a *RecordingsAPI) download(w http.ResponseWriter, req *http.Request) {
	id := req.PathValue("id")
	if !a.exists(w, id) {
		return
	}
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+id+`.tar.gz"`)
	_ = a.Store.Write(w, id) // the status is out once the body starts; a broken download shows as a truncated archive
}

func (a *RecordingsAPI) remove(w http.ResponseWriter, req *http.Request) {
	id := req.PathValue("id")
	if !a.exists(w, id) {
		return
	}
	if err := a.Store.Delete(id); err != nil {
		http.Error(w, "cannot delete the recording", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// exists answers 400 or 404 and returns false when there is no recording under id.
func (a *RecordingsAPI) exists(w http.ResponseWriter, id string) bool {
	if _, err := a.Store.Info(id); err != nil {
		if errors.Is(err, recorder.ErrBadID) {
			http.Error(w, err.Error(), http.StatusBadRequest)
		} else {
			http.Error(w, err.Error(), http.StatusNotFound)
		}
		return false
	}
	return true
}
