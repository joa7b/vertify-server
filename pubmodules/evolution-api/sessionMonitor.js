/**
 * Periodic health check for Evolution API WhatsApp sessions.
 *
 * Queries all evolution_api integrations, checks connection state via the Evolution API,
 * and updates the Integration record so the dashboard reflects the current status.
 */

'use strict';

var schedule = require('node-schedule');
var winston = require('../../config/winston');
var Integration = require('../../models/integrations');
var evoClient = require('./evoClient');

var DEFAULT_CRON = '*/60 * * * * *'; // every 60 seconds

class SessionMonitor {

    constructor() {
        this.cronExp = process.env.EVOLUTION_SESSION_CHECK_INTERVAL || DEFAULT_CRON;
        this.enabled = (process.env.EVOLUTION_SESSION_MONITOR_ENABLED || 'true') === 'true';
        this.job = null;
    }

    start() {
        if (!this.enabled) {
            winston.info('[EvoSessionMonitor] Disabled via EVOLUTION_SESSION_MONITOR_ENABLED');
            return;
        }

        if (!evoClient.evoBaseUrl() || !evoClient.evoApiKey()) {
            winston.info('[EvoSessionMonitor] Not starting — Evolution API not configured');
            return;
        }

        winston.info('[EvoSessionMonitor] Starting session monitor (cron: ' + this.cronExp + ')');
        var self = this;
        this.job = schedule.scheduleJob(this.cronExp, function () {
            self.checkAllSessions().catch(function (err) {
                winston.error('[EvoSessionMonitor] Error in check cycle: ' + err.message);
            });
        });
    }

    stop() {
        if (this.job) {
            this.job.cancel();
            this.job = null;
            winston.info('[EvoSessionMonitor] Stopped');
        }
    }

    async checkAllSessions() {
        if (evoClient.isCircuitOpen()) {
            winston.warn('[EvoSessionMonitor] Skipping check — circuit breaker is open');
            return;
        }

        var integrations;
        try {
            integrations = await Integration.find({ name: 'evolution_api' });
        } catch (err) {
            winston.error('[EvoSessionMonitor] Error querying integrations: ' + err.message);
            return;
        }

        if (!integrations || integrations.length === 0) {
            return; // No integrations to check
        }

        for (var i = 0; i < integrations.length; i++) {
            var integration = integrations[i];
            var instanceName = integration.value && integration.value.instanceName;
            if (!instanceName) continue;

            try {
                var result = await evoClient.evoRequest('GET', '/instance/connectionState/' + encodeURIComponent(instanceName));
                var state = (result && (result.state || result.instance && result.instance.state)) || 'unknown';

                var previousState = integration.value.connectionState;
                if (previousState !== state) {
                    winston.info('[EvoSessionMonitor] Instance "' + instanceName + '" state changed: ' +
                        (previousState || 'unknown') + ' -> ' + state +
                        ' (project: ' + integration.id_project + ')');

                    await Integration.updateOne(
                        { _id: integration._id },
                        { $set: { 'value.connectionState': state, 'value.lastCheckedAt': new Date() } }
                    );
                } else {
                    // Just update the timestamp
                    await Integration.updateOne(
                        { _id: integration._id },
                        { $set: { 'value.lastCheckedAt': new Date() } }
                    );
                }

                if (state !== 'open') {
                    winston.warn('[EvoSessionMonitor] Instance "' + instanceName + '" is NOT connected (state: ' + state +
                        '). Project: ' + integration.id_project);
                }
            } catch (err) {
                winston.error('[EvoSessionMonitor] Error checking instance "' + instanceName + '": ' + err.message);
                await Integration.updateOne(
                    { _id: integration._id },
                    { $set: { 'value.connectionState': 'error', 'value.lastCheckedAt': new Date() } }
                ).catch(function () {});
            }
        }
    }
}

module.exports = new SessionMonitor();
