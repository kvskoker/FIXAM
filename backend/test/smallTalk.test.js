// Small-talk recognition.
//
// The negative cases are the important ones. The version this replaces matched
// on substrings, so any report containing the letters "thanks" or starting with
// "hi " was discarded and answered with a pleasantry. Every "is not small talk"
// test below is a report that used to be lost.
const smallTalk = require('../services/smallTalk');

const { classify, showsMenu, stripGreetingPrefix } = smallTalk;

const typeOf = (input) => {
    const result = classify(input);
    return result ? result.type : null;
};

describe('classify — greetings', () => {
    const greetings = [
        'hi', 'Hi!', 'HELLO', 'hey', 'heyyy', 'good morning', 'Good Afternoon',
        'goooood morning', 'kushe', 'kushe o', 'wagwan', 'wasup', 'menu', 'start',
    ];
    for (const input of greetings) {
        test(`"${input}" is a greeting`, () => expect(typeOf(input)).toBe('greeting'));
    }
});

describe('classify — thanks, praise and acknowledgement', () => {
    const expectations = {
        'thanks': 'thanks',
        'Thank you': 'thanks',
        'thankssss': 'thanks',
        'tenki ya': 'thanks',
        'God bless': 'thanks',
        'well done': 'praise',
        'nice one': 'praise',
        'ok': 'ack',
        'Okkkk': 'ack',
        'alright': 'ack',
        'no wahala': 'ack',
        'noted': 'ack',
        'great': 'ack',
    };
    for (const [input, expected] of Object.entries(expectations)) {
        test(`"${input}" -> ${expected}`, () => expect(typeOf(input)).toBe(expected));
    }
});

describe('classify — the rest of the conversation', () => {
    test('"how are you" is a wellbeing question', () => {
        expect(typeOf('how are you')).toBe('wellbeing');
    });

    test('"aw di bodi" is a wellbeing question', () => {
        expect(typeOf('aw di bodi')).toBe('wellbeing');
    });

    test('"bye" is a farewell', () => {
        expect(typeOf('bye bye')).toBe('farewell');
    });

    test('"who are you" asks what this is', () => {
        expect(typeOf('who are you')).toBe('identity');
    });

    test('"are you a robot" asks what this is', () => {
        expect(typeOf('are you a robot')).toBe('identity');
    });

    test('"sorry" and "no vex" are apologies', () => {
        expect(typeOf('sorry')).toBe('apology');
        expect(typeOf('no vex')).toBe('apology');
    });

    test('a farewell does not lead back into the menu', () => {
        expect(showsMenu('farewell')).toBe(false);
        expect(showsMenu('greeting')).toBe(true);
    });
});

describe('classify — emoji-only messages', () => {
    test('a thumbs-up is an acknowledgement', () => expect(typeOf('👍')).toBe('ack'));
    test('folded hands are thanks', () => expect(typeOf('🙏')).toBe('thanks'));
    test('a wave is a greeting', () => expect(typeOf('👋')).toBe('greeting'));
    test('an unknown emoji still counts as being present', () => {
        expect(typeOf('🦋')).toBe('ack');
    });
    test('emoji alongside words are not emoji-only', () => {
        expect(typeOf('👍 there is a pothole on my street')).toBe(null);
    });
});

describe('classify — what is NOT small talk', () => {
    const reports = [
        // The regression that motivated whole-message matching: this contains
        // "thanks" and used to be answered with "You're very welcome!".
        'the road by Thanksgiving Ground is washed away',
        // Contains "ok".
        'the manhole cover at Brookfields is broken',
        // Starts with a greeting but carries a request.
        'hi there is a pothole on Wilkinson Road',
        'hello I want to report a burst pipe',
        'good morning, no light at Congo Cross since Friday',
        'I appreciate the work but the drain is still blocked',
        'thanks for fixing the last one, there is a new problem at Lumley',
    ];
    for (const input of reports) {
        test(`"${input}" is not small talk`, () => expect(classify(input)).toBe(null));
    }

    test('menu numbers are never small talk', () => {
        for (const n of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) {
            expect(classify(n)).toBe(null);
        }
    });

    test('a ticket ID is never small talk', () => {
        expect(classify('FIX-A1B2C3')).toBe(null);
    });

    test('"yes" and "no" are answers, not small talk', () => {
        // Every confirmation step in the bot needs these to reach it untouched.
        for (const input of ['yes', 'Yes', 'no', 'NO', 'yeah', 'nope']) {
            expect(classify(input)).toBe(null);
        }
    });

    test('navigation words are left to the handler', () => {
        for (const input of ['back', 'cancel', 'reset', 'skip', 'help']) {
            expect(classify(input)).toBe(null);
        }
    });
});

describe('stripGreetingPrefix', () => {
    test('removes an opening greeting and keeps the request', () => {
        expect(stripGreetingPrefix('hello I want to report flooding'))
            .toBe('I want to report flooding');
        expect(stripGreetingPrefix('Good morning, there is no water'))
            .toBe('there is no water');
    });

    test('leaves "there" alone after "hi"', () => {
        // "hi there is a pothole" is a report; matching the longer "hi there"
        // would eat the word the sentence needs.
        expect(stripGreetingPrefix('hi there is a pothole')).toBe('there is a pothole');
    });

    test('does not clip a word that merely starts with a greeting', () => {
        expect(stripGreetingPrefix('hilltop road is bad')).toBe('hilltop road is bad');
        expect(stripGreetingPrefix('heyford street flooding')).toBe('heyford street flooding');
    });

    test('leaves navigation commands whole', () => {
        expect(stripGreetingPrefix('menu')).toBe('menu');
        expect(stripGreetingPrefix('start')).toBe('start');
    });

    test('a message with no greeting is returned unchanged', () => {
        const input = 'the bridge at Kissy is cracked';
        expect(stripGreetingPrefix(input)).toBe(input);
    });
});

describe('replies', () => {
    test('every classified type produces something to say', () => {
        const types = ['greeting', 'thanks', 'praise', 'ack', 'laugh',
            'apology', 'wellbeing', 'farewell', 'identity'];
        for (const type of types) {
            const reply = smallTalk.replyFor(type);
            expect(typeof reply).toBe('string');
            expect(reply.length).toBeGreaterThan(0);
        }
    });

    test('the identity reply says plainly that this is a bot', () => {
        expect(smallTalk.replyFor('identity').toLowerCase()).toContain('bot');
    });
});
