/*

Configuration loading for mitsu-monitor.

All behaviour is driven by environment variables (see .env.example).
Values are parsed and validated once at startup so the rest of the app
can rely on a fully-formed AppConfig.

*/

// MELCloud OperationMode integer values (see README operation-mode map).
export enum OperationMode {
    Heat = 1,
    Dry = 2,
    Cool = 3,
    Fan = 7,
    Auto = 8,
}

// Which auto-dry behaviours are active.
export type DryStrategy = 'post-off' | 'periodic' | 'both';

export interface DeviceConfig {
    label: string;
    port: number;
}

export interface AppConfig {
    host: string;
    devices: DeviceConfig[];
    strategy: DryStrategy;
    // How long to run FAN mode to dry the unit out.
    fanDryDurationMs: number;
    // For the 'periodic' strategy: max continuous COOL/DRY runtime before we force a dry cycle.
    maxCoolRunMs: number;
    // How often we poll each device.
    pollIntervalMs: number;
    // GET path for reading device state on the RESTful server (case-insensitive on the plugin, 'state' is canonical).
    statePath: string;
    // Optional fixed fan speed to request during the dry cycle (0 = Auto, 1-6). Omit to leave fan speed untouched.
    fanSpeed?: number;
    // When true, never POST to the device: log the action that *would* be taken instead. Useful for testing.
    dryRun: boolean;
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (value === undefined || value.trim() === '') {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value.trim();
}

function parseIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Environment variable ${name} must be a positive number, got: ${raw}`);
    }
    return value;
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function parseStrategy(raw: string | undefined): DryStrategy {
    const value = (raw ?? 'both').trim().toLowerCase();
    if (value === 'post-off' || value === 'periodic' || value === 'both') {
        return value;
    }
    throw new Error(`DRY_STRATEGY must be one of 'post-off', 'periodic', 'both', got: ${raw}`);
}

// Devices can be specified either as a generic list (MONITOR_DEVICES="downstairs:9567,upstairs:9568")
// or via the legacy DOWNSTAIRS_PORT / UPSTAIRS_PORT variables documented in the README.
function parseDevices(): DeviceConfig[] {
    const list = process.env.MONITOR_DEVICES;
    if (list !== undefined && list.trim() !== '') {
        const devices = list
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
            .map((entry) => {
                const [label, portRaw] = entry.split(':').map((part) => part.trim());
                const port = Number(portRaw);
                if (!label || !Number.isInteger(port) || port <= 0 || port > 65535) {
                    throw new Error(`Invalid MONITOR_DEVICES entry "${entry}" (expected "label:port")`);
                }
                return { label, port };
            });
        if (devices.length === 0) {
            throw new Error('MONITOR_DEVICES was set but no valid devices could be parsed');
        }
        return devices;
    }

    // Legacy two-device fallback.
    const devices: DeviceConfig[] = [];
    for (const [label, envName] of [
        ['downstairs', 'DOWNSTAIRS_PORT'],
        ['upstairs', 'UPSTAIRS_PORT'],
    ] as const) {
        const raw = process.env[envName];
        if (raw !== undefined && raw.trim() !== '') {
            const port = Number(raw);
            if (!Number.isInteger(port) || port <= 0 || port > 65535) {
                throw new Error(`${envName} must be a valid port number, got: ${raw}`);
            }
            devices.push({ label, port });
        }
    }
    if (devices.length === 0) {
        throw new Error('No devices configured. Set MONITOR_DEVICES or DOWNSTAIRS_PORT / UPSTAIRS_PORT.');
    }
    return devices;
}

export function loadConfig(): AppConfig {
    const fanSpeedRaw = process.env.FAN_SPEED;
    let fanSpeed: number | undefined;
    if (fanSpeedRaw !== undefined && fanSpeedRaw.trim() !== '') {
        const value = Number(fanSpeedRaw);
        if (!Number.isInteger(value) || value < 0 || value > 6) {
            throw new Error(`FAN_SPEED must be an integer 0-6, got: ${fanSpeedRaw}`);
        }
        fanSpeed = value;
    }

    return {
        host: requireEnv('HOMEBRIDGE_ADDRESS'),
        devices: parseDevices(),
        strategy: parseStrategy(process.env.DRY_STRATEGY),
        fanDryDurationMs: parseIntEnv('FAN_DRY_DURATION_MS', 15 * 60 * 1000),
        maxCoolRunMs: parseIntEnv('MAX_COOL_RUN_HOURS', 2) * 60 * 60 * 1000,
        pollIntervalMs: parseIntEnv('POLL_INTERVAL_MS', 60 * 1000),
        statePath: (process.env.STATE_PATH ?? 'state').trim().replace(/^\//, ''),
        fanSpeed,
        dryRun: parseBoolEnv('DRY_RUN', false),
    };
}
