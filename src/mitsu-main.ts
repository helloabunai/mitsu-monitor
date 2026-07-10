/*

Mitsu-monitor

Simple Mitsubishi air-conditioner monitor that automates a FAN "dry" cycle
after COOL/DRY use, to keep the unit's internals dry and mould-free.

See README.md for the why, and .env.example for configuration.

*/

import * as fs from 'fs';

import * as dotenv from 'dotenv';

import { AirConditioner } from './airConditioner';
import { loadConfig } from './config';
import { AirConditionerMonitor } from './monitor';

// Prefer a local override file if present, otherwise fall back to process env / .env.
if (fs.existsSync('.env.local')) {
    dotenv.config({ path: '.env.local' });
} else {
    dotenv.config();
}

function main(): void {
    let config;
    try {
        config = loadConfig();
    } catch (error) {
        console.error(`Configuration error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
        return;
    }

    console.log(`mitsu-monitor starting: ${config.devices.length} device(s) on ${config.host}`);

    for (const device of config.devices) {
        const ac = new AirConditioner({
            label: device.label,
            host: config.host,
            port: device.port,
            statePath: config.statePath,
            dryRun: config.dryRun,
        });
        new AirConditionerMonitor(ac, config).start();
    }
}

main();
