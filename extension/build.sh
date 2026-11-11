#!/bin/sh
# Builds dialer-extension.zip to send to counsellors: unzip, then chrome://extensions → Developer mode → Load unpacked.
# The Supabase URL and publishable key are public values (they ship in the APK too); RLS keeps rows private.
set -e
cd "$(dirname "$0")"
set -a; . ../app/.env; set +a
cp ../app/node_modules/@supabase/supabase-js/dist/umd/supabase.js .
cp ../app/assets/icon-fg.png icon.png
printf 'const CONFIG = { supabaseUrl: "%s", supabaseKey: "%s" };\n' "$EXPO_PUBLIC_SUPABASE_URL" "$EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY" > config.js
rm -f dialer-extension.zip
zip -q dialer-extension.zip manifest.json background.js popup.html popup.js supabase.js config.js icon.png
echo "Built extension/dialer-extension.zip"
