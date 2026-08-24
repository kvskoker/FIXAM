/**
 * Deciding how an official may be messaged, and shaping the message to fit.
 *
 * WhatsApp only lets a business send freely for 24 hours after the person last
 * wrote in. Outside that window the first message must be a pre-approved
 * template, and a plain send is rejected by Meta with 131047 -- which the send
 * path logs and moves past, so the officer is simply never told. That failure
 * is invisible from inside the platform: the report is filed, the dashboard
 * shows it routed, and nobody is looking at it.
 *
 * Officials are the group this hurts. A citizen is mid-conversation when the
 * bot replies to them; an MDA officer may not have written in for weeks.
 */
require('../loadEnv');

// The approved template. Created in the Meta dashboard, not here -- this only
// has to agree with what is there.
//
//   Hello {{customer_name}},
//
//   {{message_details}}
//
//   Regards,
//   Fixam SL Team.
//
// Category must be Utility. A Marketing template is subject to per-user
// marketing opt-outs, so an officer who has ever opted out of marketing would
// simply never receive dispatch alerts -- and nothing in the platform would
// show that they had not.
const TEMPLATE_NAME = process.env.WHATSAPP_BROADCAST_TEMPLATE || 'fixam_broadcast_message';

// The template uses named parameters, so the send has to name them. Meta
// matches on these strings, not on order: getting one wrong fails the send
// rather than filling the wrong slot.
const PARAM_GREETING = process.env.WHATSAPP_TEMPLATE_PARAM_GREETING || 'customer_name';
const PARAM_BODY = process.env.WHATSAPP_TEMPLATE_PARAM_BODY || 'message_details';

// Must match the template's language exactly. Meta treats "en" and "en_US" as
// different templates, and the mismatch surfaces only as 132001 at send time.
const TEMPLATE_LANGUAGE = process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en';

// Meta's per-parameter ceiling is 1024 characters. Alerts are far shorter than
// that; the cap exists so a pathological title cannot fail the whole send.
const MAX_PARAM_LENGTH = 900;

/**
 * Is this person still inside the 24-hour service window?
 *
 * Takes the timestamp rather than the user id so the caller can answer it for a
 * whole team from the one query that fetched them -- alerting a group otherwise
 * means a round trip per member, in a loop, while a citizen waits.
 */
function withinServiceWindow(lastInboundAt) {
    if (!lastInboundAt) return false;
    const last = lastInboundAt instanceof Date ? lastInboundAt : new Date(lastInboundAt);
    if (Number.isNaN(last.getTime())) return false;
    return Date.now() - last.getTime() < 24 * 60 * 60 * 1000;
}

/**
 * Flatten a multi-line alert into something a template parameter will accept.
 *
 * Meta rejects newlines, tabs and runs of more than four spaces inside a
 * parameter. The alerts are deliberately line-per-field, so they all fail this
 * as written -- and the rejection is for the whole message, not the offending
 * character.
 *
 * Lines are joined with a bullet rather than a space so the fields stay
 * separable by eye: "Urgency: HIGH • Category: Water" reads as two facts,
 * "Urgency: HIGH Category: Water" reads as one confusing one.
 */
function flattenForTemplate(text) {
    const flattened = String(text || '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(line => line.replace(/\t/g, ' ').replace(/ {2,}/g, ' ').trim())
        .filter(Boolean)
        .join(' • ');

    return flattened.length > MAX_PARAM_LENGTH
        ? flattened.slice(0, MAX_PARAM_LENGTH - 1) + '…'
        : flattened;
}

/**
 * The name to greet somebody by in {{1}}.
 *
 * First name only. "Hello Mohamed," is a message from a colleague; "Hello
 * Mohamed Sesay," is a message from a system, and the template is doing enough
 * of that already. Falls back to a form of address rather than an empty
 * parameter, which Meta rejects outright.
 */
function greetingNameFor(member) {
    const name = String((member && (member.first_name || member.name)) || '').trim();
    if (!name) return 'Colleague';
    return name.split(/\s+/)[0];
}

/**
 * The parameter list for one official's alert.
 *
 * Kept here rather than at the call site so the template's shape is described
 * in exactly one place. If the template is ever rewritten -- renamed
 * parameters, a third field -- this is the only function that has to change.
 */
function buildParams(member, body) {
    return [
        { name: PARAM_GREETING, text: greetingNameFor(member) },
        { name: PARAM_BODY, text: flattenForTemplate(body) },
    ];
}

module.exports = {
    TEMPLATE_NAME,
    TEMPLATE_LANGUAGE,
    PARAM_GREETING,
    PARAM_BODY,
    withinServiceWindow,
    flattenForTemplate,
    greetingNameFor,
    buildParams,
};
