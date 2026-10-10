ARG PYTHON_VERSION="3.14"
ARG NODE_VERSION="24"

FROM node:${NODE_VERSION}-slim AS node

# Single dev container: Claude Code + mockserver + backend + Angular dev server.
# Production images are built from backend/Containerfile and frontend/Containerfile
# and contain none of this.
FROM python:${PYTHON_VERSION}-slim-trixie AS dev

WORKDIR /app

ENV PATH="/root/.local/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update && apt-get install -y --no-install-recommends bash curl jq git libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

# Node from the official image
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Python deps for backend and mockserver (shared pins, installed together)
COPY backend/src/requirements.txt /tmp/backend-requirements.txt
COPY mockserver/requirements.txt /tmp/mockserver-requirements.txt
RUN pip install --no-cache-dir -r /tmp/backend-requirements.txt -r /tmp/mockserver-requirements.txt \
    && rm /tmp/*-requirements.txt

RUN curl -fsSL https://claude.ai/install.sh -o /tmp/install.sh \
    && bash /tmp/install.sh \
    && rm /tmp/install.sh

COPY entrypoint.sh /entrypoint.sh
COPY dev-services.sh /usr/local/bin/dev-services
RUN chmod +x /entrypoint.sh /usr/local/bin/dev-services

ENTRYPOINT ["/entrypoint.sh"]
CMD ["dev-services"]
