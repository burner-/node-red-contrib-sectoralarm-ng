'use strict';

module.exports = function (RED) {
    const COMMANDS = ['arm', 'partialarm', 'disarm', 'lock', 'unlock'];
    const NEEDS_CODE = new Set(['disarm', 'lock', 'unlock']);
    const NEEDS_SERIAL = new Set(['lock', 'unlock']);

    function SectorAlarmControlNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.account = RED.nodes.getNode(config.account);
        node.action = config.action || 'useMsg';
        node.lockSerial = config.lockSerial || '';

        if (!node.account || !node.account.client || !node.account.panelId) {
            node.status({ fill: 'red', shape: 'ring', text: 'missing configuration' });
            node.error('Sector Alarm account configuration is missing or incomplete');
            return;
        }

        const client = node.account.client;
        const panelId = node.account.panelId;
        let statusResetTimer = null;

        function setStatus(fill, shape, text) {
            clearTimeout(statusResetTimer);
            node.status({ fill, shape, text });
            if (fill === 'green') {
                statusResetTimer = setTimeout(() => node.status({}), 5000);
            }
        }

        node.on('input', async (msg, send, done) => {
            send = send || node.send.bind(node);

            let command = node.action;
            let lockSerial = node.lockSerial;
            let code = null;

            if (typeof msg.payload === 'object' && msg.payload !== null) {
                if (msg.payload.command) command = String(msg.payload.command);
                if (msg.payload.lockSerial) lockSerial = String(msg.payload.lockSerial);
                if (msg.payload.code) code = String(msg.payload.code);
            } else if (command === 'useMsg' && typeof msg.payload === 'string') {
                command = msg.payload;
            }

            command = String(command || '').toLowerCase().trim();
            if (command === 'usemsg' || !COMMANDS.includes(command)) {
                const err = new Error(
                    `Invalid control command '${command}'. Use one of: ${COMMANDS.join(', ')}`
                );
                err.code = 'invalid_input';
                setStatus('red', 'ring', 'invalid command');
                done(err);
                return;
            }

            if (!code) code = node.account.getCode();
            if (NEEDS_CODE.has(command) && !code) {
                const err = new Error(
                    `'${command}' requires a panel code (set it in the config node or pass msg.payload.code)`
                );
                err.code = 'code_required';
                setStatus('red', 'ring', 'panel code required');
                done(err);
                return;
            }
            if (NEEDS_SERIAL.has(command) && !lockSerial) {
                const err = new Error(
                    `'${command}' requires a lock serial (set it in the node or pass msg.payload.lockSerial)`
                );
                err.code = 'lock_serial_required';
                setStatus('red', 'ring', 'lock serial required');
                done(err);
                return;
            }

            setStatus('blue', 'ring', `${command}...`);
            try {
                let raw;
                switch (command) {
                    case 'arm': raw = await client.arm(panelId, code); break;
                    case 'partialarm': raw = await client.partialArm(panelId, code); break;
                    case 'disarm': raw = await client.disarm(panelId, code); break;
                    case 'lock': raw = await client.lock(panelId, lockSerial, code); break;
                    case 'unlock': raw = await client.unlock(panelId, lockSerial, code); break;
                }
                setStatus('green', 'dot', `${command} ok`);
                const outMsg = Object.assign({}, msg, {
                    topic: 'sectoralarm/control',
                    payload: {
                        command,
                        ok: true,
                        panelId,
                        ...(NEEDS_SERIAL.has(command) ? { lockSerial } : {})
                    },
                    raw: raw === undefined ? null : raw
                });
                send(outMsg);
                done();
            } catch (err) {
                setStatus('red', 'ring', `${command} failed: ${err.code || 'error'}`);
                msg.error = { code: err.code, statusCode: err.statusCode, message: err.message };
                done(err);
            }
        });

        node.on('close', () => clearTimeout(statusResetTimer));
    }

    RED.nodes.registerType('sectoralarm-ng-control', SectorAlarmControlNode);
};
