/*

Per-device auto-dry state machine.

Two behaviours (selectable via DRY_STRATEGY):

  post-off  When a unit that was running COOL/DRY is switched OFF (Power true->false),
            turn it back on in FAN mode for fanDryDurationMs, then switch it OFF again.

  periodic  When a unit has been running COOL/DRY continuously for longer than
            maxCoolRunMs, interrupt it with a FAN cycle for fanDryDurationMs, then
            resume the previous COOL/DRY mode (leaving it powered on).

The machine is careful to (a) never mistake its own FAN writes for a user action,
and (b) relinquish control if the user manually intervenes during a dry cycle.

*/

import { AirConditioner } from './airConditioner';
import { AppConfig, OperationMode } from './config';

type Phase = 'MONITORING' | 'DRYING';

type DryReason = 'post-off' | 'periodic';

interface DryCycle {
    reason: DryReason;
    startedAt: number;
    endAt: number;
    // Mode to restore when a periodic cycle completes.
    restoreMode: number;
    // Set true once the device has confirmed it is actually in FAN mode.
    confirmed: boolean;
}

interface Snapshot {
    power: boolean;
    mode: number;
}

function isCoolOrDry(mode: number): boolean {
    return mode === OperationMode.Cool || mode === OperationMode.Dry;
}

export class AirConditionerMonitor {
    private phase: Phase = 'MONITORING';
    private prev: Snapshot | null = null;
    // Epoch ms at which the current continuous COOL/DRY run began (null when not in COOL/DRY).
    private coolRunStartAt: number | null = null;
    private dry: DryCycle | null = null;

    private readonly postOffEnabled: boolean;
    private readonly periodicEnabled: boolean;

    constructor(private readonly ac: AirConditioner, private readonly config: AppConfig) {
        this.postOffEnabled = config.strategy === 'post-off' || config.strategy === 'both';
        this.periodicEnabled = config.strategy === 'periodic' || config.strategy === 'both';
    }

    start(): void {
        console.log(
            `[${this.ac.label}] monitoring ${this.ac.host}:${this.ac.port} ` +
                `(strategy=${this.config.strategy}, poll=${this.config.pollIntervalMs}ms, ` +
                `dry=${this.config.fanDryDurationMs}ms, maxRun=${this.config.maxCoolRunMs}ms` +
                `${this.config.dryRun ? ', DRY_RUN' : ''})`,
        );
        // Fire immediately, then on the configured interval.
        void this.tick();
        setInterval(() => void this.tick(), this.config.pollIntervalMs);
    }

    private async tick(): Promise<void> {
        const now = Date.now();
        const state = await this.ac.getState();
        if (state === null) {
            // Transient failure: hold all state (don't advance `prev`, or we'd miss/fake a transition).
            return;
        }

        const snap: Snapshot = { power: state.Power, mode: state.OperationMode };
        const inCoolDry = snap.power && isCoolOrDry(snap.mode);

        console.log(
            `[${this.ac.label}] phase=${this.phase} power=${snap.power} ` +
                `mode=${OperationMode[snap.mode] ?? snap.mode} room=${state.RoomTemperature} outdoor=${state.OutdoorTemperature}`,
        );

        if (this.phase === 'DRYING') {
            await this.tickDrying(now, snap);
        } else {
            await this.tickMonitoring(now, snap, inCoolDry);
        }
    }

    private async tickDrying(now: number, snap: Snapshot): Promise<void> {
        const cycle = this.dry!;
        const inFan = snap.power && snap.mode === OperationMode.Fan;

        // In dry-run we never actually drive the device, so skip the confirm/abort checks
        // and simply let the timer run so the full cycle can be observed.
        if (!this.config.dryRun) {
            if (inFan) {
                cycle.confirmed = true;
            } else if (cycle.confirmed) {
                // We had FAN, and now we don't: the user (or something else) took over. Back off.
                console.log(`[${this.ac.label}] user intervened during dry cycle — relinquishing control.`);
                this.endDryCycle(now, snap);
                return;
            } else if (now - cycle.startedAt > this.settleGraceMs()) {
                // Our command never took effect. Give up rather than hang in DRYING forever.
                console.warn(`[${this.ac.label}] device never entered FAN mode — aborting dry cycle.`);
                this.endDryCycle(now, snap);
                return;
            }
        }

        if (now >= cycle.endAt) {
            if (cycle.reason === 'post-off') {
                console.log(`[${this.ac.label}] dry cycle complete → powering off.`);
                await this.ac.apply({ Power: false });
            } else {
                console.log(`[${this.ac.label}] dry cycle complete → resuming ${OperationMode[cycle.restoreMode] ?? cycle.restoreMode}.`);
                await this.ac.apply({ OperationMode: cycle.restoreMode });
            }
            this.endDryCycle(now, snap);
        }
    }

    private async tickMonitoring(now: number, snap: Snapshot, inCoolDry: boolean): Promise<void> {
        // Track how long we've been continuously cooling/drying.
        if (inCoolDry) {
            if (this.coolRunStartAt === null) {
                this.coolRunStartAt = now;
            }
        } else {
            this.coolRunStartAt = null;
        }

        // Periodic: long continuous COOL/DRY run → interrupt with a FAN cycle, then resume.
        if (
            this.periodicEnabled &&
            inCoolDry &&
            this.coolRunStartAt !== null &&
            now - this.coolRunStartAt >= this.config.maxCoolRunMs
        ) {
            console.log(`[${this.ac.label}] COOL/DRY ran >= ${this.config.maxCoolRunMs}ms → starting periodic dry cycle.`);
            await this.startDryCycle(now, 'periodic', snap.mode, { OperationMode: OperationMode.Fan });
            return;
        }

        // Post-off: COOL/DRY (on) → off transition → dry, then power off.
        if (
            this.postOffEnabled &&
            this.prev !== null &&
            this.prev.power &&
            isCoolOrDry(this.prev.mode) &&
            !snap.power
        ) {
            console.log(`[${this.ac.label}] switched OFF after COOL/DRY → starting post-off dry cycle.`);
            await this.startDryCycle(now, 'post-off', this.prev.mode, { Power: true, OperationMode: OperationMode.Fan });
            return;
        }

        this.prev = snap;
    }

    private async startDryCycle(
        now: number,
        reason: DryReason,
        restoreMode: number,
        command: { Power?: boolean; OperationMode: number },
    ): Promise<void> {
        const payload = this.config.fanSpeed !== undefined ? { ...command, FanSpeed: this.config.fanSpeed } : command;
        await this.ac.apply(payload);
        this.phase = 'DRYING';
        this.coolRunStartAt = null;
        this.dry = {
            reason,
            startedAt: now,
            endAt: now + this.config.fanDryDurationMs,
            restoreMode,
            confirmed: false,
        };
        // Record what we just asked for so the next tick doesn't read this as a fresh user action.
        this.prev = { power: true, mode: OperationMode.Fan };
    }

    private endDryCycle(now: number, snap: Snapshot): void {
        this.phase = 'MONITORING';
        this.dry = null;
        // Restart run-tracking from a clean slate; the next tick re-derives it from the live state.
        this.coolRunStartAt = null;
        this.prev = snap;
    }

    // How long to wait for our FAN command to take effect before giving up.
    // MELCloud serves Mitsubishi's *cached* cloud state, which can lag reality by a couple of
    // minutes, so this floor is deliberately generous to avoid aborting a command that did land.
    private settleGraceMs(): number {
        return Math.max(this.config.pollIntervalMs * 3, 300000);
    }
}
