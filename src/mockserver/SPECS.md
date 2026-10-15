# Specifications
Dashboard app with three components: frontend, backend, mockserver.
Mark a new or changed spec `[ ]` (TODO); once it is built and verified, mark it `[x]`.
Each spec is verified by a test: **data** specs by unit tests (`*.spec.ts`, `*_test.go`), **UI** specs by Playwright e2e specs (`src/frontend/e2e`). Specs without a test are checked by hand.

All components:
- [x] Run in a container via `compose.yml` and `Containerfile`; no host package installs; formatting tools; no HTTPS between containers

## Mockserver

### Features
- [x] Go (standard library only); `gofmt`; `MOCKSERVER_DATA_SAMPLE_DIRECTORY` (default `data`) holds one subdirectory per competition, named by its competition id (`competitionId`)
- [x] `GET /Competition?competitionId=<id>` serves the competition's current sample; the first request starts its replay, competitions replay independently
- [x] `GET /api/matches` lists the competition ids (also the health check); `POST /api/reset[?competitionId=<id>]` restarts one or all started competitions

### Generated matches (unit specs: `generate_test.go`)
- [x] Without a sample directory (or with `MOCKSERVER_DATA_GENERATE=true`) it generates four matches (`MOCKSERVER_DATA_GENERATED_MATCHES`, 1 to 4, limits them), `mock-match-1..4`, each at its own Dutch long-track venue (`MK1..MK4`); `mock-match-4` holds only a mass start and is live from the first frame of its data (the mass start distance is flagged live from the start), listed by `/api/venues`, `/api/competitions` (running today) and `/api/matches`
- [x] The generated mass starts have 20 skaters, update one skater at a time as they pass the line, each at its time on the race clock, replayed in real time (`MOCKSERVER_DATA_MASS_START_LAP_INTERVAL` scales it by the leader's first lap, 0 is real time); they change leader a few times and spread out lap after lap
- [x] Each match has live data: distances with heat pairs (and a mass start), a frame per lap with status 0 while running → 4 on finish, ranks on finish, the last frame held; frames are `MOCKSERVER_DATA_SAMPLE_INTERVAL` apart (default 5 s) and deterministic; names, categories and clubs are anonymized
- [x] The generated feeds contain the quirks of the recorded live feeds: the not-live error (`success: false`, no distances) before the data (for a few seconds in the first match, minutes in the others, so the match list shows both live and not-live competitions), running heats at status 0 with laps, a heat reset while running, a future heat reporting laps early, a finished heat flickering back to status 0, skaters with an invalid result (DNS, DNF, WDR, DQ: status 4 with an invalid reason), a replaced skater, a skater swapped within a race, a race briefly vanishing from a distance, a corrected final time, and the remarks `PR`, `TR TRC PR`, `FL`, `MT`, `TRC`, `NR TR`

### Data (unit specs: `main_test.go`)
- [x] A replay serves the `.json` samples in filename order, `MOCKSERVER_DATA_SAMPLE_INTERVAL` seconds apart (default 5), skips unparseable ones and holds the last
- [x] A competition whose last sample has been held for `MOCKSERVER_DATA_EXPIRE_AFTER` seconds (default 300, `0` never) restarts from the first on the next request
- [x] `competitionId` is required and competitions `[A-Za-z0-9_-]{1,64}` (else 400); an unknown competition or one without valid samples is 404
