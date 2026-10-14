# Specifications
Dashboard app with three components: frontend, backend, mockserver.
Mark a new or changed spec `[ ]` (TODO); once it is built and verified, mark it `[x]`.
Each spec is verified by a test: **data** specs by unit tests (`*.spec.ts`, `*_test.go`), **UI** specs by Playwright e2e specs (`frontend/e2e`). Specs without a test are checked by hand.

All components:
- [x] Run in a container via `compose.yml` and `Containerfile`; no host package installs; formatting tools; no HTTPS between containers

## Mockserver

### Features
- [x] Go (standard library only); `gofmt`; `DATA_SAMPLE_DIRECTORY` (default `data`) holds one subdirectory per competition, named by its competition id (`competitionId`)
- [x] `GET /Competition?competitionId=<id>` serves the competition's current sample; the first request starts its replay, competitions replay independently
- [x] `GET /api/matches` lists the competition ids (also the health check); `POST /api/reset[?competitionId=<id>]` restarts one or all started competitions

### Generated matches (unit specs: `generate_test.go`)
- [x] Without a sample directory (or with `DATA_GENERATE=true`) it generates three matches, `mock-match-1..3`, each at its own Dutch long-track venue (`MK1..MK3`), listed by `/api/venues`, `/api/competitions` (running today) and `/api/matches`
- [x] Each match has live data: distances with heat pairs (and a mass start), a frame per lap with status 0 while running → 4 on finish, ranks on finish, the last frame held; frames are `DATA_SAMPLE_INTERVAL` apart (default 5 s) and deterministic; names, categories and clubs are anonymized
- [x] The generated feeds contain the quirks of the recorded live feeds: the not-live error (`success: false`, no distances) before the data, running heats at status 0 with laps, a heat reset while running, a future heat reporting laps early, a finished heat flickering back to status 0, skaters with an invalid result (DNS, DNF, WDR, DQ: status 4 with an invalid reason), a replaced skater, a skater swapped within a race, a race briefly vanishing from a distance, a corrected final time, and the remarks `PR`, `TR TRC PR`, `FL`, `MT`, `TRC`, `NR TR`
- [x] The `Containerfile` builds a self-contained image (no mounted samples needed)

### Data (unit specs: `main_test.go`)
- [x] A replay serves the `.json` samples in filename order, `DATA_SAMPLE_INTERVAL` seconds apart (default 5), skips unparseable ones and holds the last
- [x] A competition whose last sample has been held for `DATA_EXPIRE_AFTER` seconds (default 300, `0` never) is dropped; the next request replays it from the start
- [x] `competitionId` is required and competitions `[A-Za-z0-9_-]{1,64}` (else 400); an unknown competition or one without valid samples is 404
