package config

import (
	"strings"
	"testing"
)

func TestLiveResultsBaseURL(t *testing.T) {
	for _, tc := range []struct{ base, want string }{
		{"https://h.test", "https://h.test/Competition"},
		{"https://h.test/", "https://h.test/Competition"},
	} {
		t.Setenv("BACKEND_LIVE_RESULTS_BASE_URL", tc.base)
		if got := Load().Upstreams[0].DataSourceURL; got != tc.want {
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

func TestExtraUpstream(t *testing.T) {
	t.Setenv("BACKEND_LIVE_RESULTS_BASE_URL", "https://real.test")
	t.Setenv("BACKEND_MATCH_INFO_BASE_URL", "https://info.test")
	if got := Load().Upstreams; len(got) != 1 || got[0].CatalogURL != "https://info.test" {
		t.Fatalf("without BACKEND_EXTRA_BASE_URL there is only the primary upstream: %+v", got)
	}
	t.Setenv("BACKEND_EXTRA_BASE_URL", "http://127.0.0.1:5001/")
	got := Load().Upstreams
	if len(got) != 2 || got[1].DataSourceURL != "http://127.0.0.1:5001/Competition" || got[1].CatalogURL != "http://127.0.0.1:5001/" {
		t.Fatalf("the extra upstream follows the primary: %+v", got)
	}
}
