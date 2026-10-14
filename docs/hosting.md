# Hosting

`prod/Containerfile` builds one image with both halves, to host on a single small instance such as DigitalOcean App Platform:

```
docker build -f prod/Containerfile -t live-results .
docker run -p 8888:8080 live-results
```

nginx (port `8080`) is the only process reachable from outside. [s6-overlay](https://github.com/just-containers/s6-overlay) starts the processes, and stops the container when either dies, so the platform restarts it:

| Path | Served by |
| --- | --- |
| `/api/*` | backend (proxied) |
| `/ws` | backend websocket (proxied) |
| `/healthcheck` | backend (proxied); use it as the platform's health check |
| anything else | the Angular app (static files, unknown page routes fall back to `index.html`) |

The backend listens on `127.0.0.1:5000` inside the container. The page and the API share one origin, so `BACKEND_URL` stays empty and no CORS or extra `connect-src` is needed. On App Platform set the HTTP port to `8080`, the health check path to `/healthcheck` and `CLIENT_IP_HEADER=Do-Connecting-Ip`, together with the [backend settings](backend-configuration.md) as environment variables.
