#!/bin/bash
# Records a live competition so it can be anonymized and replayed by the mockserver.
#
#   ./record-match.sh <LIVE_RESULTS_BASE_URL> <competitionId> [interval-seconds]
#
# Polls <base URL>/Competition?competitionId=<id> and keeps every reply that differs from the
# previous one as <RECORD_DIRECTORY>/<id>/<UTC timestamp>.json (default directory: the
# mockserver's sample directory). The mockserver replays those files in filename order.
# Stop with Ctrl+C. Anonymize the files before sharing or committing anything.
# USER_AGENT sets the User-Agent header; without it curl's default is sent.

set -u

if [ $# -lt 2 ] || [ $# -gt 3 ]; then
  echo "usage: $0 <LIVE_RESULTS_BASE_URL> <competitionId> [interval-seconds]" >&2
  exit 2
fi

base=${1%/}
id=$2
interval=${3:-5}

if ! [[ $id =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
  echo "competitionId must be 1-64 letters, digits, '-' or '_'" >&2
  exit 2
fi
if ! [[ $interval =~ ^[0-9]+$ ]] || [ "$interval" -lt 1 ]; then
  echo "interval must be a whole number of seconds, at least 1" >&2
  exit 2
fi
for tool in curl jq; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
done

dir=${RECORD_DIRECTORY:-$(dirname "$0")/src/mockserver/data}/$id
tmp=$(mktemp) || exit 1
trap 'rm -f "$tmp"' EXIT
trap 'exit 0' INT TERM

curl_args=(-sS --max-time 10 -o "$tmp" -w '%{http_code} %{content_type}')
[ -n "${USER_AGENT:-}" ] && curl_args+=(-A "$USER_AGENT")

saved=0
echo "Recording to $dir every ${interval}s (Ctrl+C to stop)"
while true; do
  if status=$(curl "${curl_args[@]}" "$base/Competition?competitionId=$id"); then
    code=${status%% *}
    if [ "$code" != 200 ]; then
      echo "$(date -u +%T) HTTP $code, skipped"
    elif ! jq -e . "$tmp" >/dev/null 2>&1; then
      echo "$(date -u +%T) reply is not JSON (content type: ${status#* }), skipped"
    else
      last=
      [ -d "$dir" ] && last=$(find "$dir" -maxdepth 1 -name '*.json' | sort | tail -n 1)
      if [ -z "$last" ] || ! cmp -s "$tmp" "$last"; then
        mkdir -p "$dir" || exit 1
        file=$dir/$(date -u +%Y%m%dT%H%M%SZ).json
        cp "$tmp" "$file" && saved=$((saved + 1)) && echo "$(date -u +%T) saved sample $saved ($(basename "$file"))"
      fi
    fi
  else
    echo "$(date -u +%T) request failed, retrying"
  fi
  sleep "$interval"
done
