"use strict";

import BaseAccessory from "./base_accessory.mjs";

class SmokeSensorAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.SENSOR,
      Service.SmokeSensor,
    );

    this.statusArr = deviceConfig.status || [];

    // משתני מצב (Source of Truth)
    this.smokeDetected = 0; // 0 = Normal, 1 = Smoke Detected
    this.lowBatteryStatus = 0; // 0 = Normal, 1 = Low

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  /**
   * הגדרת ה-Handlers עבור Homebridge 2.0
   */
  initStatus() {
    const { Characteristic } = this.platform.api.hap;
    const service = this.service;

    // --- זיהוי עשן ---
    service.getCharacteristic(Characteristic.SmokeDetected).onGet(() => {
      return this.smokeDetected === 1
        ? Characteristic.SmokeDetected.SMOKE_DETECTED
        : Characteristic.SmokeDetected.SMOKE_NOT_DETECTED;
    });

    // --- סטטוס סוללה (אם נתמך) ---
    if (this._hasBatteryStatus()) {
      service.getCharacteristic(Characteristic.StatusLowBattery).onGet(() => {
        return this.lowBatteryStatus === 1
          ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      });
    }
  }

  /**
   * עדכון ערכים בזמן אמת (MQTT / Initial Load)
   */
  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    for (const statusMap of statusArr) {
      const rawValue = statusMap.value;

      switch (statusMap.code) {
        case "smoke_sensor_status":
          // המרה למספר (Enum) במקום String
          this.smokeDetected = rawValue === "alarm" ? 1 : 0;

          this.service
            .getCharacteristic(Characteristic.SmokeDetected)
            .updateValue(this.smokeDetected);
          break;

        case "battery_state":
          this.lowBatteryStatus = rawValue === "low" ? 1 : 0;

          this.service
            .getCharacteristic(Characteristic.StatusLowBattery)
            .updateValue(this.lowBatteryStatus);
          break;
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  /**
   * בדיקה אם המכשיר מדווח על סוללה
   */
  _hasBatteryStatus() {
    return this.statusArr.some((item) => item.code === "battery_state");
  }

  /**
   * עדכון State מה-SDK
   */
  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default SmokeSensorAccessory;
