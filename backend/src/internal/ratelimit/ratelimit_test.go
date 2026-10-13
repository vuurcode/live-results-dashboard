package ratelimit

import (
	"testing"
	"time"
)

func newTest(perMinute float64, burst, maxOpen int) (*Limiter, *time.Time) {
	l := New(perMinute, burst, maxOpen)
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	l.Now = func() time.Time { return now }
	return l, &now
}

func TestBurstThenRefillOverTime(t *testing.T) {
	l, now := newTest(60, 3, 100) // one attempt per second, three back to back
	for range 3 {
		if _, _, ok := l.Acquire("a"); !ok {
			t.Fatal("the burst must fit")
		}
	}
	_, wait, ok := l.Acquire("a")
	if ok || wait != time.Second {
		t.Fatalf("ok=%v wait=%v, want a refusal asking for 1s", ok, wait)
	}
	*now = now.Add(time.Second)
	if _, _, ok := l.Acquire("a"); !ok {
		t.Fatal("a token is back after a second")
	}
	if _, _, ok := l.Acquire("b"); !ok {
		t.Fatal("another client has its own bucket")
	}
}

func TestOpenConnectionsAreCapped(t *testing.T) {
	l, _ := newTest(6000, 100, 2)
	r1, _, _ := l.Acquire("a")
	if _, _, ok := l.Acquire("a"); !ok {
		t.Fatal("the second connection fits")
	}
	if _, _, ok := l.Acquire("a"); ok {
		t.Fatal("a third open connection must be refused")
	}
	r1()
	r1() // releasing twice must not free a second place
	if _, _, ok := l.Acquire("a"); !ok {
		t.Fatal("a place is free after a release")
	}
	if _, _, ok := l.Acquire("a"); ok {
		t.Fatal("a double release must not make room")
	}
}

func TestRecoveredEntriesArePruned(t *testing.T) {
	l, now := newTest(60, 2, 5)
	release, _, _ := l.Acquire("busy")
	if gone, _, _ := l.Acquire("gone"); gone != nil {
		gone()
	}
	if l.Len() != 2 {
		t.Fatalf("len = %d", l.Len())
	}
	*now = now.Add(10 * time.Minute)
	l.Acquire("trigger") // pruning runs on use
	if l.Len() != 2 {    // "busy" holds a connection, "trigger" is fresh
		t.Fatalf("len = %d, want busy and trigger kept", l.Len())
	}
	release()
	*now = now.Add(10 * time.Minute)
	l.Acquire("trigger")
	if l.Len() != 1 {
		t.Fatalf("len = %d, want only trigger", l.Len())
	}
}
