# Live results dashboard
Experimental - non commercial.

## About
This is an experimental visualisation of publicly available results data. The data is not owned by this project: it is already published by its original source, and this project only displays it in a different way.

There is no commercial branding and no financial model. It is an open-source project that plots some ideas, in the hope that they help improve existing systems.

Developed with assistance from [Claude Code](https://claude.com/claude-code).

## Backend configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATA_SOURCE_URL` | `http://localhost:8080/api/data` | Live data source. `{id}` in it is replaced by the competition id, otherwise `competitionId=<id>` is added as a query parameter. A trailing `/` is optional for a bare host (`https://host` and `https://host/` are the same); other paths are used exactly as given. Must not be set to an empty value |
| `CATALOG_URL` | origin of `DATA_SOURCE_URL` | Base URL serving `/api/venues` and `/api/competitions` |
| `VENUE_COUNTRY_CODE` | `NED` | Only venues in this country are listed |
| `VENUE_DISCIPLINE` | `SpeedSkating.LongTrack` | Only venues and competitions of this discipline are listed |
| `CATALOG_TTL_SECONDS` | `86400` | Cache time of the competitions list (venues are cached for the life of the process) |
| `DEFAULT_COMPETITION_ID` | none | Competition followed when the page names none |

`GET /api/matches/today` lists the matches happening today (including ones that have not started), each with the `id` to pass as `?competitionId=`.
