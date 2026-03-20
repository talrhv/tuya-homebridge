"use strict";

import BaseAccessory from "./base_accessory.mjs";

class WindowCoveringAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.WINDOW_COVERING,
      Service.WindowCovering,
    );

    this.statusArr = deviceConfig.status || [];

    // מיפוי ה-DPs של טויה
    this.fullySituationMap = null; // קובע אם 100% זה פתוח או סגור
    this.percentControlMap = null; // שליטה (Target Position)
    this.positionMap = null; // מצב נוכחי (Current Position)

    // ניהול המצב המקומי
    this.currentPosition = 0;
    this.targetPosition = 0;

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  /**
   * הגדרת ה-Handlers עבור Homebridge 2.0
   */
  initStatus() {
    const { Characteristic } = this.platform.api.hap;
    const service = this.service;

    // --- Current Position ---
    service
      .getCharacteristic(Characteristic.CurrentPosition)
      .onGet(() => this.currentPosition);

    // --- Target Position ---
    service
      .getCharacteristic(Characteristic.TargetPosition)
      .onGet(() => this.targetPosition)
      .onSet(async (value) => {
        await this.sendTuyaCommand(Characteristic.TargetPosition, value);
      });

    // --- Position State (בדרך כלל במצב STOPPED אלא אם כן יש לוגיקה לזיהוי תנועה) ---
    service
      .getCharacteristic(Characteristic.PositionState)
      .onGet(() => Characteristic.PositionState.STOPPED);
  }

  /**
   * שליחת פקודה לטויה עם טיפול בשגיאות
   */
  async sendTuyaCommand(characteristic, value) {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    try {
      // המרת אחוזים לפי הלוגיקה של המנוע הספציפי
      const tuyaPercent = this._getCorrectPercent(value);

      let code = this.percentControlMap?.code || "percent_control";
      let tuyaValue = tuyaPercent;

      // אם הקוד הוא 'position', טויה מצפה למחרוזת
      if (code === "position") {
        tuyaValue = String(tuyaPercent);
      }

      const command = {
        commands: [{ code, value: tuyaValue }],
      };

      await this.platform.tuyaOpenApi.sendCommand(this.deviceId, command);

      this.targetPosition = value;
      this.log.debug(
        `[${this.deviceConfig.name}] Target position set to ${value}% (Tuya: ${tuyaValue})`,
      );
    } catch (error) {
      this.log.error(`[SET] Failed to set position:`, error);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * עדכון ערכים בזמן אמת מה-MQTT
   */
  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;
    if (!statusArr) return;

    for (const statusMap of statusArr) {
      switch (statusMap.code) {
        case "situation_set":
          this.fullySituationMap = statusMap;
          break;

        case "percent_control":
        case "position":
          this.percentControlMap = statusMap;
          const targetPos = this._getCorrectPercent(parseInt(statusMap.value));
          this.targetPosition = targetPos;

          if (isRefresh) {
            this.service
              .getCharacteristic(Characteristic.TargetPosition)
              .updateValue(targetPos);
          }

          // אם אין DP ייעודי למצב הנוכחי, נעדכן גם אותו לפי ה-Control
          if (!this._isHaveDPCodeOfPercentState()) {
            this.currentPosition = targetPos;
            if (isRefresh) {
              this.service
                .getCharacteristic(Characteristic.CurrentPosition)
                .updateValue(targetPos);
            }
          }
          break;

        case "percent_state":
          this.positionMap = statusMap;
          const currentPos = this._getCorrectPercent(parseInt(statusMap.value));
          this.currentPosition = currentPos;

          if (isRefresh) {
            this.service
              .getCharacteristic(Characteristic.CurrentPosition)
              .updateValue(currentPos);
          }
          break;
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  /**
   * לוגיקת היפוך אחוזים (Backend Precision)
   * בודק אם 100% זה פתוח לגמרי או סגור לגמרי
   */
  _getCorrectPercent(value) {
    let percent = value;
    const isFullyOpenDefault =
      (this.fullySituationMap &&
        this.fullySituationMap.value === "fully_open") ||
      this.deviceConfig.category === "clkg";

    if (isFullyOpenDefault) {
      return percent;
    } else {
      // היפוך לוגיקה: 0 הופך ל-100 ולהפך
      return 100 - percent;
    }
  }

  _isHaveDPCodeOfPercentState() {
    return this.statusArr.some((item) => item.code.includes("percent_state"));
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default WindowCoveringAccessory;
