'use strict';

const { normalizeStatus } = require('../lib/client');

const STATUS_COLORS = {
    armed: 'green',
    partialArmed: 'yellow',
    disarmed: 'blue',
    unknown: 'grey'
};

module.exports = function (RED) {
    function SectorAlarmStatusNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.account = RED.nodes.getNode(config.account);
        node.intervalSec = Math.max(parseInt(config.interval, 10) || 60, 10);
        node.emitOnStart = !!config.emitOnStart;
        node.topic = config.topic || 'sectoralarm/status';
        node.lastStatus = undefined;

        if (!node.account || !node.account.client || !node.account.panelId) {
            node.status({ fill: 'red', shape: 'ring', text: 'missing configuration' });
            node.error('Sector Alarm account configuration is missing or incomplete');
            return;
        }

        const client = node.account.client;
        const panelId = node.account.panelId;

        async function poll({ forced = false, msg = null, send = null, done = null } = {}) {
            const doSend = send || node.send.bind(node);
            try {
                const raw = await client.getPanelStatus(panelId);
                const normalized = normalizeStatus(raw);
                const previous = node.lastStatus;
                const changed = previous !== undefined && previous !== normalized.status;
                const first = previous === undefined;
                node.lastStatus = normalized.status;

                const fill = normalized.isOnline ? (STATUS_COLORS[normalized.status] || 'grey') : 'grey';
                const text = normalized.isOnline ? normalized.status : `${normalized.status} (offline)`;
                node.status({ fill, shape: 'dot', text });

                const shouldEmit = forced || changed || (first && node.emitOnStart);
                if (shouldEmit) {
                    const outMsg = Object.assign({}, msg, {
                        topic: node.topic,
                        payload: {
                            status: normalized.status,
                            previousStatus: first ? null : previous,
                            changed,
                            isOnline: normalized.isOnline,
                            statusTime: normalized.statusTime,
                            panelId
                        },
                        raw
                    });
                    doSend(outMsg);
                }
                if (done) done();
            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: err.code || 'error' });
                if (done) {
                    done(err);
                } else {
                    node.error(err, { payload: { error: { code: err.code, message: err.message } } });
                }
            }
        }

        node.status({ fill: 'grey', shape: 'ring', text: 'connecting' });
        poll();
        node.pollTimer = setInterval(() => poll(), node.intervalSec * 1000);

        node.on('input', (msg, send, done) => {
            poll({ forced: true, msg, send, done });
        });

        node.on('close', (removed, done) => {
            clearInterval(node.pollTimer);
            done();
        });
    }

    RED.nodes.registerType('sectoralarm-ng-status', SectorAlarmStatusNode);
};
