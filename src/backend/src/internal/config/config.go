// Package config holds the settings of the backend: the limits baked into the image (limits.conf) and what the
// environment says about the data source, the venue and the listener.
package config

import (
	"log/slog"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/vuurcode/live-results-experiment/backend/internal/source"
)

// DataSourcePath is where the live results API serves a competition; BACKEND_LIVE_RESULTS_BASE_URL supplies the part before it.
const dataSourcePath = "/Competition"

// ListWatchInterval is how often the competitions list is checked for changes to tell the clients about.
const ListWatchInterval = 30 * time.Second

// DefaultPingInterval keeps a quiet connection busy enough for proxies (nginx closes after 60s of silence).
const DefaultPingInterval = 25 * time.Second

// Config is everything the backend is configured with.
type Config struct {
	Upstreams            []source.Upstream // the primary upstream, then the extra one if BACKEND_EXTRA_BASE_URL is set
	DataSourceIntervals  Intervals         // seconds between upstream fetches of a competition, by what it is doing
	ListenAddr           string
	DefaultCompetitionID string        // used when a client does not send competitionId; empty = required
	MaxCompetitions      int           // distinct competitions followed at once
	MaxClientsPerRoom    int           // clients following one competition at once
	MaxClients           int           // clients following all competitions together
	MaxClients30Days     int           // client connections accepted in any 30 days (see the hub's allowance check)
	MaxClientsPerIP      int           // connections one client address may hold at once
	ConnectsPerMinute    float64       // connection attempts per minute one client address may average
	ConnectBurst         int           // connection attempts one client address may make back to back
	ClientIPHeader       string        // request header naming the client address behind a proxy; empty = the connection's address
	CORSAllowedOrigins   []string      // origins whose pages may call the HTTP API from a browser; "*" = all, empty = none
	WebSocketOrigins     []string      // origins whose pages may open the websocket (the host of the request always may); "*" or empty = all
	IdleGrace            time.Duration // how long an empty competition keeps polling before it is closed
	PingInterval         time.Duration // how often idle websocket clients are pinged, so proxies do not close a quiet connection

	CatalogTTL      time.Duration // how long the competitions list is cached; venues are refetched at most once an hour
	DataRetention   time.Duration // how long after its start a competition's data is served; 0 = until the day after it ends
	VenueCountry    string        // only venues in this country (ISO 3166 alpha-3, as the upstream uses)
	VenueDiscipline string        // only venues and competitions of this discipline
}

// Intervals are the seconds between upstream fetches of one competition. Which one applies depends on what the
// competition is doing, and changes while it runs.
type Intervals struct {
	NotStarted float64 // no distance is live yet (or any more)
	MassStart  float64 // the live distance is a mass start
	Distance   float64 // any other live distance
}

// Duration converts seconds to a duration.
func Duration(seconds float64) time.Duration {
	return time.Duration(seconds * float64(time.Second))
}

// Load reads the configuration from the environment and the baked limits. It exits when the base URL is set but empty or a
// baked value is invalid.
func Load() Config {
	base, baseSet := os.LookupEnv("BACKEND_LIVE_RESULTS_BASE_URL")
	if baseSet && base == "" {
		slog.Error("BACKEND_LIVE_RESULTS_BASE_URL is set but empty; set it to the base URL of the live results API")
		os.Exit(1)
	}
	if !baseSet {
		base = "http://localhost:8080"
	}
	cfg := Config{
		DataSourceIntervals: Intervals{
			NotStarted: number("BACKEND_LIVE_RESULTS_INTERVAL_NOT_STARTED", positive),
			MassStart:  number("BACKEND_LIVE_RESULTS_INTERVAL_MASS_START", positive),
			Distance:   number("BACKEND_LIVE_RESULTS_INTERVAL_DISTANCE", positive),
		},
		ListenAddr: getenv("BACKEND_LISTEN_ADDR", ":5000"),

		DefaultCompetitionID: os.Getenv("BACKEND_DEFAULT_COMPETITION_ID"),
		MaxCompetitions:      int(number("BACKEND_MAX_COMPETITIONS", positive)),
		MaxClientsPerRoom:    int(number("BACKEND_MAX_CLIENTS_PER_ROOM", positive)),
		MaxClients:           int(number("BACKEND_MAX_CLIENTS", positive)),
		MaxClients30Days:     int(number("BACKEND_MAX_CLIENTS_30_DAYS", positive)),
		MaxClientsPerIP:      int(number("BACKEND_MAX_CLIENTS_PER_IP", positive)),
		ConnectsPerMinute:    number("BACKEND_CONNECTS_PER_MINUTE", positive),
		ConnectBurst:         int(number("BACKEND_CONNECT_BURST", positive)),
		ClientIPHeader:       os.Getenv("BACKEND_CLIENT_IP_HEADER"),
		CORSAllowedOrigins:   splitList(os.Getenv("BACKEND_CORS_ALLOWED_ORIGINS")),
		WebSocketOrigins:     splitList(os.Getenv("BACKEND_WEBSOCKET_ALLOWED_ORIGINS")),
		IdleGrace:            time.Duration(number("BACKEND_IDLE_GRACE_SECONDS", nonNegative) * float64(time.Second)),
		PingInterval:         DefaultPingInterval,

		CatalogTTL:      time.Duration(number("BACKEND_CATALOG_TTL_SECONDS", positive) * float64(time.Second)),
		DataRetention:   time.Duration(number("BACKEND_DATA_RETENTION_HOURS", nonNegative) * float64(time.Hour)),
		VenueCountry:    getenv("BACKEND_VENUE_COUNTRY_CODE", "NED"),
		VenueDiscipline: getenv("BACKEND_VENUE_DISCIPLINE", "SpeedSkating.LongTrack"),
	}
	primary := upstream(base, os.Getenv("BACKEND_MATCH_INFO_BASE_URL"))
	cfg.Upstreams = []source.Upstream{primary}
	if extra := os.Getenv("BACKEND_EXTRA_BASE_URL"); extra != "" {
		cfg.Upstreams = append(cfg.Upstreams, upstream(extra, extra))
	}
	return cfg
}

// upstream builds an upstream from the base URL of its live results API and the one of its competitions list, which
// defaults to the origin of the live results URL.
func upstream(liveBase, catalogBase string) source.Upstream {
	u := source.Upstream{DataSourceURL: strings.TrimRight(liveBase, "/") + dataSourcePath, CatalogURL: catalogBase}
	if u.CatalogURL == "" {
		u.CatalogURL = originOf(u.DataSourceURL)
	}
	return u
}

// splitList parses a comma separated setting, dropping blanks and the trailing slash of each entry.
func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimRight(strings.TrimSpace(p), "/"); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// originOf returns scheme://host of a URL, or "" if it has none.
func originOf(raw string) string {
	u, err := url.Parse(strings.ReplaceAll(raw, "{id}", "x"))
	if err != nil || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
