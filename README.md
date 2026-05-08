
<p align="center">

<img src="https://github.com/homebridge/branding/raw/master/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>


# Homebridge AiSEG2 Plugin

 A Homebridge platform plugin to control devices managed by a [Panasonic AiSEG2](https://www2.panasonic.biz/ls/densetsu/aiseg/) controller.

This plugin supports the following AiSEG2 devices:

* Panasonic Advance Series light switches as HomeKit Lightbulb accessories
* AiSEG2 air conditioners as HomeKit Thermostat accessories
* AiSEG2 shutters as HomeKit Window Covering accessories
* AiSEG2 air purifiers as HomeKit Air Purifier accessories with separate automatic-mode switches and odor, PM2.5, and house dust Air Quality Sensor services
* AiSEG2 air environment sensors as HomeKit Temperature Sensor and Humidity Sensor services
* AiSEG2 electric door locks as HomeKit Lock Mechanism accessories
* AiSEG2 open/close and window lock sensors as HomeKit Contact Sensor accessories
* AiSEG2 fire alarm registrations as HomeKit Smoke Sensor accessories

Air conditioner support currently provides reliable power/status and temperature reporting. Advanced mode, target temperature, and fan
setting writes need more controller-specific testing.

All development and testing has been performed using an MKN704 controller. It is likely that the code will also work with the MKN705 and KMN713 controllers.

## Configuration

To configure the plugin the hostname or IP address of the controller will need to be supplied as well as the password used to login to the web interface. _Autodiscovery of controllers is not yet implemented._

    "platforms": [{
        "name": "AiSEG2",
        "autodiscover": false,
        "host": "<controller IP address>",
        "password": "<controller password>",
        "platform": "AiSEG2"
    }]

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
