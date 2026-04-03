/**
 * Lightweight webhook payload validator for Evolution API events.
 *
 * Validates that required fields exist before the processing pipeline trusts them.
 * No external dependencies — pure functions only.
 */

'use strict';

/**
 * Validate an Evolution API webhook payload.
 *
 * @param {Object} body - The raw request body from the webhook
 * @returns {{ valid: boolean, event: string|null, instanceName: string|null, data: Object|null, reason: string|null }}
 */
function validate(body) {
    if (!body || typeof body !== 'object') {
        return { valid: false, event: null, instanceName: null, data: null, reason: 'Payload is not an object' };
    }

    var event = body.event;
    if (!event || typeof event !== 'string') {
        return { valid: false, event: null, instanceName: null, data: null, reason: 'Missing or invalid "event" field' };
    }

    var instanceName = body.instance;
    if (!instanceName || typeof instanceName !== 'string') {
        return { valid: false, event: event, instanceName: null, data: null, reason: 'Missing or invalid "instance" field' };
    }

    // Event-specific validation
    if (event === 'messages.upsert') {
        return validateMessagesUpsert(body, event, instanceName);
    }

    if (event === 'messages.update') {
        return validateMessagesUpdate(body, event, instanceName);
    }

    // Other events (connection.update, etc.) — valid but no deep checks
    return { valid: true, event: event, instanceName: instanceName, data: body.data || null, reason: null };
}

function validateMessagesUpsert(body, event, instanceName) {
    var data = body.data;
    if (!data || typeof data !== 'object') {
        return { valid: false, event: event, instanceName: instanceName, data: null, reason: 'messages.upsert: missing "data" field' };
    }

    if (!data.key || typeof data.key !== 'object') {
        return { valid: false, event: event, instanceName: instanceName, data: data, reason: 'messages.upsert: missing "data.key" field' };
    }

    if (!data.key.remoteJid || typeof data.key.remoteJid !== 'string') {
        return { valid: false, event: event, instanceName: instanceName, data: data, reason: 'messages.upsert: missing or invalid "data.key.remoteJid"' };
    }

    return { valid: true, event: event, instanceName: instanceName, data: data, reason: null };
}

function validateMessagesUpdate(body, event, instanceName) {
    var data = body.data;
    if (!data || typeof data !== 'object') {
        return { valid: false, event: event, instanceName: instanceName, data: null, reason: 'messages.update: missing "data" field' };
    }

    return { valid: true, event: event, instanceName: instanceName, data: data, reason: null };
}

module.exports = {
    validate: validate
};
