"use strict";

import BaseAccessory from "./base_accessory.mjs";

class ContactSensorAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.SENSOR,
      Service.ContactSensor,
    );

    this.statusArr = deviceConfig.status || [];

    // מיפוי ה-DPs של טויה למשתנים מקומיים
    this.sensorStatus = null;
    this.batteryStatus = null;

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  /**
   * הגדרת ה-Handlers עבור Homebridge 2.0
   */
  initStatus() {
    const { Characteristic } = this.platform.api.hap;
    const service = this.service;

    // --- מצב החיישן (פתוח/סגור) ---
    service.getCharacteristic(Characteristic.ContactSensorState).onGet(() => {
      return this.sensorStatus?.value === true
        ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED // פתוח
        : Characteristic.ContactSensorState.CONTACT_DETECTED; // סגור
    });

    // --- התראת סוללה חלשה ---
    if (this._hasBatteryStatus()) {
      service.getCharacteristic(Characteristic.StatusLowBattery).onGet(() => {
        const batteryLevel = parseInt(this.batteryStatus?.value) || 100;
        return batteryLevel < 20
          ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      });
    }
  }

  /**
   * עדכון ה-Services מהודעות MQTT או בזמן טעינה
   */
  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    for (const statusMap of statusArr) {
      switch (statusMap.code) {
        case "doorcontact_state":
          this.sensorStatus = statusMap;
          const sensorState =
            statusMap.value === true
              ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
              : Characteristic.ContactSensorState.CONTACT_DETECTED;

          this.service
            .getCharacteristic(Characteristic.ContactSensorState)
            .updateValue(sensorState);
          break;

        case "battery_percentage":
          this.batteryStatus = statusMap;
          const batteryLevel = parseInt(statusMap.value) || 100;
          const batteryState = batteryLevel < 20 ? 1 : 0;

          this.service
            .getCharacteristic(Characteristic.StatusLowBattery)
            .updateValue(batteryState);
          break;
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  /**
   * בודק האם המכשיר הספציפי תומך בדיווח סוללה
   */
  _hasBatteryStatus() {
    return this.statusArr.some((item) => item.code === "battery_percentage");
  }

  /**
   * עדכון State ממקור חיצוני (SDK)
   */
  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default ContactSensorAccessory;
