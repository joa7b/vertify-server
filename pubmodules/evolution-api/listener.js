var winston = require('../../config/winston');
var configGlobal = require('../../config/global');
var message2Event = require('../../event/message2Event');
var rp = require('request-promise');

function evoBaseUrl() {
    const url = process.env.EVOLUTION_API_URL;
    return url ? url.replace(/\/$/, '') : null;
}

function evoApiKey() {
    return process.env.EVOLUTION_API_KEY;
}

function sendToEvolution(instance, to, text, type, metadata) {
    const base = evoBaseUrl();
    const key = evoApiKey();
    if (!base || !key) {
        return Promise.reject(new Error('EVOLUTION_API_URL or EVOLUTION_API_KEY not configured'));
    }

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
        // Default: send as text
        endpoint = '/message/sendText/' + encodeURIComponent(instance);
        body = {
            number: to,
            text: text
        };
    }

    return rp({
        method: 'POST',
        uri: base + endpoint,
        headers: { apikey: key, 'Content-Type': 'application/json' },
        json: true,
        body: body
    });
}

class Listener {

    listen(config) {
        winston.info('Evolution API Listener initialized');

        const evolutionApiUrl = process.env.EVOLUTION_API_URL;
        const evolutionApiKey = process.env.EVOLUTION_API_KEY;

        if (evolutionApiUrl) {
            winston.info('[EvoAPI] Evolution API URL: ' + evolutionApiUrl);
        } else {
            winston.warn('[EvoAPI] EVOLUTION_API_URL not set - set it to enable Evolution API integration');
        }

        if (!evolutionApiKey) {
            winston.warn('[EvoAPI] EVOLUTION_API_KEY not set');
        }

        var webhookUrl = process.env.EVOLUTION_WEBHOOK_URL || 'derived from API_URL';
        winston.info('[EvoAPI] Webhook endpoint: POST /modules/evolution-api/webhook (configured URL: ' + webhookUrl + ')');

        // Listen for outgoing messages on evolution channel requests
        // This fires when the bot (or an agent) sends a reply to a request that came in via Evolution API
        message2Event.on('message.create.request.channel.evolution', function(messageJson) {
            winston.info('[EvoAPI] Outbound event fired — sender: ' + messageJson.sender +
                ' text: ' + (messageJson.text || '').substring(0, 50) +
                ' type: ' + (messageJson.type || 'text'));

            try {
                var request = messageJson.request;
                if (!request) {
                    winston.warn('[EvoAPI] No request in message event');
                    return;
                }

                // Skip messages from the requester (incoming) — only forward bot/agent replies
                var leadId = request.lead ? request.lead.lead_id : null;
                if (leadId && messageJson.sender === leadId) {
                    winston.info('[EvoAPI] Skipping incoming echo (sender=' + messageJson.sender + ' == lead=' + leadId + ')');
                    return;
                }

                var text = messageJson.text;
                if (!text) {
                    winston.info('[EvoAPI] Skipping empty text message from ' + messageJson.sender);
                    return;
                }

                var attributes = request.attributes || {};
                var phone = attributes.remoteJid || attributes.phone;
                var instance = attributes.instance;

                if (!phone || !instance) {
                    winston.error('[EvoAPI] Missing phone/remoteJid or instance in request.attributes: ' + JSON.stringify(attributes));
                    return;
                }

                var msgType = messageJson.type || 'text';
                var msgMetadata = messageJson.metadata || undefined;

                winston.info('[EvoAPI] Sending reply (' + msgType + ') to ' + phone + ' via instance ' + instance + ': ' + text.substring(0, 80));

                sendToEvolution(instance, phone, text, msgType, msgMetadata).then(function(result) {
                    winston.info('[EvoAPI] Message sent successfully to ' + phone);
                }).catch(function(err) {
                    winston.error('[EvoAPI] Error sending message to Evolution API: ' + err.message);
                });

            } catch (err) {
                winston.error('[EvoAPI] Error processing outgoing message: ' + err.message, err);
            }
        });
    }
}

var listener = new Listener();

module.exports = listener;
