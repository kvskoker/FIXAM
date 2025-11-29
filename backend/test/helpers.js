// fenam-helpers.js
// Helper functions for FENAM service

const axios = require('axios');

class FenamHelpers {
  constructor(debugLog) {
    this.debugLog = debugLog;
    
    // List of service types that FENAM supports
    this.serviceTypes = [
      'Hair Dresser', 'Barber', 'Carpenter', 'Mechanic', 'Welder', 
      'Electrician', 'Plumber', 'Painter', 'Tailor', 'Mason',
      'Tiler', 'Roofer', 'AC Technician', 'Phone Repair', 'Computer Repair',
      'Catering', 'Event Planning', 'Photography', 'Videography', 'DJ',
      'Cleaning Service', 'Laundry', 'Gardener', 'Security', 'Driver'
    ];

    // Dummy provider data
    this.dummyProviders = this.generateDummyProviders();
  }

  // Generate dummy provider data
  generateDummyProviders() {
    const providers = [];
    const firstNames = ['Abdul', 'Fatmata', 'Mohamed', 'Mariama', 'Ibrahim', 'Isatu', 'Sorie', 'Kadiatu', 'Alimamy', 'Hawa'];
    const lastNames = ['Kamara', 'Sesay', 'Koroma', 'Bangura', 'Conteh', 'Turay', 'Mansaray', 'Jalloh', 'Kanu', 'Fofanah'];
    
    this.serviceTypes.forEach(serviceType => {
      // Generate 5-8 providers per service type
      const count = Math.floor(Math.random() * 4) + 5;
      for (let i = 0; i < count; i++) {
        const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
        const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];
        const phoneNumber = `232${Math.floor(Math.random() * 90000000) + 10000000}`;
        const reviews = [3, 4, 5][Math.floor(Math.random() * 3)];
        const verified = Math.random() > 0.3; // 70% verified
        // Price range: SLE 50 to SLE 2000
        const startingFee = Math.floor(Math.random() * (2000 - 50 + 1)) + 50;
        
        providers.push({
          name: `${firstName} ${lastName}`,
          serviceType: serviceType,
          phoneNumber: phoneNumber,
          reviews: reviews,
          verified: verified,
          startingFee: startingFee,
          // Random location in Freetown area (8.4657° N, 13.2317° W)
          latitude: 8.4657 + (Math.random() - 0.5) * 0.1,
          longitude: -13.2317 + (Math.random() - 0.5) * 0.1
        });
      }
    });

    return providers;
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
          'User-Agent': 'FENAM-Service/1.0' // Required by Nominatim
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
          'User-Agent': 'FENAM-Service/1.0'
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

  // Match user input to service type
  matchServiceType(userInput) {
    const input = userInput.toLowerCase().trim();
    
    // Direct match
    for (const serviceType of this.serviceTypes) {
      if (serviceType.toLowerCase() === input) {
        return serviceType;
      }
    }

    // Partial match
    for (const serviceType of this.serviceTypes) {
      if (serviceType.toLowerCase().includes(input) || input.includes(serviceType.toLowerCase())) {
        return serviceType;
      }
    }

    // Fuzzy matching for common variations
    const variations = {
      'hair': 'Hair Dresser',
      'cut': 'Barber',
      'wood': 'Carpenter',
      'car': 'Mechanic',
      'weld': 'Welder',
      'electric': 'Electrician',
      'pipe': 'Plumber',
      'paint': 'Painter',
      'sew': 'Tailor',
      'build': 'Mason',
      'tile': 'Tiler',
      'roof': 'Roofer',
      'ac': 'AC Technician',
      'air': 'AC Technician',
      'phone': 'Phone Repair',
      'computer': 'Computer Repair',
      'laptop': 'Computer Repair',
      'food': 'Catering',
      'cook': 'Catering',
      'event': 'Event Planning',
      'photo': 'Photography',
      'video': 'Videography',
      'music': 'DJ',
      'clean': 'Cleaning Service',
      'wash': 'Laundry',
      'garden': 'Gardener',
      'guard': 'Security',
      'drive': 'Driver'
    };

    for (const [key, value] of Object.entries(variations)) {
      if (input.includes(key)) {
        return value;
      }
    }

    return null;
  }

  // Calculate distance between two coordinates (Haversine formula)
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = this.toRadians(lat2 - lat1);
    const dLon = this.toRadians(lon2 - lon1);
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;
    
    return Math.round(distance * 10) / 10; // Round to 1 decimal place
  }

  toRadians(degrees) {
    return degrees * (Math.PI / 180);
  }

  // Get providers by service type and location
  getProvidersByService(serviceType, userLat, userLon, limit = 3, offset = 0) {
    // Filter providers by service type
    let providers = this.dummyProviders.filter(p => p.serviceType === serviceType);

    // Calculate distance for each provider
    providers = providers.map(provider => ({
      ...provider,
      distance: this.calculateDistance(userLat, userLon, provider.latitude, provider.longitude)
    }));

    // Sort by distance
    providers.sort((a, b) => a.distance - b.distance);

    // Return paginated results
    return {
      providers: providers.slice(offset, offset + limit),
      allProviders: providers, // Keep all for pagination
      hasMore: providers.length > (offset + limit),
      totalCount: providers.length,
      currentOffset: offset
    };
  }

  // Format provider list for display
  formatProviderList(providers, startIndex = 0) {
    return providers.map((provider, index) => {
      const stars = '⭐'.repeat(provider.reviews);
      const verifiedBadge = provider.verified ? '✓ Verified' : '';
      const fee = `Le ${provider.startingFee.toLocaleString()}`;
      
      return `${startIndex + index + 1}. *${provider.name}*\n   ${stars} (${provider.reviews} stars) ${verifiedBadge}\n   📍 ${provider.distance} km away\n   💰 Starting fee: ${fee}`;
    }).join('\n\n');
  }

  // Format provider list with "See more" option
  formatProviderListWithMore(providers, hasMore, totalRemaining) {
    const formatted = this.formatProviderList(providers);
    if (hasMore) {
      return `${formatted}\n\n4. *See more providers* (${totalRemaining} more available)`;
    }
    return formatted;
  }

  // Format currency
  formatCurrency(amount) {
    return `Le ${amount.toLocaleString()}`;
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

    return null;
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
        
        // Validate coordinates are in Sierra Leone range
        if (lat >= 6.9 && lat <= 10.0 && lon >= -13.5 && lon <= -10.2) {
          return { latitude: lat, longitude: lon };
        }
      }
    }

    return null;
  }
}

module.exports = FenamHelpers;
