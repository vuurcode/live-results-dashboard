package main

import (
	"context"
	"runtime"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestCloseAllTellsClientsAndStopsRooms(t *testing.T) {
	tb := newTestBackend(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := tb.dial(t, ctx, "?competitionId=A", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	readUntilCompetitor(t, ctx, conn)

	tb.m.closeAll()
	if tb.m.roomCount() != 0 {
		t.Fatalf("rooms = %d, want none", tb.m.roomCount())
	}
	for { // messages still queued come first
		if _, _, err = conn.Read(ctx); err != nil {
			break
		}
	}
	if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("closed with %v, want a close frame", err)
	}
}

func TestIdleRoomLeavesNothingRunning(t *testing.T) {
	tb := newTestBackend(t, func(c *config) { c.dataSourceInterval = 0.02 })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	time.Sleep(50 * time.Millisecond) // let the server's own goroutines settle
	before := runtime.NumGoroutine()

	conn, _, err := tb.dial(t, ctx, "?competitionId=A", nil)
	if err != nil {
		t.Fatal(err)
	}
	readUntilCompetitor(t, ctx, conn)
	_ = conn.Close(websocket.StatusNormalClosure, "")

	waitFor(t, "the idle room to close", func() bool { return tb.m.roomCount() == 0 })
	hits := tb.hitCount("A")
	time.Sleep(150 * time.Millisecond)
	if got := tb.hitCount("A"); got != hits {
		t.Fatalf("closed room still polls: %d -> %d fetches", hits, got)
	}
	tb.m.client.CloseIdleConnections() // the upstream connections are kept alive for reuse, with a goroutine each
	tb.srv.CloseClientConnections()
	waitFor(t, "the goroutines to end", func() bool { return runtime.NumGoroutine() <= before+4 })
}
