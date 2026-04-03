var winston = require('../../config/winston');
var message2Event = require('../../event/message2Event');
var messageService = require('../../services/messageService');
var MessageConstants = require('../../models/messageConstants');
var evoClient = require('./evoClient');
var evoCache = require('./evoCache');
var sessionMonitor = require('./sessionMonitor');
var Message = require('../../models/message');

class Listener {

    listen(config) {
        winston.info('Evolution API Listener initialized');

        // Initialize shared Redis cache for idempotency
        if (config && config.tdCache) {
            evoCache.init(config.tdCache);
        }

        // Start periodic session health checks
        sessionMonitor.start();

        var evolutionApiUrl = process.env.EVOLUTION_API_URL;
        var evolutionApiKey = process.env.EVOLUTION_API_KEY;

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
                var messageId = messageJson._id;

                winston.info('[EvoAPI] Sending reply (' + msgType + ') to ' + phone + ' via instance ' + instance + ': ' + text.substring(0, 80));

                evoClient.sendMessage(instance, phone, text, msgType, msgMetadata).then(function(result) {
                    winston.info('[EvoAPI] Message sent successfully to ' + phone);

                    // Store Evolution message ID for status correlation (MESSAGES_UPDATE events)
                    var evoMessageId = result && result.key && result.key.id;
                    if (messageId && evoMessageId) {
                        Message.updateOne(
                            { _id: messageId },
                            { $set: { 'attributes.evoMessageId': evoMessageId } }
                        ).catch(function(err) {
                            winston.error('[EvoAPI] Error storing evoMessageId: ' + err.message);
                        });
                    }

                    // Update message status to SENT
                    if (messageId) {
                        messageService.changeStatus(messageId, MessageConstants.CHAT_MESSAGE_STATUS.SENT)
                            .catch(function(err) {
                                winston.error('[EvoAPI] Error updating message status to SENT: ' + err.message);
                            });
                    }
                }).catch(function(err) {
                    winston.error('[EvoAPI] Error sending message to Evolution API: ' + err.message);

                    // Update message status to FAILED
                    if (messageId) {
                        messageService.changeStatus(messageId, MessageConstants.CHAT_MESSAGE_STATUS.FAILED)
                            .catch(function(statusErr) {
                                winston.error('[EvoAPI] Error updating message status to FAILED: ' + statusErr.message);
                            });
                    }
                });

            } catch (err) {
                winston.error('[EvoAPI] Error processing outgoing message: ' + err.message, err);
            }
        });
    }
}

var listener = new Listener();

module.exports = listener;
