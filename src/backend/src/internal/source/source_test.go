package source

import (
	"context"
	"testing"
)

func TestFeedURL(t *testing.T) {
	cases := []struct{ base, want string }{
		{"http://h/api/data", "http://h/api/data?competitionId=abc"},
		{"http://h/api/data?x=1", "http://h/api/data?competitionId=abc&x=1"},
		{"http://h", "http://h/?competitionId=abc"},
		{"http://h/", "http://h/?competitionId=abc"},
		{"http://h:8080?x=1", "http://h:8080/?competitionId=abc&x=1"},
		{"http://h/api/data/", "http://h/api/data/?competitionId=abc"},
	}
	for _, c := range cases {
		got, err := Upstream{DataSourceURL: c.base}.FeedURL("abc")
		if err != nil || got != c.want {
			t.Errorf("%s -> %q (%v), want %q", c.base, got, err, c.want)
		}
	}
}

func TestSetRoutesACompetitionToItsOwner(t *testing.T) {
	s := NewSet(Upstream{DataSourceURL: "http://real/Competition"}, Upstream{DataSourceURL: "http://demo/Competition"})
	for id, want := range map[string]string{
		"unlisted": "http://real/Competition?competitionId=unlisted",
	} {
		if got, _ := s.FeedURL(id); got != want {
			t.Errorf("%s -> %q, want %q", id, got, want)
		}
	}
	s.SetOwners(map[string]int{"real-1": 0, "demo-1": 1})
	if got, _ := s.FeedURL("demo-1"); got != "http://demo/Competition?competitionId=demo-1" {
		t.Errorf("demo-1 -> %q", got)
	}
	if got, _ := s.FeedURL("real-1"); got != "http://real/Competition?competitionId=real-1" {
		t.Errorf("real-1 -> %q", got)
	}
}

func TestSetPrepareLoadsOwnersOnce(t *testing.T) {
	set := NewSet(Upstream{DataSourceURL: "http://real/Competition"}, Upstream{DataSourceURL: "http://demo/Competition"})
	calls := 0
	set.SetLister(func(context.Context) error {
		calls++
		set.SetOwners(map[string]int{"demo-1": 1})
		return nil
	})
	set.Prepare(context.Background(), "demo-1")
	set.Prepare(context.Background(), "demo-1")
	if calls != 1 {
		t.Errorf("the lists are loaded %d times, want once", calls)
	}
	if got, _ := set.FeedURL("demo-1"); got != "http://demo/Competition?competitionId=demo-1" {
		t.Errorf("demo-1 is fetched from %q", got)
	}
}
