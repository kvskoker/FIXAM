const {
    withinServiceWindow,
    flattenForTemplate,
    greetingNameFor,
    buildParams,
    TEMPLATE_NAME,
} = require('../services/officialBroadcast');

const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000);

describe('withinServiceWindow', () => {
    test('open while the last inbound message is under 24 hours old', () => {
        expect(withinServiceWindow(hoursAgo(1))).toBe(true);
        expect(withinServiceWindow(hoursAgo(23.5))).toBe(true);
    });

    test('closed once 24 hours have passed', () => {
        expect(withinServiceWindow(hoursAgo(24.5))).toBe(false);
        expect(withinServiceWindow(hoursAgo(24 * 30))).toBe(false);
    });

    // An officer who has never written in is the common case for a newly
    // onboarded MDA, and treating "no timestamp" as an open window would send
    // them a plain message that Meta rejects.
    test('closed when there is no inbound message on record', () => {
        expect(withinServiceWindow(null)).toBe(false);
        expect(withinServiceWindow(undefined)).toBe(false);
        expect(withinServiceWindow('not a date')).toBe(false);
    });

    test('accepts the ISO strings the driver returns as well as Date objects', () => {
        expect(withinServiceWindow(hoursAgo(2).toISOString())).toBe(true);
        expect(withinServiceWindow(hoursAgo(48).toISOString())).toBe(false);
    });
});

describe('flattenForTemplate', () => {
    const alert = '📢 *ISSUE ALERT* 📢\n\n'
        + '*Urgency:* HIGH\n'
        + '*Category:* Water\n'
        + '*ID:* FIX-A1B2C3';

    // Meta rejects the whole message if a parameter contains any of these, and
    // the error names the code rather than the character.
    test('leaves no newline, tab or long space run behind', () => {
        const flat = flattenForTemplate(alert);
        expect(flat).not.toMatch(/[\n\r\t]/);
        expect(flat).not.toMatch(/ {5}/);
    });

    test('keeps the fields separable rather than running them together', () => {
        expect(flattenForTemplate(alert)).toContain('*Urgency:* HIGH • *Category:* Water');
    });

    test('drops the blank lines instead of emitting empty separators', () => {
        expect(flattenForTemplate('one\n\n\ntwo')).toBe('one • two');
    });

    test('truncates rather than letting Meta reject an over-long parameter', () => {
        const flat = flattenForTemplate('x'.repeat(2000));
        expect(flat.length).toBeLessThanOrEqual(900);
        expect(flat.endsWith('…')).toBe(true);
    });

    test('survives empty and missing input', () => {
        expect(flattenForTemplate('')).toBe('');
        expect(flattenForTemplate(null)).toBe('');
        expect(flattenForTemplate(undefined)).toBe('');
    });
});

describe('greetingNameFor', () => {
    test('greets by first name', () => {
        expect(greetingNameFor({ name: 'Mohamed Sesay' })).toBe('Mohamed');
    });

    test('prefers the parsed first name when one exists', () => {
        expect(greetingNameFor({ first_name: 'Aminata', name: 'Aminata Kamara' })).toBe('Aminata');
    });

    // An empty parameter is rejected outright, so there has to be a fallback.
    test('falls back to a form of address rather than an empty parameter', () => {
        expect(greetingNameFor({ name: '' })).toBe('Colleague');
        expect(greetingNameFor({})).toBe('Colleague');
        expect(greetingNameFor(null)).toBe('Colleague');
    });
});

describe('buildParams', () => {
    const member = { name: 'Mohamed Sesay' };
    const alert = '📢 *ISSUE ALERT* 📢\n\n*Urgency:* HIGH\n*ID:* FIX-A1B2C3';

    // The template is written with {{customer_name}} and {{message_details}},
    // and Meta matches on those names rather than on position. A wrong or
    // missing name fails the send outright instead of filling the wrong slot.
    test('names both parameters the way the template declares them', () => {
        const params = buildParams(member, alert);
        expect(params.map(p => p.name)).toEqual(['customer_name', 'message_details']);
    });

    test('greets by first name and flattens the alert body', () => {
        const [greeting, body] = buildParams(member, alert);
        expect(greeting.text).toBe('Mohamed');
        expect(body.text).not.toMatch(/[\n\r\t]/);
        expect(body.text).toContain('FIX-A1B2C3');
    });

    test('never produces an empty greeting, which Meta rejects', () => {
        const [greeting] = buildParams({}, '');
        expect(greeting.text.length).toBeGreaterThan(0);
    });
});

describe('template identity', () => {
    test('defaults to the utility template that exists in the dashboard', () => {
        expect(TEMPLATE_NAME).toBe('fixam_broadcast_message');
    });
});
