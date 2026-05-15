
<p align="center">

<img src="https://github.com/homebridge/branding/raw/master/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>


# Homebridge AiSEG2 Plugin

 A Homebridge platform plugin to control devices managed by a [Panasonic AiSEG2](https://www2.panasonic.biz/ls/densetsu/aiseg/) controller.

This plugin supports the following AiSEG2 devices:

* Panasonic Advance Series light switches as HomeKit Lightbulb accessories
* AiSEG2 air conditioners as HomeKit Heater Cooler accessories with indoor humidity, outdoor temperature, fan, humidity, and extra mode services
* AiSEG2 shutters as HomeKit Window Covering accessories
* AiSEG2 air purifiers as HomeKit Air Purifier accessories with separate AirMe/Eco mode switches and odor, PM2.5, and house dust Air Quality Sensor services
* AiSEG2 EcoCute heat pump water systems as HomeKit Switch and Temperature Sensor services when matched to ECHONET Lite
* AiSEG2 solar/storage battery status as Apple Home-compatible status sensors, with optional EcoCute solar automation
* AiSEG2 air environment sensors as HomeKit Temperature Sensor and Humidity Sensor services
* AiSEG2 electric door locks as HomeKit Lock Mechanism accessories
* AiSEG2 open/close and window lock sensors as HomeKit Contact Sensor accessories, optionally with read-only lock-state Contact Sensor services
* AiSEG2 fire alarm registrations as HomeKit Smoke Sensor accessories

Development and testing has been performed using an MKN704 controller. The MKN705 and KMN713 controllers may also work if their web
interfaces expose the same AiSEG2 endpoints.

## Configuration

To configure the plugin, supply the password used to login to the AiSEG2 web interface. Set `host` for a fixed controller IP, or
leave `host` empty with `autodiscover` enabled to scan the Homebridge host's current local IPv4 subnets. Auto discovery does not
write the discovered address back to `config.json`, and a configured `host` always takes precedence.

    "platforms": [{
        "name": "AiSEG2",
        "autodiscover": false,
        "host": "<controller IP address>",
        "password": "<controller password>",
        "groupAirPurifierSensors": true,
        "groupAirConditionerSensors": true,
        "groupAirEnvironmentSensors": true,
        "groupEcocuteServices": true,
        "exposeContactSensorLockState": false,
        "echonetDiscovery": false,
        "echonetSubnets": "",
        "echonet": {
            "enabled": false,
            "subnets": "192.168.20.0/24",
            "preferShutters": true,
            "preferDoorLocks": true,
            "preferAirPurifiers": true,
            "preferEcocutes": true,
            "fallbackToAiseg": false,
            "doorLockHosts": {}
        },
        "energy": {
            "enabled": false,
            "exposeStatusSensors": true,
            "solarSurplusWatts": 2500,
            "batteryReadyPercent": 80,
            "batteryDischargeThresholdWatts": 100
        },
        "ecocuteSolarAutomation": {
            "enabled": false,
            "dryRun": true,
            "ecocuteName": "",
            "allowedStartTime": "09:30",
            "allowedEndTime": "14:30",
            "minSolarWatts": 2500,
            "minBatteryPercent": 80,
            "requireBatteryNotDischarging": true,
            "minBatteryChargeWatts": 0,
            "oncePerDay": true,
            "cooldownHours": 18,
            "checkIntervalSeconds": 300,
            "weatherEnabled": false,
            "latitude": 0,
            "longitude": 0,
            "forecastHours": 3,
            "minForecastRadiationWatts": 350,
            "maxForecastCloudCover": 85,
            "maxForecastPrecipitationProbability": 70
        },
        "webhook": {
            "enabled": false,
            "port": 18582,
            "bind": "0.0.0.0",
            "publicHost": "",
            "token": "",
            "method": "post",
            "action": "unlock",
            "doorLockName": "",
            "cooldownSeconds": 5
        },
        "platform": "AiSEG2"
    }]

Auto discovery is intentionally local-only: it scans private IPv4 addresses on the Homebridge machine's active non-Docker
interfaces and does not use mDNS or cross-VLAN routing.

Grouping options use HomeKit primary/linked services so related measurements stay associated with the same accessory. Air purifiers
link odor, PM2.5, house dust, and AirMe/Eco mode switches to the purifier service. Air conditioners link indoor humidity, outdoor
temperature, fan, humidity, and extra mode services to the heater cooler service. Air environment sensors link humidity to the
paired temperature service. EcoCute devices link automatic bath and temperature services to the manual water-heating switch.

For air purifiers with AirMe/Eco automatic modes, HomeKit's generic Auto target maps to AirMe by default. Eco remains available as
a separate mode switch.

Set `exposeContactSensorLockState` to `true` to add a read-only Contact Sensor service to window lock sensors that report
`lockVal`. Locked is reported as contact detected, and unlocked is reported as contact not detected.

Set `echonetDiscovery` to `true` to log ECHONET Lite devices visible from the Homebridge host. Leave `echonetSubnets` empty to scan
the host's current local IPv4 subnets, or set a comma-separated list such as `192.168.20.0/24` for routed device networks. This
top-level discovery option is diagnostic; `echonet.enabled` below also runs discovery and uses matched endpoints for direct control.

Set `echonet.enabled` to `true` to prefer direct ECHONET Lite control for devices that can be matched automatically. AiSEG2 still
provides the accessory names. Shutters, air purifiers, and EcoCute devices are matched by EOJ after ECHONET discovery; HF-JA1/HF-JA2
door locks are matched automatically when exactly one endpoint is found. Use `echonet.doorLockHosts` only if multiple door lock
endpoints exist. Startup and action logs show whether each accessory uses ECHONET Lite or AiSEG2. Set `echonet.fallbackToAiseg` to
`true` only if you want shutters, door locks, and air purifiers to retry through AiSEG2 when direct ECHONET Lite fails.

Direct shutter position control is used only when the ECHONET endpoint advertises the standard degree-of-opening property (`0xe1`).
Some shutters expose timed movement (`0xd2`/`0xe9`) instead; the plugin does not treat that as exact percentage feedback and keeps
AiSEG2 as the fallback for half-open commands.

EcoCute support uses AiSEG2 only to discover the named water heater and ECHONET Lite for status/control. The manual water-heating
HomeKit switch turns on while manual water heating is active; turning it off sends the water-heating stop command. The automatic bath
switch controls and reflects `ふろ自動`, which keeps the bath filled/warm until stopped. Automatic tank heating settings are not
exposed in HomeKit.

Set `energy.enabled` to `true` to read ECHONET Lite household solar generation (`0x0279`) and storage battery (`0x027d`) data.
Apple Home does not expose raw W/kWh power meters through Homebridge, so the plugin publishes derived Contact Sensor-style services:
Solar Surplus, Battery Ready, Battery Discharging, and EcoCute Good Time. These are intended for Apple Home visibility and
automations; raw values are logged at debug level.

Set `ecocuteSolarAutomation.enabled` to `true` to allow the plugin to start EcoCute manual water heating when the configured solar,
battery, weather, and time-window conditions are met. This automation only sends the manual water-heating ON command; it never sends
OFF, so EcoCute completes or stops the heating cycle using its own controls. Keep `dryRun` enabled first to verify the log decisions
before allowing active control. Weather gating uses Open-Meteo forecast data when `weatherEnabled` is true and `latitude`/`longitude`
are configured.

Set `webhook.enabled` to `true` to start a token-protected HTTP endpoint for external triggers such as UniFi fingerprint events.
The endpoint accepts `/api/webhook/<token>` on `webhook.port`; leave `webhook.token` empty to auto-generate and persist one. The
generated URL is printed in the Homebridge log, using `webhook.publicHost` when set. `webhook.method` can be `post`, `get`, or
`any`; POST is the safer default, and GET should be used only when the triggering system cannot send POST. `webhook.action` can be
`unlock` or `toggle`; use `unlock` for fingerprint unlock-only behavior, and `toggle` only when duplicate events are controlled by
`webhook.cooldownSeconds`.

## Future Development

Additional AiSEG2 device classes may be added where HomeKit has a reasonable mapping:

* Call button alerts
* Delivery box alerts
* EV chargers
* Gas hot water systems
* Rangehoods
* Under floor heaters
* Window sashes
