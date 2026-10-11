# Specifications
Dashboard app with three components: frontend, backend, mockserver.
Mark a new or changed spec `[ ]` (TODO); once it is built and verified, mark it `[x]`.
Each spec is verified by a test: **data** specs by unit tests (`*.spec.ts`, `*_test.go`), **UI** specs by Playwright e2e specs (`frontend/e2e`). Specs without a test are checked by hand.

All components:
- [x] Run in a container via `compose.yml` and `Containerfile`; no host package installs; formatting tools; no HTTPS between containers

## Mockserver

### Features
- [x] Go (standard library only); `gofmt`; `DATA_SAMPLE_DIRECTORY` (default `data`) holds one subdirectory per match, named by its match id (`competitionId`)
- [x] `GET /Competition?competitionId=<id>` serves the match's current sample; the first request starts its replay, matches replay independently
- [x] `GET /api/matches` lists the match ids (also the health check); `POST /api/reset[?competitionId=<id>]` restarts one or all started matches

### Data (unit specs: `main_test.go`)
- [x] A replay serves the `.json` samples in filename order, `DATA_SAMPLE_INTERVAL` seconds apart (default 5), skips unparseable ones and holds the last
- [x] A match whose last sample has been held for `DATA_EXPIRE_AFTER` seconds (default 300, `0` never) is dropped; the next request replays it from the start
- [x] `competitionId` is required and matches `[A-Za-z0-9_-]{1,64}` (else 400); an unknown match or one without valid samples is 404
