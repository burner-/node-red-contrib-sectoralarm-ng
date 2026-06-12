'use strict';

const { SectorClient } = require('../lib/client');
const { AuthError } = require('../lib/errors');

module.exports = function (RED) {
    function SectorAlarmConfigNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.panelId = config.panelId;

        const email = node.credentials.email;
        const password = node.credentials.password;

        if (email && password) {
            node.client = new SectorClient({
                email,
                password,
                log: (msg) => node.debug(`[client] ${msg}`)
            });
        } else {
            node.client = null;
            node.warn('Sector Alarm config node has no credentials configured');
        }

        node.getCode = () => node.credentials.code || null;

        node.on('close', () => {
            if (node.client) node.client.invalidateToken();
        });
    }

    RED.nodes.registerType('sectoralarm-ng-config', SectorAlarmConfigNode, {
        credentials: {
            email: { type: 'text' },
            password: { type: 'password' },
            code: { type: 'password' }
        }
    });

    // Editor support: fetch the panel list for the "Fetch panels" button.
    RED.httpAdmin.post(
        '/sectoralarm-ng/panels',
        RED.auth.needsPermission('flows.write'),
        async function (req, res) {
            try {
                let { email, password, nodeId } = req.body || {};

                // The editor sends '__PWRD__' when the stored password was not changed.
                if (password === '__PWRD__' && nodeId) {
                    const stored = RED.nodes.getCredentials(nodeId);
                    password = stored && stored.password;
                    if (!email && stored) email = stored.email;
                }
                if (!email || !password) {
                    res.status(400).json({ error: 'missing_credentials' });
                    return;
                }

                const client = new SectorClient({ email, password });
                const panels = await client.getPanelList();
                res.json((Array.isArray(panels) ? panels : []).map((p) => ({
                    panelId: p.PanelId,
                    displayName: p.DisplayName
                })));
            } catch (err) {
                if (err instanceof AuthError) {
                    res.status(401).json({ error: 'auth_failed' });
                } else {
                    res.status(502).json({ error: err.code || 'error', message: err.message });
                }
            }
        }
    );
};
