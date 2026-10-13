# Specifications
Dashboard app with three components: frontend, backend, mockserver.
Mark a new or changed spec `[ ]` (TODO); once it is built and verified, mark it `[x]`.
Each spec is verified by a test: **data** specs by unit tests (`*.spec.ts`, `*_test.go`), **UI** specs by Playwright e2e specs (`frontend/e2e`). Specs without a test are checked by hand.

All components:
- [x] Run in a container via `compose.yml` and `Containerfile`; no host package installs; formatting tools; no HTTPS between containers

## Backend

### Features
- [x] Go with `github.com/coder/websocket`; versions pinned in `go.mod`, hashes in `go.sum`; prod image on `scratch` from a base pinned by digest, built with `go mod download && go mod verify` and `-mod=readonly`
- [x] `/ws?competitionId=<id>` on port `5000`; ids competition `[A-Za-z0-9_-]{1,64}`; an invalid or missing id (no default) is refused with a close frame the page reads as "no competition"
- [x] One room per competition: the first client starts the one fetch loop, later clients share its cache and broadcasts; a room closes `IDLE_GRACE_SECONDS` (default 30) after its last client leaves, and when its competition ended more than a day ago or started more than `DATA_RETENTION_HOURS` (default 12, `0` off) ago, counted from the start of its last day for a multi-day competition (checked every minute, with its clients told)
- [x] Upstream URL: `LIVE_RESULTS_BASE_URL` + `/Competition?competitionId=<id>`, polled every `LIVE_RESULTS_INTERVAL` seconds (default 1)
- [x] `DEFAULT_COMPETITION_ID` for clients without an id; at most `MAX_COMPETITIONS` (default 25) rooms, further ones get 503
- [x] `GET /api/competitions/today`: the competitions whose local days include today (also before they start), for the configured venue country and discipline, without secrets; empty list when none; cached `CATALOG_TTL_SECONDS` (default 900), stale data kept when a refresh fails; a competition is kept the day after it ended and dropped after that, by the competition's own time zone, and dropped earlier once `DATA_RETENTION_HOURS` have passed since its start
- [x] The most recent inbound `User-Agent` is mirrored on outbound fetches (the default Go one before any client connected), unless `USER_AGENT` is set
- [x] Feed status (`ok`, `not_live`, `unavailable`) with the data source's own message is sent to clients when it changes
- [x] Logs data received, updates sent, and rooms opening and closing

### Data (unit specs: `src/*_test.go`)
- [x] Each fetch is parsed and diffed against the previous state; only changes are broadcast
- [x] Mass start: a distance with more than two races sharing one heat; the warm-up lap is dropped; total laps come from the title; positions and standings groups are not computed here
- [x] Timed distance: the first lap counts; the distance comes from the title; races grouped by heat, then time; complete only once every competitor has every expected lap
- [x] Per competitor: id, start number (string or number), name, heat, lane, lap count, total time, formatted time (leading zeros stripped, 3 decimals truncated), laps remaining, finished rank
- [x] Times of races that must not show them (DNS, DQ, WDR) are not sent; setting a no-time status does not reset the cache
- [x] Messages: `status` (`competition_id`, `data_source_url`, `data_source_interval`), `feed_status`, `event_name`, `distance_meta` (per distance, no groups), `competitor_update` (per changed competitor, with `lap_times`, `personal_record`, `invalid_reason`, `remark`, empty strings as `null`)
- [x] Replay on connect: `status`, feed status, event name, one `distance_meta` per distance, then every `competitor_update` including those without a time; the suppression of no-time updates applies to live diffs only
