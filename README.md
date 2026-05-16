
<p align="center">

<img src="https://github.com/homebridge/branding/raw/master/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>


# Homebridge AiSEG2 插件

本插件是一个 Homebridge 平台插件,用来控制由 [Panasonic AiSEG2](https://www2.panasonic.biz/ls/densetsu/aiseg/) 控制器接入的设备。

## 支持的设备

| AiSEG2 设备 | 暴露给 HomeKit 的服务 |
| --- | --- |
| Panasonic Advance 系列开关 / 调光灯 | `Lightbulb`(支持调光的设备会自动启用 `Brightness`) |
| 空调 | `HeaterCooler`,并附带室内湿度、室外温度、风量、加湿和扩展模式服务 |
| 电动百叶 / 卷帘 | `WindowCovering` |
| 空气净化器 | `AirPurifier` + 气味 / PM2.5 / ハウスダスト 三个 `AirQualitySensor` + エアミー / 省エネ 两个模式开关 |
| EcoCute(エコキュート,匹配到 ECHONET Lite 后) | 手动沸き上げ `Switch` + 罐 / 给汤 / 风呂 三个 `TemperatureSensor`,设备支持时再加一个 ふろ自動 `Switch` |
| 太阳能 / 蓄电池能量状态 | Solar Surplus / Battery Ready / Battery Discharging / EcoCute Good Time 四个 `OccupancySensor`(按可用性裁剪),以及检测到蓄电池时附带的 `Battery` 服务 |
| 空气环境传感器 | 配对的 `TemperatureSensor` + `HumiditySensor` |
| 电子门锁 | `LockMechanism` |
| 开关 / 窗锁传感器 | `ContactSensor`,可选另加一个只读的锁状态 `ContactSensor` |
| 火灾报警注册 | `SmokeSensor` |

开发和测试基于 MKN704 控制器。如果 MKN705、KMN713 等型号的 Web 界面暴露相同的 AiSEG2 端点,也可能能用。

## 配置

最少需要提供 AiSEG2 Web 界面的登录密码。`host` 可以填一个固定 IP;或者留空 `host` 并开启 `autodiscover`,插件会扫描 Homebridge 主机当前的本地 IPv4 子网。自动发现的结果不会回写到 `config.json`,并且一旦配置了 `host`,`host` 始终优先。

Homebridge 自定义 UI 用比较友好的命名,但底层配置键保持稳定,老的 `config.json` 升级时不需要重写。

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
            "fallbackToAiseg": false
        },
        "energy": {
            "enabled": false,
            "solarSurplusWatts": 2500,
            "batteryReadyPercent": 80,
            "batteryDischargeThresholdWatts": 100
        },
        "statusApi": {
            "enabled": false,
            "port": 18583,
            "bind": "0.0.0.0",
            "publicHost": "",
            "token": "",
            "ecocuteName": "",
            "weatherEnabled": false,
            "latitude": 0,
            "longitude": 0,
            "forecastHours": 3,
            "emergencyHotWaterLiters": 200,
            "nightFallbackTime": "01:00",
            "nightFallbackHotWaterLiters": 350
        },
        "ecocuteSolarAutomation": {
            "enabled": false,
            "dryRun": true,
            "ecocuteName": "",
            "allowedStartTime": "09:30",
            "allowedEndTime": "14:30",
            "minSolarWatts": 2500,
            "minBatteryPercent": 80,
            "minBatteryChargeWatts": 0,
            "nightFallbackTime": "01:00",
            "nightFallbackHotWaterLiters": 350,
            "checkIntervalSeconds": 300,
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

### 自动发现

`autodiscover` 只扫本机:遍历 Homebridge 主机活动的非 Docker 网卡上的私有 IPv4 地址(`lo`、`docker*`、`br-*` 等接口会被跳过),不使用 mDNS 也不会跨 VLAN。每个子网最多扫 254 个主机,扫到的候选并发数为 64。

### Apple Home 服务分组

四个 `group*` 选项使用 HomeKit 的主服务 / 关联服务机制,把相关传感器挂到同一个配件下:

- `groupAirPurifierSensors`:气味、PM2.5、ハウスダスト 和 エアミー/省エネ 模式开关挂到 `AirPurifier` 上
- `groupAirConditionerSensors`:室内湿度、室外温度、风量、加湿和扩展模式服务挂到 `HeaterCooler` 上
- `groupAirEnvironmentSensors`:配对的湿度传感器挂到温度传感器上
- `groupEcocuteServices`:ふろ自動 和三个温度服务挂到手动沸き上げ开关上

空气净化器的 HomeKit Auto 目标态映射到 AirMe (エアミー)模式。省エネ (Eco) 作为单独的模式开关保留。

### 窗锁状态传感器

`exposeContactSensorLockState` 设为 `true` 时,会给上报 `lockVal` 的窗锁传感器再加一个只读 `ContactSensor`:**锁上 = Contact Detected**,**未锁 = Contact Not Detected**。老版本曾用 `LockMechanism`,启动时会自动迁移到 ContactSensor。

### ECHONET Lite 直连

ECHONET Lite 相关有两层开关:

1. `echonetDiscovery` 仅作诊断:启动时打印通过 ECHONET Lite 发现的设备,但不改变控制路径。
2. `echonet.enabled` 真正启用直连。匹配方式:
   - 卷帘、空气净化器、EcoCute 按 EOJ 自动匹配
   - HF-JA1/HF-JA2 门锁:只有当只发现到唯一一个端点时才会自动匹配
   - `echonet.doorLockHosts` 是手动覆盖,只为极少数 HF-JA 多端点歧义场景准备,默认在 UI 里隐藏

`echonet.subnets` 留空就扫本机当前本地 IPv4 子网;也可以传 `192.168.20.0/24` 这种逗号分隔列表(`/24` 到 `/32`),用于跨网段设备。`echonetSubnets` 顶层键仅用于 `echonetDiscovery` 的诊断扫描;两者作用范围不同。

启动和动作日志会显示每个配件用的是 ECHONET Lite 还是 AiSEG2。`echonet.fallbackToAiseg` 只在你希望卷帘、门锁和空气净化器在直连失败时再退回 AiSEG2 时才打开。**EcoCute 没有 AiSEG2 回退路径**——AiSEG2 只用来发现设备名,实际控制必须依赖 ECHONET Lite。

卷帘的精确位置控制仅当端点支持标准的「开度」属性 `0xe1` 时启用。部分卷帘只有定时移动属性 `0xd2`/`0xe9`,插件不会把它们当作精确百分比反馈使用——半开命令仍走 AiSEG2。

### EcoCute

EcoCute 用 AiSEG2 来发现命名的设备,用 ECHONET Lite 拿状态、发命令。HomeKit 暴露:

- **手动沸き上げ** `Switch`:打开后发出手动沸き上げ命令并跟踪「沸き上げ中」状态;关闭时仅在当前正在手动加热时才发停止命令,其他场景下视为无操作,避免误关 AiSEG2 自动运行模式。
- **ふろ自動** `Switch`:仅当 ECHONET 端点支持 EPC `0xe3` 时才暴露,控制并反映「ふろ自動」(保持浴缸有水且保温,直到停止)。
- 三个 `TemperatureSensor`:罐温、给汤温、风呂水温。

罐内剩余热水量、罐容量、自动沸き上げ的时段设置等不在 HomeKit 中暴露,但可通过下面的 Homepage 状态 API 读到。

### 能量状态(`energy`)

`energy.enabled` 打开后,会用 ECHONET Lite 的家庭太阳能(`0x0279`)和蓄电池(`0x027d`)数据生成 Apple Home 服务。由于 Homebridge 不能把原始 W/kWh 功率表上报到 Apple Home,插件改为发布四个派生的 `OccupancySensor` 状态服务:

| 服务 | 何时 Occupied | 阈值 |
| --- | --- | --- |
| Solar Surplus | 实时发电 ≥ 阈值 | `solarSurplusWatts`(默认 2500W) |
| Battery Ready | 电量 ≥ 阈值,且电池未在放电 | `batteryReadyPercent`(默认 80%) |
| Battery Discharging | ECHONET 上报放电,或电池功率 ≤ -阈值 | `batteryDischargeThresholdWatts`(默认 100W) |
| EcoCute Good Time | 同时满足 Solar Surplus + Battery Ready,且当前在 `ecocuteSolarAutomation` 的允许时间窗内 | — |

检测到蓄电池时再附加一个 `Battery` 服务,带电量百分比和充放电状态。原始的 W/kWh 数据会以 debug 级别记录到日志。EcoCute 太阳能自动化即使没开 `energy.enabled` 也能独立读取这些 ECHONET Lite 数据。

### Homepage 状态 API(`statusApi`)

打开 `statusApi.enabled` 会启动一个**只读**本地 HTTP 端点,供 [Homepage](https://gethomepage.dev/) 的 customapi widget 等外部服务读取:

```
GET http://<host>:18583/api/aiseg2/status/<token>
```

- `token` 留空时自动生成并持久化到 Homebridge 存储目录下的 `aiseg2-status-api.json`(权限 0600),生成的完整 URL 会打印到日志。
- 响应包含一次性整合的 EcoCute 状态、太阳能/电池/电网数据、可选的 Open-Meteo 天气预报,以及当下加热计划摘要(`current` / `solar` / `nextSolar` / `emergency` / `nightFallback`),同时提供一个扁平的 `homepage` 字段树,便于直接拼到 widget 里。
- 内置 25 秒的内存缓存,同时去重并发请求。
- 此 API 只产生 JSON 数据,不会在 Apple Home 里多出任何配件。

`emergencyHotWaterLiters`(默认 200L)和 `nightFallback*`(默认 01:00 / 350L)仅用于 Homepage 显示——告知用户剩余热水偏低 / 夜间补热计划状态。**插件不会因为 emergency 阈值触发立即加热**,真正动手的是下面的 EcoCute 自动化。

天气预报字段在 `weatherEnabled` 为 true 且 `latitude`/`longitude` 已设置时填充,使用 Open-Meteo 的短波辐射 / 云量 / 降水概率小时数据;若 `ecocuteSolarAutomation` 已经配置了 lat/lng,这里留空会自动复用。

### EcoCute 太阳能自动化(`ecocuteSolarAutomation`)

`ecocuteSolarAutomation.enabled = true` 时,插件会按 `checkIntervalSeconds`(默认 300s)轮询,在满足条件时**仅发出**手动沸き上げ的 ON 命令——**永远不会发 OFF**,加热的结束完全由 EcoCute 自己决定。前提:必须同时开启 `echonet.enabled` 且 `echonet.preferEcocutes` 为 true,否则只会打 warn 日志。

建议先把 `dryRun` 开着,观察日志里的判定再放行实际动作。

#### 日间太阳能启动

启动条件按顺序检查(任何一条不满足就跳过本次轮询):

1. 当前时间落在 `allowedStartTime`–`allowedEndTime`(默认 09:30–14:30,可跨午夜)
2. 当天本地日期还没启动过太阳能或夜间补热加热(状态持久化到 `aiseg2-ecocute-solar-automation.json`)
3. EcoCute 当前不在加热中
4. 太阳能发电 ≥ `minSolarWatts`(默认 2500W)
5. 蓄电池电量 ≥ `minBatteryPercent`(默认 80%)
6. 蓄电池**没在放电**(硬性条件,不可配置)
7. 若 `minBatteryChargeWatts > 0`,蓄电池充电功率 ≥ 此阈值(默认 0,允许待机 / 低速充电)
8. 若已配置 `latitude`/`longitude`,未来 `forecastHours` 小时的天气满足:
   - 最大短波辐射 ≥ `minForecastRadiationWatts`(默认 350 W/m²)
   - 平均云量 ≤ `maxForecastCloudCover`(默认 85%)
   - 最大降水概率 ≤ `maxForecastPrecipitationProbability`(默认 70%)

> 注:在 `ecocuteSolarAutomation` 这个块下并不存在 `weatherEnabled`——是否启用天气过滤完全取决于 lat/lng 是否被配置成有限且非 (0, 0) 的值。自定义 UI 提供「Get Location」按钮,经用户同意后可用浏览器地理定位填充。

#### 夜间补热(night fallback)

在 `nightFallbackTime`(默认 01:00,日间窗口之外)前后 `checkIntervalSeconds + 60s` 的窗口内,若 EcoCute 不在加热,以下任一成立即触发手动沸き上げ:

- 罐内剩余热水 < `nightFallbackHotWaterLiters`(默认 350L)
- 第二天的太阳能时间窗(由 `allowedStartTime`–`allowedEndTime` 推算)的天气预报被判定为「不够好」——最大辐射 / 平均云量 / 最大降水概率任一超过日间使用的同一组阈值

夜间补热和日间太阳能共享每日一次的状态,记录字段不同(`lastNightFallbackLocalDate` vs `lastStartedLocalDate`),互不重复触发。

### Webhook(`webhook`)

`webhook.enabled = true` 会启动一个带 token 防护的本地 HTTP 端点,常用于 UniFi 指纹开锁等外部触发:

```
POST http://<host>:18582/api/webhook/<token>
```

- `webhook.token` 留空时自动生成并持久化到 `aiseg2-webhook.json`,完整 URL 打印到日志。`webhook.publicHost` 设置时会用它替换 URL 中的主机部分。
- `webhook.method` 可为 `post` / `get` / `any`。默认 `post`;只有触发系统无法发 POST 时才考虑 GET。
- `webhook.action`:
  - `unlock`——总是请求解锁,即便当前已解锁(此时返回 200 并标 `ignored`)
  - `toggle`——按当前锁状态切换。只有指纹一次扫描产生多次回调时才适合用,务必配合下面的冷却。
- `webhook.cooldownSeconds`(默认 5s)用于忽略重复事件:在窗口内的请求返回 202 并标 `ignored=true, reason=cooldown`,防止指纹多次回调把锁切回去。
- 多门锁场景下必须设置 `webhook.doorLockName`;只有一把锁时可以留空。
- 请求体上限 64 KiB,超出会拒绝。

## 未来开发方向

下列 AiSEG2 设备类别在 HomeKit 中存在合理映射,可能后续会加入:

* 呼叫按钮告警
* 配送箱告警
* 电动汽车充电桩
* 燃气热水器
* 抽油烟机
* 地暖
* 电动开窗器
