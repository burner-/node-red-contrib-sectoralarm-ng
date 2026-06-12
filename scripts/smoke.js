'use strict';

/**
 * Read-only live smoke test against the real Sector Alarm API.
 * Never arms, disarms, locks or unlocks anything.
 *
 * Usage (PowerShell):
 *   $env:SA_EMAIL='you@example.com'; $env:SA_PASSWORD='...'; npm run smoke
 *   # optional: $env:SA_PANEL_ID='01234567' to skip panel auto-pick
 */

const { SectorClient, normalizeStatus } = require('../lib/client');

async function main() {
    const email = process.env.SA_EMAIL;
    const password = process.env.SA_PASSWORD;
    if (!email || !password) {
        console.error('Set SA_EMAIL and SA_PASSWORD environment variables first.');
        process.exit(1);
    }

    const client = new SectorClient({ email, password, log: (m) => console.log(`  [client] ${m}`) });

    console.log('1. Panel list (logs in)...');
    const panels = await client.getPanelList();
    for (const p of panels) console.log(`   - ${p.DisplayName} (PanelId: ${p.PanelId})`);

    const panelId = process.env.SA_PANEL_ID || (panels[0] && panels[0].PanelId);
    if (!panelId) {
        console.error('No panels on this account.');
        process.exit(1);
    }
    console.log(`\nUsing panel ${panelId}\n`);

    console.log('2. Panel status...');
    const rawStatus = await client.getPanelStatus(panelId);
    console.log('   raw:', JSON.stringify(rawStatus));
    console.log('   normalized:', JSON.stringify(normalizeStatus(rawStatus), (k, v) => (k === 'raw' ? undefined : v)));

    console.log('\n3. Temperatures...');
    const temps = await client.getTemperatures(panelId);
    console.log('  ', JSON.stringify(temps));

    console.log('\n4. Lock status...');
    const locks = await client.getLockStatus(panelId);
    console.log('  ', JSON.stringify(locks));

    console.log('\n5. Last 5 log events...');
    const logs = await client.getLogs(panelId, { pageSize: 5 });
    console.log('  ', JSON.stringify(logs, null, 2));

    console.log('\nSmoke test finished OK (read-only — nothing was armed or unlocked).');
}

main().catch((err) => {
    console.error(`\nFAILED [${err.code || 'error'}]: ${err.message}`);
    process.exit(2);
});
