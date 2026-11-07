#!/usr/bin/env bash
# Gate 1 staging smoke test. Run from a machine NOT signed in to Cloudflare
# Access. Read-only: sends no credentials and changes nothing.
#   ./scripts/staging-smoke.sh https://imi-staging.example.com [https://other-hostname ...]
set -u
fail=0
check() { # url expected-codes...
  local url=$1; shift
  local code; code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$url")
  for want in "$@"; do [ "$code" = "$want" ] && { echo "PASS $code $url"; return; }; done
  echo "FAIL $code $url (expected $*)"; fail=1
}
for host in "$@"; do
  # Without sign-in: Access redirects (302) or blocks (403) at the edge, or the
  # Worker refuses (401) / is unconfigured (503). Never 200.
  check "$host/api/whoami" 302 401 403 503
  check "$host/api/decisions" 302 401 403 503
  check "$host/oauth/linkedin/callback?state=x&code=y" 302 401 403 503
  check "$host/public/enquiry" 302 401 403 503
  # A media URL that is not published must look exactly like a missing file.
  check "$host/media/posters/00000000-0000-4000-8000-000000000000.jpg" 404 302 403
done
echo
echo "Now the step only a browser can do: sign in to the staging app, then open"
echo "  <staging app>/api/whoami"
echo "It must show your email and \"owner\": true. That proves the browser"
echo "delivers the Access sign-in to the Worker without any API key."
exit $fail
