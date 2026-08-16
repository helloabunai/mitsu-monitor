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
import { HeatPumpState } from './heatPumpState';

type Phase = 'MONITORING' | 'DRYING';

type DryReason = 'post-off' | 'periodic';

// A single flaky /state read (MELCloud serves cached state) must not be mistaken for a
// user takeover. Require this many *consecutive* non-FAN reads, after we've confirmed FAN,
// before we relinquish control.
const RELINQUISH_AFTER_MISSED = 2;

interface DryCycle {
    reason: DryReason;
    startedAt: number;
    endAt: number;
    // Mode to restore when a periodic cycle completes.
    restoreMode: number;
    // Set true once the device has confirmed it is actually in FAN mode.
    confirmed: boolean;
    // Consecutive non-FAN reads observed since FAN was last confirmed (debounces flaky reads).
    missedFan: number;
}

interface Snapshot {
    power: boolean;
    mode: number;
}

function describeSnap(snap: Snapshot): string {
    const mode = OperationMode[snap.mode] ?? String(snap.mode);
    return snap.power ? mode : `off(${mode})`;
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
    // Set once we've seen the unit sitting in FAN that we did not put there. A user choosing FAN
    // is an explicit instruction to leave the unit alone, so it suppresses the periodic trigger.
    private manualFan = false;
    // Epoch ms at which the periodic threshold was first crossed (null when not armed). See
    // confirmWindowMs() for why crossing the threshold does not fire a cycle on its own.
    private armedAt: number | null = null;
    // FAN readings before this instant are the lagging tail of our own dry cycle, not a user action.
    private selfFanUntil = 0;
    // Last state observed, used only by the transition audit below.
    private lastSeen: Snapshot | null = null;
    // Observations before this instant may still be echoing a write we made ourselves.
    private ourWriteUntil = 0;

    // Re-entrancy guard: a tick's I/O can outlast the poll interval, and setInterval does not
    // wait for the previous callback. Without this, overlapping ticks could double-fire commands.
    private ticking = false;
    private stopped = false;
    private timer: ReturnType<typeof setInterval> | null = null;

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
        this.timer = setInterval(() => void this.tick(), this.config.pollIntervalMs);
    }

    // Stops polling and, if a dry cycle is in flight, finalizes it so we never leave a unit
    // parked in FAN when the process is asked to exit (e.g. `docker stop` -> SIGTERM).
    async shutdown(): Promise<void> {
        this.stopped = true;
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.phase === 'DRYING' && this.dry !== null) {
            const cycle = this.dry;
            console.log(`[${this.ac.label}] shutting down mid dry-cycle — finalizing.`);
            if (cycle.reason === 'post-off') {
                await this.ac.apply({ Power: false });
            } else {
                await this.ac.apply({ OperationMode: cycle.restoreMode });
            }
        }
    }

    private async tick(): Promise<void> {
        // Skip this beat if the previous tick is still running, or we're shutting down.
        if (this.ticking || this.stopped) {
            return;
        }
        this.ticking = true;
        try {
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

            this.auditTransition(now, snap, state);

            if (this.phase === 'DRYING') {
                await this.tickDrying(now, snap);
            } else {
                await this.tickMonitoring(now, snap, inCoolDry);
            }
        } finally {
            this.ticking = false;
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
                cycle.missedFan = 0;
            } else if (cycle.confirmed) {
                // We had FAN and now we don't. Tolerate a flaky read or two before concluding the
                // user (or something else) took over; only relinquish after it persists.
                cycle.missedFan += 1;
                if (cycle.missedFan >= RELINQUISH_AFTER_MISSED) {
                    console.log(`[${this.ac.label}] user intervened during dry cycle — relinquishing control.`);
                    this.endDryCycle(now, snap);
                    return;
                }
            } else if (now - cycle.startedAt > this.settleGraceMs()) {
                // Our command never took effect. Give up rather than hang in DRYING forever.
                console.warn(`[${this.ac.label}] device never entered FAN mode — aborting dry cycle.`);
                this.endDryCycle(now, snap);
                return;
            }
        }

        if (now >= cycle.endAt) {
            // Only leave DRYING once the completion command actually lands; otherwise a failed POST
            // would strand the unit in FAN. Stay put and retry on the next tick.
            let ok: boolean;
            if (cycle.reason === 'post-off') {
                ok = await this.ac.apply({ Power: false });
                if (ok) console.log(`[${this.ac.label}] dry cycle complete → powered off.`);
            } else {
                ok = await this.ac.apply({ OperationMode: cycle.restoreMode });
                if (ok) console.log(`[${this.ac.label}] dry cycle complete → resumed ${OperationMode[cycle.restoreMode] ?? cycle.restoreMode}.`);
            }
            if (!ok) {
                console.warn(`[${this.ac.label}] dry cycle completion command failed — retrying next tick.`);
                return;
            }
            this.ourWriteUntil = now + this.confirmWindowMs();
            this.endDryCycle(now, snap);
        }
    }

    private async tickMonitoring(now: number, snap: Snapshot, inCoolDry: boolean): Promise<void> {
        this.trackManualFan(now, snap);

        // Track how long we've been continuously cooling/drying.
        if (inCoolDry) {
            if (this.coolRunStartAt === null) {
                this.coolRunStartAt = now;
            }
        } else {
            this.coolRunStartAt = null;
        }

        // Periodic: long continuous COOL/DRY run → interrupt with a FAN cycle, then resume.
        const due =
            this.periodicEnabled &&
            inCoolDry &&
            !this.manualFan &&
            this.coolRunStartAt !== null &&
            now - this.coolRunStartAt >= this.config.maxCoolRunMs;

        if (!due) {
            // Left COOL/DRY (or the user took FAN) before the window elapsed.
            this.armedAt = null;
        } else if (this.armedAt === null) {
            this.armedAt = now;
            console.log(
                `[${this.ac.label}] COOL/DRY ran >= ${this.config.maxCoolRunMs}ms → ` +
                    `confirming for ${this.confirmWindowMs()}ms before starting a dry cycle.`,
            );
        } else if (now - this.armedAt >= this.confirmWindowMs()) {
            console.log(`[${this.ac.label}] still COOL/DRY after confirmation window → starting periodic dry cycle.`);
            // `armedAt` is cleared by endDryCycle, so a failed start simply retries on the next tick.
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

    // Logs every observed power/mode transition and whether we asked for it
    private auditTransition(now: number, snap: Snapshot, state: HeatPumpState): void {
        const before = this.lastSeen;
        this.lastSeen = snap;
        if (before === null || (before.power === snap.power && before.mode === snap.mode)) {
            return;
        }
        const origin = now < this.ourWriteUntil ? 'ours' : 'EXTERNAL';
        console.log(
            `[${this.ac.label}] MODE CHANGE ${describeSnap(before)} -> ${describeSnap(snap)} (${origin}) ` +
                `EffectiveFlags=${state.EffectiveFlags} LastEffectiveFlags=${state.LastEffectiveFlags} ` +
                `FanSpeed=${state.FanSpeed} SetTemperature=${state.SetTemperature}`,
        );
    }

    // the user put this unit in FAN, leave it there
    private trackManualFan(now: number, snap: Snapshot): void {
        const inFan = snap.power && snap.mode === OperationMode.Fan;
        if (inFan) {
            if (!this.manualFan && now >= this.selfFanUntil) {
                console.log(`[${this.ac.label}] FAN set outside our control — holding off until the mode changes.`);
                this.manualFan = true;
            }
        } else if (this.manualFan) {
            console.log(
                `[${this.ac.label}] manual FAN ended (now ${OperationMode[snap.mode] ?? snap.mode}, ` +
                    `power=${snap.power}) — resuming normal monitoring.`,
            );
            this.manualFan = false;
        }
    }

    private async startDryCycle(
        now: number,
        reason: DryReason,
        restoreMode: number,
        command: { Power?: boolean; OperationMode: number },
    ): Promise<void> {
        const payload = this.config.fanSpeed !== undefined ? { ...command, FanSpeed: this.config.fanSpeed } : command;
        const ok = await this.ac.apply(payload);
        if (!ok) {
            // Don't enter DRYING on a command we couldn't send. Leaving `prev`/`coolRunStartAt`
            // untouched means the same trigger re-fires next tick, so the start naturally retries.
            console.warn(`[${this.ac.label}] failed to start ${reason} dry cycle — retrying next tick.`);
            return;
        }
        this.ourWriteUntil = now + this.confirmWindowMs();
        this.phase = 'DRYING';
        this.coolRunStartAt = null;
        this.dry = {
            reason,
            startedAt: now,
            endAt: now + this.config.fanDryDurationMs,
            restoreMode,
            confirmed: false,
            missedFan: 0,
        };
        // Record what we just asked for so the next tick doesn't read this as a fresh user action.
        this.prev = { power: true, mode: OperationMode.Fan };
    }

    private endDryCycle(now: number, snap: Snapshot): void {
        this.phase = 'MONITORING';
        this.dry = null;
        // Restart run-tracking from a clean slate; the next tick re-derives it from the live state.
        this.coolRunStartAt = null;
        this.armedAt = null;
        // Our own FAN will keep coming back from the cache for a while yet; don't read it as the user.
        this.manualFan = false;
        this.selfFanUntil = now + this.confirmWindowMs();
        this.prev = snap;
    }

    // How long to wait for our FAN command to take effect before giving up.
    // MELCloud serves Mitsubishi's *cached* cloud state, which can lag reality by a couple of
    // minutes, so this floor is deliberately generous to avoid aborting a command that did land.
    private settleGraceMs(): number {
        return Math.max(this.config.pollIntervalMs * 3, 300000);
    }

    // How long the unit must keep reading COOL/DRY after crossing maxCoolRunMs before we act on it.
    private confirmWindowMs(): number {
        return Math.max(this.config.pollIntervalMs * 3, 180000);
    }
}
