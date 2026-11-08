#!/usr/bin/env bash
# Builds the IMI ONE web app in live mode and copies it into ./staging-web,
# which wrangler.staging.toml serves from the same address as the API.
#   ./scripts/stage-web.sh ../imi-one-web
set -euo pipefail
WEB="${1:-../imi-one-web}"
[ -f "$WEB/package.json" ] || { echo "Cannot find the IMI ONE web app at $WEB"; exit 1; }
( cd "$WEB" && npm ci && VITE_DATA_SOURCE=live npm run build )
rm -rf staging-web
cp -R "$WEB/dist" staging-web
echo "Staged $(find staging-web -type f | wc -l | tr -d ' ') files into ./staging-web (live mode, same-origin API)."
