const axios = require('axios');

/**
 * The area this instance serves. Reports outside it are refused rather than
 * stored: a pin from another country is either a mis-tap or a test, and either
 * way it pollutes the map and the duplicate radius.
 *
 * Bounds come from the country registry (services/countries.js) so the bot, the
 * geocoder and the admin map all agree on where "inside" is.
 */
const SERVICE_AREA = require('./countries').getServiceArea();

const NOMINATIM_BASE = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const NOMINATIM_TIMEOUT_MS = Number(process.env.NOMINATIM_TIMEOUT_MS) || 8000;
// Nominatim's usage policy allows at most one request per second from an
// application. Without this the bot can burst past it under load and get the
// whole deployment blocked.
const NOMINATIM_MIN_INTERVAL_MS = Number(process.env.NOMINATIM_MIN_INTERVAL_MS) || 1100;
const GEO_CACHE_MAX = 500;

// Shared across instances: the limit is per application, not per handler.
let lastRequestAt = 0;
let requestChain = Promise.resolve();
const geoCache = new Map();

class FixamHelpers {
    constructor(debugLog) {
        this.debugLog = debugLog || console.log;
    }

    get serviceArea() {
        return SERVICE_AREA;
    }

    /**
     * Coordinates usable as a report location, or null.
     *
     * Rejects non-numeric input, the 0,0 "null island" pin that broken clients
     * send, and anything outside the served area.
     */
    parseCoordinates(latitude, longitude) {
        const lat = Number(latitude);
        const lng = Number(longitude);

        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        if (lat === 0 && lng === 0) return null;
        if (!this.isWithinServiceArea(lat, lng)) return null;

        return { latitude: lat, longitude: lng };
    }

    isWithinServiceArea(latitude, longitude) {
        const lat = Number(latitude);
        const lng = Number(longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
        return lat >= SERVICE_AREA.minLat && lat <= SERVICE_AREA.maxLat
            && lng >= SERVICE_AREA.minLng && lng <= SERVICE_AREA.maxLng;
    }

    /**
     * Pull administrative areas out of a Nominatim `address` object.
     *
     * OSM does not use one consistent key per level, and coverage in Sierra
     * Leone is patchy outside Freetown, so each field falls back through the
     * plausible tags and may still come back null. Callers must treat every
     * value as optional.
     *
     * Constituency and MDA service area are deliberately absent: neither exists
     * in OSM data. Populating them needs an official boundary set matched
     * against the point -- see the `constituency` column, left null until then.
     */
    extractAdminAreas(address) {
        if (!address || typeof address !== 'object') {
            return { district: null, city: null, ward: null, chiefdom: null, country: null };
        }

        const pick = (...keys) => {
            for (const key of keys) {
                const value = address[key];
                if (typeof value === 'string' && value.trim()) return value.trim();
            }
            return null;
        };

        return {
            // "county" is how OSM tags Sierra Leone's districts (e.g. Western
            // Area Urban); "state" is the province above it.
            district: pick('county', 'state_district', 'district', 'state'),
            city: pick('city', 'town', 'village', 'municipality', 'hamlet'),
            ward: pick('suburb', 'neighbourhood', 'quarter', 'city_district', 'residential'),
            chiefdom: pick('chiefdom', 'subdistrict', 'city_district'),
            country: pick('country'),
        };
    }

    /**
     * Run a Nominatim call under the shared rate limit, with caching.
     * Resolves to the response data, or throws so callers can tell a lookup
     * failure apart from a lookup that legitimately found nothing.
     */
    async _nominatim(endpoint, params, cacheKey) {
        if (geoCache.has(cacheKey)) return geoCache.get(cacheKey);

        const run = async () => {
            const wait = Math.max(0, lastRequestAt + NOMINATIM_MIN_INTERVAL_MS - Date.now());
            if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
            lastRequestAt = Date.now();

            const response = await axios.get(`${NOMINATIM_BASE}/${endpoint}`, {
                params,
                timeout: NOMINATIM_TIMEOUT_MS,
                headers: {
                    // Nominatim rejects requests without a contactable agent.
                    'User-Agent': `Fixam-Service/1.0 (${process.env.FIXAM_CONTACT_EMAIL || 'privacy@fixam.sl'})`,
                },
            });
            return response.data;
        };

        // Chain rather than fire in parallel so the interval actually holds.
        requestChain = requestChain.then(run, run);
        const data = await requestChain;

        if (geoCache.size >= GEO_CACHE_MAX) {
            geoCache.delete(geoCache.keys().next().value);
        }
        geoCache.set(cacheKey, data);
        return data;
    }

    // Extract name from message (simple heuristic)
    extractNameFromMessage(message) {
        // Look for patterns like "My name is X" or "I'm X" or "This is X"
        const patterns = [
            /my name is ([a-zA-Z\s]+)/i,
            /i'm ([a-zA-Z\s]+)/i,
            /i am ([a-zA-Z\s]+)/i,
            /this is ([a-zA-Z\s]+)/i,
            /call me ([a-zA-Z\s]+)/i
        ];

        for (const pattern of patterns) {
            const match = message.match(pattern);
            if (match && match[1]) {
                return match[1].trim();
            }
        }

        // If just a name is sent (assuming it's not a command or common word)
        if (message.split(' ').length <= 3) {
            return message.trim();
        }

        return null;
    }

    /**
     * Look up an address within the served area.
     *
     * Returns { ok, results, error }. `ok: false` means the lookup could not be
     * performed (Nominatim down, timed out, rate-limited); `ok: true` with an
     * empty `results` means it ran and genuinely matched nothing. Callers must
     * treat these differently -- telling somebody "I couldn't find that address"
     * when the geocoder is simply unreachable sends them into a retry loop they
     * cannot win.
     */
    async geocodeAddress(address) {
        const query = String(address || '').trim();
        if (!query) return { ok: true, results: [] };

        // The caller may already have appended the country; don't double it up.
        const q = new RegExp(`${SERVICE_AREA.name}\\s*$`, 'i').test(query)
            ? query
            : `${query}, ${SERVICE_AREA.name}`;

        try {
            const data = await this._nominatim('search', {
                q,
                format: 'json',
                limit: 3,
                countrycodes: SERVICE_AREA.countryCode,
                addressdetails: 1,
            }, `search:${q.toLowerCase()}`);

            const results = (Array.isArray(data) ? data : [])
                .map((result) => ({
                    display_name: result.display_name,
                    latitude: parseFloat(result.lat),
                    longitude: parseFloat(result.lon),
                    address: result.address,
                    admin: this.extractAdminAreas(result.address),
                }))
                // countrycodes should be enough, but a result outside the area
                // would break distance maths downstream -- drop it here.
                .filter((r) => this.isWithinServiceArea(r.latitude, r.longitude));

            return { ok: true, results };
        } catch (error) {
            this.debugLog('Geocoding lookup failed', { error: error.message, address: query });
            return { ok: false, results: [], error: error.message };
        }
    }

    /**
     * Resolve coordinates to an address. Same contract as geocodeAddress:
     * { ok, result, error }, where ok:true with a null result means the point
     * is valid but unnamed in OSM (common for rural Sierra Leone).
     */
    async reverseGeocode(latitude, longitude) {
        const point = this.parseCoordinates(latitude, longitude);
        if (!point) return { ok: true, result: null, outOfArea: true };

        try {
            const data = await this._nominatim('reverse', {
                lat: point.latitude,
                lon: point.longitude,
                format: 'json',
                addressdetails: 1,
            }, `reverse:${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`);

            if (data && data.display_name) {
                return {
                    ok: true,
                    result: {
                        display_name: data.display_name,
                        latitude: parseFloat(data.lat),
                        longitude: parseFloat(data.lon),
                        address: data.address,
                        admin: this.extractAdminAreas(data.address),
                    },
                };
            }

            return { ok: true, result: null };
        } catch (error) {
            this.debugLog('Reverse geocoding failed', { error: error.message, latitude, longitude });
            return { ok: false, result: null, error: error.message };
        }
    }

    // Parse location from message (coordinates)
    parseLocationFromMessage(message) {
        // Look for latitude and longitude patterns
        // Format: lat,lon or latitude:X longitude:Y
        const patterns = [
            /(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)/,
            /lat(?:itude)?:\s*(-?\d+\.?\d*)\s*lon(?:gitude)?:\s*(-?\d+\.?\d*)/i
        ];

        for (const pattern of patterns) {
            const match = message.match(pattern);
            if (match) {
                const lat = parseFloat(match[1]);
                const lon = parseFloat(match[2]);

                // Validate coordinates are in Sierra Leone range (approx)
                if (lat >= 6.9 && lat <= 10.0 && lon >= -13.5 && lon <= -10.2) {
                    return { latitude: lat, longitude: lon };
                }
            }
        }

        return null;
    }

    /**
     * File extension to store a download under, given its MIME type.
     *
     * Taking the subtype verbatim ("audio/mpeg" -> ".mpeg") produces names the
     * web server then mislabels: nginx maps .mpeg to video/mpeg, so an MP3 voice
     * note saved that way will not play in the <audio> element on the admin
     * pages. Only the types whose subtype is not the right extension need an
     * entry here.
     */
    extensionForMime(mimeType, fallback = 'bin') {
        if (!mimeType) return fallback;

        const type = String(mimeType).split(';')[0].trim().toLowerCase();
        const overrides = {
            'audio/mpeg': 'mp3',
            'audio/mp3': 'mp3',
            'audio/x-wav': 'wav',
            'audio/wave': 'wav',
            'audio/x-m4a': 'm4a',
            'audio/mp4': 'm4a',
            'video/quicktime': 'mov',
            'video/x-msvideo': 'avi',
            'image/svg+xml': 'svg',
            'application/octet-stream': fallback,
        };
        if (overrides[type]) return overrides[type];

        const subtype = type.split('/')[1];
        // Anything still carrying a vendor prefix or "+suffix" is not usable as
        // a file extension; fall back rather than write a nonsense name.
        if (!subtype || /[^a-z0-9]/.test(subtype)) return fallback;
        return subtype;
    }

    // Generate ticket ID (FIX-XXXXXX)
    generateTicketId() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        for (let i = 0; i < 6; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return `FIX-${result}`;
    }
}

module.exports = FixamHelpers;
