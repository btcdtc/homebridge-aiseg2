
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
        "exposeContactSensorLockState": false,
        "echonetDiscovery": false,
        "echonetSubnets": "",
        "echonet": {
            "enabled": false,
            "subnets": "192.168.20.0/24",
            "preferShutters": true,
            "preferDoorLocks": true,
            "preferAirPurifiers": true,
            "doorLockHosts": {}
        },
        "platform": "AiSEG2"
    }]

Auto discovery is intentionally local-only: it scans private IPv4 addresses on the Homebridge machine's active non-Docker
interfaces and does not use mDNS or cross-VLAN routing.

Grouping options use HomeKit primary/linked services so related measurements stay associated with the same accessory. Air purifiers
link odor, PM2.5, house dust, and AirMe/Eco mode switches to the purifier service. Air conditioners link indoor humidity, outdoor
temperature, fan, humidity, and extra mode services to the heater cooler service. Air environment sensors link humidity to the
paired temperature service.

For air purifiers with AirMe/Eco automatic modes, HomeKit's generic Auto target maps to AirMe by default. Eco remains available as
a separate mode switch.

Set `exposeContactSensorLockState` to `true` to add a read-only Contact Sensor service to window lock sensors that report
`lockVal`. Locked is reported as contact detected, and unlocked is reported as contact not detected.

Set `echonetDiscovery` to `true` to log ECHONET Lite devices visible from the Homebridge host. Leave `echonetSubnets` empty to scan
the host's current local IPv4 subnets, or set a comma-separated list such as `192.168.20.0/24` for routed device networks. This
top-level discovery option is diagnostic; `echonet.enabled` below also runs discovery and uses matched endpoints for direct control.

Set `echonet.enabled` to `true` to prefer direct ECHONET Lite control for devices that can be matched automatically. AiSEG2 still
provides the accessory names and remains the fallback path. Shutters and air purifiers are matched by EOJ after ECHONET discovery;
HF-JA1/HF-JA2 door locks are matched automatically when exactly one endpoint is found. Use `echonet.doorLockHosts` only if multiple
door lock endpoints exist. Startup and action logs show whether each accessory uses ECHONET Lite or AiSEG2.

Direct shutter position control is used only when the ECHONET endpoint advertises the standard degree-of-opening property (`0xe1`).
Some shutters expose timed movement (`0xd2`/`0xe9`) instead; the plugin does not treat that as exact percentage feedback and keeps
AiSEG2 as the fallback for half-open commands.

## Future Development

Additional AiSEG2 device classes may be added where HomeKit has a reasonable mapping:

* Call button alerts
* Delivery box alerts
* EcoCute heat pump water systems
* EV chargers
* Gas hot water systems
* Rangehoods
* Under floor heaters
* Window sashes
