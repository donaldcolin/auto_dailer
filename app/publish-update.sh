#!/bin/sh
# Publishes the app's JS to every phone over the air: ./publish-update.sh "what changed"
# Bundles first and refuses to publish if the backend or Supabase address is missing from the bundle
# (EAS skips app/.env, and a bundle without them shows a blank screen on every phone).
set -e
cd "$(dirname "$0")"
[ -n "$1" ] || { echo 'Usage: ./publish-update.sh "what changed"'; exit 1; }

set -a; . ./.env; set +a
rm -rf dist
npx expo export --platform android

for url in "$EXPO_PUBLIC_API_URL" "$EXPO_PUBLIC_SUPABASE_URL"; do
  host=$(echo "$url" | sed -E 's#^https?://##; s#/.*##')
  case "$host" in localhost*|127.*|"") echo "Refusing: $url is not a public address"; exit 1;; esac
  LC_ALL=C grep -a -q "$host" dist/_expo/static/js/android/*.hbc || { echo "Refusing: $host is missing from the bundle"; exit 1; }
done

npx eas-cli update --channel production --environment production --platform android \
  --skip-bundler --input-dir dist --message "$1" --non-interactive
