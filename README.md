# mitsu-monitor
Simple auto-dry feature for Mitsubishi heat pumps.

Mitsubishi air-source heat pump user manuals state that you should run the FAN mode after using COOL mode, in order to avoid mould growth inside the drum of the unit. There is some sort of auto-dry mode that occurs when switching the device OFF after using COOL mode, but the system does not run FAN for long enough to thoroughly dry the unit internals on extremely hot/humid summer days.

This simple script (made into a massive, lumbering blob thanks to Docker image sizes and the hellscape that is type/javascript development) will utilise a REST server provided by [homebridge-melcloud-control](https://github.com/grzegorz914/homebridge-melcloud-control) to monitor the state of Mitsubishi air conditioner units, and if identifying an OFF event after being previously in COOL, will automatically run FAN mode for 10 minutes, before proceeding to switch the unit OFF.

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

If you have more ata heat pumps then you can modify the script and the dotenv file, to add more monitors.

### Basic docker instructions: 

```
ssh linux_server

>> clone repository
>> cd cloned_repository
cp .env.example .env.local
>> modify .env.local with your server address/port

docker build --no-cache -t helloabunai/mitsu-monitor .
docker run -d --name mitsu-monitor -p 8877:8877 helloabunai/mitsu-monitor:latest
docker logs -f mitsu-monitor
```

### Operation mode map

|   OperationMode  | Meaning |
| -----------------| ------- |
| 1                | Heat    |
| 2                | Dry     |
| 3                | Cool    |
| 7                | Fan     |
| 8                | Auto    |

