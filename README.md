# mitsu-monitor
Simple auto-dry feature for Mitsubishi heat pumps.

Mitsubishi air-source heat pump user manuals state that you should run the FAN mode after using COOL mode, in order to avoid mould growth inside the drum of the unit. There is some sort of auto-dry mode that occurs when switching the device OFF after using COOL mode, but the system does not run FAN for long enough to thoroughly dry the unit internals on extremely hot/humid summer days.

This simple script (made into a massive, lumbering blob thanks to Docker image sizes and the hellscape that is type/javascript development) will utilise a REST server provided by [homebridge-melcloud-control](https://github.com/grzegorz914/homebridge-melcloud-control) to monitor the state of Mitsubishi air conditioner units and automatically run a FAN "dry" cycle. Two behaviours are supported (via `DRY_STRATEGY`), and both are on by default:

- **post-off**: when a unit that was running COOL or DRY is switched OFF (i.e. `Power` goes `true` → `false`, while `OperationMode` persists as COOL/DRY), the monitor turns it back on in FAN mode for the dry duration, then switches it OFF again.
- **periodic**: when a unit has been running COOL/DRY *continuously* for longer than `MAX_COOL_RUN_HOURS`, the monitor interrupts it with a FAN cycle for the dry duration, then resumes the previous COOL/DRY mode (leaving it powered on).

The FAN duration defaults to 15 minutes (`FAN_DRY_DURATION_MS`). If the user manually changes the unit during a dry cycle, the monitor detects this and relinquishes control rather than fighting the user.

Mitsubishi heat pumps for some reason do not provide any local network API to control the units via JSON payload, so as a result we are using the external integration support from homebridge-melcloud-control to achieve this. Obviously because the RESTful API from melcloud-control also relies on Mitsubishi's servers being online to GET/POST information.. if Mitsubishi is offline or your server loses internet connection then this entire script is useless. Great job Mitsubishi for not providing a local mechanism by which to control heat pumps.

Solutions do exist for (some :tm:) local control involve creating custom ESP32 boards plugged into the wifi module socket on the heat pump, but I can't be arsed with that.

This README is purely written for my own notes. If anyone else uses this, then great. But your environment, house and heat-pump situation will be different.

I have written this to support monitoring of two Mitsubishi air-to-air devices at once. Maybe one day I will write code to make this limitation generic. I do not have air-to-water or air-recycle devices and do not plan on supporting them.

## Requirements

- Mitsubishi air-to-air heat pumps
- Homebridge server running homebridge-melcloud-control (3.7.5 or later)
- Docker/Some server to run this monitoring tool

## Setup

### Homebridge-melcloud-control

For homebridge-melcloud-control setup, refer to the README in that repository. It's thorough. Make sure to enable the RESTful external integration in the settings. Use 3.7.5 or later.

### Dotenv details

You will need information from the homebridge-melcloud-control plugin to populate your dotenv file on your machine for this script.

Within Homebridge GUI, navigate to homebridge-melcloud-control and view the JSON config.

You will see information similar to:

```
"ataDevices": [
                {
                    "id": 12340567,
                    ...
```

For each device (in the ataDevices i.e. air-to-air section), note each `id` value. Take the last 4 digits of each ID, these are your PORT values for the dotenv file. If the last 4 digits of your id begins with 0 (like in this example), then replace the 0 with 9. This is to avoid the RESTful server in melcloud-control attempting to assign to UNIX reserved ports under 1000.

In the above example, id `0567` would be used on port `9567`.

If you have more ata heat pumps, set `MONITOR_DEVICES` (a comma-separated `label:port` list) instead of the two legacy `DOWNSTAIRS_PORT` / `UPSTAIRS_PORT` variables — no code changes needed.

### Configuration reference

All configuration is via environment variables (see `.env.example`):

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `HOMEBRIDGE_ADDRESS` | yes | – | IP/host of the melcloud-control RESTful server |
| `MONITOR_DEVICES` | one of these | – | `label:port,label:port` list of units to monitor |
| `DOWNSTAIRS_PORT` / `UPSTAIRS_PORT` | one of these | – | Legacy per-device ports (last 4 digits of the device id) |
| `DRY_STRATEGY` | no | `both` | `post-off`, `periodic`, or `both` |
| `FAN_DRY_DURATION_MS` | no | `900000` (15 min) | How long to run FAN to dry the unit |
| `MAX_COOL_RUN_HOURS` | no | `2` | Continuous COOL/DRY runtime before a periodic dry cycle |
| `POLL_INTERVAL_MS` | no | `60000` | How often each device is polled |
| `FAN_SPEED` | no | (untouched) | Fixed fan speed during the dry cycle (0=Auto, 1-6) |
| `DRY_RUN` | no | `false` | Log the actions that *would* be taken without POSTing |

> **Note:** `DRY_RUN` must be `false` (or unset) for the monitor to actually drive the units. When `true` it only logs state changes, doesn't send actual API reqs. Used for testing.

### Basic docker instructions: 

```
ssh linux_server

>> clone repository
>> cd cloned_repository
cp .env.example .env.local
>> modify .env.local with your server address/port

docker build --no-cache -t helloabunai/mitsu-monitor .
# Config is passed in at runtime (not baked into the image):
docker run -d --name mitsu-monitor --restart unless-stopped --env-file .env.local helloabunai/mitsu-monitor:latest
docker logs -f mitsu-monitor
```

### Rebuilding on a Synology NAS

I run stuff on an old synology box. Rebuilding process is fairly standard. Synology container manager needs root.

```
ssh user@synology
cd /path/to/mitsu-monitor          # wherever you rsync'd or cloned it

# 1. Rebuild the image from the new source
sudo docker build --no-cache -t helloabunai/mitsu-monitor .

# 2. Replace the running container
sudo docker stop mitsu-monitor
sudo docker rm mitsu-monitor

# 3. Start the new one (config still comes in at runtime, not baked into the image)
sudo docker run -d --name mitsu-monitor \
  --restart unless-stopped \
  --env-file .env.local \
  helloabunai/mitsu-monitor:latest

# 4. Confirm it came up cleanly
sudo docker logs -f mitsu-monitor
```

### Operation mode map

|   OperationMode  | Meaning |
| -----------------| ------- |
| 1                | Heat    |
| 2                | Dry     |
| 3                | Cool    |
| 7                | Fan     |
| 8                | Auto    |

