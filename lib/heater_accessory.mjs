"use strict";

import BaseAccessory from "./base_accessory.mjs";

const DEFAULT_LEVEL_COUNT = 3;

class HeaterAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;
    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.AIR_HEATER,
      Service.HeaterCooler,
    );

    this.statusArr = deviceConfig.status || [];
    this.functionArr = deviceConfig.functions || [];

    // הגדרות טווחים ורמות (Backend Logic)
    this.level_count = this.getLevelFunctionCount("level");
    this.speed_coefficient = 100 / this.level_count;
    this.temp_set_range = this.getTempSetDPRange();

    // מיפוי ה-DPs של טויה למשתנים מקומיים
    this.switchMap = null;
    this.temperatureMap = null;
    this.lockMap = null;
    this.speedMap = null;
    this.shakeMap = null;
    this.tempsetMap = null;

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  /**
   * הגדרת ה-Handlers עבור Homebridge 2.0
   */
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

    // --- Current Heater State ---
    service
      .getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .onGet(() => {
        if (!this.switchMap?.value)
          return Characteristic.CurrentHeaterCoolerState.INACTIVE;
        return Characteristic.CurrentHeaterCoolerState.HEATING;
      });

    // --- Target Heater State (Fixed to HEAT for this device) ---
    service
      .getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .setProps({
        minValue: Characteristic.TargetHeaterCoolerState.HEAT,
        maxValue: Characteristic.TargetHeaterCoolerState.HEAT,
        validValues: [Characteristic.TargetHeaterCoolerState.HEAT],
      })
      .onGet(() => Characteristic.TargetHeaterCoolerState.HEAT);

    // --- Current Temperature ---
    service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -20, maxValue: 122, minStep: 0.1 })
      .onGet(() => this.temperatureMap?.value || 0);

    // --- Temperature Display Units ---
    service
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => (this.temperatureMap?.code === "temp_current" ? 0 : 1));

    // --- Target Temperature (Heating Threshold) ---
    if (this.tempsetMap) {
      service
        .getCharacteristic(Characteristic.HeatingThresholdTemperature)
        .setProps({
          minValue: this.temp_set_range?.min || 0,
          maxValue: this.temp_set_range?.max || 50,
          minStep: 1,
        })
        .onGet(() => this.tempsetMap.value)
        .onSet(async (value) => {
          await this.sendTuyaCommand(
            Characteristic.HeatingThresholdTemperature,
            value,
          );
        });
    }

    // --- Lock / Swing / Speed ---
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

    if (this.shakeMap) {
      service
        .getCharacteristic(Characteristic.SwingMode)
        .onGet(() => (this.shakeMap.value ? 1 : 0))
        .onSet(
          async (value) =>
            await this.sendTuyaCommand(Characteristic.SwingMode, value),
        );
    }

    if (this.speedMap) {
      service
        .getCharacteristic(Characteristic.RotationSpeed)
        .onGet(() =>
          Math.floor((this.speedMap.value || 1) * this.speed_coefficient),
        )
        .onSet(
          async (value) =>
            await this.sendTuyaCommand(Characteristic.RotationSpeed, value),
        );
    }
  }

  /**
   * שליחת פקודה לטויה עם טיפול בשגיאות
   */
  async sendTuyaCommand(characteristic, value) {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    try {
      const param = this.getSendParam(characteristic, value);
      await this.platform.tuyaOpenApi.sendCommand(this.deviceId, param);
    } catch (error) {
      this.log.error(
        `[SET] Failed to set ${characteristic.name || "Characteristic"}:`,
        error,
      );
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * עדכון ערכים בזמן אמת (MQTT)
   */
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
            .getCharacteristic(Characteristic.CurrentHeaterCoolerState)
            .updateValue(statusMap.value ? 2 : 0);
          break;
        case "temp_current":
        case "temp_current_f":
          this.temperatureMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.CurrentTemperature)
            .updateValue(statusMap.value);
          break;
        case "lock":
          this.lockMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.LockPhysicalControls)
            .updateValue(statusMap.value ? 1 : 0);
          break;
        case "level":
          this.speedMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.RotationSpeed)
            .updateValue(Math.floor(statusMap.value * this.speed_coefficient));
          break;
        case "shake":
          this.shakeMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.SwingMode)
            .updateValue(statusMap.value ? 1 : 0);
          break;
        case "temp_set":
        case "temp_set_f":
          this.tempsetMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.HeatingThresholdTemperature)
            .updateValue(statusMap.value);
          break;
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  /**
   * בניית פקודות לטויה
   */
  getSendParam(name, hbValue) {
    const { Characteristic } = this.platform.api.hap;
    let code, value;

    switch (name) {
      case Characteristic.Active:
        code = "switch";
        value = Boolean(hbValue);
        break;
      case Characteristic.LockPhysicalControls:
        code = "lock";
        value = Boolean(hbValue);
        break;
      case Characteristic.RotationSpeed:
        code = this.speedMap.code;
        value = String(
          Math.min(
            this.level_count,
            Math.floor(hbValue / this.speed_coefficient) + 1,
          ),
        );
        break;
      case Characteristic.SwingMode:
        code = "shake";
        value = Boolean(hbValue);
        break;
      case Characteristic.HeatingThresholdTemperature:
        code = this.tempsetMap.code;
        value = hbValue;
        break;
    }

    return { commands: [{ code, value }] };
  }

  // --- פונקציות עזר ללוגיקה הפנימית ---

  getLevelFunctionCount(code) {
    const func = this.functionArr.find((item) => item.code === code);
    if (func) {
      const values = JSON.parse(func.values);
      return values.range ? values.range.length : DEFAULT_LEVEL_COUNT;
    }
    return DEFAULT_LEVEL_COUNT;
  }

  getTempSetDPRange() {
    const func = this.functionArr.find(
      (f) => f.code === "temp_set" || f.code === "temp_set_f",
    );
    if (func) {
      const range = JSON.parse(func.values);
      return { min: parseInt(range.min), max: parseInt(range.max) };
    }
    return null;
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default HeaterAccessory;
