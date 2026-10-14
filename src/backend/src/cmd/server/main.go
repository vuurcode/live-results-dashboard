// Live Results Dashboard — Backend
//
// Clients connect to /ws?competitionId=<id>. For each competition that has at
// least one client, the backend fetches raw race data from the live results API on
// each interval (one fetch loop per competition, however many clients follow
// it), processes it (sorting, ranking, heat grouping), then pushes
// per-competitor and per-distance update messages to that competition's clients.
// Every live message carries a per-room sequence number "seq". A client that reconnects passes the "epoch" of the
// status message and the last "seq" it saw (epoch and lastSeq query parameters) and then receives only what it missed.
//
// WebSocket message types (backend → frontend):
//
//	status            — sent on connect: { competition_id, data_source_url, data_source_interval, seq, epoch }
//	feed_status       — { state, message }: whether the data source has the competition live
//	event_name        — { name }
//	reset             — the source restarted; the frontend should drop its state
//	distance_meta     — scalar fields for one distance (sent when any field changes)
//	competitor_update — one message per changed competitor
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/vuurcode/live-results-experiment/backend/internal/catalog"
	"github.com/vuurcode/live-results-experiment/backend/internal/config"
	"github.com/vuurcode/live-results-experiment/backend/internal/hub"
	"github.com/vuurcode/live-results-experiment/backend/internal/ratelimit"
	"github.com/vuurcode/live-results-experiment/backend/internal/server"
	"github.com/vuurcode/live-results-experiment/backend/internal/source"
	"github.com/vuurcode/live-results-experiment/backend/internal/useragent"
)

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	cfg := config.Load()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	ua := useragent.New(os.Getenv("BACKEND_USER_AGENT"))
	set := source.NewSet(cfg.Upstreams...)
	h := hub.New(ctx, cfg, set, ua)

	limiter := ratelimit.New(cfg.ConnectsPerMinute, cfg.ConnectBurst, cfg.MaxClientsPerIP)

	var today http.HandlerFunc
	if cat, err := catalog.New(cfg, set, ua); err != nil {
		slog.Error("Competition list disabled", "err", err)
	} else {
		today = cat.ServeToday
		h.Ended = cat.Ended
		go h.WatchEnded(ctx, time.Minute)
	}
	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           server.New(h, server.Options{PingInterval: cfg.PingInterval, Limiter: limiter, ClientIPHeader: cfg.ClientIPHeader, CORSAllowedOrigins: cfg.CORSAllowedOrigins}).Handler(ua, today),
		ReadHeaderTimeout: 10 * time.Second,
	}

	// On SIGTERM the websocket clients are closed first (Shutdown does not wait for hijacked connections), then
	// in-flight requests are given a few seconds; main waits for all of it before returning.
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		h.CloseAll()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	slog.Info("Listening", "addr", cfg.ListenAddr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("Server failed", "err", err)
		os.Exit(1)
	}
	<-shutdownDone
}
