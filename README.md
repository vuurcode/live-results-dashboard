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
| `MATCH_INFO_BASE_URL` | `LIVE_RESULTS_BASE_URL` | Base URL (`https://host`) of the match info API, without the path: the venues and today's matches (`/api/venues`, `/api/competitions`) |
| `LIVE_RESULTS_INTERVAL` | `1` | Seconds between live results requests per match |
| `VENUE_COUNTRY_CODE` | `NED` | Only venues in this country are listed |
| `VENUE_DISCIPLINE` | `SpeedSkating.LongTrack` | Only venues and competitions of this discipline are listed |
| `CATALOG_TTL_SECONDS` | `86400` | Cache time of the competitions list (venues are cached for the life of the process) |
| `USER_AGENT` | mirrors the viewer's browser | User-Agent header sent on every request to the data source and catalog. When unset, the most recent inbound User-Agent is mirrored (some sources block Go's default one) |
| `DEFAULT_COMPETITION_ID` | none | Competition followed when the page names none |

`GET /api/matches/today` lists the matches happening today (including ones that have not started), each with the `id` to pass as `?competitionId=`.
