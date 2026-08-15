/**
 * Countries this platform can be deployed for.
 *
 * One source of truth for the served area: the bot uses it to refuse pins from
 * outside the country, the geocoder uses the ISO code to scope lookups, and the
 * admin map uses the bounds to frame and constrain manual placement. Keeping
 * them in one place stops those three drifting apart -- a map that lets an admin
 * click somewhere the bot would have rejected is worse than no map.
 *
 * West Africa only for now. Bounds are the country's bounding box, so a point
 * inside them is not guaranteed to be inside the border -- they are a sanity
 * check against pins from the wrong continent, not a substitute for a boundary
 * dataset. Erring wide is deliberate: refusing a citizen's genuine location is
 * worse than accepting one slightly offshore.
 */

const COUNTRIES = {
    SL: { name: 'Sierra Leone', minLat: 6.87, maxLat: 10.05, minLng: -13.35, maxLng: -10.25 },
    LR: { name: 'Liberia', minLat: 4.30, maxLat: 8.56, minLng: -11.50, maxLng: -7.36 },
    GN: { name: 'Guinea', minLat: 7.17, maxLat: 12.70, minLng: -15.10, maxLng: -7.63 },
    GW: { name: 'Guinea-Bissau', minLat: 10.85, maxLat: 12.70, minLng: -16.75, maxLng: -13.63 },
    SN: { name: 'Senegal', minLat: 12.28, maxLat: 16.70, minLng: -17.55, maxLng: -11.34 },
    GM: { name: 'Gambia', minLat: 13.05, maxLat: 13.85, minLng: -16.85, maxLng: -13.78 },
    ML: { name: 'Mali', minLat: 10.13, maxLat: 25.01, minLng: -12.25, maxLng: 4.27 },
    BF: { name: 'Burkina Faso', minLat: 9.39, maxLat: 15.09, minLng: -5.53, maxLng: 2.41 },
    CI: { name: "Côte d'Ivoire", minLat: 4.34, maxLat: 10.75, minLng: -8.61, maxLng: -2.48 },
    GH: { name: 'Ghana', minLat: 4.72, maxLat: 11.18, minLng: -3.27, maxLng: 1.20 },
    TG: { name: 'Togo', minLat: 6.09, maxLat: 11.15, minLng: -0.16, maxLng: 1.82 },
    BJ: { name: 'Benin', minLat: 6.21, maxLat: 12.43, minLng: 0.76, maxLng: 3.86 },
    NE: { name: 'Niger', minLat: 11.69, maxLat: 23.54, minLng: 0.16, maxLng: 16.00 },
    NG: { name: 'Nigeria', minLat: 4.26, maxLat: 13.90, minLng: 2.66, maxLng: 14.69 },
    MR: { name: 'Mauritania', minLat: 14.71, maxLat: 27.31, minLng: -17.08, maxLng: -4.82 },
    CV: { name: 'Cape Verde', minLat: 14.79, maxLat: 17.21, minLng: -25.37, maxLng: -22.66 },
};

const DEFAULT_CODE = 'SL';

// FIXAM_COUNTRY used to set the display name. It is ignored now, but a stale
// value in an existing .env would otherwise look like it was still doing
// something -- say so once at startup instead.
if (process.env.FIXAM_COUNTRY) {
    console.warn(
        `[config] FIXAM_COUNTRY ("${process.env.FIXAM_COUNTRY}") is ignored. `
        + 'The country and its name come from FIXAM_COUNTRY_CODE; remove FIXAM_COUNTRY from your .env.'
    );
}

/**
 * The configured service area, as { code, name, bounds, center }.
 *
 * FIXAM_COUNTRY_CODE is the ONLY input that selects the country, and the
 * display name is derived from it. An ISO code is two characters with one
 * correct spelling; a country name has many ("Sierra Leone", "sierraleone",
 * "SIERRA LEONE", a typo) and every variant would have to be matched or would
 * silently produce a differently-named instance.
 *
 * The individual FIXAM_MIN_LAT etc. still win where set, so an instance
 * covering one city or a border region can narrow the box.
 */
function getServiceArea() {
    const raw = (process.env.FIXAM_COUNTRY_CODE || DEFAULT_CODE).trim().toUpperCase();

    if (!COUNTRIES[raw]) {
        // Fall back rather than run with no bounds at all, which would accept
        // pins from anywhere on earth.
        console.warn(
            `[config] Unknown FIXAM_COUNTRY_CODE "${raw}"; using ${DEFAULT_CODE}. `
            + `Supported: ${Object.keys(COUNTRIES).join(', ')}`
        );
        return getServiceAreaFor(DEFAULT_CODE);
    }

    return getServiceAreaFor(raw);
}

function getServiceAreaFor(code) {
    const country = COUNTRIES[code];
    const minLat = Number(process.env.FIXAM_MIN_LAT) || country.minLat;
    const maxLat = Number(process.env.FIXAM_MAX_LAT) || country.maxLat;
    const minLng = Number(process.env.FIXAM_MIN_LNG) || country.minLng;
    const maxLng = Number(process.env.FIXAM_MAX_LNG) || country.maxLng;

    return {
        code,
        countryCode: code.toLowerCase(),        // what Nominatim expects
        name: country.name,
        minLat, maxLat, minLng, maxLng,
        center: [(minLat + maxLat) / 2, (minLng + maxLng) / 2],
    };
}

/** Every supported country, for a picker or documentation. */
function listCountries() {
    return Object.entries(COUNTRIES)
        .map(([code, c]) => ({ code, name: c.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { COUNTRIES, getServiceArea, listCountries };
