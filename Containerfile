ARG PYTHON_VERSION="3.14"
ARG NODE_VERSION="24"
ARG GO_VERSION="1.27.2"

FROM node:${NODE_VERSION}-slim AS node
FROM golang:${GO_VERSION} AS go

# Single dev container: Claude Code + Go mockserver + Go backend + Angular dev server.
# The production image is built from prod/Containerfile and contains none of this.
FROM python:${PYTHON_VERSION}-slim-trixie AS dev

WORKDIR /app

ENV PATH="/usr/local/go/bin:/root/.local/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    CGO_ENABLED=0 GOFLAGS=-mod=readonly GOTOOLCHAIN=local

# hadolint ignore=DL3008 # dev-only image: follow Debian's current package versions
RUN apt-get update && apt-get install -y --no-install-recommends bash curl jq git libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

# Node from the official image
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Chromium and its system libraries for the Playwright e2e tests; keep the version in step with
# @playwright/test in src/frontend/package.json so the browser build matches.
ARG PLAYWRIGHT_VERSION="1.64.0"
RUN npx --yes playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Go toolchain from the official image (backend and mockserver are Go; modules are verified against go.sum)
COPY --from=go /usr/local/go /usr/local/go

RUN curl -fsSL https://claude.ai/install.sh -o /tmp/install.sh \
    && bash /tmp/install.sh \
    && rm /tmp/install.sh

COPY entrypoint.sh /entrypoint.sh
COPY dev-services.sh /usr/local/bin/dev-services
RUN chmod +x /entrypoint.sh /usr/local/bin/dev-services

ENTRYPOINT ["/entrypoint.sh"]
CMD ["dev-services"]
