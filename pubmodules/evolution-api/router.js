const express = require('express');
const router = express.Router();
var winston = require('../../config/winston');
var configGlobal = require('../../config/global');
var leadService = require('../../services/leadService');
var requestService = require('../../services/requestService');
var messageService = require('../../services/messageService');
var MessageConstants = require('../../models/messageConstants');
var Integration = require('../../models/integrations');
var evoClient = require('./evoClient');
var evoCache = require('./evoCache');
var EvoWebhookEvent = require('./models/evoWebhookEvent');
var webhookValidator = require('./webhookValidator');

const apiUrl = process.env.API_URL || configGlobal.apiUrl;

var Message = require('../../models/message');

// Aliases for backward compatibility within this file
var evoBaseUrl = evoClient.evoBaseUrl;
var evoApiKey = evoClient.evoApiKey;
var evoRequest = evoClient.evoRequest;

// ---------------------------------------------------------------
// Map Evolution API status codes to Tiledesk message status
// Evolution: 1=PENDING, 2=SERVER_ACK(SENT), 3=DELIVERY_ACK(DELIVERED), 4=READ, 5=PLAYED
// ---------------------------------------------------------------
var EVO_STATUS_MAP = {
    2: MessageConstants.CHAT_MESSAGE_STATUS.SENT,
    3: MessageConstants.CHAT_MESSAGE_STATUS.DELIVERED,
    4: MessageConstants.CHAT_MESSAGE_STATUS.SEEN,
    5: MessageConstants.CHAT_MESSAGE_STATUS.SEEN // PLAYED (audio) → treat as seen
};

/**
 * Process a messages.update event — delivery/read status from Evolution API.
 * Finds the corresponding Tiledesk message and updates its status.
 */
async function processMessageStatusUpdate(data) {
    // data can be a single update or array depending on Evolution API version
    var updates = Array.isArray(data) ? data : [data];

    for (var i = 0; i < updates.length; i++) {
        var update = updates[i];
        var key = update.key || (update.keyId ? { id: update.keyId } : null);
        var status = update.status || (update.update && update.update.status);

        if (!key || !key.id || !status) {
            winston.debug('[EvoAPI] Skipping messages.update — missing key.id or status');
            continue;
        }

        var tiledeskStatus = EVO_STATUS_MAP[status];
        if (!tiledeskStatus) {
            winston.debug('[EvoAPI] Ignoring messages.update with unmapped status: ' + status);
            continue;
        }

        try {
            // Find the Tiledesk message by the stored Evolution message ID
            var msg = await Message.findOne({ 'attributes.evoMessageId': key.id });
            if (msg) {
                // Only update if the new status is higher (more advanced)
                if (tiledeskStatus > (msg.status || 0)) {
                    await messageService.changeStatus(msg._id, tiledeskStatus);
                    winston.info('[EvoAPI] Message status updated: ' + key.id + ' -> ' + tiledeskStatus);
                }
            } else {
                winston.debug('[EvoAPI] No Tiledesk message found for evoMessageId: ' + key.id);
            }
        } catch (err) {
            winston.error('[EvoAPI] Error processing message status update: ' + err.message);
        }
    }
}

// ---------------------------------------------------------------
// WEBHOOK - receives events from Evolution API
// POST /modules/evolution-api/webhook
//
// Creates a Tiledesk request+message so the bot pipeline kicks in.
// ---------------------------------------------------------------
router.post('/webhook', async (req, res) => {
    const body = req.body;
    const realIp = req.headers['x-forwarded-for']
        ? req.headers['x-forwarded-for'].split(',')[0].trim()
        : req.headers['x-real-ip'] || req.ip;

    winston.info('[EvoAPI] Webhook received — event: ' + (body.event || 'unknown') +
        ' instance: ' + (body.instance || 'N/A') +
        ' from: ' + realIp);
    winston.debug('[EvoAPI] Webhook headers: ' + JSON.stringify({
        'content-type': req.headers['content-type'],
        'user-agent': req.headers['user-agent'],
        'x-forwarded-for': req.headers['x-forwarded-for'],
        'x-forwarded-proto': req.headers['x-forwarded-proto'],
        'x-ngrok-region': req.headers['x-ngrok-region'],
        host: req.headers['host']
    }));
    winston.debug('[EvoAPI] Webhook payload: ' + JSON.stringify(body).substring(0, 2000));

    // Acknowledge immediately
    res.status(200).json({ status: 'ok' });

    // Persist raw payload before any parsing
    var rawEventId = null;
    try {
        var rawEvent = await EvoWebhookEvent.create({
            instanceName: body.instance || 'unknown',
            event: body.event || 'unknown',
            messageId: (body.data && body.data.key && body.data.key.id) || undefined,
            rawPayload: body
        });
        rawEventId = rawEvent._id;
    } catch (rawErr) {
        // Don't block processing if raw persistence fails (e.g., duplicate messageId on unique index)
        winston.warn('[EvoAPI] Failed to persist raw webhook event: ' + rawErr.message);
    }

    try {
        // Validate payload schema
        var validation = webhookValidator.validate(body);
        if (!validation.valid) {
            winston.warn('[EvoAPI] Invalid webhook payload: ' + validation.reason);
            if (rawEventId) {
                EvoWebhookEvent.updateOne({ _id: rawEventId }, { error: 'Validation failed: ' + validation.reason, processedAt: new Date() }).catch(function() {});
            }
            return;
        }

        // Handle message status updates (delivered, read)
        if (validation.event === 'messages.update') {
            await processMessageStatusUpdate(validation.data);
            if (rawEventId) {
                EvoWebhookEvent.updateOne({ _id: rawEventId }, { processed: true, processedAt: new Date() }).catch(function() {});
            }
            return;
        }

        if (validation.event !== 'messages.upsert') {
            winston.debug('[EvoAPI] Ignoring non-message event: ' + validation.event);
            if (rawEventId) {
                EvoWebhookEvent.updateOne({ _id: rawEventId }, { processed: true, processedAt: new Date() }).catch(function() {});
            }
            return;
        }

        const data = validation.data;
        if (data.key && data.key.fromMe) return; // ignore outgoing

        // Idempotency check — skip if this event was already processed
        if (data.key && data.key.id) {
            var isNew = await evoCache.checkAndSetProcessed(data.key.id);
            if (!isNew) {
                winston.info('[EvoAPI] Duplicate webhook event ignored (messageId: ' + data.key.id + ')');
                return;
            }
        }

        const instanceName = body.instance;
        const remoteJid = (data.key && data.key.remoteJid) || '';
        const phoneNumber = remoteJid.split('@')[0];
        if (!phoneNumber) return;

        // Extract message content based on type
        const msg = data.message || {};
        let messageText = '';
        let messageType = 'text';
        let messageMetadata = undefined;

        if (msg.conversation) {
            messageText = msg.conversation;
        } else if (msg.extendedTextMessage && msg.extendedTextMessage.text) {
            messageText = msg.extendedTextMessage.text;
        } else if (msg.imageMessage) {
            messageText = msg.imageMessage.caption || '📷 Imagem';
            messageType = 'image';
            messageMetadata = {
                type: msg.imageMessage.mimetype || 'image/jpeg',
                src: msg.imageMessage.url || '',
                width: msg.imageMessage.width,
                height: msg.imageMessage.height
            };
        } else if (msg.audioMessage) {
            messageText = '🎵 Áudio';
            messageType = 'file';
            messageMetadata = {
                type: msg.audioMessage.mimetype || 'audio/ogg',
                src: msg.audioMessage.url || '',
                duration: msg.audioMessage.seconds
            };
        } else if (msg.videoMessage) {
            messageText = msg.videoMessage.caption || '🎥 Vídeo';
            messageType = 'file';
            messageMetadata = {
                type: msg.videoMessage.mimetype || 'video/mp4',
                src: msg.videoMessage.url || '',
                duration: msg.videoMessage.seconds
            };
        } else if (msg.documentMessage) {
            messageText = msg.documentMessage.fileName || '📄 Documento';
            messageType = 'file';
            messageMetadata = {
                type: msg.documentMessage.mimetype || 'application/octet-stream',
                src: msg.documentMessage.url || '',
                name: msg.documentMessage.fileName
            };
        } else if (msg.locationMessage) {
            messageText = '📍 Localização: ' + (msg.locationMessage.degreesLatitude || '') + ',' + (msg.locationMessage.degreesLongitude || '');
            messageType = 'text';
            messageMetadata = {
                type: 'location',
                latitude: msg.locationMessage.degreesLatitude,
                longitude: msg.locationMessage.degreesLongitude,
                name: msg.locationMessage.name,
                address: msg.locationMessage.address
            };
        } else if (msg.contactMessage) {
            messageText = '👤 Contato: ' + (msg.contactMessage.displayName || '');
            messageType = 'text';
            messageMetadata = {
                type: 'contact',
                displayName: msg.contactMessage.displayName,
                vcard: msg.contactMessage.vcard
            };
        } else if (msg.buttonsResponseMessage) {
            messageText = msg.buttonsResponseMessage.selectedDisplayText || msg.buttonsResponseMessage.selectedButtonId || '';
        } else if (msg.listResponseMessage) {
            messageText = msg.listResponseMessage.title || msg.listResponseMessage.singleSelectReply?.selectedRowId || '';
        } else if (msg.reactionMessage) {
            winston.debug('[EvoAPI] Ignoring reaction message');
            return;
        } else {
            winston.warn('[EvoAPI] Unsupported message type from ' + phoneNumber + ': ' + JSON.stringify(Object.keys(msg)));
            return;
        }

        if (!messageText) {
            winston.warn('[EvoAPI] Empty message content from ' + phoneNumber);
            return;
        }

        const senderName = data.pushName || phoneNumber;

        winston.info('[EvoAPI] Incoming from ' + phoneNumber + ' (' + senderName + ') via ' + instanceName + ': ' + messageText);

        // ---- STEP 1: Find which project has this instance configured ----
        winston.info('[EvoAPI][STEP 1] Looking up integration for instanceName: "' + instanceName + '"');
        var integration;
        try {
            integration = await Integration.findOne({
                name: 'evolution_api',
                'value.instanceName': instanceName
            });
        } catch (dbErr) {
            winston.error('[EvoAPI][STEP 1] DB error querying integrations: ' + dbErr.message);
            return;
        }

        if (!integration) {
            winston.error('[EvoAPI][STEP 1] FAILED — No integration record found for instance "' + instanceName + '". ' +
                'The user must save the integration in the dashboard (click "Salvar" after connecting). ' +
                'Dropping message from ' + phoneNumber);
            return;
        }

        const id_project = integration.id_project.toString();
        winston.info('[EvoAPI][STEP 1] OK — Found integration for project: ' + id_project);

        // ---- STEP 2: Create or find the lead (the external WhatsApp user) ----
        winston.info('[EvoAPI][STEP 2] Creating/finding lead for phone: ' + phoneNumber);
        const lead_id = 'evolution-' + phoneNumber;
        var lead;
        try {
            lead = await leadService.createIfNotExistsWithLeadId(
                lead_id, senderName, null, id_project, null, {
                    channel: 'evolution',
                    phone: phoneNumber,
                    instance: instanceName
                }
            );
        } catch (leadErr) {
            winston.error('[EvoAPI][STEP 2] FAILED — Error creating/finding lead: ' + leadErr.message);
            return;
        }

        if (!lead) {
            winston.error('[EvoAPI][STEP 2] FAILED — leadService returned null for lead_id: ' + lead_id);
            return;
        }
        winston.info('[EvoAPI][STEP 2] OK — Lead: ' + lead._id + ' (lead_id: ' + lead_id + ')');

        // ---- STEP 3: Build a stable request_id ----
        const request_id = 'support-group-' + id_project + '-evolution-' + phoneNumber;

        // ---- STEP 4: Find or create request (chat) ----
        var Request = require('../../models/request');
        var existingRequest;
        try {
            existingRequest = await Request.findOne({ request_id: request_id, id_project: id_project, status: { $lt: 1000 } });
        } catch (findErr) {
            winston.error('[EvoAPI][STEP 4] DB error finding request: ' + findErr.message);
        }

        if (existingRequest) {
            // Request exists and is not closed — add message to it
            winston.info('[EvoAPI][STEP 4] Found existing request: ' + request_id + ' (status: ' + existingRequest.status + ')');

            // Update request attributes so the instance name stays current
            // (the user may have reconnected with a different instance)
            var oldInstance = existingRequest.attributes && existingRequest.attributes.instance;
            if (oldInstance !== instanceName) {
                winston.info('[EvoAPI][STEP 4] Updating request instance: ' + oldInstance + ' -> ' + instanceName);
                try {
                    await Request.updateOne(
                        { _id: existingRequest._id },
                        { $set: { 'attributes.instance': instanceName, 'attributes.phone': phoneNumber, 'attributes.remoteJid': remoteJid } }
                    );
                } catch (updateErr) {
                    winston.error('[EvoAPI][STEP 4] Error updating request attributes: ' + updateErr.message);
                }
            }

            try {
                await messageService.create(
                    lead_id,          // sender
                    senderName,       // senderFullname
                    request_id,       // recipient (request_id)
                    messageText,      // text
                    id_project,       // id_project
                    lead_id,          // createdBy
                    MessageConstants.CHAT_MESSAGE_STATUS.RECEIVED,
                    { channel: 'evolution', phone: phoneNumber, instance: instanceName, remoteJid: remoteJid, evoMessageId: (data.key && data.key.id) || undefined }, // attributes
                    messageType,      // type
                    messageMetadata,  // metadata
                    undefined,        // language
                    undefined,        // channel_type
                    { name: 'evolution' } // channel
                );
                winston.info('[EvoAPI][STEP 5] OK — Message added to existing request: ' + request_id);
            } catch (msgErr) {
                winston.error('[EvoAPI][STEP 5] FAILED — Error creating message: ' + msgErr.message);
            }
        } else {
            // Create new request
            winston.info('[EvoAPI][STEP 4] No open request found. Creating new request: ' + request_id);
            try {
                const new_request = {
                    request_id: request_id,
                    lead_id: lead._id,
                    id_project: id_project,
                    first_text: messageText,
                    departmentid: 'default',
                    channel: { name: 'evolution' },
                    sourcePage: 'evolution-api/' + instanceName,
                    language: undefined,
                    userAgent: 'evolution-api',
                    status: null,
                    createdBy: 'system',
                    attributes: {
                        channel: 'evolution',
                        phone: phoneNumber,
                        instance: instanceName,
                        remoteJid: remoteJid
                    },
                    lead: lead
                };

                const savedRequest = await requestService.create(new_request);
                winston.info('[EvoAPI][STEP 4] OK — Request created: ' + savedRequest.request_id +
                    ' (status: ' + savedRequest.status + ', department: ' + savedRequest.department + ')');
            } catch (createErr) {
                if (createErr.code === 11000 || (createErr.message && createErr.message.indexOf('duplicate') > -1)) {
                    winston.warn('[EvoAPI][STEP 4] Request already exists (race condition handled): ' + request_id);
                } else {
                    winston.error('[EvoAPI][STEP 4] FAILED — Error creating request: ' + createErr.message, createErr);
                    return;
                }
            }

            // Create the first message
            try {
                await messageService.create(
                    lead_id,
                    senderName,
                    request_id,
                    messageText,
                    id_project,
                    lead_id,
                    MessageConstants.CHAT_MESSAGE_STATUS.RECEIVED,
                    { channel: 'evolution', phone: phoneNumber, instance: instanceName, remoteJid: remoteJid, evoMessageId: (data.key && data.key.id) || undefined },
                    messageType,
                    messageMetadata,
                    undefined,
                    undefined,
                    { name: 'evolution' }
                );
                winston.info('[EvoAPI][STEP 5] OK — First message created on new request: ' + request_id);
            } catch (msgErr) {
                winston.error('[EvoAPI][STEP 5] FAILED — Error creating first message: ' + msgErr.message);
            }
        }

        // Mark raw event as successfully processed
        if (rawEventId) {
            EvoWebhookEvent.updateOne({ _id: rawEventId }, { processed: true, processedAt: new Date() }).catch(function() {});
        }
    } catch (err) {
        winston.error('[EvoAPI] Webhook processing error: ' + err.message, err);
        // Mark raw event with error
        if (rawEventId) {
            EvoWebhookEvent.updateOne({ _id: rawEventId }, { error: err.message, processedAt: new Date() }).catch(function() {});
        }
    }
});

// ---------------------------------------------------------------
// CREATE INSTANCE
// POST /modules/evolution-api/instances
// Body: { instanceName, number }
// ---------------------------------------------------------------
router.post('/instances', async (req, res) => {
    const { instanceName, number } = req.body;
    if (!instanceName) {
        return res.status(400).json({ error: 'instanceName is required' });
    }

    // EVOLUTION_WEBHOOK_URL allows overriding the webhook URL for Docker networking
    // (e.g., http://server:3000/modules/evolution-api/webhook instead of http://localhost:3000/...)
    const webhookUrl = process.env.EVOLUTION_WEBHOOK_URL
        || (apiUrl || '').replace(/\/$/, '') + '/modules/evolution-api/webhook';

    winston.info('[EvoAPI] Creating instance "' + instanceName + '" with webhook URL: ' + webhookUrl);

    try {
        const result = await evoRequest('POST', '/instance/create', {
            instanceName: instanceName,
            number: number || undefined,
            qrcode: true,
            integration: 'WHATSAPP-BAILEYS',
            webhook: {
                url: webhookUrl,
                byEvents: false,
                base64: false,
                events: [
                    'MESSAGES_UPSERT',
                    'CONNECTION_UPDATE',
                    'MESSAGES_UPDATE'
                ]
            },
            rejectCall: false,
            groupsIgnore: true,
            alwaysOnline: true,
            readMessages: true,
            readStatus: true
        });

        winston.info('[EvoAPI] Instance created: ' + instanceName);

        // Explicitly set webhook after creation to ensure it's configured
        try {
            await evoRequest('POST', '/webhook/set/' + encodeURIComponent(instanceName), {
                webhook: {
                    enabled: true,
                    url: webhookUrl,
                    webhookByEvents: false,
                    webhookBase64: false,
                    events: [
                        'MESSAGES_UPSERT',
                        'CONNECTION_UPDATE',
                        'MESSAGES_UPDATE'
                    ]
                }
            });
            winston.info('[EvoAPI] Webhook configured for instance: ' + instanceName + ' -> ' + webhookUrl);
        } catch (whErr) {
            winston.error('[EvoAPI] Warning: instance created but webhook setup failed: ' + (whErr.message || whErr));
        }

        res.status(201).json(result);
    } catch (err) {
        const msg = (err.error && err.error.message) || err.message;
        winston.error('[EvoAPI] Create instance error: ' + msg);
        res.status(err.statusCode || 500).json({ error: msg });
    }
});

// ---------------------------------------------------------------
// GET QR CODE (refresh)
// GET /modules/evolution-api/instances/:name/qrcode
// ---------------------------------------------------------------
router.get('/instances/:name/qrcode', async (req, res) => {
    try {
        const result = await evoRequest('GET', '/instance/connect/' + encodeURIComponent(req.params.name));
        res.json(result);
    } catch (err) {
        const msg = (err.error && err.error.message) || err.message;
        res.status(err.statusCode || 500).json({ error: msg });
    }
});

// ---------------------------------------------------------------
// CONNECTION STATUS
// GET /modules/evolution-api/instances/:name/status
// ---------------------------------------------------------------
router.get('/instances/:name/status', async (req, res) => {
    try {
        const result = await evoRequest('GET', '/instance/connectionState/' + encodeURIComponent(req.params.name));
        res.json(result);
    } catch (err) {
        const msg = (err.error && err.error.message) || err.message;
        res.status(err.statusCode || 500).json({ error: msg });
    }
});

// ---------------------------------------------------------------
// LIST INSTANCES
// GET /modules/evolution-api/instances
// ---------------------------------------------------------------
router.get('/instances', async (req, res) => {
    try {
        const result = await evoRequest('GET', '/instance/fetchInstances');
        res.json(result);
    } catch (err) {
        const msg = (err.error && err.error.message) || err.message;
        res.status(500).json({ error: msg });
    }
});

// ---------------------------------------------------------------
// SEND MESSAGE (used internally by the listener)
// POST /modules/evolution-api/send
// Body: { instance, to, message }
// ---------------------------------------------------------------
router.post('/send', async (req, res) => {
    const { instance, to, message } = req.body;
    if (!instance || !to || !message) {
        return res.status(400).json({ error: 'instance, to and message are required' });
    }
    try {
        const result = await evoRequest('POST', '/message/sendText/' + encodeURIComponent(instance), {
            number: to,
            text: message
        });
        res.json(result);
    } catch (err) {
        const msg = (err.error && err.error.message) || err.message;
        res.status(500).json({ error: msg });
    }
});

// ---------------------------------------------------------------
// HEALTH
// ---------------------------------------------------------------
router.get('/status', (req, res) => {
    res.json({ status: 'running', configured: !!(evoBaseUrl() && evoApiKey()) });
});

// ---------------------------------------------------------------
// DIAGNOSTIC — checks full chain for a given instance
// GET /modules/evolution-api/diagnose/:name
// ---------------------------------------------------------------
router.get('/diagnose/:name', async (req, res) => {
    const instanceName = req.params.name;
    const diag = {
        instance: instanceName,
        timestamp: new Date().toISOString(),
        checks: {}
    };

    // 1. Environment
    diag.checks.env = {
        EVOLUTION_API_URL: evoBaseUrl() ? 'set' : 'MISSING',
        EVOLUTION_API_KEY: evoApiKey() ? 'set' : 'MISSING',
        EVOLUTION_WEBHOOK_URL: process.env.EVOLUTION_WEBHOOK_URL || 'not set (using API_URL fallback)',
        API_URL: apiUrl || 'not set'
    };

    // 2. Evolution API reachable?
    try {
        var evoStatus = await evoRequest('GET', '/instance/connectionState/' + encodeURIComponent(instanceName));
        diag.checks.evolution_api = { reachable: true, connectionState: evoStatus };
    } catch (err) {
        diag.checks.evolution_api = { reachable: false, error: err.message };
    }

    // 3. Webhook config on Evolution
    try {
        var webhookConfig = await evoRequest('GET', '/webhook/find/' + encodeURIComponent(instanceName));
        diag.checks.webhook_config = webhookConfig;
    } catch (err) {
        diag.checks.webhook_config = { error: err.message };
    }

    // 4. Integration record in DB
    try {
        var integration = await Integration.findOne({
            name: 'evolution_api',
            'value.instanceName': instanceName
        });
        if (integration) {
            diag.checks.integration_record = {
                found: true,
                id_project: integration.id_project,
                value: integration.value
            };
        } else {
            diag.checks.integration_record = {
                found: false,
                hint: 'No integration saved for this instance. Click "Salvar" in the dashboard after connecting.'
            };
        }
    } catch (err) {
        diag.checks.integration_record = { error: err.message };
    }

    // 5. Computed webhook URL
    var computedWebhookUrl = process.env.EVOLUTION_WEBHOOK_URL
        || (apiUrl || '').replace(/\/$/, '') + '/modules/evolution-api/webhook';
    diag.checks.computed_webhook_url = computedWebhookUrl;

    // Verdict
    var issues = [];
    if (!evoBaseUrl()) issues.push('EVOLUTION_API_URL not configured');
    if (!evoApiKey()) issues.push('EVOLUTION_API_KEY not configured');
    if (diag.checks.evolution_api && !diag.checks.evolution_api.reachable) issues.push('Cannot reach Evolution API');
    if (diag.checks.webhook_config && !diag.checks.webhook_config.enabled) issues.push('Webhook DISABLED on Evolution instance');
    if (diag.checks.webhook_config && diag.checks.webhook_config.url && diag.checks.webhook_config.url.indexOf('localhost') > -1) {
        issues.push('Webhook URL contains "localhost" — Evolution API container cannot reach it. Use Docker service name or ngrok URL.');
    }
    if (diag.checks.integration_record && !diag.checks.integration_record.found) issues.push('Integration record not found in DB — save the integration in the dashboard');

    diag.issues = issues;
    diag.healthy = issues.length === 0;

    res.json(diag);
});

// ---------------------------------------------------------------
// ACTION HANDLER — used by chatbot designer nodes (via webrequestv2)
// POST /modules/evolution-api/actions/execute
// ---------------------------------------------------------------
var actionHandler = require('./actionHandler');
router.use('/actions', actionHandler);

module.exports = router;
