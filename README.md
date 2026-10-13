# Live results dashboard
Experimental - non commercial.

## About
This is an experimental visualisation of publicly available results data. The data is not owned by this project: it is already published by its original source, and this project only displays it in a different way.

There is no commercial branding and no financial model. It is an open-source project that plots some ideas, in the hope that they help improve existing systems.

Developed with assistance from [Claude Code](https://claude.com/claude-code).

## Backend configuration

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
| `IDLE_GRACE_SECONDS` | `30` | Seconds a competition keeps being followed after its last viewer left |
| `LISTEN_ADDR` | `:5000` | Address the backend listens on |

In `compose.yml` (prod profile) the optional ones are passed through from the environment or a compose env file; empty means the default above. The ports are `FRONTEND_PORT` (default `8888`) for the published frontend.

## Frontend configuration

Set on the frontend container when it starts:

| Variable | Default | Meaning |
| --- | --- | --- |
| `BACKEND_URL` | empty | API address the browser uses. Empty: the same origin, which nginx proxies under `/api` and `/ws` |
| `BACKEND_UPSTREAM` | `backend:5000` | `host:port` nginx proxies to |
| `CSP_CONNECT_SRC` | `'self'` | Origins the page may call, in the Content-Security-Policy. When `BACKEND_URL` points to another host, list it here, e.g. `'self' https://api.example.com wss://api.example.com` |
| `CSP_FRAME_ANCESTORS` | `'none'` | Hosts that may embed the page in a frame, e.g. `https://example.com`; `'none'` allows nobody |

`GET /api/competitions/today` lists the competitions happening today (including ones that have not started), each with the `id` to pass as `?competitionId=`.

## Frontend structure

`frontend/src/app` is split by responsibility, so a change has one obvious place:

| Folder | Holds | Tested by |
| --- | --- | --- |
| `logic/` | Pure functions: times, heats, standings, race codes, the live heat, scrolling. No Angular. | unit specs next to them |
| `services/` | `DataService` (the socket, the message queue, the processed distances), `SettingsService` (the viewer's persisted settings), `TranslateService` | unit specs next to them |
| `components/` | Dashboard page, timed heat card, mass start row | `frontend/e2e/*.e2e.ts` |
| `models/` | Wire and view types | |
| `i18n/` | One file per language; `languages.spec.ts` checks they all carry the same keys | |

- A new viewer setting is one `Setting` in `settings.service.ts` plus its control in the dashboard template.
- A new race code goes in `logic/race-codes.ts`, with the rule that uses it in `logic/`.
- A new language is one file in `i18n/`, registered in `languages.ts` (the keys are typed by `translations.ts`).
- Behaviour that is data (what is computed) is specified in `frontend/SPECS.md` under *Data* and covered by unit specs; behaviour that is on screen is under *UI* and covered by Playwright specs.
