/**
 * Turning "what is your name?" into a first name and a surname we can stand
 * behind.
 *
 * The demo database is the argument for this module. It holds users called
 * "I'm John Doe", "call me John", "I Just Saw This", "Wasup", "Who Win The Big
 * Five AI And Blockchain Hackathon?", "Kon3", "Tester" and "Am Called  Michel
 * Hindolo Tommy" -- every one of them the whole message the citizen happened to
 * send at the moment the bot asked. A field that accepts anything records
 * nothing, and by the time an institution is reading a report the name on it is
 * the only thing tying it to a person.
 *
 * What comes out the other side is a first name and a surname, both of them
 * plausibly a name, neither of them a brand, an institution or a reserved word.
 *
 * Three judgements are worth stating, because they are judgements and not
 * facts:
 *
 *  - A surname is required. Sierra Leonean naming practice is given name plus
 *    family name, and a register of first names alone cannot distinguish the
 *    fourteen Mohameds who reported the same street. The cost is a citizen who
 *    genuinely uses one name, who is asked once more and can then be registered
 *    by an administrator; the alternative cost is a register that cannot be
 *    used.
 *
 *  - The word lists refuse things that could be somebody's name somewhere. A
 *    person named Orange or Government exists in principle; in this deployment
 *    the far likelier explanation is impersonation of the telco or the state,
 *    and the citizen is told plainly and can try again.
 *
 *  - Nothing here throws or blocks. Every refusal comes back as a reason and a
 *    sentence the bot can say out loud, so the flow always has somewhere to go.
 *
 * Pure and synchronous: the caller supplies any extra blacklist entries from
 * the database, so this module can be tested without one.
 */

'use strict';

const MIN_PART_LENGTH = 2;
const MAX_PART_LENGTH = 30;
const MAX_NAME_PARTS = 5;
const MAX_FULL_NAME_LENGTH = 80;

/**
 * Openings people put in front of their name, stripped one layer at a time.
 *
 * Applied repeatedly until nothing matches, because they stack: "Hi, am called
 * Michel Tommy" is a greeting on top of an introduction. Order within the list
 * is longest-first per family, so "am called" is consumed before the bare "am".
 *
 * Every pattern requires whitespace after the phrase, which is what keeps
 * "Amara Kamara" safe from the `am` rule and "Ibrahim" safe from the `i'm` one.
 */
const LEAD_IN_PATTERNS = [
    // Greetings and fillers that can precede the introduction.
    /^(hi|hii|hello|helo|hey|heyy|hai|yo|kushe|greetings|good\s+(morning|afternoon|evening|day))\b[\s,.!:-]*/i,
    /^(ok(ay)?|so|well|erm|um|please|pls|abeg|yes|yeah|sure)\b[\s,.!:-]*/i,
    // Introductions, English and Krio.
    /^my\s+name\s+(is|na)\s+/i,
    /^my\s+names?\s+/i,
    /^(the\s+)?name\s+(is|na)\s+/i,
    /^names?\s+/i,
    /^i\s+am\s+called\s+/i,
    /^am\s+called\s+/i,
    /^i'?m\s+called\s+/i,
    /^(you\s+can\s+)?call\s+me\s+/i,
    /^(they|dem|people)\s+call\s+me\s+/i,
    /^(also\s+)?known\s+as\s+/i,
    /^a\.?k\.?a\.?\s+/i,
    /^goes\s+by\s+/i,
    /^i\s+am\s+/i,
    /^i'?m\s+/i,
    /^im\s+/i,
    /^am\s+/i,
    /^this\s+is\s+/i,
    /^that\s+is\s+/i,
    /^it'?s\s+/i,
    /^its\s+/i,
    /^dis\s+na\s+/i,
    /^na\s+me\s+/i,
    /^me\s+na\s+/i,
    /^mi\s+n[ae]m\s+na\s+/i,
    /^a\s+n[ae]m\s+na\s+/i,
    // Honorifics. A title is not a name, and keeping it would sort every
    // Alhaji in the register together.
    /^(mr|mrs|ms|miss|mstr|master|dr|prof|professor|engr|eng|rev|reverend|pastor|imam|sheikh|alhaji|alhaj|hajia|haja|chief|pa|mama|papa|aunty|auntie|uncle|hon|honou?rable|sir|madam)\b\.?\s+/i,
];

/** Politeness people add after their name. */
const TRAILING_PATTERNS = [
    /[\s,.!]*\b(please|pls|abeg|thanks?|thank\s+you|tenki(\s+ya)?|sir|madam|ma)\b[\s,.!]*$/i,
];

/**
 * A message that asks rather than answers.
 *
 * "Who Win The Big Five AI And Blockchain Hackathon?" is in the demo database
 * as somebody's name. It reached the name field because the bot asked for a
 * name at the moment the citizen wanted to ask a question.
 */
const QUESTION_OPENERS = new Set([
    'who', 'what', 'when', 'where', 'why', 'which', 'whose', 'whom', 'how',
    'is', 'are', 'was', 'were', 'do', 'does', 'did', 'can', 'could', 'shall',
    'should', 'would', 'may', 'might', 'have', 'has', 'had',
    // Krio / West African question words.
    'wetin', 'udat', 'usai', 'ustem', 'aw', 'ow',
]);

/**
 * Words that appear in sentences, not in names.
 *
 * One of these anywhere in the input is enough to conclude the citizen typed a
 * phrase. Deliberately conservative: anything that is plausibly a given name
 * somewhere in West Africa -- Sunday, Prince, Blessing, Success, Precious,
 * Gift, May, Will -- is left out, because refusing a real name is a worse
 * failure than accepting an odd one.
 */
const NON_NAME_WORDS = new Set([
    'the', 'and', 'but', 'or', 'nor', 'for', 'with', 'from', 'into', 'onto',
    'this', 'that', 'these', 'those', 'here', 'there', 'then', 'than',
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'them',
    'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours',
    'am', 'is', 'are', 'was', 'were', 'be', 'being', 'been',
    'just', 'saw', 'see', 'seen', 'seeing', 'look', 'looking', 'watch',
    'want', 'wanted', 'need', 'needed', 'know', 'knew', 'think', 'thought',
    'said', 'say', 'says', 'tell', 'told', 'ask', 'asked', 'answer',
    'win', 'won', 'wins', 'winner', 'lose', 'lost',
    'big', 'small', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
    'eight', 'nine', 'ten', 'first', 'second', 'third', 'all', 'some', 'any',
    'not', 'never', 'nothing', 'something', 'anything', 'everything',
    'report', 'reporting', 'issue', 'issues', 'problem', 'complaint',
    'road', 'water', 'light', 'electricity', 'waste', 'rubbish', 'drainage',
    'pothole', 'flooding', 'street', 'bridge', 'hospital', 'school',
    'hackathon', 'blockchain', 'crypto', 'app', 'application', 'phone',
    'number', 'account', 'password', 'code', 'link', 'website',
    'hi', 'hii', 'hello', 'helo', 'hey', 'kushe', 'wasup', 'wassup', 'whatsup',
    'sup', 'wagwan', 'thanks', 'thank', 'tenki', 'ok', 'okay', 'yes', 'yeah',
    'no', 'nope', 'sorry', 'please', 'help', 'menu', 'start', 'stop', 'cancel',
    'na', 'dey', 'abeg', 'oya', 'wetin', 'udat', 'usai',
    'how', 'what', 'who', 'when', 'where', 'why', 'which',
    'good', 'bad', 'nice', 'fine', 'great', 'well', 'better', 'best', 'worst',
    'today', 'tomorrow', 'yesterday', 'now', 'later', 'soon', 'again',
]);

/**
 * Names nobody may register under.
 *
 * Grouped so the reason for each entry stays visible, and so a deployment in
 * another country can swap the local blocks without disturbing the rest. The
 * database adds to this list -- see `mergeBlacklist` -- it never replaces it.
 */
const PLATFORM_NAMES = [
    'Fixam', 'Fixam SL', 'Fixam Sierra Leone', 'Fixam Bot', 'Fixambot',
    'Fixam Support', 'Fixam Admin', 'Fixam Team', 'MaxCIT',
];

const INSTITUTION_NAMES = [
    'Government', 'Government of Sierra Leone', 'GoSL', 'State House',
    'Parliament', 'Ministry', 'Ministry of Health', 'Ministry of Works',
    'President', 'Vice President', 'Minister', 'Mayor', 'Paramount Chief',
    'Police', 'Sierra Leone Police', 'SLP', 'Military', 'Army', 'RSLAF',
    'Fire Force', 'Fire Service', 'Ambulance', 'Emergency Services',
    'Freetown City Council', 'City Council', 'Council', 'Local Council',
    'EDSA', 'SALWACO', 'Guma', 'Guma Valley', 'SLRA', 'SLRSA', 'NRA', 'NCRA',
    'NaCSA', 'ONS', 'ACC', 'Anti Corruption Commission', 'EPA',
    'United Nations', 'UNICEF', 'UNDP', 'WHO', 'World Bank', 'Red Cross',
];

const BRAND_NAMES = [
    'Orange', 'Orange SL', 'Orange Money', 'Africell', 'Africell Money',
    'Afrimoney', 'Qcell', 'Sierratel', 'Splash',
    'Apple', 'Google', 'Facebook', 'Meta', 'WhatsApp', 'Instagram', 'TikTok',
    'Twitter', 'YouTube', 'Microsoft', 'Amazon', 'Netflix', 'Samsung',
    'Huawei', 'Nokia', 'Tesla', 'OpenAI', 'ChatGPT', 'Anthropic',
    'Nike', 'Adidas', 'Coca Cola', 'Pepsi', 'Visa', 'Mastercard', 'PayPal',
    'Ecobank', 'Rokel', 'Rokel Bank', 'UBA', 'Zenith', 'GTBank', 'Access Bank',
    'Standard Chartered', 'Union Trust', 'Bank',
];

const RESERVED_WORDS = [
    'Admin', 'Administrator', 'Root', 'System', 'Superuser', 'Super Admin',
    'Moderator', 'Operator', 'Support', 'Helpdesk', 'Help Desk', 'Service',
    'Customer Care', 'Customer Service', 'Info', 'Contact', 'Notification',
    'Alert', 'Security', 'Verify', 'Verification', 'Emergency',
    'Bot', 'Chatbot', 'Robot', 'Assistant', 'Agent',
    'Test', 'Tester', 'Testing', 'Demo', 'Sample', 'Example', 'Dummy',
    'User', 'Username', 'Guest', 'Anonymous', 'Anon', 'Unknown', 'Nobody',
    'Someone', 'Somebody', 'Null', 'Undefined', 'None', 'Nil', 'Default',
    'Asdf', 'Asdfgh', 'Qwerty', 'Qwertyuiop', 'Zxcv', 'Zxcvbn', 'Hjkl',
    // Placeholder names, blocked as whole phrases only: Doe is a real surname
    // in this region -- Samuel Doe was a Liberian head of state -- so blocking
    // the word would refuse real people.
    'John Doe', 'Jane Doe', 'Joe Bloggs', 'Foo Bar', 'Lorem Ipsum',
];

/**
 * Kept apart from the rest so it can be tuned without touching the lists above.
 * Only unambiguous terms: anything that doubles as a real given name in any
 * community we serve stays off it.
 */
const PROFANITY = [
    'fuck', 'fucker', 'fucking', 'shit', 'shithead', 'bitch', 'bastard',
    'cunt', 'pussy', 'whore', 'slut', 'nigga', 'nigger', 'rape', 'rapist',
    'penis', 'vagina', 'porn', 'sex', 'ass', 'asshole', 'idiot', 'stupid',
    'fool', 'nonsense', 'devil', 'satan',
];

const DEFAULT_BLACKLIST = [
    ...PLATFORM_NAMES,
    ...INSTITUTION_NAMES,
    ...BRAND_NAMES,
    ...RESERVED_WORDS,
    ...PROFANITY,
];

/**
 * Nobiliary particles and their West African equivalents, which stay lowercase
 * in the middle of a name and take a capital at either end of it.
 */
const PARTICLES = new Set([
    'de', 'da', 'del', 'della', 'di', 'do', 'dos', 'das', 'du', 'des',
    'van', 'von', 'der', 'den', 'ter', 'ten', 'la', 'le', 'les',
    'bin', 'ibn', 'binte', 'al', 'el', 'ould', 'ap',
]);

/**
 * The comparison key for blacklist matching.
 *
 * Case, accents, spaces and punctuation all come out, so "Fixam SL",
 * "fixam-sl" and "F I X A M S L" collapse to the same string. The sanitiser has
 * already folded fullwidth and styled look-alikes to plain letters by the time
 * anything reaches here.
 */
function normalizeKey(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z]/g, '');
}

/**
 * Fold the configured blacklist into the two shapes matching needs: whole-name
 * phrases, and single words that may not appear as any part of a name.
 *
 * A multi-word entry ("Sierra Leone", "Coca Cola") only ever blocks the whole
 * name. That is what lets a citizen called Sierra Kamara register while "Sierra
 * Leone" is refused.
 */
function buildBlacklist(entries) {
    const phrases = new Set();
    const words = new Set();
    for (const entry of entries) {
        const raw = String(entry || '').trim();
        if (!raw) continue;
        const key = normalizeKey(raw);
        if (!key) continue;
        phrases.add(key);
        if (raw.split(/\s+/).length === 1) words.add(key);
    }
    return { phrases, words };
}

/**
 * Combine the built-in list with whatever an administrator has configured.
 * Accepts the raw `blacklisted_names` platform setting (comma or newline
 * separated) or an array.
 */
function mergeBlacklist(extra) {
    if (!extra) return DEFAULT_BLACKLIST.slice();
    const list = Array.isArray(extra)
        ? extra
        : String(extra).split(/[,\n;]/);
    return DEFAULT_BLACKLIST.concat(list.map((s) => String(s).trim()).filter(Boolean));
}

/** Is this a plausible single component of a name? */
function isValidPart(part) {
    // A letter at each end, letters/apostrophes/hyphens between. No digits, no
    // punctuation runs, nothing that starts or ends with a separator.
    if (!/^\p{L}(?:[\p{L}'-]*\p{L})?$/u.test(part)) return false;
    if (/['-]{2,}/.test(part)) return false;
    // "aaaa", "zzz" -- a key held down, not a name.
    if (/^(\p{L})\1+$/u.test(part)) return false;
    return true;
}

/** Capitalise one component, respecting the forms that are not simply Xxxx. */
function formatPart(part, { isEdge }) {
    const lower = part.toLowerCase();

    if (!isEdge && PARTICLES.has(lower)) return lower;

    const capitalise = (segment) => {
        if (!segment) return segment;
        // O'Brien, D'Souza, N'Diaye: a short prefix before the apostrophe means
        // the letter after it is the start of the real name.
        const apostrophe = segment.match(/^(\p{L}{1,2})['’](\p{L}.*)$/u);
        if (apostrophe) {
            return apostrophe[1].charAt(0).toUpperCase() + apostrophe[1].slice(1).toLowerCase()
                + "'" + apostrophe[2].charAt(0).toUpperCase() + apostrophe[2].slice(1).toLowerCase();
        }
        // McCarthy, McDonald. "Mac" is left alone: Macaulay and MacDonald are
        // both common and no rule tells them apart.
        const mc = segment.match(/^mc(\p{L}{2,})$/u);
        if (mc) return 'Mc' + mc[1].charAt(0).toUpperCase() + mc[1].slice(1);
        return segment.charAt(0).toUpperCase() + segment.slice(1);
    };

    // Hyphenated names capitalise on both sides: Sesay-Kamara, Anne-Marie.
    return lower.split('-').map(capitalise).join('-');
}

/** Strip the openings and the trailing politeness, repeatedly. */
function stripFraming(input) {
    let text = String(input || '').trim();

    let changed = true;
    let guard = 0;
    while (changed && guard < 8) {
        changed = false;
        guard += 1;
        for (const pattern of LEAD_IN_PATTERNS) {
            const next = text.replace(pattern, '');
            if (next !== text) {
                text = next.trim();
                changed = true;
                break;
            }
        }
    }

    changed = true;
    guard = 0;
    while (changed && guard < 8) {
        changed = false;
        guard += 1;
        for (const pattern of TRAILING_PATTERNS) {
            const next = text.replace(pattern, '');
            if (next !== text) {
                text = next.trim();
                changed = true;
                break;
            }
        }
    }

    return text.trim();
}

/** The sentence the bot says for each way a name can be refused. */
function messageFor(reason, context = {}) {
    switch (reason) {
        case 'empty':
            return "I didn't catch a name there. Please send your *full name* — "
                + 'first name and surname, for example *John Conteh*.';
        case 'question':
            return "That looks like a question rather than a name. I'll be happy to help "
                + 'once you are registered — please send your *full name* first '
                + '(for example *John Conteh*).';
        case 'not_a_name':
            return "That doesn't look like a name. Please send just your *full name* — "
                + 'first name and surname, for example *Aminata Kamara*.';
        case 'contains_digits':
            return 'A name cannot contain numbers. Please send your *full name* using '
                + 'letters only, for example *Mohamed Bangura*.';
        case 'invalid_characters':
            return 'Please send your *full name* using letters only — for example '
                + '*Fatmata Sesay*. Hyphens and apostrophes are fine.';
        case 'single_name':
            return context.firstName
                ? `Thanks ${context.firstName}! I also need your surname. `
                    + `Please send your *full name*, for example *${context.firstName} Conteh*.`
                : 'Please send your *full name* — both your first name and your surname, '
                    + 'for example *John Conteh*.';
        case 'too_many_parts':
            return 'That is longer than a name. Please send just your *first name and '
                + 'surname*, for example *Isatu Turay*.';
        case 'too_long':
            return 'That name is too long. Please send your *first name and surname* only.';
        case 'part_too_short':
            return 'Each part of your name needs at least two letters. Please send your '
                + '*full name*, for example *John Conteh*.';
        case 'blacklisted':
            return 'That name cannot be used to register. Please use *your own full name* '
                + '— first name and surname.';
        default:
            return 'Please send your *full name* — first name and surname, for example '
                + '*John Conteh*.';
    }
}

/**
 * Parse a citizen's answer to "what is your name?".
 *
 * @param {string} raw       the sanitised message text
 * @param {object} [options]
 * @param {string[]} [options.blacklist] full blacklist; defaults to the built-in one
 * @returns {object} `{ ok: true, firstName, lastName, middleNames, fullName }`
 *                   or `{ ok: false, reason, message }`
 */
function parseName(raw, options = {}) {
    const blacklist = buildBlacklist(options.blacklist || DEFAULT_BLACKLIST);

    const refuse = (reason, context) => ({ ok: false, reason, message: messageFor(reason, context) });

    let text = String(raw || '').trim();
    if (!text) return refuse('empty');

    // A question mark settles it before any other analysis.
    if (text.includes('?')) return refuse('question');

    text = stripFraming(text);
    if (!text) return refuse('empty');

    // Commas and full stops separate parts; everything else that is not a
    // letter, apostrophe or hyphen has no business in a name.
    const spaced = text.replace(/[,.]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!spaced) return refuse('empty');

    // Punctuation is checked before digits so that pasted markup is reported as
    // markup ("please use letters only") rather than as a stray number.
    if (/[@#$%^&*_=+/\\|<>{}[\]()~`"]/.test(spaced)) return refuse('invalid_characters');
    if (/\d/.test(spaced)) return refuse('contains_digits');

    const rawParts = spaced.split(' ').filter(Boolean);
    const lowerParts = rawParts.map((p) => p.toLowerCase().replace(/['’-]/g, ''));

    if (QUESTION_OPENERS.has(lowerParts[0])) return refuse('question');
    if (lowerParts.some((p) => NON_NAME_WORDS.has(p))) return refuse('not_a_name');

    if (rawParts.length > MAX_NAME_PARTS) return refuse('too_many_parts');

    for (const part of rawParts) {
        if (part.length > MAX_PART_LENGTH) return refuse('too_long');
        if (!isValidPart(part)) {
            return refuse(/[^\p{L}'-]/u.test(part) ? 'invalid_characters' : 'not_a_name');
        }
    }

    // Single-letter parts are initials, and an initial is not a name we can put
    // in front of an institution. Reported separately from the surname rule so
    // the citizen is told which thing to fix.
    if (rawParts.some((part) => part.length < MIN_PART_LENGTH)) {
        const usable = rawParts.filter((p) => p.length >= MIN_PART_LENGTH);
        if (usable.length < 2) {
            return refuse('part_too_short');
        }
        // Drop the initials and carry on with what is left: "John K Conteh" is
        // John Conteh.
        rawParts.length = 0;
        rawParts.push(...usable);
    }

    if (rawParts.length < 2) {
        const only = rawParts[0]
            ? formatPart(rawParts[0], { isEdge: true })
            : null;
        // Refuse a blacklisted single word as blacklisted rather than asking for
        // a surname -- "Tester" does not become acceptable with one added.
        if (only && blacklist.words.has(normalizeKey(only))) return refuse('blacklisted');
        return refuse('single_name', { firstName: only });
    }

    const formatted = rawParts.map((part, index) =>
        formatPart(part, { isEdge: index === 0 || index === rawParts.length - 1 }));

    const fullName = formatted.join(' ');
    if (fullName.length > MAX_FULL_NAME_LENGTH) return refuse('too_long');

    if (blacklist.phrases.has(normalizeKey(fullName))) return refuse('blacklisted');
    if (formatted.some((part) => blacklist.words.has(normalizeKey(part)))) return refuse('blacklisted');

    return {
        ok: true,
        firstName: formatted[0],
        lastName: formatted[formatted.length - 1],
        middleNames: formatted.slice(1, -1),
        fullName,
    };
}

module.exports = {
    parseName,
    mergeBlacklist,
    normalizeKey,
    stripFraming,
    DEFAULT_BLACKLIST,
    PLATFORM_NAMES,
    INSTITUTION_NAMES,
    BRAND_NAMES,
    RESERVED_WORDS,
    MAX_FULL_NAME_LENGTH,
};
