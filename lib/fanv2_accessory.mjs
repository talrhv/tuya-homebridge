"use strict";

import BaseAccessory from "./base_accessory.mjs";

const DEFAULT_SPEED_COUNT = 3;

class Fanv2Accessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;
    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.FAN,
      Service.Fanv2,
    );

    this.statusArr = deviceConfig.status || [];
    this.functionArr = deviceConfig.functions || [];

    // אתחול משתני עזר לטויה
    this.switchMap = null;
    this.modeMap = null;
    this.lockMap = null;
    this.directionMap = null;
    this.speedMap = null;
    this.swingMap = null;
    this.switchLed = null;
    this.brightValue = null;

    // תמיכה בתאורת המאוורר
    this.addLightService();

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  addLightService() {
    const { Service, Characteristic } = this.platform.api.hap;
    // מחפשים אם יש DP של תאורה במכשיר
    const hasLight = this.statusArr.some(
      (item) => item.code === "light" && typeof item.value === "boolean",
    );

    if (hasLight) {
      this.lightService =
        this.homebridgeAccessory.getService(Service.Lightbulb) ||
        this.homebridgeAccessory.addService(
          Service.Lightbulb,
          this.deviceConfig.name + " Light",
        );

      this.lightService.setCharacteristic(
        Characteristic.Name,
        this.deviceConfig.name + " Light",
      );
    }
  }

  initStatus() {
    const { Characteristic } = this.platform.api.hap;
    const service = this.service;

    // --- Fan Active (On/Off) ---
    service
      .getCharacteristic(Characteristic.Active)
      .onGet(() =>
        this.switchMap?.value
          ? Characteristic.Active.ACTIVE
          : Characteristic.Active.INACTIVE,
      )
      .onSet(async (value) => {
        await this.sendTuyaCommand(Characteristic.Active, value);
      });

    // --- Target Fan State (Auto/Manual) ---
    if (this.modeMap) {
      service
        .getCharacteristic(Characteristic.TargetFanState)
        .onGet(() =>
          this.modeMap.value === "smart"
            ? Characteristic.TargetFanState.AUTO
            : Characteristic.TargetFanState.MANUAL,
        )
        .onSet(async (value) => {
          await this.sendTuyaCommand(Characteristic.TargetFanState, value);
        });
    }

    // --- Rotation Speed ---
    if (this.speedMap) {
      service
        .getCharacteristic(Characteristic.RotationSpeed)
        .onGet(() => this._tuyaSpeedToHbPercentage())
        .onSet(async (value) => {
          await this.sendTuyaCommand(Characteristic.RotationSpeed, value);
        });
    }

    // --- Lock / Direction / Swing ---
    if (this.lockMap) {
      service
        .getCharacteristic(Characteristic.LockPhysicalControls)
        .onGet(() => (this.lockMap.value ? 1 : 0))
        .onSet(
          async (value) =>
            await this.sendTuyaCommand(
              Characteristic.LockPhysicalControls,
              value,
            ),
        );
    }

    if (this.directionMap) {
      service
        .getCharacteristic(Characteristic.RotationDirection)
        .onGet(() => (this.directionMap.value === "forward" ? 0 : 1))
        .onSet(
          async (value) =>
            await this.sendTuyaCommand(Characteristic.RotationDirection, value),
        );
    }

    if (this.swingMap) {
      service
        .getCharacteristic(Characteristic.SwingMode)
        .onGet(() => (this.swingMap.value ? 1 : 0))
        .onSet(
          async (value) =>
            await this.sendTuyaCommand(Characteristic.SwingMode, value),
        );
    }

    // --- Light Service Handlers ---
    if (this.lightService) {
      this.lightService
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.switchLed?.value || false)
        .onSet(
          async (value) => await this.sendTuyaCommand(Characteristic.On, value),
        );

      if (this.brightValue) {
        this.lightService
          .getCharacteristic(Characteristic.Brightness)
          .onGet(() => {
            const range = this.getBrightnessFunctionRange(
              this.brightValue.code,
            );
            return Math.floor(
              ((this.brightValue.value - range.min) * 100) /
                (range.max - range.min),
            );
          })
          .onSet(
            async (value) =>
              await this.sendTuyaCommand(Characteristic.Brightness, value),
          );
      }
    }
  }

  async sendTuyaCommand(characteristic, value) {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    try {
      const param = this.getSendParam(characteristic, value);
      await this.platform.tuyaOpenApi.sendCommand(this.deviceId, param);
    } catch (error) {
      this.log.error(`[SET] Failed to set ${characteristic.name}:`, error);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    for (const statusMap of statusArr) {
      switch (statusMap.code) {
        case "switch":
        case "fan_switch":
        case "switch_fan":
          this.switchMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.Active)
            .updateValue(statusMap.value ? 1 : 0);
          break;
        case "mode":
          this.modeMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.TargetFanState)
            .updateValue(statusMap.value === "smart" ? 1 : 0);
          break;
        case "fan_speed":
        case "fan_speed_percent":
          this.speedMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.RotationSpeed)
            .updateValue(this._tuyaSpeedToHbPercentage());
          break;
        case "light":
          this.switchLed = statusMap;
          this.lightService
            ?.getCharacteristic(Characteristic.On)
            .updateValue(statusMap.value);
          break;
        case "bright_value":
          this.brightValue = statusMap;
          // עדכון בהירות ב-Refresh (MQTT)
          break;
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  // לוגיקת המרה של מהירות (Backend logic)
  _tuyaSpeedToHbPercentage() {
    if (!this.speedMap) return 0;
    const rawValue = this.speedMap.value;

    if (typeof rawValue === "string") {
      const count = this.getSpeedFunctionLevel(this.speedMap.code);
      return Math.floor(parseInt(rawValue) * (100 / count));
    }

    const range = this.getSpeedFunctionRange(this.speedMap.code);
    return Math.floor(((rawValue - range.min) * 100) / (range.max - range.min));
  }

  getSendParam(name, hbValue) {
    const { Characteristic } = this.platform.api.hap;
    let code, value;

    switch (name) {
      case Characteristic.Active:
        code = this.switchMap.code;
        value = Boolean(hbValue);
        break;
      case Characteristic.RotationSpeed:
        code = this.speedMap.code;
        if (typeof this.speedMap.value === "string") {
          const count = this.getSpeedFunctionLevel(code);
          value = String(
            Math.min(count, Math.floor(hbValue / (100 / count)) + 1),
          );
        } else {
          const range = this.getSpeedFunctionRange(code);
          value = Math.floor(
            (hbValue * (range.max - range.min)) / 100 + range.min,
          );
        }
        break;
      case Characteristic.On:
        code = "light";
        value = Boolean(hbValue);
        break;
      // ... (שאר המקרים ימופו באותו אופן ל-code/value) ...
    }
    return { commands: [{ code, value }] };
  }

  getSpeedFunctionRange(code) {
    const func = this.functionArr.find((f) => f.code === code);
    if (func) {
      const range = JSON.parse(func.values);
      return { min: parseInt(range.min) || 1, max: parseInt(range.max) || 100 };
    }
    return { min: 1, max: 100 };
  }

  getSpeedFunctionLevel(code) {
    const func = this.functionArr.find((f) => f.code === code);
    if (func) {
      const val = JSON.parse(func.values);
      return val.range ? val.range.length : DEFAULT_SPEED_COUNT;
    }
    return DEFAULT_SPEED_COUNT;
  }

  getBrightnessFunctionRange(code) {
    const func = this.functionArr.find((f) => f.code === code);
    if (func) {
      const range = JSON.parse(func.values);
      return {
        min: parseInt(range.min) || 10,
        max: parseInt(range.max) || 1000,
      };
    }
    return { min: 10, max: 1000 };
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default Fanv2Accessory;
