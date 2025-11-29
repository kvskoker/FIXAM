// Interactive handler for the FƐNAM platform - connects service providers with customers

const FenamDatabase = require('./database');
const FenamHelpers = require('./helpers');

class FenamHandler {
  constructor(whatsAppService, databaseService, io, debugLog) {
    this.whatsAppService = whatsAppService;
    this.databaseService = databaseService;
    this.io = io;
    this.debugLog = debugLog;
    
    // Initialize FENAM-specific database and helpers
    this.fenamDb = new FenamDatabase(databaseService.pool, debugLog);
    this.helpers = new FenamHelpers(debugLog);
  }

  // Process incoming webhook data for the FƐNAM bot
  async processIncomingMessage(data) {
    if (data.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
      const message = data.entry[0].changes[0].value.messages[0];
      const fromNumber = this.whatsAppService.formatPhoneNumber(message.from);

      // Log the incoming message to the database
      const messageBody = message.text?.body || message.type;
      const loggedMessageId = await this.databaseService.logMessage({
        conversationId: fromNumber,
        waMessageId: message.id,
        direction: 'incoming',
        messageType: message.type,
        messageBody: messageBody,
      });

      // Emit to web UI
      if (loggedMessageId) {
        this.io.to(fromNumber).emit('newMessage', { 
            id: loggedMessageId,
            direction: 'incoming', 
            message_type: message.type, 
            message_body: messageBody,
            timestamp: new Date()
        });
      }

      this.debugLog(`Processing FƐNAM message from ${fromNumber}`, { messageType: message.type });
      
      // Handle location message type
      if (message.type === 'location') {
        await this.handleLocationMessage(fromNumber, message.location);
        return;
      }

      // Handle text messages
      if (message.type === 'text' && messageBody) {
        await this.handleTextMessage(fromNumber, messageBody);
        return;
      }

      // Handle other message types
      await this.sendMessage(fromNumber, "Sorry, I can only process text messages and location sharing at the moment. Please send a text message or share your location.");
    }
  }

  // Check if message is a conversation ender
  isConversationEnder(message) {
    const enders = ['bye', 'goodbye', 'thank you', 'thanks', 'tnx', 'thank u', 'thankyou', 'thx'];
    const normalized = message.toLowerCase().trim();
    return enders.some(ender => normalized === ender || normalized.startsWith(ender + ' ') || normalized.endsWith(' ' + ender));
  }

  // Check if message is a conversation starter
  isConversationStarter(message) {
    const starters = ['hi', 'sup', 'hru', 'how are you', 'hello', 'hey', 'start', 'good morning', 'good afternoon', 'good evening'];
    const normalized = message.toLowerCase().trim();
    return starters.some(starter => normalized === starter || normalized.startsWith(starter + ' '));
  }

  // Handle text messages based on conversation state
  async handleTextMessage(fromNumber, messageBody) {
    const input = messageBody.toLowerCase().trim();
    
    // --- 0. Pre-fetch User (Moved up to handle New User vs Returning User logic) ---
    let user = await this.fenamDb.getUser(fromNumber);

    // --- 1. Global Commands (High Priority) ---
    if (input === '99') {
      await this.handleNewSearchCommand(fromNumber);
      return;
    }
    
    if (input === '100' || input === 'change location') {
      await this.handleUpdateLocationCommand(fromNumber);
      return;
    }
    
    if (input === '111') {
      await this.handleCustomerSupportCommand(fromNumber);
      return;
    }

    // --- 2. Check for Greetings (Reset/Restart Logic) ---
    // FIXED: Only trigger "Welcome Back" flow if the user actually exists.
    // If user is new, we ignore this and let it fall through to "User Registration Check".
    if (this.isConversationStarter(messageBody)) {
      if (user) {
        await this.handleNewSearchCommand(fromNumber);
        return;
      }
      // If user is null, we do nothing here, continuing to Registration below.
    }

    // --- 3. User Registration Check ---
    if (!user) {
      // New user - check if name provided
      const extractedName = this.helpers.extractNameFromMessage(messageBody);
      await this.fenamDb.registerUser(fromNumber, extractedName);
      
      if (extractedName) {
        // Name provided, proceed to location
        await this.fenamDb.initializeConversationState(fromNumber);
        await this.sendMessage(fromNumber, 
          `Hello ${extractedName}! 👋 Welcome to FƐNAM!\n\nFƐNAM connects you with trusted service providers across Sierra Leone. 🇸🇱\n\nTo get started, I need to know your location to find skilled service providers in your area. You can either:\n\n📍 Share your location using WhatsApp's location feature\n✏️ Type your address (e.g., "Jabbiela Drive, Freetown")`
        );
      } else {
        // Name not provided (or message was just "Hi"), ask for it
        await this.fenamDb.initializeConversationState(fromNumber);
        await this.fenamDb.updateConversationState(fromNumber, { current_step: 'awaiting_name' });
        await this.sendMessage(fromNumber, 
          `Hello! 👋 Welcome to FƐNAM!\n\nFƐNAM connects you with trusted service providers across Sierra Leone. 🇸🇱\n\nBefore we start, may I know *your name*? This helps me personalize your experience. 😊`
        );
      }
      return;
    }

    // --- 4. Get Conversation State ---
    let state = await this.fenamDb.getConversationState(fromNumber);
    
    if (!state) {
      // Initialize state if it doesn't exist
      await this.fenamDb.initializeConversationState(fromNumber);
      state = await this.fenamDb.getConversationState(fromNumber);
    }

    // --- 5. Handle "Bye" / Ending ---
    if (this.isConversationEnder(messageBody)) {
      if (state.current_step !== 'conversation_ended') {
        await this.fenamDb.updateConversationState(fromNumber, {
          current_step: 'conversation_ended'
        });
        
        const name = user?.name ? `, ${user.name}` : '';
        await this.sendMessage(fromNumber, 
          `You're welcome${name}! 😊\n\nIt was great helping you today.\n\nTo start a new search anytime, just type *99* or say "Hi". 👋`
        );
      }
      return;
    }

    // --- 6. State Machine Logic ---
    switch (state.current_step) {
      case 'awaiting_name':
        await this.handleNameInput(fromNumber, messageBody, user);
        break;

      case 'awaiting_location':
        await this.handleLocationInput(fromNumber, messageBody, state);
        break;
      
      case 'awaiting_service_type':
        await this.handleServiceTypeInput(fromNumber, messageBody, state);
        break;
      
      case 'showing_providers':
      case 'awaiting_provider_selection':
        await this.handleProviderSelection(fromNumber, messageBody, state);
        break;
      
      case 'completed':
      case 'conversation_ended':
        await this.handleNewSearchCommand(fromNumber, true); // true = silent
        
        const possibleService = this.helpers.matchServiceType(messageBody);
        if (possibleService) {
           const freshState = await this.fenamDb.getConversationState(fromNumber);
           await this.handleServiceTypeInput(fromNumber, messageBody, freshState);
        } else {
           await this.handleNewSearchCommand(fromNumber);
        }
        break;
      
      default:
        await this.handleNewSearchCommand(fromNumber);
    }
  }

  // --- COMMAND HANDLERS ---

  async handleNewSearchCommand(fromNumber, silent = false) {
    const user = await this.fenamDb.getUser(fromNumber);
    const greeting = user?.name ? `Welcome back, ${user.name}! 👋` : `Welcome back! 👋`;

    const oldState = await this.fenamDb.getConversationState(fromNumber);
    const savedLocation = {
      address: oldState?.user_address,
      lat: oldState?.user_latitude,
      long: oldState?.user_longitude
    };

    await this.fenamDb.resetConversationState(fromNumber, true); 
    
    if (savedLocation.address) {
      await this.fenamDb.updateConversationState(fromNumber, {
        user_address: savedLocation.address,
        user_latitude: savedLocation.lat,
        user_longitude: savedLocation.long,
        current_step: 'awaiting_service_type'
      });

      if (!silent) {
        await this.sendMessage(fromNumber, 
          `${greeting}\n\nI remember you are at:\n📍 *${savedLocation.address}*\n\nWhat service do you need today? (e.g., Plumber, Mechanic, Tailor)` + this.getFooter()
        );
      }
    } else {
      await this.fenamDb.updateConversationState(fromNumber, {
        current_step: 'awaiting_location'
      });

      if (!silent) {
        await this.sendMessage(fromNumber, 
          `${greeting}\n\nPlease share your location to get started.\n\n📍 Share your location using WhatsApp's location feature or\n✏️ Type your address (e.g., "Jabbiela Drive, Freetown")` + this.getFooter()
        );
      }
    }
  }

  async handleUpdateLocationCommand(fromNumber) {
    const user = await this.fenamDb.getUser(fromNumber);
    
    if (!user) {
      await this.handleNewSearchCommand(fromNumber);
      return;
    }
    
    await this.fenamDb.updateConversationState(fromNumber, {
      current_step: 'awaiting_location',
      temp_location_change: true,
      pending_addresses: null
    });
    
    const name = user.name ? `, ${user.name}` : '';
    await this.sendMessage(fromNumber,
      `Alright${name}, let's update your location! 📍\n\n📍 Share your new location using WhatsApp or\n✏️ Type your new address`
    );
  }

  async handleCustomerSupportCommand(fromNumber) {
    await this.sendMessage(fromNumber,
      `📞 *FƐNAM Customer Support*\n\n` +
      `Need help? We're here for you!\n\n` +
      `📱 Contact: *+232 72 667 635*\n` +
      `📧 Email: support@fenam.sl\n` +
      `⏰ Hours: Mon-Fri, 9AM-5PM`
    );
  }

  // --- INPUT HANDLERS ---

  async handleNameInput(fromNumber, messageBody, user) {
    const name = messageBody.trim();
    if (name.length < 2 || name.length > 50) {
      await this.sendMessage(fromNumber, `Please provide a valid name (2-50 characters).`);
      return;
    }
    
    await this.fenamDb.updateUserName(fromNumber, name);
    await this.fenamDb.updateConversationState(fromNumber, { current_step: 'awaiting_location' });
    
    await this.sendMessage(fromNumber, 
      `Thank you, ${name}! 😊\n\nNow, I need to know your location to find skilled service providers in your area. You can either:\n\n📍 Share your location using WhatsApp's location feature or\n✏️ Type your address (e.g., "Jabbiela Drive, Freetown")`
    );
  }

  async handleLocationMessage(fromNumber, location) {
    const { latitude, longitude } = location;
    
    const addressInfo = await this.helpers.reverseGeocode(latitude, longitude);
    
    if (!addressInfo) {
      await this.sendMessage(fromNumber, 
        `I received your location, but I'm having trouble finding the address. Please try typing your address instead.`
      );
      return;
    }

    await this.fenamDb.updateConversationState(fromNumber, {
      user_latitude: latitude,
      user_longitude: longitude,
      user_address: addressInfo.display_name,
      temp_location_change: null,
      current_step: 'awaiting_service_type'
    });

    const user = await this.fenamDb.getUser(fromNumber);
    const greeting = user?.name ? `Great, ${user.name}! ` : `Perfect! `;

    await this.sendMessage(fromNumber, 
      `${greeting}📍 I've got your location:\n*${addressInfo.display_name}*\n\nNow, what type of service provider are you looking for? (e.g., Hair Dresser, Mechanic, Plumber)`
    );
  }

  async handleLocationInput(fromNumber, messageBody, state) {
    // 1. Pending Address Selection
    if (state.pending_addresses && state.pending_addresses.length > 0) {
      const selection = parseInt(messageBody.trim());
      if (selection >= 1 && selection <= state.pending_addresses.length) {
        const selectedLocation = state.pending_addresses[selection - 1];
        await this.fenamDb.updateConversationState(fromNumber, {
          user_latitude: selectedLocation.latitude,
          user_longitude: selectedLocation.longitude,
          user_address: selectedLocation.display_name,
          pending_addresses: null,
          temp_location_change: null,
          current_step: 'awaiting_service_type'
        });
        await this.sendMessage(fromNumber, `📍 Location confirmed:\n*${selectedLocation.display_name}*\n\nWhat type of service provider are you looking for?`);
        return;
      } else {
        await this.sendMessage(fromNumber, `Please reply with a valid number (1-${state.pending_addresses.length}) to select your location, or type *100* to try again.`);
        return;
      }
    }
    
    // 2. Parse Coordinates or Geocode
    const coords = this.helpers.parseLocationFromMessage(messageBody);
    if (coords) {
      const addressInfo = await this.helpers.reverseGeocode(coords.latitude, coords.longitude);
      if (addressInfo) {
        await this.fenamDb.updateConversationState(fromNumber, {
          user_latitude: coords.latitude,
          user_longitude: coords.longitude,
          user_address: addressInfo.display_name,
          temp_location_change: null,
          current_step: 'awaiting_service_type'
        });
        await this.sendMessage(fromNumber, `📍 Location confirmed:\n*${addressInfo.display_name}*\n\nWhat type of service provider are you looking for?`);
        return;
      }
    }

    const locations = await this.helpers.geocodeAddress(messageBody);
    
    if (locations.length === 0) {
      await this.sendMessage(fromNumber, `I couldn't find that address in Sierra Leone. 😕\n\nPlease try being more specific or sharing your GPS location.`);
      return;
    }

    // FIXED: Removed the auto-confirmation block for length === 1.
    // Now, whether we find 1 or 10 locations, we show the list and ask for confirmation.

    await this.fenamDb.updateConversationState(fromNumber, {
      pending_addresses: locations,
      current_step: 'awaiting_location'
    });

    let message = `I found ${locations.length} location(s). Please confirm:\n\n`;
    locations.forEach((loc, index) => {
      message += `${index + 1}. ${loc.display_name}\n\n`;
    });
    
    // Updated instruction to include option 100 for re-search
    message += `Reply with the number (1-${locations.length}) to confirm, or type *100* to search again.`;
    await this.sendMessage(fromNumber, message);
  }

  async handleServiceTypeInput(fromNumber, messageBody, state) {
    const serviceType = this.helpers.matchServiceType(messageBody);
    
    if (!serviceType) {
      await this.sendMessage(fromNumber, 
        `I couldn't find that service type. 🤔\n\nTry services like:\n• Hair Dresser\n• Mechanic\n• Electrician\n• Plumber\n• Tailor\n\nPlease type the service you're looking for.`
      );
      return;
    }

    const result = this.helpers.getProvidersByService(serviceType, state.user_latitude, state.user_longitude, 3);

    if (result.providers.length === 0) {
      await this.sendMessage(fromNumber, 
        `Sorry, I couldn't find any ${serviceType} providers near your location right now. 😕\n\nTry searching for a different service.`
      );
      return;
    }

    await this.fenamDb.updateConversationState(fromNumber, {
      service_type: serviceType,
      provider_list: result.providers,
      current_step: 'awaiting_provider_selection'
    });

    const user = await this.fenamDb.getUser(fromNumber);
    const greeting = user?.name ? `${user.name}, here` : `Here`;

    let message = `${greeting} are the top ${serviceType} providers near you:\n\n`;
    
    if (result.hasMore) {
      message += this.formatProviderListWithMore(result.providers, true, result.totalCount - 3);
      message += `\n\n💬 Reply with a number (1-4) to get details.`;
    } else {
      message += this.formatProviderList(result.providers);
      message += `\n\n💬 Reply with a number (1-${result.providers.length}) to get details.`;
    }

    await this.sendMessage(fromNumber, message + this.getFooter());
  }

  async handleProviderSelection(fromNumber, messageBody, state) {
    if (!state.provider_list || state.provider_list.length === 0) {
      await this.handleNewSearchCommand(fromNumber);
      return;
    }

    const selection = parseInt(messageBody.trim());
    
    if (selection === 4 && state.provider_list.length === 3) {
      const result = this.helpers.getProvidersByService(
        state.service_type, state.user_latitude, state.user_longitude, 6, 3
      );
      
      if (result.providers.length > 0) {
        const allProviders = [...state.provider_list, ...result.providers];
        await this.fenamDb.updateConversationState(fromNumber, { provider_list: allProviders });
        
        let message = `Here are more ${state.service_type} providers:\n\n`;
        message += this.formatProviderList(result.providers, 3);
        if (result.hasMore) message += `\n\n7. *See even more*`;
        message += `\n\n💬 Reply with a number to get details.`;
        
        await this.sendMessage(fromNumber, message + this.getFooter());
        return;
      } else {
        await this.sendMessage(fromNumber, `No more providers available. Please select from the list (1-3).`);
        return;
      }
    }
    
    if (selection >= 1 && selection <= state.provider_list.length) {
      const selectedProvider = state.provider_list[selection - 1];
      const user = await this.fenamDb.getUser(fromNumber);
      const greeting = user?.name ? `Perfect, ${user.name}! ` : `Great choice! `;
      const stars = '⭐'.repeat(selectedProvider.reviews);
      const verifiedIcon = selectedProvider.verified ? ' ✅' : '';
      
      let message = `${greeting}Here are the contact details:\n\n`;
      message += `👤 *${selectedProvider.name}${verifiedIcon}*\n`;
      message += `📞 *${selectedProvider.phoneNumber}*\n`;
      message += `${stars} (${selectedProvider.reviews} stars)\n`;
      message += `📍 ${selectedProvider.distance} km away\n`;
      message += `💰 Starting fee: ${this.helpers.formatCurrency(selectedProvider.startingFee)}\n\n`;
      message += `⚠️ Mention *FƐNAM* when you call!`;

      await this.sendMessage(fromNumber, message);
      
      let optionsMessage = `\n\n---\n\nWould you like to:\n`;
      const otherProviders = state.provider_list.filter((_, idx) => idx !== (selection - 1));
      otherProviders.forEach((p, idx) => {
        optionsMessage += `${idx + 1}. Contact ${p.name}\n`;
      });
      optionsMessage += `${otherProviders.length + 1}. Start new search (*99*)`;
      
      await this.sendMessage(fromNumber, optionsMessage);
      
      await this.fenamDb.updateConversationState(fromNumber, {
        provider_list: otherProviders,
        providers_shown: (state.providers_shown || 0) + 1
      });
      
    } else if (selection === (state.provider_list.length + 1)) {
      await this.handleNewSearchCommand(fromNumber);
    } else {
      await this.sendMessage(fromNumber, `Please reply with a valid number.`);
    }
  }

  // --- UTILITIES ---

  formatProviderList(providers, startIndex = 0) {
    return providers.map((provider, index) => {
      const stars = '⭐'.repeat(provider.reviews);
      const verifiedIcon = provider.verified ? ' ✅' : '';
      return `${startIndex + index + 1}. *${provider.name}${verifiedIcon}*\n   ${stars} (${provider.reviews}) • ${provider.distance}km\n   Fee: ${this.helpers.formatCurrency(provider.startingFee)}`;
    }).join('\n\n');
  }

  formatProviderListWithMore(providers, hasMore, remainingCount) {
    let formatted = this.formatProviderList(providers);
    if (hasMore) {
      formatted += `\n\n4. *See more providers* (${remainingCount} more)`;
    }
    return formatted;
  }

  getFooter() {
    return `\n\n────────────────\n*99*: New Search\n*100*: Update Location\n*111*: Customer Support`;
  }

  async sendMessage(toNumber, text) {
    await this.whatsAppService.sendTextMessage(toNumber, text, 'outgoing_bot');
  }
}

module.exports = FenamHandler;