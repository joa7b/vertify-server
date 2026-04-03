/**
 * Shared cache (Redis via TdCache) for the Evolution API module.
 *
 * Initialized in listener.listen(config) with config.tdCache.
 * Used for webhook idempotency and other caching needs.
 */

'use strict';

var winston = require('../../config/winston');

var _tdCache = null;

/**
 * Initialize with the TdCache instance from the app config.
 * @param {TdCache} tdCache
 */
function init(tdCache) {
    _tdCache = tdCache;
    if (_tdCache) {
        winston.info('[EvoCache] Redis cache initialized for Evolution API module');
    } else {
        winston.warn('[EvoCache] No TdCache instance provided — idempotency checks will be skipped');
    }
}

/**
 * Check if a webhook event has already been processed. If not, mark it as processed.
 * Returns true if this is a NEW event (should be processed), false if duplicate.
 *
 * @param {string} messageId - Unique event ID (e.g., data.key.id from Evolution API)
 * @returns {Promise<boolean>} true = new event, false = duplicate
 */
async function checkAndSetProcessed(messageId) {
    if (!_tdCache || !messageId) {
        return true; // No cache available or no ID — process anyway
    }
    try {
        var wasSet = await _tdCache.setNX('evo:dedup:' + messageId, '1', 3600);
        return wasSet; // true = key was set (new), false = key already existed (duplicate)
    } catch (err) {
        winston.warn('[EvoCache] Redis error during idempotency check — processing anyway: ' + err.message);
        return true; // On Redis failure, process the event rather than drop it
    }
}

/**
 * @returns {TdCache|null}
 */
function getCache() {
    return _tdCache;
}

module.exports = {
    init: init,
    checkAndSetProcessed: checkAndSetProcessed,
    getCache: getCache
};
