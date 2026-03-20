"use strict";

import BaseAccessory from "./base_accessory.mjs";

class MotionSensorAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig, overrideTime) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.SENSOR,
      Service.MotionSensor,
    );

    this.statusArr = deviceConfig.status || [];
    this.overrideTime = overrideTime || 0;

    // זיהוי אם לחיישן יש מנגנון זמן פנימי
    this.hasInternalTimeSensor = this.statusArr.some(
      (p) => p.code === "pir_time",
    );

    // משתני מצב (Source of Truth)
    this.motionDetected = false;
    this.lowBatteryStatus = 0; // 0 = Normal, 1 = Low
    this.tamperedStatus = 0; // 0 = Not Tampered, 1 = Tampered

    this._freezeTimer = null;

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  /**
   * הגדרת ה-Handlers עבור Homebridge 2.0
   */
  initStatus() {
    const { Characteristic } = this.platform.api.hap;
    const service = this.service;

    // --- Motion Detected ---
    service
      .getCharacteristic(Characteristic.MotionDetected)
      .onGet(() => this.motionDetected);

    // --- Status Low Battery ---
    service
      .getCharacteristic(Characteristic.StatusLowBattery)
      .onGet(() => this.lowBatteryStatus);

    // --- Status Tampered (התראה על חבלה במכשיר) ---
    service
      .getCharacteristic(Characteristic.StatusTampered)
      .onGet(() => this.tamperedStatus);
  }

  /**
   * עדכון הנתונים בזמן אמת (MQTT / Initial Load)
   */
  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    for (const statusMap of statusArr) {
      const rawValue = statusMap.value;

      switch (statusMap.code) {
        case "pir":
          const isMotion = rawValue === "pir";
          this._handleMotionUpdate(isMotion, isRefresh);
          break;

        case "battery_percentage":
        case "battery_value":
        case "battery_state":
          this.lowBatteryStatus = this._parseBatteryStatus(
            statusMap.code,
            rawValue,
          );
          this.service
            .getCharacteristic(Characteristic.StatusLowBattery)
            .updateValue(this.lowBatteryStatus);
          break;

        case "temper_alarm":
          this.tamperedStatus = rawValue ? 1 : 0;
          this.service
            .getCharacteristic(Characteristic.StatusTampered)
            .updateValue(this.tamperedStatus);
          break;
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  /**
   * לוגיקת ניהול התנועה כולל ה-Override Time
   */
  _handleMotionUpdate(isMotion, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    // אם יש תנועה ויש לנו הגדרת זמן השהיה (והחיישן לא מנהל זמן בעצמו)
    if (isMotion && this.overrideTime > 0 && !this.hasInternalTimeSensor) {
      this._startMotionOverride();
    } else {
      // עדכון רגיל
      this.motionDetected = isMotion;
      if (isRefresh) {
        this.service
          .getCharacteristic(Characteristic.MotionDetected)
          .updateValue(this.motionDetected);
      }
    }
  }

  /**
   * ניהול טיימר ה-Override (בדומה ל-Refire ב-Backend)
   */
  _startMotionOverride() {
    const { Characteristic } = this.platform.api.hap;

    // ניקוי טיימר קודם אם קיים (Reset)
    if (this._freezeTimer) {
      clearTimeout(this._freezeTimer);
    }

    this.motionDetected = true;
    this.service
      .getCharacteristic(Characteristic.MotionDetected)
      .updateValue(true);

    this._freezeTimer = setTimeout(() => {
      this.motionDetected = false;
      this.service
        .getCharacteristic(Characteristic.MotionDetected)
        .updateValue(false);
      this._freezeTimer = null;
      this.log.debug(
        `[${this.deviceConfig.name}] Motion auto-reset after ${this.overrideTime}s`,
      );
    }, this.overrideTime * 1000);
  }

  /**
   * פרסר נקי למצבי סוללה שונים של טויה
   */
  _parseBatteryStatus(code, value) {
    if (code === "battery_percentage") return value <= 20 ? 1 : 0;
    if (code === "battery_value") return value <= 2000 ? 1 : 0; // בד"כ במיליוולט
    if (code === "battery_state")
      return value === "low" || value === "empty" ? 1 : 0;
    return 0;
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default MotionSensorAccessory;
