#!/bin/sh
# Does Chrome terminate an idle Service Worker that holds an open WebTransport
# session? Evidence for vrek finding fnd-f844ews.
#
# Runs Chrome headless WITHOUT DevTools (DevTools keeps workers alive, so
# Playwright can't answer this). www/idle.html logs its results to the
# console, which Chrome writes to stderr. Takes about 2.5 minutes.
#
#   spikes/sw-webtransport/idle-probe.sh
set -eu
DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DIR/../.." && pwd)
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/http4-idle-probe.XXXXXX")

(cd "$ROOT" && npx esbuild "$DIR/sw-src.js" --bundle --format=iife --target=chrome120 --outfile="$DIR/www/sw.js" --log-level=warning)
(cd "$ROOT/server" && go build -o "$WORK/http4d" ./cmd/http4d)

"$WORK/http4d" -http 127.0.0.1:0 -wt 127.0.0.1:0 -static "$DIR/www" -assets "$DIR/assets" >"$WORK/ready.json" 2>"$WORK/server.log" &
SERVER=$!
CHROME_PID=""
cleanup() {
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null || true
  kill "$SERVER" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$WORK/ready.json" ] && break; sleep 0.5; done
URL=$(sed -E 's/.*"http":"([^"]+)".*/\1/' "$WORK/ready.json")

"$CHROME" --headless=new --no-first-run --user-data-dir="$WORK/profile" --enable-logging=stderr --v=0 "$URL/idle.html" 2>"$WORK/chrome.log" &
CHROME_PID=$!

for _ in $(seq 1 200); do grep -q 'SPIKE done' "$WORK/chrome.log" 2>/dev/null && break; sleep 1; done
grep -o 'SPIKE .*' "$WORK/chrome.log" | sed 's/", source:.*//'
