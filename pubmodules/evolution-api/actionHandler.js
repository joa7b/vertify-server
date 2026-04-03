/**
 * Action execution endpoint for Evolution API chatbot nodes.
 *
 * Called by the tybot-connector via webrequestv2 actions.
 * Provides a clean JSON API that chatbot flows can invoke without
 * knowing the internal Evolution API payload format.
 *
 * POST /modules/evolution-api/actions/execute
 */

'use strict';

var express = require('express');
var router = express.Router();
var winston = require('../../config/winston');
var evoClient = require('./evoClient');
var Integration = require('../../models/integrations');

/**
 * Execute a chatbot action against the Evolution API.
 *
 * Body:
 *   action: 'send_text' | 'send_media' | 'check_session'
 *   params: { instance?, to?, text?, mediaUrl?, mediaType?, fileName?, project_id? }
 *
 * For send_text/send_media, if `instance` is not provided, the handler will
 * look up the first evolution_api integration for the given project_id.
 */
router.post('/execute', async (req, res) => {
    var action = req.body.action;
    var params = req.body.params || {};

    if (!action) {
        return res.status(400).json({ success: false, error: 'Missing "action" field' });
    }

    try {
        var result;
        switch (action) {
            case 'send_text':
                result = await handleSendText(params);
                break;
            case 'send_media':
                result = await handleSendMedia(params);
                break;
            case 'check_session':
                result = await handleCheckSession(params);
                break;
            default:
                return res.status(400).json({ success: false, error: 'Unknown action: ' + action });
        }
        res.json({ success: true, data: result });
    } catch (err) {
        winston.error('[EvoActionHandler] Error executing action "' + action + '": ' + err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

async function resolveInstance(params) {
    if (params.instance) return params.instance;
    if (!params.project_id) {
        throw new Error('Either "instance" or "project_id" must be provided');
    }
    var integration = await Integration.findOne({
        name: 'evolution_api',
        id_project: params.project_id
    });
    if (!integration || !integration.value || !integration.value.instanceName) {
        throw new Error('No Evolution API integration found for project ' + params.project_id);
    }
    return integration.value.instanceName;
}

async function handleSendText(params) {
    if (!params.to || !params.text) {
        throw new Error('send_text requires "to" and "text" in params');
    }
    var instance = await resolveInstance(params);
    return evoClient.sendMessage(instance, params.to, params.text, 'text', null);
}

async function handleSendMedia(params) {
    if (!params.to || !params.mediaUrl) {
        throw new Error('send_media requires "to" and "mediaUrl" in params');
    }
    var instance = await resolveInstance(params);
    var mediaType = params.mediaType || 'image';
    var type = mediaType === 'image' ? 'image' : 'file';
    var metadata = {
        src: params.mediaUrl,
        type: params.mimetype || (mediaType === 'image' ? 'image/jpeg' : 'application/octet-stream'),
        name: params.fileName || 'file'
    };
    return evoClient.sendMessage(instance, params.to, params.text || '', type, metadata);
}

async function handleCheckSession(params) {
    var instance = await resolveInstance(params);
    var result = await evoClient.evoRequest('GET', '/instance/connectionState/' + encodeURIComponent(instance));
    var state = (result && (result.state || (result.instance && result.instance.state))) || 'unknown';
    return { instance: instance, state: state, connected: state === 'open' };
}

module.exports = router;
