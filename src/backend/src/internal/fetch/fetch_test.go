package fetch

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/vuurcode/live-results-experiment/backend/internal/results"
)

type nopSink struct{}

func (nopSink) Apply(*results.Processed) {}
func (nopSink) SetFeed(string, string)   {}

type noUA struct{}

func (noUA) Get() string { return "" }

func TestOnlyLiveRepliesAreRecorded(t *testing.T) {
	bodies := []string{
		`{"success":false,"distances":[]}`,
		`{"distances":[{"id":"d","isLive":false,"races":[]}]}`,
		`{"distances":[{"id":"d","isLive":true,"races":[]}]}`,
		`{"distances":[{"id":"d","isLive":false,"races":[{"id":"final"}]}]}`, // the final results follow the last live reply
		`{"distances":[{"id":"d","isLive":false,"races":[{"id":"later"}]}]}`,
	}
	var n atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(bodies[n.Add(1)-1]))
	}))
	defer ts.Close()

	var got []string
	f := &Fetcher{URL: ts.URL, Sink: nopSink{}, UA: noUA{}, Client: ts.Client(), Log: slog.Default(), Record: func(b []byte) { got = append(got, string(b)) }}
	for range bodies {
		if err := f.once(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if len(got) != 2 || got[0] != bodies[2] || got[1] != bodies[3] {
		t.Fatalf("recorded %v", got)
	}
}

type countSink struct{ applied, feeds int }

func (c *countSink) Apply(*results.Processed) { c.applied++ }
func (c *countSink) SetFeed(string, string)   { c.feeds++ }

func TestAnUnchangedReplyIsNotProcessedAgain(t *testing.T) {
	bodies := []string{`{"distances":[]}`, `{"distances":[]}`, `{"distances":[{"id":"d","races":[]}]}`}
	var n atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(bodies[n.Add(1)-1]))
	}))
	defer ts.Close()

	sink := &countSink{}
	var recorded int
	f := &Fetcher{URL: ts.URL, Sink: sink, UA: noUA{}, Client: ts.Client(), Log: slog.Default(), Record: func([]byte) { recorded++ }}
	for range bodies {
		if err := f.once(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if sink.applied != 2 || sink.feeds != 3 {
		t.Fatalf("applied %d, feed set %d times, want 2 and 3", sink.applied, sink.feeds)
	}
}
