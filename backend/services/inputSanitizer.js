/**
 * The single gate every citizen keystroke passes through before anything else
 * reads it.
 *
 * WhatsApp hands us whatever the sender's keyboard produced. Most of it is
 * ordinary text; a small amount is not, and the parts that are not cause
 * trouble far out of proportion to how often they arrive:
 *
 *   - Control and zero-width characters survive a `.trim()`, so a message that
 *     looks empty is not, and a name that renders as "John" can be padded past
 *     a length check with invisible joiners.
 *   - Bidirectional overrides (U+202E and friends) make text render in the
 *     opposite order to how it is stored. An admin reading the queue sees one
 *     thing; the database holds another.
 *   - Fullwidth and mathematical look-alikes defeat any comparison done on the
 *     raw string, which is how a blacklist gets walked around. NFKC folding
 *     collapses them back to plain letters before we compare.
 *
 * SQL injection is deliberately not on that list: every query in this codebase
 * is parameterised, and a citizen is entitled to describe "a drain that's 100%
 * blocked -- fix am!". Mangling apostrophes and semicolons would damage real
 * reports to defend against something already defended. What we do instead is
 * *flag* input carrying injection or prompt-injection shapes so it shows up in
 * the logs, and leave the text itself intact.
 *
 * Everything here is synchronous, dependency-free and pure, so it can be
 * unit-tested and called from anywhere without a database or a network.
 */

'use strict';

// Long enough for any genuine WhatsApp message, short enough that a pasted
// novel cannot be logged, embedded and stored in full before the per-field
// limits downstream get a look at it.
const DEFAULT_MAX_LENGTH = 4096;

// C0/C1 control characters, minus tab and newline which are legitimate inside a
// description. Carriage return is dropped separately during newline
// normalisation.
// Matching control characters is the entire point of this constant.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

// Characters that occupy no width when rendered: soft hyphen, Mongolian vowel
// separator, zero-width space/non-joiner/joiner, word joiner, invisible
// operators, and the byte-order mark.
// The joiners are listed deliberately -- they are what we are removing.
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE_CHARS = /[\u00AD\u180E\u200B\u200C\u200D\u2060-\u2064\uFEFF]/g;

// Explicit bidirectional formatting: LRM/RLM, the embedding and override pair,
// and the isolate family. Their presence is worth logging on its own -- no
// phone keyboard emits them by accident.
const BIDI_CHARS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

// LINE SEPARATOR / PARAGRAPH SEPARATOR. Valid Unicode, but they break JSON
// embedded in HTML and render inconsistently, so they become plain newlines.
const LINE_SEPARATORS = /[\u2028\u2029]/g;

// Anything shaped like a markup tag. Only stripped when the caller asks for it
// (names, addresses); a description saying "water level < 5 cm" keeps it.
const TAG_LIKE = /<[^<>]{0,200}>/g;

// Purely advisory patterns. These do not change the text; they add a flag so an
// operator reviewing the logs can see what arrived.
const SQL_SHAPES = /(\bunion\s+select\b|\bdrop\s+table\b|\binsert\s+into\b|\bdelete\s+from\b|\bor\s+1\s*=\s*1\b|;\s*shutdown\b)/i;
const PROMPT_INJECTION_SHAPES = /(ignore\s+(all\s+)?(the\s+)?(previous|prior|above)\s+(instructions?|prompts?)|disregard\s+(the\s+)?(previous|above|system)|you\s+are\s+now\s+(a|an)\b|^\s*system\s*:|<\s*\/?\s*(system|assistant|user)\s*>)/i;

/**
 * Test a global regex without carrying `lastIndex` into the next call.
 *
 * `/g` regexes are stateful, and every constant above is global because it is
 * also used for replacement. Resetting first makes the check depend only on its
 * argument, which is what every call site assumes.
 */
function matches(re, text) {
    re.lastIndex = 0;
    const found = re.test(text);
    re.lastIndex = 0;
    return found;
}

/**
 * Clean one piece of citizen input.
 *
 * @param {*} raw                        whatever arrived; non-strings are coerced
 * @param {object} [options]
 * @param {number} [options.maxLength]   hard cap, applied last
 * @param {boolean} [options.singleLine] fold newlines to spaces (names, addresses)
 * @param {boolean} [options.stripTags]  remove markup-shaped runs
 * @param {boolean} [options.stripEmoji] remove pictographs and variation selectors
 * @returns {{text: string, flags: string[], truncated: boolean, changed: boolean}}
 *
 * `flags` is for logging and metrics, never for refusing a citizen: a report
 * that happens to contain "delete from" is still a report.
 */
function sanitize(raw, options = {}) {
    const {
        maxLength = DEFAULT_MAX_LENGTH,
        singleLine = false,
        stripTags = false,
        stripEmoji = false,
    } = options;

    const original = typeof raw === 'string'
        ? raw
        : (raw === null || raw === undefined ? '' : String(raw));
    const flags = [];
    let text = original;

    // Fold look-alikes before anything else, so every check below -- length,
    // tags, the name blacklist that runs later -- sees the same canonical form
    // the reader sees. NFKC rather than NFC is deliberate: it is the form that
    // maps fullwidth and styled letters back to plain ones.
    try {
        const normalized = text.normalize('NFKC');
        if (normalized !== text) flags.push('normalized');
        text = normalized;
    } catch {
        // A lone surrogate can make normalize() throw. Carry on with the raw
        // string rather than losing the message.
        flags.push('normalize_failed');
    }

    if (matches(BIDI_CHARS, text)) flags.push('bidi_control');
    text = text.replace(BIDI_CHARS, '');

    if (matches(INVISIBLE_CHARS, text)) flags.push('invisible_chars');
    text = text.replace(INVISIBLE_CHARS, '');

    if (matches(CONTROL_CHARS, text)) flags.push('control_chars');
    text = text.replace(CONTROL_CHARS, '');

    text = text.replace(LINE_SEPARATORS, '\n').replace(/\r\n?/g, '\n');

    if (stripTags && matches(TAG_LIKE, text)) {
        flags.push('markup');
        text = text.replace(TAG_LIKE, ' ');
    }

    if (stripEmoji) {
        // Extended_Pictographic covers emoji proper; the second pass removes the
        // skin-tone modifiers, variation selectors and keycap marks that would
        // otherwise be left stranded.
        const withoutEmoji = text
            .replace(/\p{Extended_Pictographic}/gu, '')
            // The combining marks are listed deliberately: with the pictograph
            // already gone, a stranded modifier or keycap is what we are here
            // to remove.
            // eslint-disable-next-line no-misleading-character-class
            .replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0E}\u{FE0F}\u{20E3}]/gu, '');
        if (withoutEmoji !== text) flags.push('emoji');
        text = withoutEmoji;
    }

    if (singleLine) {
        text = text.replace(/\s+/g, ' ');
    } else {
        // Keep paragraphs, drop the padding: trailing spaces on every line and
        // runs of blank lines are almost always accidental, and they make the
        // admin timeline unreadable.
        text = text
            .split('\n')
            .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
            .join('\n')
            .replace(/\n{3,}/g, '\n\n');
    }

    text = text.trim();

    if (SQL_SHAPES.test(text)) flags.push('sql_shape');
    if (PROMPT_INJECTION_SHAPES.test(text)) flags.push('prompt_injection_shape');

    let truncated = false;
    if (maxLength > 0 && text.length > maxLength) {
        // Cut on a code point boundary so the tail is never half a surrogate
        // pair, which would render as a replacement glyph.
        text = Array.from(text).slice(0, maxLength).join('').trim();
        truncated = true;
        flags.push('truncated');
    }

    return { text, flags, truncated, changed: text !== original };
}

/**
 * The common case: give me the cleaned string and nothing else.
 */
function sanitizeText(raw, options = {}) {
    return sanitize(raw, options).text;
}

/**
 * The strict profile used for short identity-ish fields -- names above all.
 *
 * One line, no markup, no emoji, and a cap no real person's full name reaches.
 * Kept here rather than in the name parser so addresses and any future short
 * field get the same treatment.
 */
function sanitizeIdentifier(raw, maxLength = 100) {
    return sanitize(raw, { maxLength, singleLine: true, stripTags: true, stripEmoji: true });
}

/**
 * Is there anything left worth acting on?
 *
 * A message of nothing but emoji sanitises to '' under the strict profile, and
 * a message of nothing but zero-width characters sanitises to '' under any
 * profile. Both need the same answer from the bot: ask again.
 */
function isBlank(text) {
    return !text || !String(text).trim();
}

module.exports = {
    sanitize,
    sanitizeText,
    sanitizeIdentifier,
    isBlank,
    DEFAULT_MAX_LENGTH,
};
