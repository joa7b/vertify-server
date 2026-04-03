'use strict';

var mongoose = require('mongoose');
var Schema = mongoose.Schema;

var EvoWebhookEventSchema = new Schema({
    instanceName: {
        type: String,
        index: true
    },
    event: {
        type: String
    },
    messageId: {
        type: String,
        index: true,
        sparse: true
    },
    rawPayload: {
        type: Object,
        required: true
    },
    processed: {
        type: Boolean,
        default: false
    },
    processedAt: {
        type: Date
    },
    error: {
        type: String
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 604800 // TTL: 7 days
    }
});

module.exports = mongoose.model('evo_webhook_event', EvoWebhookEventSchema);
