/**
 * Which phase of the platform's life produced a record, and what you should be
 * looking at right now.
 *
 * Three phases. The stored tag and the word an operator uses are not always the
 * same -- what the portal calls "Demo" is stored as `test`, because that is
 * what the column has always held and renaming it would mean rewriting every
 * historical row for a label change.
 *
 *   stored    portal      what it is
 *   ------    ------      ----------
 *   test      Demo        Building the thing: hackathon data, the old server,
 *                         anything filed before this platform was real.
 *   pilot     Pilot       Real reports from community champions.
 *   live      Live        Public operation.
 *
 * The visibility rule is the part worth reading twice. Demo and Pilot each show
 * only their own records -- while you are demonstrating, live reports are not
 * yours to browse, and during a pilot the demo noise is exactly what you do not
 * want in the numbers. But **Live shows pilot as well as live**, because pilot
 * reports are real problems reported by real people. A pothole does not stop
 * existing because it was reported a week before launch. The tag is retained so
 * the two can still be told apart in reporting; it is not a reason to hide one.
 *
 * Deliberately separate from `pilot_mode`, which controls *who may report*.
 * This controls *what the data is*. They move independently, and a report's
 * label must never change because an access rule changed.
 */

'use strict';

/** Stored tag -> what an operator calls it. */
const LABELS = {
    test: 'Demo',
    pilot: 'Pilot',
    live: 'Live',
};

const MODES = Object.keys(LABELS);

/**
 * What each mode may see.
 *
 * Live is the only one that spans two tags, and that asymmetry is the whole
 * design: it is how pilot reports survive the transition to public operation
 * without being silently reclassified.
 */
const VISIBILITY = {
    test: ['test'],
    pilot: ['pilot'],
    live: ['live', 'pilot'],
};

// What an unset or corrupted setting falls back to. 'pilot' rather than 'live':
// if the platform cannot tell what phase it is in, showing fewer records is the
// recoverable mistake.
const FALLBACK = 'pilot';

/** Is this a mode we recognise? */
function isValid(mode) {
    return MODES.includes(String(mode));
}

/** Coerce anything to a usable mode. */
function normalise(mode) {
    return isValid(mode) ? String(mode) : FALLBACK;
}

/**
 * The tags visible in a given mode.
 * @returns {string[]} always at least one element
 */
function visibleTags(mode) {
    return VISIBILITY[normalise(mode)];
}

/**
 * A SQL fragment plus its parameter, for filtering a query by the current mode.
 *
 * @param {string} mode         current data_mode
 * @param {number} paramIndex   next free $n in the caller's query
 * @param {string} [column]     qualified column, e.g. 'i.data_mode'
 * @returns {{clause: string, value: string[]}}
 *
 * Returns a clause that is always safe to append after an existing WHERE:
 *
 *     const filter = dataMode.sqlFilter(mode, values.length + 1, 'i.data_mode');
 *     sql += ` AND ${filter.clause}`;
 *     values.push(filter.value);
 */
function sqlFilter(mode, paramIndex, column = 'data_mode') {
    return {
        clause: `${column} = ANY($${paramIndex})`,
        value: visibleTags(mode),
    };
}

/** Human-readable name for a stored tag. */
function label(mode) {
    return LABELS[normalise(mode)];
}

/**
 * One line explaining what the operator is currently looking at. Shown in the
 * portal so nobody mistakes a filtered view for an empty database.
 */
function describe(mode) {
    const current = normalise(mode);
    switch (current) {
        case 'test':
            return 'New reports are tagged Demo. Only demo reports are shown.';
        case 'pilot':
            return 'New reports are tagged Pilot. Only pilot reports are shown.';
        case 'live':
            return 'New reports are tagged Live. Live and pilot reports are shown together.';
        default:
            return '';
    }
}

module.exports = {
    MODES,
    LABELS,
    VISIBILITY,
    FALLBACK,
    isValid,
    normalise,
    visibleTags,
    sqlFilter,
    label,
    describe,
};
