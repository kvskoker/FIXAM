const axios = require('axios');

class FixamHelpers {
    constructor(debugLog) {
        this.debugLog = debugLog || console.log;
    }

    // Extract name from message (simple heuristic)
    extractNameFromMessage(message) {
        // Look for patterns like "My name is X" or "I'm X" or "This is X"
        const patterns = [
            /my name is ([a-zA-Z\s]+)/i,
            /i'm ([a-zA-Z\s]+)/i,
            /i am ([a-zA-Z\s]+)/i,
            /this is ([a-zA-Z\s]+)/i,
            /call me ([a-zA-Z\s]+)/i
        ];

        for (const pattern of patterns) {
            const match = message.match(pattern);
            if (match && match[1]) {
                return match[1].trim();
            }
        }

        // If just a name is sent (assuming it's not a command or common word)
        if (message.split(' ').length <= 3) {
            return message.trim();
        }

        return null;
    }

    // Geocode address using Nominatim API (limited to Sierra Leone)
    async geocodeAddress(address) {
        try {
            const response = await axios.get('https://nominatim.openstreetmap.org/search', {
                params: {
                    q: `${address}, Sierra Leone`,
                    format: 'json',
                    limit: 3,
                    countrycodes: 'sl', // Limit to Sierra Leone
                    addressdetails: 1
                },
                headers: {
                    'User-Agent': 'Fixam-Service/1.0' // Required by Nominatim
                }
            });

            if (response.data && response.data.length > 0) {
                return response.data.map(result => ({
                    display_name: result.display_name,
                    latitude: parseFloat(result.lat),
                    longitude: parseFloat(result.lon),
                    address: result.address
                }));
            }

            return [];
        } catch (error) {
            this.debugLog('Error geocoding address', { error: error.message, address });
            return [];
        }
    }

    // Reverse geocode coordinates to get address
    async reverseGeocode(latitude, longitude) {
        try {
            const response = await axios.get('https://nominatim.openstreetmap.org/reverse', {
                params: {
                    lat: latitude,
                    lon: longitude,
                    format: 'json',
                    addressdetails: 1
                },
                headers: {
                    'User-Agent': 'Fixam-Service/1.0'
                }
            });

            if (response.data && response.data.display_name) {
                return {
                    display_name: response.data.display_name,
                    latitude: parseFloat(response.data.lat),
                    longitude: parseFloat(response.data.lon),
                    address: response.data.address
                };
            }

            return null;
        } catch (error) {
            this.debugLog('Error reverse geocoding', { error: error.message, latitude, longitude });
            return null;
        }
    }

    // Parse location from message (coordinates)
    parseLocationFromMessage(message) {
        // Look for latitude and longitude patterns
        // Format: lat,lon or latitude:X longitude:Y
        const patterns = [
            /(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)/,
            /lat(?:itude)?:\s*(-?\d+\.?\d*)\s*lon(?:gitude)?:\s*(-?\d+\.?\d*)/i
        ];

        for (const pattern of patterns) {
            const match = message.match(pattern);
            if (match) {
                const lat = parseFloat(match[1]);
                const lon = parseFloat(match[2]);

                // Validate coordinates are in Sierra Leone range (approx)
                if (lat >= 6.9 && lat <= 10.0 && lon >= -13.5 && lon <= -10.2) {
                    return { latitude: lat, longitude: lon };
                }
            }
        }

        return null;
    }

    // Generate 10-char alphanumeric ticket ID
    generateTicketId() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        for (let i = 0; i < 10; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }
}

module.exports = FixamHelpers;
