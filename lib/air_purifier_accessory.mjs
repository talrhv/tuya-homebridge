"use strict";

import BaseAccessory from "./base_accessory.mjs";

const DEFAULT_SPEED_COUNT = 3;

class AirPurifierAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;
    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.AIR_PURIFIER,
      Service.AirPurifier,
    );

    this.statusArr = deviceConfig.status || [];
    this.functionArr = deviceConfig.functions || [];

    // חישוב מהירות המאוורר (Backend Logic)
    this.speed_count = this.getSpeedFunctionCount("speed");
    this.speed_coefficient = 100 / this.speed_count;

    // משתני עזר למפות את ה-DPs של טויה
    this.switchMap = null;
    this.modeMap = null;
    this.lockMap = null;
    this.speedMap = null;

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    const { Characteristic } = this.platform.api.hap;
    const service = this.service;

    // --- Active (On/Off) ---
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

    // --- Current State (מצב נוכחי - קריאה בלבד) ---
    service
      .getCharacteristic(Characteristic.CurrentAirPurifierState)
      .onGet(() =>
        this.switchMap?.value
          ? Characteristic.CurrentAirPurifierState.PURIFYING_AIR
          : Characteristic.CurrentAirPurifierState.INACTIVE,
      );

    // --- Target State (Auto / Manual) ---
    if (this.modeMap) {
      service
        .getCharacteristic(Characteristic.TargetAirPurifierState)
        .onGet(() =>
          this.modeMap.value === "auto"
            ? Characteristic.TargetAirPurifierState.AUTO
            : Characteristic.TargetAirPurifierState.MANUAL,
        )
        .onSet(async (value) => {
          await this.sendTuyaCommand(
            Characteristic.TargetAirPurifierState,
            value,
          );
        });
    }

    // --- Lock (נעילת ילדים) ---
    if (this.lockMap) {
      service
        .getCharacteristic(Characteristic.LockPhysicalControls)
        .onGet(() =>
          this.lockMap.value
            ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED
            : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED,
        )
        .onSet(async (value) => {
          await this.sendTuyaCommand(
            Characteristic.LockPhysicalControls,
            value,
          );
        });
    }

    // --- Rotation Speed (מהירות מאוורר באחוזים) ---
    if (this.speedMap) {
      service
        .getCharacteristic(Characteristic.RotationSpeed)
        .onGet(() => this.tuyaSpeedToHbPercentage(this.speedMap.value))
        .onSet(async (value) => {
          await this.sendTuyaCommand(Characteristic.RotationSpeed, value);
        });
    }
  }

  /**
   * שליחת פקודה לטויה עם טיפול בשגיאות סטנדרטי ל-2.0
   */
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
          this.switchMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.Active)
            .updateValue(statusMap.value ? 1 : 0);
          this.service
            .getCharacteristic(Characteristic.CurrentAirPurifierState)
            .updateValue(statusMap.value ? 2 : 0);
          break;
        case "mode":
          this.modeMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.TargetAirPurifierState)
            .updateValue(statusMap.value === "auto" ? 1 : 0);
          break;
        case "lock":
          this.lockMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.LockPhysicalControls)
            .updateValue(statusMap.value ? 1 : 0);
          break;
        case "speed":
        case "fan_speed_enum":
          this.speedMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.RotationSpeed)
            .updateValue(this.tuyaSpeedToHbPercentage(statusMap.value));
          break;
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  /**
   * המרת מהירות טויה (Level/Enum) לאחוזי HomeKit
   */
  tuyaSpeedToHbPercentage(tuyaValue) {
    if (this.speedMap?.code === "fan_speed_enum") {
      const map = { low: 1, mid: 2, high: 3 };
      const level = map[tuyaValue] || 1;
      return Math.floor(level * this.speed_coefficient);
    }
    const level = parseInt(tuyaValue) || 1;
    return Math.floor(level * this.speed_coefficient);
  }

  getSendParam(name, hbValue) {
    const { Characteristic } = this.platform.api.hap;
    let code, value;

    switch (name) {
      case Characteristic.Active:
        code = "switch";
        value = Boolean(hbValue);
        break;
      case Characteristic.TargetAirPurifierState:
        code = "mode";
        value =
          hbValue === Characteristic.TargetAirPurifierState.AUTO
            ? "auto"
            : "manual";
        break;
      case Characteristic.LockPhysicalControls:
        code = "lock";
        value =
          hbValue === Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED;
        break;
      case Characteristic.RotationSpeed:
        code = this.speedMap.code;
        let level = Math.floor(hbValue / this.speed_coefficient) || 1;
        level = Math.min(level, this.speed_count);

        if (code === "fan_speed_enum") {
          const enumMap = ["low", "mid", "high"];
          value = enumMap[level - 1] || "low";
        } else {
          value = String(level);
        }
        break;
    }
    return { commands: [{ code, value }] };
  }

  getSpeedFunctionCount(code) {
    const funcDic = this.functionArr.find((item) => item.code === code);
    if (funcDic) {
      try {
        const values = JSON.parse(funcDic.values);
        return values.range ? values.range.length : DEFAULT_SPEED_COUNT;
      } catch (e) {
        return DEFAULT_SPEED_COUNT;
      }
    }
    return DEFAULT_SPEED_COUNT;
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default AirPurifierAccessory;
