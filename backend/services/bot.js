const db = require('../db');
const whatsappService = require('./whatsappService');
const FixamHandler = require('./whatsappHandler');

// One handler for the whole backend process.
//
// The webhook route, the admin notification routes and the data-erasure
// endpoints each used to build their own `new FixamHandler(...)`, and every
// handler builds its own `FixamDatabase` inside its constructor. That left
// several database wrappers and helper stacks running against the same pool at
// once -- harmless in behaviour, wasteful and easy to get out of step. The
// handler is stateless across requests (conversation state lives in Postgres),
// so a single instance is all any of them need.
const fixamHandler = new FixamHandler(whatsappService, db, null, console.log);

module.exports = fixamHandler;
