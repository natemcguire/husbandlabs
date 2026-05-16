#!/bin/bash
# Daily refresh for the HusbandLabs numbers dashboard.
# Pulls fresh traffic + App Store metrics, copies into the Pages deploy root,
# and ships it. Run by launchd (com.husbandlabs.numbers.refresh) once a day,
# and safe to run by hand any time.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1          # → ~/Projects/husbandlabs
LOG=/tmp/numbers-refresh.log
exec >> "$LOG" 2>&1
echo "==== $(date '+%Y-%m-%d %H:%M:%S') refresh start ===="

# Credentials: CLOUDFLARE_API_TOKEN (deploy) + ASC_VENDOR_NUMBER + optional
# CF_ANALYTICS_TOKEN all live in keys.env per husbandlabs/CLAUDE.md.
if [ -f "$HOME/.config/keys/keys.env" ]; then
  set -a; . "$HOME/.config/keys/keys.env"; set +a
fi

# Pick up a Node that has fetch (the launchd env is minimal).
export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

node numbers/fetch-stats.mjs || { echo "fetch-stats FAILED"; exit 1; }
cp numbers/public/data.json numbers/public/index.html public/numbers/

# Deploy (retry a few times — the home connection is flaky)
for i in 1 2 3 4 5; do
  if npx --yes wrangler pages deploy public --project-name husbandlabs --branch master --commit-dirty=true; then
    echo "deploy OK on attempt $i"
    echo "==== $(date '+%H:%M:%S') refresh done ===="
    exit 0
  fi
  echo "deploy attempt $i failed, sleeping 60s"
  sleep 60
done
echo "deploy FAILED after 5 attempts"
exit 1
