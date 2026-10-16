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

The backend listens on `127.0.0.1:5000` inside the container. The page and the API share one origin, so `FRONTEND_BACKEND_URL` stays empty and no CORS or extra `connect-src` is needed. On App Platform set the HTTP port to `8080`, the health check path to `/healthcheck` and `BACKEND_CLIENT_IP_HEADER=Do-Connecting-Ip`, together with the [backend settings](backend-configuration.md) as environment variables.

## Deploying

The `deploy` job of the `Publish` workflow runs once the image has been pushed to the GitHub Container Registry. It uses [digitalocean/app_action](https://github.com/digitalocean/app_action) to deploy the app as it is configured on DigitalOcean again, which pulls that image. It needs two repository secrets: `DIGITALOCEAN_ACCESS_TOKEN`, a DigitalOcean personal access token that may deploy apps, and `DIGITALOCEAN_APP_NAME`, the name of the App Platform app.
