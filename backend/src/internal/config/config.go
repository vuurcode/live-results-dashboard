// Package config holds the settings of the backend: the limits baked into the image (limits.conf) and what the
// environment says about the data source, the venue and the listener.
package config

import (
	"log/slog"
	"net/url"
	"os"
	"strings"
	"time"
)

// DataSourcePath is where the live results API serves a competition; LIVE_RESULTS_BASE_URL supplies the part before it.
const dataSourcePath = "/Competition"

// DefaultPingInterval keeps a quiet connection busy enough for proxies (nginx closes after 60s of silence).
const DefaultPingInterval = 25 * time.Second

// Config is everything the backend is configured with.
type Config struct {
	DataSourceURL        string  // may contain `{id}`; otherwise `competitionId=<id>` is added as a query parameter
	DataSourceInterval   float64 // seconds between upstream fetches, per competition
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
	IdleGrace            time.Duration // how long an empty competition keeps polling before it is closed
	PingInterval         time.Duration // how often idle websocket clients are pinged, so proxies do not close a quiet connection

	CatalogURL      string        // base URL serving /api/venues and /api/competitions
	CatalogTTL      time.Duration // how long the competitions list is cached; venues are cached forever
	DataRetention   time.Duration // how long after its start a competition's data is served; 0 = until the day after it ends
	VenueCountry    string        // only venues in this country (ISO 3166 alpha-3, as the upstream uses)
	VenueDiscipline string        // only venues and competitions of this discipline
}

func (c Config) Interval() time.Duration {
	return time.Duration(c.DataSourceInterval * float64(time.Second))
}

// Load reads the configuration from the environment and the baked limits. It exits when the base URL is set but empty or a
// baked value is invalid.
func Load() Config {
	base, baseSet := os.LookupEnv("LIVE_RESULTS_BASE_URL")
	if baseSet && base == "" {
		slog.Error("LIVE_RESULTS_BASE_URL is set but empty; set it to the base URL of the live results API")
		os.Exit(1)
	}
	if !baseSet {
		base = "http://localhost:8080"
	}
	cfg := Config{
		DataSourceURL:      strings.TrimRight(base, "/") + dataSourcePath,
		DataSourceInterval: number("LIVE_RESULTS_INTERVAL", positive),
		ListenAddr:         getenv("LISTEN_ADDR", ":5000"),

		DefaultCompetitionID: os.Getenv("DEFAULT_COMPETITION_ID"),
		MaxCompetitions:      int(number("MAX_COMPETITIONS", positive)),
		MaxClientsPerRoom:    int(number("MAX_CLIENTS_PER_ROOM", positive)),
		MaxClients:           int(number("MAX_CLIENTS", positive)),
		MaxClients30Days:     int(number("MAX_CLIENTS_30_DAYS", positive)),
		MaxClientsPerIP:      int(number("MAX_CLIENTS_PER_IP", positive)),
		ConnectsPerMinute:    number("CONNECTS_PER_MINUTE", positive),
		ConnectBurst:         int(number("CONNECT_BURST", positive)),
		ClientIPHeader:       os.Getenv("CLIENT_IP_HEADER"),
		IdleGrace:            time.Duration(number("IDLE_GRACE_SECONDS", nonNegative) * float64(time.Second)),
		PingInterval:         DefaultPingInterval,

		CatalogURL:      os.Getenv("MATCH_INFO_BASE_URL"),
		CatalogTTL:      time.Duration(number("CATALOG_TTL_SECONDS", positive) * float64(time.Second)),
		DataRetention:   time.Duration(number("DATA_RETENTION_HOURS", nonNegative) * float64(time.Hour)),
		VenueCountry:    getenv("VENUE_COUNTRY_CODE", "NED"),
		VenueDiscipline: getenv("VENUE_DISCIPLINE", "SpeedSkating.LongTrack"),
	}
	if cfg.CatalogURL == "" {
		cfg.CatalogURL = originOf(cfg.DataSourceURL)
	}
	return cfg
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

// UpstreamURL builds the live results URL for one competition by adding a competitionId query parameter.
func (c Config) UpstreamURL(id string) (string, error) {
	u, err := url.Parse(c.DataSourceURL)
	if err != nil {
		return "", err
	}
	if u.Path == "" {
		u.Path = "/" // `https://host` and `https://host/` are the same request; send the path explicitly
	}
	q := u.Query()
	q.Set("competitionId", id)
	u.RawQuery = q.Encode()
	return u.String(), nil
}
