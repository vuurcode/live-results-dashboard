# Mockserver

A fake timing source, so the dashboard can be built and tested without a live competition. The backend is pointed at it with `BACKEND_LIVE_RESULTS_BASE_URL`.

It plays a competition back step by step, starting at the first request. The data is either:

- **recorded samples** (anonymized), one folder per competition in `MOCKSERVER_DATA_SAMPLE_DIRECTORY`, or
- **generated matches**, used when that folder doesn't exist (as in the image) or when `MOCKSERVER_DATA_GENERATE=true`: `mock-match-1` to `mock-match-3`, each with heats, a mass start and the oddities of the real feed (resets, replaced skaters, DNS/DNF/DQ, corrected times).

| Setting | Default | Meaning |
| --- | --- | --- |
| `MOCKSERVER_DATA_SAMPLE_DIRECTORY` | `data` | Folder with the recorded samples |
| `MOCKSERVER_DATA_SAMPLE_INTERVAL` | `5` | Seconds between steps |
| `MOCKSERVER_DATA_EXPIRE_AFTER` | `300` | Seconds the last step is held before the replay restarts; `0` never |
| `MOCKSERVER_DATA_GENERATE` | off | Always add the generated matches |
| `MOCKSERVER_DATA_GENERATED_MATCHES` | `3` | How many generated matches are served (1 to 3) |
| `MOCKSERVER_LISTEN_ADDR` | `:8080` | Where it listens |

`GET /api/matches` lists the competitions, `POST /api/reset` restarts replays. `docker compose --profile dev up` runs it with the rest.
