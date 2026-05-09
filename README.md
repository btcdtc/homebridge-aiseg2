
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

All development and testing has been performed using an MKN704 controller. It is likely that the code will also work with the MKN705 and KMN713 controllers.

## No Support

This is a personal, vibe-coded Homebridge plugin. No support is provided. If you run into issues, fork it, debug it, and vibe code the fix yourself.

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
