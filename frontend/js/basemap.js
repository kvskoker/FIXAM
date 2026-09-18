/**
 * Basemap tiles.
 *
 * Leaflet draws the map but ships no imagery of its own -- every map here needs
 * a tile provider, and which provider is a deployment decision rather than a
 * code one. CARTO began watermarking unauthenticated raster tiles ("API KEY
 * REQUIRED") in 2026, so their basemaps now need a key. It is free: 5 million
 * tiles a month, no account, from https://dashboard.basemaps.carto.com/
 *
 * The key is never committed. It reaches the browser through js/config.js,
 * which the frontend container writes at start-up from CARTO_BASEMAP_KEY. A
 * checkout without one -- a fork, a local clone, a contributor's laptop --
 * falls back to OpenStreetMap's own tiles, which need no key at all. Nobody
 * has to obtain a credential to run this project.
 *
 * Every map in the project builds its tile layer here, so the provider, the
 * key and the attribution are changed in one file rather than four.
 */
(function (global) {
    'use strict';

    var key = (global.FIXAM_CONFIG && global.FIXAM_CONFIG.cartoBasemapKey) || '';

    var OSM_ATTRIBUTION =
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

    // CARTO's terms ask that both it and OpenStreetMap stay visibly credited.
    var CARTO_ATTRIBUTION =
        OSM_ATTRIBUTION + ', &copy; <a href="https://carto.com/attributions">CARTO</a>';

    function cartoLayer(dark, maxZoom) {
        var style = dark ? 'dark_all' : 'light_all';
        return L.tileLayer(
            'https://{s}.basemaps.cartocdn.com/' + style + '/{z}/{x}/{y}{r}.png'
                + '?key=' + encodeURIComponent(key),
            {
                attribution: CARTO_ATTRIBUTION,
                subdomains: 'abcd',
                maxZoom: maxZoom || 20
            }
        );
    }

    // No {s} placeholder: the OSM tile usage policy names tile.openstreetmap.org
    // as the host to use and warns that the a/b/c aliases may be withdrawn.
    // There is no dark variant of this style, so a dark theme keeps the standard
    // tiles rather than getting a broken URL.
    function osmLayer(maxZoom) {
        return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: OSM_ATTRIBUTION,
            maxZoom: Math.min(maxZoom || 19, 19)
        });
    }

    /**
     * The basemap layer for a map, ready to .addTo() it.
     *
     * @param {{dark?: boolean, maxZoom?: number}} [options]
     * @returns {L.TileLayer}
     */
    function basemapLayer(options) {
        var opts = options || {};
        return key ? cartoLayer(Boolean(opts.dark), opts.maxZoom) : osmLayer(opts.maxZoom);
    }

    global.FIXAM = global.FIXAM || {};
    global.FIXAM.basemapLayer = basemapLayer;
    global.FIXAM.hasBasemapKey = Boolean(key);
})(window);
