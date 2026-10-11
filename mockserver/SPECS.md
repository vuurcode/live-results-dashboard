# Specifications
Dashboard app with three components: frontend, backend, mockserver.
When updating or adding there specs, make sure to prefix (or update the prefix) with `[ ]` to mark it TODO. After processing, mark completed items with `[x]`.

Each component:
- [x] Runs in a container via `compose.yml` and `Containerfile`
- [x] No host package installs
- [x] Basic code formatting tools
- [x] No HTTPS between containers

## Mockserver
- [x] Go (standard library only); mirror src into container; `gofmt`
- [x] `DATA_SAMPLE_DIRECTORY` (default `data`) is a base directory with one subdirectory per match; the subdirectory name is the match id (`competitionId`)
- [x] `GET /Competition?competitionId=<id>` serves that match's current sample; the **first** request for a match starts its replay (its first sample is served immediately); matches replay independently
- [x] Replay serves the match's `.json` files in ascending filename order, `DATA_SAMPLE_INTERVAL` seconds apart (default `5`); unparseable samples are skipped; the last sample is held at the end
- [x] A match whose last sample has been held for `DATA_EXPIRE_AFTER` seconds (default `300`, `0` never) is dropped; the next request replays it from the first sample
- [x] `competitionId` is required and restricted to `[A-Za-z0-9_-]{1,64}`; invalid → 400, unknown match or no valid samples → 404
- [x] `GET /api/matches` lists the available match ids (also the health check)
- [x] `POST /api/reset[?competitionId=<id>]` restarts one started match, or all started matches
