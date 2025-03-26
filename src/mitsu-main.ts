/*

Mitsu-monitor

Simple mitsubishi air conditioner monitor system to automate
drying mode after running cooling mode in summer.

Packages to do this probably exist already but I was bored.

*/

// Dependencies
const axios = require('axios');
const dotenv = require('dotenv');
const fs = require('fs');

// Types for api response
import { HeatPumpState } from './heatPumpState';

// Env var for homebridge address
if (fs.existsSync('.env.local')) {
    dotenv.config({ path: '.env.local' });
} else {
    dotenv.config();
}

// Individual mitsu unit
class AirConditioner {
    public ipAddress: string;
    public port: number;
    public location: string;

    constructor(ipAddress: string, port: number, location: string) {
        this.ipAddress = ipAddress;
        this.port = port;
        this.location = location
    }

    async getState(): Promise<HeatPumpState> {
        let currentState: HeatPumpState = {} as HeatPumpState;
        try {
            const response = await axios.get(`http://${this.ipAddress}:${this.port}/State`);
            currentState = response.data as HeatPumpState;
        } catch (error) {
            console.error(`Error getting state of AC at ${this.ipAddress}:${this.port}:`, error);
        }
    
        return currentState;
    }

    async setOperationMode(mode: string): Promise<void> {
        // WIP TODO
        try {
            const response = await axios.post(`http://${this.ipAddress}:${this.port}/`, { OperationMode: mode });
            console.log(`Set Operation Mode Response for AC at ${this.ipAddress}:${this.port}:`, response.data);
        } catch (error) {
            console.error(`Error setting operation mode of AC at ${this.ipAddress}:${this.port}:`, error);
        }
    }
}

// Monitor units via melcould-control REST API
class AirConditionerMonitor {
    private airConditioner: AirConditioner;

    constructor(airConditioner: AirConditioner) {
        this.airConditioner = airConditioner;
    }

    startMonitoring(interval: number): void {
        setInterval(async () => {
            let currState: HeatPumpState = {} as HeatPumpState;
            const dryingTime: number = parseInt(process.env.TARGET_DRY_TIME_MS!);

            try {
                currState = await this.airConditioner.getState();
            } catch (error) {
                console.error(`Error monitoring AC at ${this.airConditioner.ipAddress}:${this.airConditioner.port}:`, error);
            }

            console.log(`\n\nCurrent state of AC at ${this.airConditioner.ipAddress}:${this.airConditioner.port}`);
            console.log(`operationMode: `, currState.OperationMode);
            console.log(`RoomTemperature: `, currState.RoomTemperature);
            console.log(`OutdoorTemperature: `, currState.OutdoorTemperature);
            console.log(`FanSpeed: `, currState.FanSpeed);
            console.log(`ActualFanSpeed: `, currState.ActualFanSpeed);

            // do things based on currState here.
            // monitor attribute Power going from true to false, when operationMode is 3 (COOL)
            // when that happens
            //      set power to true
            //      set operationMode to 7
            //      wait process.env.DRY_TIME minutes
            //      set operationMode to 3
            //      set power to false

            console.log(">> do logic here.");
            console.log(">> Target DRY time: ", dryingTime);


        }, interval);
    }
}

// environment details
const homebridgeServer: string = process.env.HOMEBRIDGE_ADDRESS!;
const downstairsPort: number = parseInt(process.env.DOWNSTAIRS_PORT!);
const upstairsPort: number = parseInt(process.env.UPSTAIRS_PORT!);
// create monitor; downstairs
const downstairsAC = new AirConditioner(homebridgeServer, downstairsPort, "downstairsAC");
const downstairsMonitor = new AirConditionerMonitor(downstairsAC);
downstairsMonitor.startMonitoring(15000); // change this to something longer when done developing
// create monitor; upstairs
const upstairsAC = new AirConditioner(homebridgeServer, upstairsPort, "upstairsAC");
const upstairsMonitor = new AirConditionerMonitor(upstairsAC);
upstairsMonitor.startMonitoring(15000); // change this to something longer when done developing

