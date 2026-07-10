/*

HTTP client for a single Mitsubishi air-conditioner unit exposed by the
homebridge-melcloud-control RESTful server.

  GET  http://<host>:<port>/state  -> HeatPumpState JSON
  POST http://<host>:<port>        -> { Power, OperationMode, FanSpeed, ... } (JSON)

*/

import axios from 'axios';

import { HeatPumpState } from './heatPumpState';

// The subset of fields we ever write back to the device.
export interface CommandPayload {
    Power?: boolean;
    OperationMode?: number;
    FanSpeed?: number;
}

export class AirConditioner {
    public readonly label: string;
    public readonly host: string;
    public readonly port: number;
    private readonly statePath: string;
    private readonly dryRun: boolean;

    constructor(opts: { label: string; host: string; port: number; statePath: string; dryRun: boolean }) {
        this.label = opts.label;
        this.host = opts.host;
        this.port = opts.port;
        this.statePath = opts.statePath;
        this.dryRun = opts.dryRun;
    }

    private get baseUrl(): string {
        return `http://${this.host}:${this.port}`;
    }

    // Returns the current device state, or null if the request failed (caller should skip this tick).
    async getState(): Promise<HeatPumpState | null> {
        try {
            const response = await axios.get(`${this.baseUrl}/${this.statePath}`, { timeout: 10000 });
            const data = response.data as HeatPumpState;
            if (data == null || typeof data.OperationMode !== 'number' || typeof data.Power !== 'boolean') {
                console.error(`[${this.label}] Unexpected state payload from ${this.baseUrl}/${this.statePath}`);
                return null;
            }
            return data;
        } catch (error) {
            console.error(`[${this.label}] Error getting state from ${this.baseUrl}/${this.statePath}: ${errMsg(error)}`);
            return null;
        }
    }

    // Sends a command to the device. Returns true on success (or in dry-run). Never throws.
    async apply(payload: CommandPayload): Promise<boolean> {
        if (this.dryRun) {
            console.log(`[${this.label}] [DRY RUN] would POST ${JSON.stringify(payload)} to ${this.baseUrl}`);
            return true;
        }
        try {
            await axios.post(this.baseUrl, payload, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000,
            });
            console.log(`[${this.label}] applied ${JSON.stringify(payload)}`);
            return true;
        } catch (error) {
            console.error(`[${this.label}] Error applying ${JSON.stringify(payload)} to ${this.baseUrl}: ${errMsg(error)}`);
            return false;
        }
    }
}

function errMsg(error: unknown): string {
    if (axios.isAxiosError(error)) {
        return error.response ? `HTTP ${error.response.status}` : error.message;
    }
    return error instanceof Error ? error.message : String(error);
}
