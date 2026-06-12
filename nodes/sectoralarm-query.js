'use strict';

const { normalizeStatus } = require('../lib/client');

module.exports = function (RED) {
    const QUERIES = ['status', 'panel', 'panels', 'temperatures', 'logs', 'locks'];

    function SectorAlarmQueryNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.account = RED.nodes.getNode(config.account);
        node.queryType = config.queryType || 'useMsg';
        node.pageSize = parseInt(config.pageSize, 10) || 10;

        if (!node.account || !node.account.client || !node.account.panelId) {
            node.status({ fill: 'red', shape: 'ring', text: 'missing configuration' });
            node.error('Sector Alarm account configuration is missing or incomplete');
            return;
        }

        const client = node.account.client;
        const panelId = node.account.panelId;

        node.on('input', async (msg, send, done) => {
            send = send || node.send.bind(node);

            let type = node.queryType;
            let pageSize = node.pageSize;
            let pageNumber = 1;

            if (typeof msg.payload === 'object' && msg.payload !== null) {
                if (msg.payload.type) type = String(msg.payload.type);
                if (msg.payload.pageSize) pageSize = parseInt(msg.payload.pageSize, 10) || pageSize;
                if (msg.payload.pageNumber) pageNumber = parseInt(msg.payload.pageNumber, 10) || 1;
            } else if (type === 'useMsg' && typeof msg.payload === 'string') {
                type = msg.payload;
            }

            type = String(type || '').trim();
            if (!QUERIES.includes(type)) {
                const err = new Error(`Invalid query type '${type}'. Use one of: ${QUERIES.join(', ')}`);
                err.code = 'invalid_input';
                node.status({ fill: 'red', shape: 'ring', text: 'invalid query' });
                done(err);
                return;
            }

            node.status({ fill: 'blue', shape: 'ring', text: `${type}...` });
            try {
                let payload;
                let raw;
                switch (type) {
                    case 'status':
                        raw = await client.getPanelStatus(panelId);
                        payload = normalizeStatus(raw);
                        delete payload.raw;
                        break;
                    case 'panel': payload = await client.getPanel(panelId); break;
                    case 'panels': payload = await client.getPanelList(); break;
                    case 'temperatures': payload = await client.getTemperatures(panelId); break;
                    case 'logs': payload = await client.getLogs(panelId, { pageNumber, pageSize }); break;
                    case 'locks': payload = await client.getLockStatus(panelId); break;
                }
                node.status({});
                const outMsg = Object.assign({}, msg, {
                    topic: `sectoralarm/${type}`,
                    payload
                });
                if (raw !== undefined) outMsg.raw = raw;
                send(outMsg);
                done();
            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: `${type} failed: ${err.code || 'error'}` });
                msg.error = { code: err.code, statusCode: err.statusCode, message: err.message };
                done(err);
            }
        });
    }

    RED.nodes.registerType('sectoralarm-ng-query', SectorAlarmQueryNode);
};
