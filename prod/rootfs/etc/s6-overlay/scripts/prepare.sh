#!/command/with-contenv sh
# Fills the nginx templates from the container environment and refuses to start on a broken config.
set -eu

envsubst '${FRONTEND_LISTEN_PORT} ${FRONTEND_BACKEND_UPSTREAM}' < /etc/nginx/default.conf.template > /etc/nginx/conf.d/default.conf
envsubst '${FRONTEND_CSP_CONNECT_SRC} ${FRONTEND_CSP_FRAME_ANCESTORS}' < /etc/nginx/security-headers.conf.template > /etc/nginx/security-headers.conf
envsubst '${FRONTEND_BACKEND_URL}' < /etc/nginx/env-inject.js.template > /usr/share/nginx/html/env-inject.js
nginx -t
