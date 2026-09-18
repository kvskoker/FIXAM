/**
 * Runtime configuration for the browser.
 *
 * The frontend container overwrites this file at start-up from its environment
 * (see docker-entrypoint.d/40-fixam-config.sh). The copy committed here is the
 * no-key default, so a plain checkout still runs: the maps fall back to
 * OpenStreetMap tiles.
 *
 * Nothing secret belongs in this file -- it is served to every visitor. A CARTO
 * basemap key is a public, domain-visible token by design; anything that must
 * stay private belongs behind the API.
 */
window.FIXAM_CONFIG = {
    cartoBasemapKey: ''
};
