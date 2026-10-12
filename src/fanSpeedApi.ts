/*

Optional HTTP API for setting fan speed only (used during heating season from apple shortcut/lazy dev)

  POST /fan-speed
       Authorization: Bearer <FAN_SPEED_API_TOKEN>
       body: {"speed": 3}      (0 = Auto, 1-5)
*/

import * as crypto from 'crypto';
import * as http from 'http';

import { AirConditioner } from './airConditioner';
import { FanSpeedApiConfig } from './config';

const MAX_FAN_SPEED = 5;
const MAX_BODY_BYTES = 4096;

export function parseSpeed(body: string): number | null {
    let speed: unknown;
    try {
        speed = JSON.parse(body)?.speed;
    } catch {
        return null;
    }
    const n = typeof speed === 'string' && speed.trim() !== '' ? Number(speed) : speed;
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_FAN_SPEED ? n : null;
}

function isAuthorized(req: http.IncomingMessage, token: string): boolean {
    const actual = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function reply(res: http.ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(message);
}

export function startFanSpeedApi(api: FanSpeedApiConfig, ac: AirConditioner): http.Server {
    const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
        if (!isAuthorized(req, api.token)) {
            console.warn(`[fan-speed-api] rejected unauthorized ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
            reply(res, 401, 'Not authorized.');
            return;
        }

        if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/fan-speed') {
            reply(res, 404, 'Unknown command.');
            return;
        }
        if (req.method !== 'POST') {
            reply(res, 405, 'Use POST to set the fan speed.');
            return;
        }

        const body = await readBody(req);
        const speed = parseSpeed(body);
        if (speed === null) {
            console.warn(`[fan-speed-api] ${ac.label}: no valid fan speed in body ${JSON.stringify(body)}`);
            reply(res, 400, `Speed must be 0 to ${MAX_FAN_SPEED}, where 0 is auto.`);
            return;
        }

        console.log(`[fan-speed-api] ${ac.label}: set fan speed ${speed}`);
        if (!(await ac.apply({ FanSpeed: speed }))) {
            reply(res, 502, "Couldn't reach the heat pump.");
            return;
        }
        reply(res, 200, `Fan set to ${speed === 0 ? 'auto' : speed}.`);
    };

    const server = http.createServer((req, res) => {
        handle(req, res).catch((error) => {
            console.error(`[fan-speed-api] error handling ${req.method} ${req.url}: ${error instanceof Error ? error.message : String(error)}`);
            if (!res.headersSent) {
                reply(res, 500, 'Something went wrong.');
            }
        });
    });
    // A broken fan speed API (e.g. port already taken) must not take the main feature (auto-dry) monitors down with it.
    server.on('error', (error) => {
        console.error(`[fan-speed-api] server error on :${api.port}: ${error.message} — fan speed API unavailable.`);
    });
    server.listen(api.port, () => {
        console.log(`[fan-speed-api] listening on :${api.port}, setting fan speed for ${ac.label}`);
    });
    return server;
}
