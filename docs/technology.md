# Technology

| Part | Built with |
| --- | --- |
| Server | Go, standard library plus one WebSocket package (`coder/websocket`) |
| Web page | Angular and TypeScript, CoreUI/Bootstrap for the look, RxJS for the live data |
| Web server | nginx, with s6-overlay running it next to the server in one container |
| Mockserver | Go, standard library only; fake timing source ([Mockserver](mockserver.md)) |
| Tests | Go tests; Vitest for unit tests; Playwright (with axe for accessibility) for end to end |
| Checks | golangci-lint, ESLint, Prettier, hadolint, shellcheck |
| Delivery | Docker/Podman containers, GitHub Actions, GitHub Container Registry, DigitalOcean App Platform |

Versions are pinned in `go.mod`, `src/frontend/package.json` and the container files; Dependabot proposes major upgrades.

Developed with assistance from [Claude Code](https://claude.com/claude-code).
