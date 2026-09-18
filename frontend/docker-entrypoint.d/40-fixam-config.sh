#!/bin/sh
# Write the browser-visible runtime configuration.
#
# The image is built once and deployed anywhere, so per-deployment values cannot
# be baked into it. nginx runs every executable in /docker-entrypoint.d before
# it begins serving, which is where this lands.
#
# CARTO_BASEMAP_KEY is unset by default: the maps then fall back to
# OpenStreetMap tiles, which need no key. See js/basemap.js.
set -eu

CONFIG=/usr/share/nginx/html/js/config.js

cat > "$CONFIG" <<EOF
window.FIXAM_CONFIG = {
    cartoBasemapKey: "${CARTO_BASEMAP_KEY:-}"
};
EOF

if [ -n "${CARTO_BASEMAP_KEY:-}" ]; then
    echo "fixam-config: CARTO basemap key configured"
else
    echo "fixam-config: no CARTO_BASEMAP_KEY set -- maps will use OpenStreetMap tiles"
fi
