#!/command/with-contenv sh
# Fills the nginx templates from the container environment and refuses to start on a broken config.
set -eu

envsubst '${LISTEN_PORT} ${BACKEND_UPSTREAM}' < /etc/nginx/default.conf.template > /etc/nginx/conf.d/default.conf
envsubst '${CSP_CONNECT_SRC} ${CSP_FRAME_ANCESTORS}' < /etc/nginx/security-headers.conf.template > /etc/nginx/security-headers.conf
envsubst '${BACKEND_URL}' < /etc/nginx/env-inject.js.template > /usr/share/nginx/html/env-inject.js
nginx -t
