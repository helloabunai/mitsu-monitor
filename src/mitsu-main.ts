/*

Mitsu-monitor

Simple Mitsubishi air-conditioner monitor that automates a FAN "dry" cycle
after COOL/DRY use, to keep the unit's internals dry and mould-free.

See README.md for the why, and .env.example for configuration.

*/

import * as fs from 'fs';

import * as dotenv from 'dotenv';

import { AirConditioner } from './airConditioner';
import { AppConfig, loadConfig } from './config';
import { AirConditionerMonitor } from './monitor';

// Prefer a local override file if present, otherwise fall back to process env / .env.
if (fs.existsSync('.env.local')) {
    dotenv.config({ path: '.env.local' });
} else {
    dotenv.config();
}

function main(): void {
    let config: AppConfig;
    try {
        config = loadConfig();
    } catch (error) {
        console.error(`Configuration error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
        return;
    }

    console.log(`mitsu-monitor starting: ${config.devices.length} device(s) on ${config.host}`);

    const monitors = config.devices.map((device) => {
        const ac = new AirConditioner({
            label: device.label,
            host: config.host,
            port: device.port,
            statePath: config.statePath,
            dryRun: config.dryRun,
        });
        const monitor = new AirConditionerMonitor(ac, config);
        monitor.start();
        return monitor;
    });

    // Finalize any in-flight dry cycle on exit so we never leave a unit parked in FAN.
    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        console.log(`Received ${signal} — shutting down ${monitors.length} monitor(s)...`);
        await Promise.allSettled(monitors.map((m) => m.shutdown()));
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main();
