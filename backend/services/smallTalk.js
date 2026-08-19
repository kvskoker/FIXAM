/**
 * Recognising the messages that are conversation rather than instruction.
 *
 * People do not talk to a bot the way they fill in a form. Between the answers
 * that matter come "ok", "tenki ya", "kushe", a thumbs-up, "how di bodi" -- and
 * every one of them used to be handled by the same code that handles a report.
 *
 * Two rules shape this module, both learned from the way the previous version
 * failed:
 *
 *  1. Small talk is matched on the WHOLE message, never as a substring. The old
 *     check was `lowerInput.includes('thanks')`, which meant a citizen
 *     describing "the road by Thanksgiving Ground is washed away" had their
 *     report thrown away and replaced with "You're very welcome!". A message is
 *     small talk or it is not; there is no such thing as a description that is
 *     partly a greeting.
 *
 *  2. "Yes" and "no" are deliberately NOT small talk. They are answers. Every
 *     confirmation step in the bot needs them, and a module that swallowed them
 *     centrally would have to be special-cased at each of those steps -- which
 *     is exactly the tangle this replaces.
 *
 * The vocabulary is deliberately local. Krio is what people actually type in
 * Freetown, so "kushe", "aw di bodi", "tenki ya" and "no vex" carry the same
 * weight here as "hello" and "thanks".
 */

'use strict';

/** Emoji that carry a whole message on their own, and what they mean. */
const EMOJI_MEANINGS = [
    { type: 'thanks', chars: ['🙏'] },
    { type: 'greeting', chars: ['👋', '🤝'] },
    { type: 'laugh', chars: ['😂', '🤣', '😹', '😄', '😃', '😆'] },
    { type: 'praise', chars: ['❤️', '❤', '😍', '🔥', '💪', '🎉', '👏', '⭐'] },
    { type: 'ack', chars: ['👍', '👌', '✅', '☑️', '💯', '🆗', '🙌', '😊', '🙂'] },
];

/**
 * Whole-message phrases, grouped by what the citizen means.
 *
 * Order matters only in that a phrase appearing in two groups resolves to the
 * first group listed, so the more specific intents come first.
 */
const PHRASES = {
    // "Are you a real person?" -- asked constantly on a WhatsApp bot, and
    // answering it honestly is a transparency obligation, not a nicety.
    identity: [
        'who are you', 'who is this', 'who be this', 'who dis',
        'what are you', 'what is this', 'wetin be this', 'wetin be dis',
        'what is fixam', 'what be fixam', 'wetin be fixam', 'what does fixam do',
        'what do you do', 'wetin you dey do', 'what can you do',
        'are you a bot', 'are you a robot', 'are you human', 'are you real',
        'is this a bot', 'is this a robot', 'na machine', 'na robot',
        'na person or machine', 'you be human',
    ],

    wellbeing: [
        'how are you', 'how are you doing', 'how are you today', 'how do you do',
        'how you dey', 'how you doing', 'how is it going', 'hows it going',
        'how is everything', 'hope you are fine', 'hope you are well',
        'aw di bodi', 'aw de bodi', 'how di bodi', 'how de body', 'how body',
        'aw yu du', 'aw you du', 'aw di go', 'how far', 'you good',
        'are you ok', 'are you okay', 'are you fine',
    ],

    greeting: [
        'hi', 'hii', 'hie', 'hey', 'heyy', 'hello', 'helo', 'hallo', 'hullo',
        'yo', 'hai', 'holla', 'hola', 'bonjour', 'salam', 'salaam',
        'assalamu alaikum', 'asalamu alaikum', 'shalom', 'greetings', 'greeting',
        'hi there', 'hello there', 'hey there', 'hi fixam', 'hello fixam',
        'hey fixam', 'fixam', 'start', 'menu', 'main menu', 'home',
        'good morning', 'good afternoon', 'good evening', 'good day',
        'morning', 'afternoon', 'evening', 'gm', 'ga', 'ge',
        'kushe', 'kushe o', 'kushe ya', 'kushe kushe', 'wotoko', 'bo',
        'wagwan', 'whatsup', 'whats up', 'wassup', 'wasup', 'sup', 'watsup',
        'wetin dey', 'wetin dey happen', 'how now',
    ],

    thanks: [
        'thanks', 'thank you', 'thank u', 'thanku', 'thankyou', 'thx', 'tnx', 'ty',
        'thanks a lot', 'thanks so much', 'thank you so much', 'thank you very much',
        'thanks very much', 'many thanks', 'big thanks', 'thanks fixam',
        'thank you fixam', 'thanks o', 'thank you o', 'thanks ya',
        'tanks', 'tenki', 'tenki ya', 'tenki so much', 'tenki plenty', 'tenki tenki',
        'tenki bo', 'mi tenki', 'appreciate', 'appreciate it', 'appreciated',
        'i appreciate', 'i appreciate it', 'much appreciated', 'grateful',
        'i am grateful', 'god bless', 'god bless you', 'bless you', 'respect',
    ],

    praise: [
        'good job', 'great job', 'nice job', 'well done', 'nice one', 'nice work',
        'good work', 'bravo', 'excellent', 'brilliant', 'amazing', 'wonderful',
        'keep it up', 'keep up the good work', 'this is nice', 'this is good',
        'i like this', 'i like it', 'na correct', 'na correct app', 'dis app fine',
        'this app is nice', 'you too much', 'you are too good', 'proud of you',
        'good initiative', 'nice initiative',
    ],

    apology: [
        'sorry', 'so sorry', 'am sorry', 'i am sorry', 'im sorry', 'my bad',
        'my apologies', 'apologies', 'pardon', 'pardon me', 'excuse me',
        'no vex', 'no vex o', 'sorry for that', 'sorry o', 'oops', 'my mistake',
    ],

    farewell: [
        'bye', 'byebye', 'bye bye', 'goodbye', 'good bye', 'gbye',
        'see you', 'see you later', 'see u', 'catch you later', 'later',
        'ttyl', 'talk later', 'we go talk', 'i go come', 'a de go',
        'good night', 'goodnight', 'gnite', 'nite', 'take care', 'cheers',
        'that is all', 'thats all', 'that is all for now', 'i am done',
        'am done', 'im done', 'nothing else', 'nothing more',
    ],

    laugh: [
        'lol', 'lmao', 'rofl', 'haha', 'hahaha', 'hehe', 'hehehe', 'hihi',
        'funny', 'very funny', 'you funny', 'na laugh',
    ],

    // The residue: sounds a person makes to show they are still there. These
    // must never be stored as an answer to anything.
    ack: [
        'ok', 'okay', 'okey', 'oky', 'okk', 'k', 'kk', 'ok o', 'okay o',
        'ok then', 'okay then', 'ok thanks', 'okay thanks', 'ok fine', 'okay fine',
        'alright', 'all right', 'aight', 'right', 'cool', 'fine', 'sure',
        'noted', 'understood', 'got it', 'gotcha', 'i see', 'i understand',
        'i hear', 'i hear you', 'a yeri', 'na so', 'e good', 'ehen',
        'no problem', 'no wahala', 'no worry', 'no worries', 'np',
        'great', 'good', 'very good', 'nice', 'perfect', 'awesome', 'super',
        'sounds good', 'sound good', 'well noted', 'copy', 'copied', 'roger',
        'hmm', 'hm', 'mmm', 'mm', 'oya', 'sha', 'anyway', 'whatever',
    ],
};

// Built once. Later groups do not overwrite earlier ones, so a phrase listed
// twice keeps the meaning of the group declared first.
const PHRASE_INDEX = new Map();
for (const [type, phrases] of Object.entries(PHRASES)) {
    for (const phrase of phrases) {
        if (!PHRASE_INDEX.has(phrase)) PHRASE_INDEX.set(phrase, type);
    }
}

// Greetings that can legitimately open a real request: "hello, there is a
// pothole...". Longest first so "good morning" wins over "morning".
//
// Two exclusions. Navigation words ("menu", "start") are commands, not
// greetings, so stripping them would leave the bot acting on the remainder of a
// command it should have obeyed whole. And the "hi there" family is left out
// because "hi there is a pothole" is a report -- matching the longer form would
// swallow the "there" that the sentence needs.
const GREETING_PREFIXES = PHRASES.greeting
    .filter((g) => !['menu', 'main menu', 'home', 'start', 'fixam'].includes(g))
    .filter((g) => !/\bthere$/.test(g))
    .sort((a, b) => b.length - a.length);

/**
 * Reduce a message to the form the phrase lists are written in.
 *
 * Punctuation and emoji go, case goes, and runs of a repeated letter are
 * shortened -- "okkkkk", "heyyy" and "tenkiiii" are the same word typed with
 * feeling.
 */
function normalize(input) {
    return String(input || '')
        .toLowerCase()
        .replace(/\p{Extended_Pictographic}/gu, ' ')
        .replace(/['’`]/g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * The variants of a message worth testing against the phrase lists.
 *
 * A repeated letter can be doubled legitimately ("good", "well"), so both the
 * collapse-to-two and the collapse-to-one forms are tried: "goooood morning"
 * reaches "good morning" through the first, "okkkk" reaches "ok" through the
 * second.
 */
function candidates(normalized) {
    const collapsedToTwo = normalized.replace(/(\p{L})\1{2,}/gu, '$1$1');
    const collapsedToOne = normalized.replace(/(\p{L})\1+/gu, '$1');
    return [...new Set([normalized, collapsedToTwo, collapsedToOne])];
}

/**
 * What does a message made only of emoji mean?
 * Returns a type, or null when the message is not emoji-only.
 */
function classifyEmojiOnly(raw) {
    const text = String(raw || '');
    if (!text.trim()) return null;
    // Anything with a letter or a digit is a worded message, whatever else it
    // carries.
    if (/[\p{L}\p{N}]/u.test(text)) return null;
    if (!/\p{Extended_Pictographic}/u.test(text)) return null;

    for (const { type, chars } of EMOJI_MEANINGS) {
        if (chars.some((c) => text.includes(c))) return type;
    }
    // An emoji we do not have a meaning for still means "I am here".
    return 'ack';
}

/**
 * Classify a whole message.
 *
 * @param {string} raw the sanitised message text
 * @returns {{type: string, matched: string} | null} null when this is not small talk
 */
function classify(raw) {
    const emojiType = classifyEmojiOnly(raw);
    if (emojiType) return { type: emojiType, matched: 'emoji' };

    const normalized = normalize(raw);
    if (!normalized) return null;

    // Nothing in the lists is longer than five words; checking first keeps a
    // long report from being scanned word by word.
    if (normalized.split(' ').length > 6) return null;

    for (const candidate of candidates(normalized)) {
        const type = PHRASE_INDEX.get(candidate);
        if (type) return { type, matched: candidate };
    }

    // "hello, how are you" and "hi thanks" -- a greeting glued to a second
    // piece of small talk. Strip the greeting and ask again; if what is left is
    // also small talk, the whole message is.
    const withoutGreeting = stripGreetingPrefix(normalized);
    if (withoutGreeting !== normalized && withoutGreeting) {
        for (const candidate of candidates(withoutGreeting)) {
            const type = PHRASE_INDEX.get(candidate);
            if (type) return { type, matched: candidate };
        }
        return null;
    }
    if (withoutGreeting !== normalized && !withoutGreeting) {
        return { type: 'greeting', matched: normalized };
    }

    return null;
}

/**
 * Remove an opening greeting, leaving the actual request.
 *
 * "hello I want to report a pothole" is a report, not a greeting. The old code
 * matched the leading "hello" and sent the citizen back to the menu, throwing
 * away the sentence they had just typed. Callers use this to keep the rest.
 */
function stripGreetingPrefix(text) {
    let working = String(text || '').trim();
    const lower = working.toLowerCase();

    for (const greeting of GREETING_PREFIXES) {
        // Only when a separator follows, so "hi" never eats the start of
        // "hilltop road" and "morning" never eats "morningside".
        const pattern = new RegExp(
            '^' + greeting.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[\\s,.!:;-])',
            'i'
        );
        if (pattern.test(lower)) {
            working = working.slice(greeting.length).replace(/^[\s,.!:;-]+/, '').trim();
            return working;
        }
    }
    return working;
}

/** Reply pools. One is picked at random so the bot does not sound like a loop. */
const REPLIES = {
    // Only used when a greeting arrives part-way through a flow: at the menu the
    // greeting IS the main menu, and the handler sends that instead.
    greeting: [
        'Hello again! 👋',
        'Kushe! 👋',
        'Hello! 👋',
    ],
    thanks: [
        "You're very welcome! 😊",
        'Happy to help! 🙏',
        'Any time — that is what we are here for. 😊',
        'Tenki ya! Glad to help. 🙏',
    ],
    praise: [
        'Thank you! That means a lot to the team. 🙏',
        'We appreciate that! 😊',
        'Thank you — we are working to make it even better. 💪',
    ],
    ack: [
        '👍 Let me know if you need anything else.',
        'Great! What would you like to do next?',
        '👍 I am here whenever you are ready.',
    ],
    laugh: [
        '😄 Glad that landed! What can I help you with?',
        '😊 Let me know how I can help.',
    ],
    apology: [
        'No need to apologise at all! 😊 How can I help?',
        'No vex — no problem at all. How can I help?',
    ],
    wellbeing: [
        "I'm doing well, thank you for asking! 😊 How can I help you today?",
        'All good on my side, tenki ya! 🙏 What can I do for you?',
    ],
    farewell: [
        'Goodbye! 👋 Thank you for helping improve our community. Say *Hi* any time.',
        'Take care! 👋 Say *Hi* whenever you need me.',
        'See you soon! 👋 Your reports make a real difference.',
    ],
    identity: [
        "I'm *FIXAM* 🤖 — an automated assistant that helps you report and track "
        + 'community infrastructure problems (roads, water, electricity, waste and more) '
        + 'so the right institution can act on them.\n\nI am a bot, not a person, '
        + 'but real people at the responsible institutions see every report.',
    ],
};

/** Which types should be followed by the main menu? */
const SHOWS_MENU = new Set(['greeting', 'thanks', 'praise', 'ack', 'laugh', 'apology', 'wellbeing', 'identity']);

/**
 * A reply for a classified type.
 * `types` with no pool fall back to the acknowledgement pool.
 */
function replyFor(type) {
    const pool = REPLIES[type] || REPLIES.ack;
    return pool[Math.floor(Math.random() * pool.length)];
}

/** Should the main menu follow this reply? */
function showsMenu(type) {
    return SHOWS_MENU.has(type);
}

module.exports = {
    classify,
    replyFor,
    showsMenu,
    stripGreetingPrefix,
    normalize,
    PHRASES,
};
