const db = require('../db');
const logger = require('./logger');
const FixamHelpers = require('./fixamHelpers');

/**
 * Give reports their administrative area back after a geocoder failure.
 *
 * A report keeps its coordinates whatever happens -- the citizen's pin is never
 * lost. What a failed lookup costs is the district, city and ward, and those
 * are what the dashboard groups by and what an MDA filters on. One dropped TLS
 * handshake left nineteen reports without any of it, permanently, because
 * nothing ever went back to try again.
 *
 * So something goes back and tries again. Retrying is cheap, the answer does
 * not change, and the alternative is a permanent hole in the data caused by a
 * momentary one in the network.
 */

const helpers = new FixamHelpers();

// Nominatim asks for no more than one request a second and the helper already
// paces itself. This bounds a single pass so a large backlog is worked through
// over several days rather than in one long burst against a public service.
const MAX_PER_PASS = Number(process.env.LOCATION_BACKFILL_BATCH) || 25;

async function backfillOnce() {
    const pending = await db.query(
        `SELECT id, ticket_id, lat, lng
         FROM issues
         WHERE lat IS NOT NULL AND lng IS NOT NULL
           AND (district IS NULL
                OR address IS NULL
                OR address = ''
                -- When a lookup fails the handler stores the coordinates in
                -- place of an address, so the field is filled but says nothing
                -- a person could act on. Those count as unresolved too.
                OR address ~ '^-?[0-9]+\\.[0-9]+, *-?[0-9]+\\.[0-9]+$')
         ORDER BY created_at DESC
         LIMIT $1`,
        [MAX_PER_PASS]
    );

    if (pending.rows.length === 0) return { examined: 0, resolved: 0, failed: 0 };

    let resolved = 0;
    let failed = 0;

    for (const issue of pending.rows) {
        try {
            const lookup = await helpers.reverseGeocode(issue.lat, issue.lng);
            if (!lookup || !lookup.ok) { failed++; continue; }

            const a = lookup.result.address || {};

            // Nominatim names the same level differently depending on the
            // country and how built-up the area is, so each falls back through
            // the plausible alternatives rather than assuming one shape.
            const district = a.state || a.county || a.state_district || null;
            const city = a.city || a.town || a.village || a.municipality || null;
            const ward = a.suburb || a.neighbourhood || a.city_district || a.quarter || null;

            await db.query(
                `UPDATE issues
                 SET address  = CASE
                         -- Replace a placeholder coordinate string with the
                         -- real address; keep anything a human typed or fixed.
                         WHEN address IS NULL OR address = ''
                              OR address ~ '^-?[0-9]+\\.[0-9]+, *-?[0-9]+\\.[0-9]+$'
                         THEN COALESCE($1, address)
                         ELSE address END,
                     district = COALESCE(district, $2),
                     city     = COALESCE(city, $3),
                     ward     = COALESCE(ward, $4),
                     location_source = CASE
                         WHEN location_source = 'unresolved' THEN 'geocoded'
                         ELSE location_source END
                 WHERE id = $5`,
                [lookup.result.display_name || null, district, city, ward, issue.id]
            );
            resolved++;
        } catch (err) {
            // Still unreachable. Left exactly as it was, to be picked up next
            // time rather than marked as anything.
            failed++;
        }
    }

    logger.log('geocoding',
        `Location backfill: ${resolved} resolved, ${failed} still unresolved, `
        + `of ${pending.rows.length} examined`);

    return { examined: pending.rows.length, resolved, failed };
}

/**
 * Runs a few minutes after boot and then hourly. Hourly rather than daily
 * because the gap between a citizen reporting and an officer looking at the
 * report is often shorter than a day, and an address that arrives after the
 * officer has already read the report is of no use to them.
 */
function schedule() {
    setTimeout(() => backfillOnce().catch(() => {}), 3 * 60 * 1000);
    setInterval(() => backfillOnce().catch(() => {}), 60 * 60 * 1000);
    logger.log('geocoding', `Location backfill scheduled: up to ${MAX_PER_PASS} reports per hour`);
}

module.exports = { schedule, backfillOnce };
