#!/usr/bin/env sh
set -eu
if [ "$#" -ne 2 ]; then
  echo "Usage: ./scripts/setup-webhook.sh https://YOUR-WORKER.workers.dev YOUR_SETUP_SECRET"
  exit 1
fi
URL="${1%/}"
SECRET="$2"
curl -sS -X POST -H "Authorization: Bearer ${SECRET}" "${URL}/admin/setup-webhook"
echo
curl -sS -H "Authorization: Bearer ${SECRET}" "${URL}/admin/webhook-info"
echo
