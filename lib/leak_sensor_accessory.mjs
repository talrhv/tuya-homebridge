"use strict";

import BaseAccessory from "./base_accessory.mjs";

class LeakSensorAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.LEAK_SENSOR,
      Service.LeakSensor,
    );

    this.statusArr = deviceConfig.status || [];

    // רשימת הקודים האפשריים של טויה להתראות
    this.alarmCodes = [
      "gas_sensor_status",
      "gas_sensor_state",
      "ch4_sensor_state",
    ];

    // משתני מצב פנימיים
    this.leakStatus = null;
    this.batteryState = null;

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  /**
   * הגדרת ה-Handlers עבור Homebridge 2.0
   */
  initStatus() {
    const { Characteristic } = this.platform.api.hap;
    const service = this.service;

    // --- זיהוי דליפה ---
    service.getCharacteristic(Characteristic.LeakDetected).onGet(() => {
      return this._isLeakDetected()
        ? Characteristic.LeakDetected.LEAK_DETECTED
        : Characteristic.LeakDetected.LEAK_NOT_DETECTED;
    });

    // --- סטטוס סוללה (אם נתמך) ---
    if (this._hasBatteryStatus()) {
      service.getCharacteristic(Characteristic.StatusLowBattery).onGet(() => {
        return this.batteryState?.value === "low"
          ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      });
    }
  }

  /**
   * עדכון ערכים בזמן אמת מה-MQTT או בזמן טעינה
   */
  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    for (const statusMap of statusArr) {
      // בדיקה אם הקוד הנוכחי הוא אחד מקודי ההתראה שלנו
      if (this.alarmCodes.includes(statusMap.code)) {
        this.leakStatus = statusMap;
        const hbState = this._isLeakDetected()
          ? Characteristic.LeakDetected.LEAK_DETECTED
          : Characteristic.LeakDetected.LEAK_NOT_DETECTED;

        this.service
          .getCharacteristic(Characteristic.LeakDetected)
          .updateValue(hbState);
      }

      // בדיקת מצב סוללה
      if (statusMap.code === "battery_state") {
        this.batteryState = statusMap;
        const batteryValue = statusMap.value === "low" ? 1 : 0;
        this.service
          .getCharacteristic(Characteristic.StatusLowBattery)
          .updateValue(batteryValue);
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  /**
   * לוגיקת המרה פנימית (Encapsulation)
   * בודק את הערכים השונים שטויה שולחת (alarm/normal או 1/2)
   */
  _isLeakDetected() {
    if (!this.leakStatus) return false;
    const val = this.leakStatus.value;

    // טויה משתמשת לפעמים ב-Strings "alarm"/"normal" ולפעמים ב-"1"/"2" בגרסאות ישנות
    return val === "alarm" || val === "1";
  }

  /**
   * האם המכשיר הספציפי מדווח על סוללה
   */
  _hasBatteryStatus() {
    return this.statusArr.some((item) => item.code === "battery_state");
  }

  /**
   * עדכון סטטוס מה-SDK
   */
  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default LeakSensorAccessory;
