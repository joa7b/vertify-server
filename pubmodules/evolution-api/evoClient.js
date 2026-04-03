/**
 * Centralized HTTP client for Evolution API with timeout, retry and circuit breaker.
 *
 * Every HTTP call to the Evolution API container goes through this module.
 * Nothing else in the codebase should import `request-promise` to talk to Evolution.
 */

'use strict';

var rp = require('request-promise');
var winston = require('../../config/winston');

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

function evoBaseUrl() {
    var url = process.env.EVOLUTION_API_URL;
    return url ? url.replace(/\/$/, '') : null;
}

function evoApiKey() {
    return process.env.EVOLUTION_API_KEY;
}

// ---------------------------------------------------------------------------
// Circuit breaker (in-memory, single-process)
// ---------------------------------------------------------------------------

var CIRCUIT_FAILURE_THRESHOLD = 5;
var CIRCUIT_OPEN_DURATION_MS = 15000; // 15 seconds

var circuitState = {
    failures: 0,
    openUntil: 0 // timestamp when circuit should close again
};

function isCircuitOpen() {
    if (circuitState.openUntil > Date.now()) {
        return true;
    }
    // If the open period has passed, we are half-open — allow the next attempt
    if (circuitState.openUntil > 0 && Date.now() >= circuitState.openUntil) {
        circuitState.openUntil = 0; // half-open: let one request through
    }
    return false;
}

function recordSuccess() {
    circuitState.failures = 0;
    circuitState.openUntil = 0;
}

function recordFailure() {
    circuitState.failures++;
    if (circuitState.failures >= CIRCUIT_FAILURE_THRESHOLD) {
        circuitState.openUntil = Date.now() + CIRCUIT_OPEN_DURATION_MS;
        winston.error('[EvoClient] Circuit breaker OPEN — ' + circuitState.failures +
            ' consecutive failures. Blocking requests for ' + (CIRCUIT_OPEN_DURATION_MS / 1000) + 's');
    }
}

// ---------------------------------------------------------------------------
// Retry with exponential backoff
// ---------------------------------------------------------------------------

var MAX_RETRIES = 3;
var BASE_DELAY_MS = 1000; // 1s, 2s, 4s

function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function isRetryable(err) {
    // Network errors (ECONNREFUSED, ECONNRESET, ETIMEDOUT, ESOCKETTIMEDOUT)
    if (err.cause && (err.cause.code === 'ECONNREFUSED' ||
        err.cause.code === 'ECONNRESET' ||
        err.cause.code === 'ETIMEDOUT' ||
        err.cause.code === 'ESOCKETTIMEDOUT')) {
        return true;
    }
    // 5xx server errors
    if (err.statusCode && err.statusCode >= 500) {
        return true;
    }
    // request-promise ETIMEDOUT at top level
    if (err.error && err.error.code === 'ETIMEDOUT') {
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Core request function
// ---------------------------------------------------------------------------

var REQUEST_TIMEOUT_MS = 10000; // 10 seconds

/**
 * Make an HTTP request to the Evolution API with timeout, retry and circuit breaker.
 *
 * @param {string} method - HTTP method (GET, POST, PUT, DELETE)
 * @param {string} path   - URL path (e.g. '/instance/create')
 * @param {Object} [body] - Request body (for POST/PUT)
 * @returns {Promise<Object>} Parsed JSON response
 */
function evoRequest(method, path, body) {
    var base = evoBaseUrl();
    var key = evoApiKey();
    if (!base || !key) {
        return Promise.reject(new Error('EVOLUTION_API_URL or EVOLUTION_API_KEY not configured'));
    }

    if (isCircuitOpen()) {
        return Promise.reject(new Error('Circuit breaker is OPEN — Evolution API temporarily unavailable'));
    }

    var opts = {
        method: method,
        uri: base + path,
        headers: { apikey: key, 'Content-Type': 'application/json' },
        json: true,
        timeout: REQUEST_TIMEOUT_MS
    };
    if (body) opts.body = body;

    return executeWithRetry(opts, 0);
}

function executeWithRetry(opts, attempt) {
    return rp(opts).then(function (result) {
        recordSuccess();
        return result;
    }).catch(function (err) {
        if (attempt < MAX_RETRIES && isRetryable(err)) {
            var delay = BASE_DELAY_MS * Math.pow(2, attempt); // 1s, 2s, 4s
            winston.warn('[EvoClient] Request failed (attempt ' + (attempt + 1) + '/' + (MAX_RETRIES + 1) +
                '): ' + (err.message || err) + ' — retrying in ' + delay + 'ms');
            return sleep(delay).then(function () {
                return executeWithRetry(opts, attempt + 1);
            });
        }
        // Final failure
        recordFailure();
        throw err;
    });
}

// ---------------------------------------------------------------------------
// High-level: send message to WhatsApp via Evolution API
// ---------------------------------------------------------------------------

/**
 * Send a message (text or media) through Evolution API.
 *
 * @param {string} instance - Evolution instance name
 * @param {string} to       - Recipient phone/remoteJid
 * @param {string} text     - Message text (or caption for media)
 * @param {string} [type]   - 'text', 'image', 'file'
 * @param {Object} [metadata] - Media metadata { src, type (mimetype), name, duration }
 * @returns {Promise<Object>} Evolution API response
 */
function sendMessage(instance, to, text, type, metadata) {
    var endpoint;
    var body;

    if (type === 'image' && metadata && metadata.src) {
        endpoint = '/message/sendMedia/' + encodeURIComponent(instance);
        body = {
            number: to,
            mediatype: 'image',
            mimetype: metadata.type || 'image/jpeg',
            caption: text || '',
            media: metadata.src,
            fileName: metadata.name || 'image'
        };
    } else if (type === 'file' && metadata && metadata.src) {
        var mediatype = 'document';
        if (metadata.type && metadata.type.startsWith('audio/')) {
            mediatype = 'audio';
        } else if (metadata.type && metadata.type.startsWith('video/')) {
            mediatype = 'video';
        }
        endpoint = '/message/sendMedia/' + encodeURIComponent(instance);
        body = {
            number: to,
            mediatype: mediatype,
            mimetype: metadata.type || 'application/octet-stream',
            caption: text || '',
            media: metadata.src,
            fileName: metadata.name || 'file'
        };
    } else {
        endpoint = '/message/sendText/' + encodeURIComponent(instance);
        body = {
            number: to,
            text: text
        };
    }

    return evoRequest('POST', endpoint, body);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    evoBaseUrl: evoBaseUrl,
    evoApiKey: evoApiKey,
    evoRequest: evoRequest,
    sendMessage: sendMessage,
    isCircuitOpen: isCircuitOpen,
    // Exposed for testing
    _circuitState: circuitState,
    _recordSuccess: recordSuccess,
    _recordFailure: recordFailure
};
