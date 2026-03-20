"use strict";

import BaseAccessory from "./base_accessory.mjs";

class SwitchAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig, deviceData) {
    const { Categories, Service } = platform.api.hap;

    // שליחת ה-subType (רשימת ה-DP Codes) ל-Base לצורך יצירת ה-Services
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

    this.states = new Map();

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  /**
   * הגדרת ה-Handlers המודרניים עבור Homebridge 2.0
   */
  initStatus() {
    const { Characteristic } = this.platform.api.hap;

    // הגדרת לוגיקה לכל כפתור במפסק
    for (const dpCode of this.subTypeArr) {
      const service = this._getServiceByCode(dpCode);
      if (!service) continue;

      service
        .getCharacteristic(Characteristic.On)
        .onGet(() => {
          return this.states.get(dpCode) || false;
        })
        .onSet(async (value) => {
          await this.sendTuyaCommand(dpCode, value);
        });
    }
  }

  /**
   * שליחת פקודה לטויה עם טיפול בשגיאות תקני
   */
  async sendTuyaCommand(dpCode, value) {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    try {
      const isOn = Boolean(value);
      const command = {
        commands: [{ code: dpCode, value: isOn }],
      };

      await this.platform.tuyaOpenApi.sendCommand(this.deviceId, command);

      // עדכון ה-State המקומי לאחר הצלחה
      this.states.set(dpCode, isOn);
      this.log.debug(
        `[${this.deviceConfig.name}] Switch ${dpCode} set to ${isOn}`,
      );
    } catch (error) {
      this.log.error(`[SET][${dpCode}] Failed to send command:`, error);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * עדכון נתונים בזמן אמת (MQTT / Initial Load)
   */
  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;
    if (!statusArr) return;

    for (const dpCode of this.subTypeArr) {
      const status = statusArr.find((item) => item.code === dpCode);
      if (!status) continue;

      const value = Boolean(status.value);
      this.states.set(dpCode, value);

      const service = this._getServiceByCode(dpCode);
      if (service && isRefresh) {
        service.getCharacteristic(Characteristic.On).updateValue(value);
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  /**
   * עוזר לשליפת ה-Service הנכון (ראשי או משני)
   */
  _getServiceByCode(dpCode) {
    // אם יש רק כפתור אחד, משתמשים בשירות הראשי שנוצר ב-Base
    if (this.subTypeArr.length === 1) {
      return this.service;
    }
    // במקרה של ריבוי מפסקים, שולפים לפי ה-DP Code ששימש כשם השירות
    return this.homebridgeAccessory.getService(dpCode);
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default SwitchAccessory;
