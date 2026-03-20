"use strict";

import BaseAccessory from "./base_accessory.mjs";

class OutletAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig, deviceData) {
    const { Categories, Service } = platform.api.hap;

    // שליחת ה-subType (מערך ה-DPs של השקעים) ל-Base כדי שייצר את ה-Services
    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.OUTLET,
      Service.Outlet,
      deviceData.subType,
    );

    this.statusArr = deviceConfig.status || [];
    this.subTypeArr = deviceData.subType || [];

    // ניהול המצב המקומי ללא תלות ב-Cache הישן של ה-Base
    this.states = new Map();

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  /**
   * הגדרת ה-Handlers עבור Homebridge 2.0
   */
  initStatus() {
    const { Characteristic } = this.platform.api.hap;

    // עוברים על כל ה-DPs (שירותים) ומגדירים להם Get/Set
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
    const { Characteristic, HapStatusError, HAPStatus } = this.platform.api.hap;
    try {
      const isOn = Boolean(value);
      const command = {
        commands: [{ code: dpCode, value: isOn }],
      };

      await this.platform.tuyaOpenApi.sendCommand(this.deviceId, command);

      // עדכון מצב מקומי
      this.states.set(dpCode, isOn);
    } catch (error) {
      this.log.error(`[SET][${dpCode}] Failed to set value:`, error);
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
   * פונקציית עזר לשליפת השירות המתאים (Main או Sub)
   */
  _getServiceByCode(dpCode) {
    const { Service } = this.platform.api.hap;

    // אם יש רק שקע אחד, השירות הראשי הוא this.service
    if (this.subTypeArr.length === 1) {
      return this.service;
    }

    // אם יש כמה, נשלוף לפי השם שנתנו לו ב-BaseAccessory (שהוא ה-dpCode)
    return this.homebridgeAccessory.getService(dpCode);
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default OutletAccessory;
