package config

import (
	"strings"
	"testing"
)

func TestUpstreamURL(t *testing.T) {
	cases := []struct{ base, want string }{
		{"http://h/api/data", "http://h/api/data?competitionId=abc"},
		{"http://h/api/data?x=1", "http://h/api/data?competitionId=abc&x=1"},
		{"http://h", "http://h/?competitionId=abc"},
		{"http://h/", "http://h/?competitionId=abc"},
		{"http://h:8080?x=1", "http://h:8080/?competitionId=abc&x=1"},
		{"http://h/api/data/", "http://h/api/data/?competitionId=abc"},
	}
	for _, c := range cases {
		got, err := Config{DataSourceURL: c.base}.UpstreamURL("abc")
		if err != nil || got != c.want {
			t.Errorf("%s -> %q (%v), want %q", c.base, got, err, c.want)
		}
	}
}

func TestLiveResultsBaseURL(t *testing.T) {
	for _, tc := range []struct{ base, want string }{
		{"https://h.test", "https://h.test/Competition"},
		{"https://h.test/", "https://h.test/Competition"},
	} {
		t.Setenv("BACKEND_LIVE_RESULTS_BASE_URL", tc.base)
		if got := Load().DataSourceURL; got != tc.want {
			t.Errorf("base=%q: got %q, want %q", tc.base, got, tc.want)
		}
	}
}

func TestBakedSettingsAreComplete(t *testing.T) {
	cfg := Load()
	if cfg.MaxClients30Days != 50000 || cfg.MaxClients <= 0 || cfg.MaxClientsPerRoom <= 0 || cfg.MaxCompetitions <= 0 ||
		cfg.IdleGrace <= 0 || cfg.CatalogTTL <= 0 || cfg.DataRetention <= 0 || cfg.DataSourceInterval <= 0 {
		t.Fatalf("limits.conf does not define every setting: %+v", cfg)
	}
	t.Setenv("BACKEND_MAX_CLIENTS", "7")
	t.Setenv("BACKEND_MAX_CLIENTS_PER_ROOM", "junk")
	if got := Load(); got.MaxClients != 7 || got.MaxClientsPerRoom != cfg.MaxClientsPerRoom {
		t.Fatalf("the environment overrides a valid value only: %+v", got)
	}
}

func TestOriginOf(t *testing.T) {
	if got := originOf("https://example.test/api/data?x=1"); got != "https://example.test" {
		t.Errorf("originOf = %q", got)
	}
	for _, in := range []string{"https://example.test", "https://example.test/", "https://example.test:8443/x/"} {
		if got := originOf(in); !strings.HasPrefix(in, got) || strings.Count(got, "/") != 2 {
			t.Errorf("originOf(%q) = %q", in, got)
		}
	}
	if got := originOf("https://example.test/Competition/{id}"); got != "https://example.test" {
		t.Errorf("originOf with {id} = %q", got)
	}
}

func TestSplitList(t *testing.T) {
	got := splitList(" https://a.example/ ,, https://b.example ,")
	if len(got) != 2 || got[0] != "https://a.example" || got[1] != "https://b.example" {
		t.Errorf("splitList = %q", got)
	}
	if got := splitList(""); len(got) != 0 {
		t.Errorf("splitList(\"\") = %q", got)
	}
}
