// Name parsing and blacklisting.
//
// The first block is the regression suite that matters: every one of those
// strings is a real value from the pilot database's `name` column. If any of
// them starts passing again, the register is filling up with sentences.
const nameValidator = require('../services/nameValidator');

const { parseName, mergeBlacklist } = nameValidator;

describe('parseName — values found in the pilot database', () => {
    test('"I\'m John Doe" yields John Doe, then refuses it as a placeholder', () => {
        // The lead-in is stripped correctly -- the blacklist is what stops it.
        const result = parseName("I'm John Doe");
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('blacklisted');
    });

    test('"I\'m Sorie Kamara" yields Sorie Kamara', () => {
        const result = parseName("I'm Sorie Kamara");
        expect(result.ok).toBe(true);
        expect(result.fullName).toBe('Sorie Kamara');
        expect(result.firstName).toBe('Sorie');
        expect(result.lastName).toBe('Kamara');
    });

    test('"call me John" is refused for want of a surname, not stored as "call me John"', () => {
        const result = parseName('call me John');
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('single_name');
        // The guidance names them, so the next message can just add a surname.
        expect(result.message).toContain('John');
    });

    test('"I Just Saw This" is refused as a sentence', () => {
        expect(parseName('I Just Saw This').reason).toBe('not_a_name');
    });

    test('"Wasup" is refused', () => {
        expect(parseName('Wasup').ok).toBe(false);
    });

    test('"Who Win The Big Five AI And Blockchain Hackathon?" is refused as a question', () => {
        const result = parseName('Who Win The Big Five AI And Blockchain Hackathon?');
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('question');
    });

    test('"Kon3" is refused for the digit', () => {
        expect(parseName('Kon3').reason).toBe('contains_digits');
    });

    test('"Tester" is refused as a reserved word, not merely as a single name', () => {
        const result = parseName('Tester');
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('blacklisted');
    });

    test('"Am Called  Michel Hindolo Tommy" yields Michel Hindolo Tommy', () => {
        const result = parseName('Am Called  Michel Hindolo Tommy');
        expect(result.ok).toBe(true);
        expect(result.fullName).toBe('Michel Hindolo Tommy');
        expect(result.firstName).toBe('Michel');
        expect(result.lastName).toBe('Tommy');
        expect(result.middleNames).toEqual(['Hindolo']);
    });
});

describe('parseName — a surname is required', () => {
    test('"John" alone is refused', () => {
        const result = parseName('John');
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('single_name');
    });

    test('"John Conteh" is accepted', () => {
        const result = parseName('John Conteh');
        expect(result.ok).toBe(true);
        expect(result.firstName).toBe('John');
        expect(result.lastName).toBe('Conteh');
    });

    test('initials are dropped rather than counted as a name', () => {
        const result = parseName('Fatmata O. Sesay');
        expect(result.ok).toBe(true);
        expect(result.fullName).toBe('Fatmata Sesay');
    });

    test('initials alone leave nothing to register', () => {
        expect(parseName('J K').reason).toBe('part_too_short');
    });

    test('a whole sentence is refused rather than truncated', () => {
        expect(parseName('there is a big pothole on my street').ok).toBe(false);
    });
});

describe('parseName — introductions and honorifics', () => {
    const introductions = {
        'my name is Sorie Kamara': 'Sorie Kamara',
        'My name na Sorie Kamara': 'Sorie Kamara',
        'i am Isatu Turay': 'Isatu Turay',
        'im Isatu Turay': 'Isatu Turay',
        'this is Michel Tommy': 'Michel Tommy',
        'you can call me Aminata Bangura': 'Aminata Bangura',
        'they call me Aminata Bangura': 'Aminata Bangura',
        'Hi, am called Michel Tommy': 'Michel Tommy',
        'Alhaji Ibrahim Turay': 'Ibrahim Turay',
        'Dr. Fatmata Sesay': 'Fatmata Sesay',
        'Mohamed Bangura please': 'Mohamed Bangura',
        'Good morning, my name is Adama Koroma': 'Adama Koroma',
    };

    for (const [input, expected] of Object.entries(introductions)) {
        test(`"${input}" -> ${expected}`, () => {
            const result = parseName(input);
            expect(result.ok).toBe(true);
            expect(result.fullName).toBe(expected);
        });
    }

    test('a name that merely begins with "Am" is left alone', () => {
        // The lead-in patterns all require whitespace after the phrase, which
        // is what keeps Amara from becoming "ara".
        expect(parseName('Amara Kamara').fullName).toBe('Amara Kamara');
    });

    test('a name that merely begins with "Im" is left alone', () => {
        expect(parseName('Imran Jalloh').fullName).toBe('Imran Jalloh');
    });
});

describe('parseName — capitalisation', () => {
    const expectations = {
        'aminata kamara': 'Aminata Kamara',
        'MOHAMED BANGURA': 'Mohamed Bangura',
        'aNnE-mArIe sesay-kamara': 'Anne-Marie Sesay-Kamara',
        "o'brien mccarthy": "O'Brien McCarthy",
        'michel de souza': 'Michel de Souza',
        'de souza': 'De Souza',
    };

    for (const [input, expected] of Object.entries(expectations)) {
        test(`"${input}" -> ${expected}`, () => {
            expect(parseName(input).fullName).toBe(expected);
        });
    }

    test('accented letters survive', () => {
        expect(parseName('josé márquez').fullName).toBe('José Márquez');
    });
});

describe('parseName — blacklist', () => {
    const blocked = [
        'Fixam', 'Fixam SL', 'fixam sierra leone', 'FIXAM BOT',
        'Apple', 'google', 'Facebook', 'Orange', 'Africell',
        'Government', 'Sierra Leone Police', 'Admin', 'System', 'Test',
    ];

    for (const name of blocked) {
        test(`"${name}" cannot be registered`, () => {
            const result = parseName(name);
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('blacklisted');
        });
    }

    test('a blacklisted word is blocked wherever it appears in the name', () => {
        expect(parseName('Mohamed Fixam').reason).toBe('blacklisted');
    });

    test('a multi-word entry blocks only the whole name', () => {
        // "Sierra Leone" is blocked; someone called Sierra is not.
        expect(parseName('Sierra Kamara').ok).toBe(true);
    });

    test('spacing and punctuation do not evade the list', () => {
        // The comparison key drops everything that is not a letter, so the same
        // word broken up any number of ways still matches.
        expect(parseName('F-i-x-a-m S-L').reason).toBe('blacklisted');
        expect(parseName('Fi Xamsl').reason).toBe('blacklisted');
    });

    test('fullwidth look-alikes do not evade the list', () => {
        // The sanitiser folds these to plain letters before the parser sees
        // them; parseName is given the folded form here to prove the pairing.
        const sanitizer = require('../services/inputSanitizer');
        const folded = sanitizer.sanitizeIdentifier('Ｆｉｘａｍ ＳＬ').text;
        expect(parseName(folded).reason).toBe('blacklisted');
    });

    test('extra entries can be configured without losing the built-ins', () => {
        const blacklist = mergeBlacklist('Bo City, Kenema Council');
        expect(parseName('Bo City', { blacklist }).reason).toBe('blacklisted');
        // The built-in list still applies.
        expect(parseName('Fixam', { blacklist }).reason).toBe('blacklisted');
    });

    test('an empty setting leaves the built-in list intact', () => {
        const blacklist = mergeBlacklist('');
        expect(parseName('Fixam', { blacklist }).reason).toBe('blacklisted');
    });
});

describe('parseName — hostile and malformed input', () => {
    test('markup is refused as invalid characters', () => {
        expect(parseName('<script>alert(1)</script>').reason).toBe('invalid_characters');
    });

    test('an SQL fragment is refused', () => {
        expect(parseName("Robert'); DROP TABLE users;--").ok).toBe(false);
    });

    test('digits anywhere are refused', () => {
        expect(parseName('Mohamed 007').reason).toBe('contains_digits');
    });

    test('a held-down key is refused', () => {
        expect(parseName('aaaa bbbb').ok).toBe(false);
    });

    test('an over-long name is refused rather than silently cut', () => {
        const result = parseName('Mohamedmohamedmohamedmohamedmohamed Bangura');
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('too_long');
    });

    test('too many parts is treated as a sentence', () => {
        expect(parseName('Abu Bakarr Sorie Ibrahim Musa Kamara').reason).toBe('too_many_parts');
    });

    test('empty and whitespace-only input never throws', () => {
        expect(parseName('').reason).toBe('empty');
        expect(parseName('   ').reason).toBe('empty');
        expect(parseName(null).reason).toBe('empty');
        expect(parseName(undefined).reason).toBe('empty');
    });

    test('every refusal carries a sentence the bot can say', () => {
        const inputs = ['', 'John', 'Kon3', 'Fixam', 'Who is this?', 'J K', '<b>x</b>'];
        for (const input of inputs) {
            const result = parseName(input);
            expect(result.ok).toBe(false);
            expect(typeof result.message).toBe('string');
            expect(result.message.length).toBeGreaterThan(10);
        }
    });
});
