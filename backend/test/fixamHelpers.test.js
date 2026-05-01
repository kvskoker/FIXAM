// Fixam Helpers Tests
const FixamHelpers = require('../services/fixamHelpers');

describe('FixamHelpers', () => {
    let helpers;

    beforeEach(() => {
        helpers = new FixamHelpers(console.log);
    });

    test('generateTicketId returns a 10-char string', () => {
        const id = helpers.generateTicketId();
        expect(typeof id).toBe('string');
        expect(id.length).toBe(10);
    });

    test('generateTicketId starts with FIX- prefix', () => {
        const id = helpers.generateTicketId();
        expect(id.startsWith('FIX-')).toBe(true);
    });

    test('generateTicketId only contains uppercase alphanumeric after prefix', () => {
        const id = helpers.generateTicketId();
        const suffix = id.substring(4); // After "FIX-"
        expect(suffix).toMatch(/^[A-Z0-9]{6}$/);
    });

    test('generateTicketId produces unique values', () => {
        const ids = new Set();
        for (let i = 0; i < 100; i++) {
            ids.add(helpers.generateTicketId());
        }
        // All 100 should be unique (astronomically likely)
        expect(ids.size).toBe(100);
    });

    // Geocode
    test('geocodeAddress returns array on valid query', async () => {
        const results = await helpers.geocodeAddress('Freetown, Sierra Leone');
        expect(Array.isArray(results)).toBe(true);
    });

    test('geocodeAddress returns coordinates structure', async () => {
        const results = await helpers.geocodeAddress('Freetown, Sierra Leone');
        if (results.length > 0) {
            expect(results[0]).toHaveProperty('latitude');
            expect(results[0]).toHaveProperty('longitude');
            expect(results[0]).toHaveProperty('display_name');
        }
    });
});
