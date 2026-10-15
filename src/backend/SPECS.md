# Specifications
Dashboard app with three components: frontend, backend, mockserver.
Mark a new or changed spec `[ ]` (TODO); once it is built and verified, mark it `[x]`.
Each spec is verified by a test: **data** specs by unit tests (`*.spec.ts`, `*_test.go`), **UI** specs by Playwright e2e specs (`src/frontend/e2e`). Specs without a test are checked by hand.

All components:
- [x] Run in a container via `compose.yml` and `Containerfile`; no host package installs; formatting tools; no HTTPS between containers

## Backend

### Features
- [x] Go with `github.com/coder/websocket`; versions pinned in `go.mod`, hashes in `go.sum`; prod image on `scratch` from a base pinned by digest, built with `go mod download && go mod verify` and `-mod=readonly`
- [x] `/ws?competitionId=<id>` on port `5000`; ids competition `[A-Za-z0-9_-]{1,64}`; an invalid or missing id (no default) is refused with a close frame the page reads as "no competition"
- [x] The limits and timings (`BACKEND_LIVE_RESULTS_INTERVAL`, `BACKEND_CATALOG_TTL_SECONDS`, `MAX_*`, `BACKEND_IDLE_GRACE_SECONDS`, `BACKEND_DATA_RETENTION_HOURS`) are defined in `src/internal/config/limits.conf`, embedded in the binary at build; an environment variable of the same name overrides one; an invalid baked value stops the start
- [x] Client limits, beyond which a connection is refused with 503: `BACKEND_MAX_CLIENTS_30_DAYS` in any rolling 30 days (default 50000, UTC days, counted in memory), `BACKEND_MAX_CLIENTS` over all rooms (default 2000), `BACKEND_MAX_CLIENTS_PER_ROOM` per room (default 1000)
- [x] `GET /healthcheck`: an empty 200, for the hosting platform's health check
- [x] One room per competition: the first client starts the one fetch loop, later clients share its cache and broadcasts; a room closes `BACKEND_IDLE_GRACE_SECONDS` (default 30) after its last client leaves, and when its competition ended more than a day ago or started more than `BACKEND_DATA_RETENTION_HOURS` (default 12, `0` off) ago, counted from the start of its last day for a multi-day competition (checked every minute, with its clients told)
- [x] Upstream URL: `BACKEND_LIVE_RESULTS_BASE_URL` + `/Competition?competitionId=<id>`, polled every `BACKEND_LIVE_RESULTS_INTERVAL` seconds (default 1)
- [x] `BACKEND_EXTRA_BASE_URL` adds a second source (`/api/venues`, `/api/competitions`, `/Competition`): its competitions are merged into the list (the primary wins on a duplicate id) and each is fetched from the source that lists it (an id nobody lists goes to the primary); a source that fails keeps what it had
- [x] `BACKEND_DEFAULT_COMPETITION_ID` for clients without an id; at most `BACKEND_MAX_COMPETITIONS` (default 25) rooms, then 503
- [x] `GET /api/competitions/today`: the competitions whose local days include today (also before they start), for the configured venue country and discipline, without secrets, each with `live` (the data source answers and does not say the competition is not live; asked per competition at most every 30 seconds); empty list when none; cached `BACKEND_CATALOG_TTL_SECONDS` (default 900), stale data kept when a refresh fails; a competition is kept the day after it ended and dropped after that, by the competition's own time zone, and dropped earlier once `BACKEND_DATA_RETENTION_HOURS` have passed since its start
- [x] Every HTTP response carries the security headers (nosniff, `X-Frame-Options: DENY`, no referrer, a `default-src 'none'` CSP, a Permissions-Policy); CORS only for the origins in `BACKEND_CORS_ALLOWED_ORIGINS` (comma separated, `*` for all), echoed with `Vary: Origin`, preflights answered 204
- [x] Per client address (`BACKEND_CLIENT_IP_HEADER` names the proxy header, else the connection; IPv6 by /64): at most `BACKEND_MAX_CLIENTS_PER_IP` connections at once and `BACKEND_CONNECTS_PER_MINUTE` attempts on average with a burst of `BACKEND_CONNECT_BURST`; further ones get 429 with `Retry-After`, before a room is opened or the 30-day allowance is used
- [x] The most recent inbound `User-Agent` is mirrored on outbound fetches unless `BACKEND_USER_AGENT` is set
- [x] Feed status (`ok`, `not_live`, `unavailable`) with the data source's own message is sent to clients when it changes; data received, updates sent and rooms opening and closing are logged

### Data (unit specs: `src/internal/*/*_test.go`)
- [x] Each fetch is parsed and diffed against the previous state; only changes are broadcast
- [x] Mass start: a distance with more than two races sharing one heat; the warm-up lap is dropped; total laps come from the title; positions and standings groups are not computed here
- [x] Timed distance: the first lap counts; the distance comes from the title; races grouped by heat, then time; complete only once every competitor has every expected lap
- [x] Per competitor: id, start number, name, heat, lane, lap count, total time, formatted time (leading zeros stripped, 3 decimals truncated), laps remaining, finished rank; races that must not show a time (DNS, DQ, WDR) send none, and such a status does not reset the cache
- [x] While clients are connected the list and its `live` flags are checked every 30 seconds; a change is announced to all clients of all rooms as a `competitions_changed` message (no number, not kept for reconnecting clients), so they can ask for the list again
- [x] Messages: `status` (`competition_id`, `data_source_url`, `data_source_interval`), `feed_status`, `event_name`, `distance_meta` (per distance, no groups), `competitor_update` (per changed competitor, with `lap_times`, `personal_record`, `invalid_reason`, `remark`, empty strings as `null`)
- [x] Every live message carries the room's sequence number `seq`, up by one per message and starting again when the room is opened anew; `status.seq` is the number the replay stands for and the replay messages carry none
- [x] A client that reconnects can say where it left off (`epoch` from the status message and `lastSeq`, as query parameters); if the room is still the same incarnation and still holds the messages it missed (the latest 2000, none from before a `reset`), it gets the status, those messages under their own numbers and the current `feed_status` instead of the full replay; `status.following` says how many messages come after it, so a page only resumes from a replay it received completely
- [x] Replay on connect: `status`, feed status, event name, one `distance_meta` per distance, then every `competitor_update` including those without a time; the suppression of no-time updates applies to live diffs only
