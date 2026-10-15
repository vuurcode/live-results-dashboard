# Frontend configuration

Set on the container when it starts (the combined image, see [Hosting](hosting.md)):

| Variable | Default | Meaning |
| --- | --- | --- |
| `FRONTEND_BACKEND_URL` | empty | API address the browser uses. Empty: the same origin, which nginx proxies under `/api` and `/ws` |
| `FRONTEND_LISTEN_PORT` | `8080` | Port nginx listens on (the only port the container serves) |
| `FRONTEND_BACKEND_UPSTREAM` | `127.0.0.1:5000` | `host:port` nginx proxies to; the backend inside the combined image listens there |
| `FRONTEND_CSP_CONNECT_SRC` | `'self'` | Origins the page may call, in the Content-Security-Policy. When `FRONTEND_BACKEND_URL` points to another host, list it here, e.g. `'self' https://api.example.com wss://api.example.com` |
| `FRONTEND_CSP_FRAME_ANCESTORS` | `'none'` | Hosts that may embed the page in a frame, e.g. `https://example.com`; `'none'` allows nobody |

`GET /api/competitions/today` lists the competitions happening today (including ones that have not started), each with the `id` to pass as `?competitionId=` and whether it is `live`.
