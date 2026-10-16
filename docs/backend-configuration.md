# Backend configuration

The limits and timings (`BACKEND_LIVE_RESULTS_INTERVAL_*`, `BACKEND_CATALOG_TTL_SECONDS`, `BACKEND_MAX_COMPETITIONS`, `BACKEND_MAX_CLIENTS`, `BACKEND_MAX_CLIENTS_30_DAYS`, `BACKEND_MAX_CLIENTS_PER_ROOM`, `BACKEND_MAX_CLIENTS_PER_IP`, `BACKEND_CONNECTS_PER_MINUTE`, `BACKEND_CONNECT_BURST`, `BACKEND_IDLE_GRACE_SECONDS`, `BACKEND_DATA_RETENTION_HOURS`) are defined in `src/backend/src/internal/config/limits.conf` and baked into the image when it is built; the defaults below are the values in that file. Setting the variable at run time overrides the baked value.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BACKEND_LIVE_RESULTS_BASE_URL` | `http://localhost:8080` | Base URL (`https://host`) of the live results API, without the path; the backend requests `/Competition?competitionId=<id>`. A trailing `/` is optional. Must not be set to an empty value |
| `BACKEND_MATCH_INFO_BASE_URL` | `BACKEND_LIVE_RESULTS_BASE_URL` | Base URL (`https://host`) of the competition info API, without the path: the venues and today's competitions (`/api/venues`, `/api/competitions`) |
| `BACKEND_EXTRA_BASE_URL` | none | Base URL of a second source serving both the competitions list and the live results, such as the demo mockserver. Its competitions are added to the list and fetched from it; when both sources list an id, the primary wins. Off when empty |
| `BACKEND_LIVE_RESULTS_INTERVAL_NOT_STARTED` | `15` | Seconds between live results requests per competition while no distance is live, or the live one has been skated out by everyone |
| `BACKEND_LIVE_RESULTS_INTERVAL_MASS_START` | `0.5` | The same while a mass start is live |
| `BACKEND_LIVE_RESULTS_INTERVAL_DISTANCE` | `5` | The same while any other distance is live |
| `BACKEND_VENUE_COUNTRY_CODE` | `NED` | Only venues in this country are listed |
| `BACKEND_VENUE_DISCIPLINE` | `SpeedSkating.LongTrack` | Only venues and competitions of this discipline are listed |
| `BACKEND_CATALOG_TTL_SECONDS` | `900` | Cache time of the competitions list (capped at one hour; venues are refetched at most once an hour). Rooms of competitions that ended more than a day ago are closed within a minute |
| `BACKEND_USER_AGENT` | mirrors the viewer's browser | User-Agent header sent on every request to the data source and catalog. When unset, the most recent inbound User-Agent is mirrored (some sources block Go's default one) |
| `BACKEND_DEFAULT_COMPETITION_ID` | none | Competition followed when the page names none |
| `BACKEND_MAX_COMPETITIONS` | `25` | Competitions the backend follows at the same time |
| `BACKEND_MAX_CLIENTS` | `2000` | Viewers allowed at once over all competitions together; more are refused with 503. Sized for the memory and bandwidth of a small instance |
| `BACKEND_MAX_CLIENTS_30_DAYS` | `50000` | Viewer connections accepted in any 30 days (a rolling window kept in memory, emptied by a restart); further ones are refused with 503. Sized for the outbound bandwidth of the hosting plan |
| `BACKEND_MAX_CLIENTS_PER_ROOM` | `1000` | Viewers allowed on one competition at once; further connections are refused with 503 (the page retries with a growing wait) |
| `BACKEND_MAX_CLIENTS_PER_IP` | `10` | Connections one client address may hold at once; further ones are refused with 429 |
| `BACKEND_CONNECTS_PER_MINUTE` | `30` | Connection attempts per minute one client address may average (a token bucket); more are refused with 429 and a `Retry-After`. Refused attempts neither open competitions nor use up `BACKEND_MAX_CLIENTS_30_DAYS` |
| `BACKEND_CONNECT_BURST` | `10` | Connection attempts one client address may make back to back |
| `BACKEND_CORS_ALLOWED_ORIGINS` | _(empty)_ | Comma separated origins (`https://example.com`) whose pages may call the HTTP API from a browser; `*` allows every origin. Empty sends no CORS headers, so only the API's own origin works (the combined image needs none). The websocket is not covered by CORS, see `BACKEND_WEBSOCKET_ALLOWED_ORIGINS` |
| `BACKEND_WEBSOCKET_ALLOWED_ORIGINS` | _(empty)_ | Comma separated origins (`https://example.com`) whose pages may open the websocket, next to the host the connection is made to, which always may. Empty or `*` allows every origin, which suits a frontend that reaches the backend through a proxy that does not keep the host |
| `BACKEND_CLIENT_IP_HEADER` | _(empty)_ | Request header carrying the client address when the backend runs behind a proxy (for example `X-Forwarded-For`, or `Do-Connecting-Ip` on DigitalOcean). Only its last entry is used. Empty uses the address of the connection, which behind a proxy is the proxy itself and would put every viewer in one bucket |
| `BACKEND_IDLE_GRACE_SECONDS` | `30` | Seconds a competition keeps being followed after its last viewer left |
| `BACKEND_DATA_RETENTION_HOURS` | `12` | Hours after a competition's start (after the start of its last day, for a multi-day competition) that its data is served; then its room is closed, its data dropped and the competition leaves the list. `0` keeps it until the day after it ends |
| `BACKEND_LISTEN_ADDR` | `:5000` | Address the backend listens on |

Every response carries `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Content-Security-Policy` and `Permissions-Policy` headers that lock down a JSON-only service.

In `compose.yml` (prod profile) the variables are read from the optional `.env.prod` and the optional, gitignored `.env.prod.local`, which wins; an empty value means the default above. `COMPOSE_APP_PORT` (default `8888`) is the published port.

## Demo match

The combined image carries the mockserver. With `MOCKSERVER_ENABLED=true` it runs on loopback with one generated match, `mock-match-1`, restarted `MOCKSERVER_DATA_EXPIRE_AFTER` seconds (default 300) after it has finished, and the backend reads it as its extra source (`BACKEND_EXTRA_BASE_URL`). Without the variable the service idles and the backend has only its primary source.
