"use strict";

import BaseAccessory from "./base_accessory.mjs";

class PushAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig, deviceData) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.SWITCH,
      Service.Switch,
      deviceData.subType,
    );

    this.statusArr = deviceConfig.status || [];
    this.subTypeArr = deviceData.subType || [];

    // ניהול המצב המקומי
    this.states = new Map();

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  /**
   * הגדרת ה-Handlers עבור Homebridge 2.0
   */
  initStatus() {
    const { Characteristic } = this.platform.api.hap;

    for (const dpCode of this.subTypeArr) {
      const service = this._getServiceByCode(dpCode);
      if (!service) continue;

      service
        .getCharacteristic(Characteristic.On)
        .onGet(() => {
          // בלחצן רגעי, המצב בדרך כלל תמיד כבוי בתצוגה
          return this.states.get(dpCode) || false;
        })
        .onSet(async (value) => {
          // מבצעים לחיצה רק אם הערך הוא true
          if (value) {
            await this.sendTuyaPushCommand(dpCode, service);
          }
        });
    }
  }

  /**
   * שליחת פקודת "לחיצה" וחזרה למצב כבוי
   */
  async sendTuyaPushCommand(dpCode, service) {
    const { Characteristic, HapStatusError, HAPStatus } = this.platform.api.hap;

    try {
      // 1. שליחת פקודת הדלקה לטויה
      const command = {
        commands: [{ code: dpCode, value: true }],
      };
      await this.platform.tuyaOpenApi.sendCommand(this.deviceId, command);

      this.log.debug(`[${this.deviceConfig.name}] Push triggered on ${dpCode}`);

      // 2. כיבוי וירטואלי מיידי ב-HomeKit כדי לדמות לחיצה (Momentary)
      this.states.set(dpCode, false);

      // השהיה קצרה לפני עדכון ה-UI כדי שהמשתמש יראה את ה"קפיצה" של הכפתור
      setTimeout(() => {
        service.getCharacteristic(Characteristic.On).updateValue(false);
      }, 500);
    } catch (error) {
      this.log.error(`[PUSH][${dpCode}] Failed to trigger:`, error);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * עדכון הנתונים בזמן אמת מה-MQTT
   */
  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;
    if (!statusArr) return;

    for (const dpCode of this.subTypeArr) {
      const status = statusArr.find((item) => item.code === dpCode);
      if (!status) continue;

      // בלחצן רגעי, גם אם טויה שולחת true, אנחנו מתייחסים לזה כאירוע לחיצה ומאפסים
      const value = Boolean(status.value);
      this.states.set(dpCode, false);

      const service = this._getServiceByCode(dpCode);
      if (service && isRefresh) {
        // אם הגיע true מטויה, אנחנו מעדכנים ל-true ואז מיד ל-false
        if (value) {
          service.getCharacteristic(Characteristic.On).updateValue(true);
          setTimeout(() => {
            service.getCharacteristic(Characteristic.On).updateValue(false);
          }, 500);
        } else {
          service.getCharacteristic(Characteristic.On).updateValue(false);
        }
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  /**
   * עזר לשליפת השירות (Main או Sub)
   */
  _getServiceByCode(dpCode) {
    if (this.subTypeArr.length === 1) {
      return this.service;
    }
    return this.homebridgeAccessory.getService(dpCode);
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default PushAccessory;
