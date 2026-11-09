#!/usr/bin/env bash
# Redeploy the game server (Azure App Service realm-ledger-api): build the image in Azure Container
# Registry, point the app at it, and wait until /api/health reports the new version. The web app
# deploys itself through Vercel's Git integration; run this after server changes merge to main.
set -euo pipefail
RG=${RG:-realm-ledger}
APP=${APP:-realm-ledger-api}
ACR=${ACR:-$(az acr list -g "$RG" --query '[0].name' -o tsv)}
TAG=${TAG:-$(git rev-parse --short HEAD)}
cd "$(dirname "$0")/.."
az acr build -r "$ACR" -t "realm-ledger-server:$TAG" --build-arg "APP_VERSION=$TAG" .
az webapp config container set -g "$RG" -n "$APP" --container-image-name "$ACR.azurecr.io/realm-ledger-server:$TAG" -o none
URL="https://$(az webapp show -g "$RG" -n "$APP" --query defaultHostName -o tsv)"
for i in $(seq 1 50); do
  if curl -fsS --max-time 15 "$URL/api/health" 2>/dev/null | grep -qF "\"version\":\"$TAG\""; then
    echo "$URL is live on $TAG"; curl -fsS "$URL/api/health"; echo; exit 0
  fi
  sleep 6
done
echo "the API didn't report $TAG on /api/health within 5 minutes; check: az webapp log tail -g $RG -n $APP" >&2
exit 1
