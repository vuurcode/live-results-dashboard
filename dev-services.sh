#!/bin/bash
# Starts mockserver, backend and the Angular dev server inside the dev container.
# Services reach each other via localhost (backend/mockserver also resolve to
# 127.0.0.1 through extra_hosts, which keeps proxy.conf.json working unchanged).
# A crashing service never takes the container down; check output with `docker logs dev`.

trap 'kill $(jobs -p) 2>/dev/null' EXIT TERM INT

# run_go <dir> <binary> [package]: build and run a Go service, rebuilding and restarting it
# whenever a source file in <dir> changes.
run_go() {
  local dir=$1 bin=/tmp/$2 pkg=${3:-.} pid='' last='' cur
  trap '[ -n "$pid" ] && kill $pid 2>/dev/null' EXIT TERM INT
  cd "$dir" || return
  while true; do
    cur=$(find . \( -name '*.go' -o -name go.mod -o -name go.sum \) -exec stat -c '%n %Y' {} + | sort | md5sum)
    if [ "$cur" != "$last" ]; then
      last=$cur
      if [ -n "$pid" ]; then kill $pid 2>/dev/null; wait $pid 2>/dev/null; pid=; fi
      if go build -o "$bin" "$pkg"; then
        "$bin" &
        pid=$!
      else
        echo "$2 build failed; waiting for changes" >&2
      fi
    fi
    sleep 1
  done
}

(DATA_SAMPLE_DIRECTORY=${DATA_SAMPLE_DIRECTORY:-data} run_go /app/mockserver mockserver) &

(
  until curl -fs -o /dev/null http://localhost:8080/api/matches; do sleep 1; done
  run_go /app/backend/src backend ./cmd/server
) &

(
  cd /app/frontend || exit 1
  [ -x node_modules/.bin/ng ] || npm ci
  exec npm start -- --host 0.0.0.0 --poll 2000
) &

wait
exec sleep infinity
