# Backend configuration

The limits and timings (`LIVE_RESULTS_INTERVAL`, `CATALOG_TTL_SECONDS`, `MAX_COMPETITIONS`, `MAX_CLIENTS`, `MAX_CLIENTS_30_DAYS`, `MAX_CLIENTS_PER_ROOM`, `MAX_CLIENTS_PER_IP`, `CONNECTS_PER_MINUTE`, `CONNECT_BURST`, `IDLE_GRACE_SECONDS`, `DATA_RETENTION_HOURS`) are defined in `backend/src/internal/config/limits.conf` and baked into the image when it is built; the defaults below are the values in that file. Setting the variable at run time overrides the baked value.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LIVE_RESULTS_BASE_URL` | `http://localhost:8080` | Base URL (`https://host`) of the live results API, without the path; the backend requests `/Competition?competitionId=<id>`. A trailing `/` is optional. Must not be set to an empty value |
| `MATCH_INFO_BASE_URL` | `LIVE_RESULTS_BASE_URL` | Base URL (`https://host`) of the competition info API, without the path: the venues and today's competitions (`/api/venues`, `/api/competitions`) |
| `LIVE_RESULTS_INTERVAL` | `1` | Seconds between live results requests per competition |
| `VENUE_COUNTRY_CODE` | `NED` | Only venues in this country are listed |
| `VENUE_DISCIPLINE` | `SpeedSkating.LongTrack` | Only venues and competitions of this discipline are listed |
| `CATALOG_TTL_SECONDS` | `900` | Cache time of the competitions list (venues are cached for the life of the process). Rooms of competitions that ended more than a day ago are closed within a minute |
| `USER_AGENT` | mirrors the viewer's browser | User-Agent header sent on every request to the data source and catalog. When unset, the most recent inbound User-Agent is mirrored (some sources block Go's default one) |
| `DEFAULT_COMPETITION_ID` | none | Competition followed when the page names none |
| `MAX_COMPETITIONS` | `25` | Competitions the backend follows at the same time |
| `MAX_CLIENTS` | `2000` | Viewers allowed at once over all competitions together; more are refused with 503. Sized for the memory and bandwidth of a small instance |
| `MAX_CLIENTS_30_DAYS` | `50000` | Viewer connections accepted in any 30 days (a rolling window kept in memory, emptied by a restart); further ones are refused with 503. Sized for the outbound bandwidth of the hosting plan |
| `MAX_CLIENTS_PER_ROOM` | `1000` | Viewers allowed on one competition at once; further connections are refused with 503 (the page retries with a growing wait) |
| `MAX_CLIENTS_PER_IP` | `10` | Connections one client address may hold at once; further ones are refused with 429 |
| `CONNECTS_PER_MINUTE` | `30` | Connection attempts per minute one client address may average (a token bucket); more are refused with 429 and a `Retry-After`. Refused attempts neither open competitions nor use up `MAX_CLIENTS_30_DAYS` |
| `CONNECT_BURST` | `10` | Connection attempts one client address may make back to back |
| `CLIENT_IP_HEADER` | _(empty)_ | Request header carrying the client address when the backend runs behind a proxy (for example `X-Forwarded-For`, or `Do-Connecting-Ip` on DigitalOcean). Only its last entry is used. Empty uses the address of the connection, which behind a proxy is the proxy itself and would put every viewer in one bucket |
| `IDLE_GRACE_SECONDS` | `30` | Seconds a competition keeps being followed after its last viewer left |
| `DATA_RETENTION_HOURS` | `12` | Hours after a competition's start (after the start of its last day, for a multi-day competition) that its data is served; then its room is closed, its data dropped and the competition leaves the list. `0` keeps it until the day after it ends |
| `LISTEN_ADDR` | `:5000` | Address the backend listens on |

In `compose.yml` (prod profile) the optional ones are passed through from the environment or a compose env file; empty means the default above. `APP_PORT` (default `8888`) is the published port.
