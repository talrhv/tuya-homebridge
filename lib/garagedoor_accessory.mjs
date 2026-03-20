"use strict";

import BaseAccessory from "./base_accessory.mjs";

class GarageDoorAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.GARAGE_DOOR_OPENER,
      Service.GarageDoorOpener,
    );

    this.statusArr = deviceConfig.status || [];

    // מיפוי ה-DPs של טויה
    this.switchMap = null; // שולט על הפתיחה/סגירה (Target)
    this.contactMap = null; // החיישן המגנטי (Current)
    this.obstructionMap = null; // זיהוי חסימה

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  /**
   * הגדרת הלוגיקה עבור Homebridge 2.0
   */
  initStatus() {
    const { Characteristic } = this.platform.api.hap;
    const service = this.service;

    // --- Current Door State (המצב בפועל לפי החיישן) ---
    service.getCharacteristic(Characteristic.CurrentDoorState).onGet(() => {
      // בטויה: true בד"כ אומר פתוח, false אומר סגור
      return this.contactMap?.value === true
        ? Characteristic.CurrentDoorState.OPEN
        : Characteristic.CurrentDoorState.CLOSED;
    });

    // --- Target Door State (הפקודה שאנחנו שולחים) ---
    service
      .getCharacteristic(Characteristic.TargetDoorState)
      .onGet(() => {
        return this.switchMap?.value === true
          ? Characteristic.TargetDoorState.OPEN
          : Characteristic.TargetDoorState.CLOSED;
      })
      .onSet(async (value) => {
        await this.sendTuyaCommand(Characteristic.TargetDoorState, value);
      });

    // --- Obstruction Detected (חסימה) ---
    service.getCharacteristic(Characteristic.ObstructionDetected).onGet(() => {
      return Boolean(this.obstructionMap?.value);
    });
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
      this.log.error(`[SET] Failed to set ${characteristic.name}:`, error);
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
        case "switch_1":
          this.switchMap = statusMap;
          const targetState =
            statusMap.value === true
              ? Characteristic.TargetDoorState.OPEN
              : Characteristic.TargetDoorState.CLOSED;
          this.service
            .getCharacteristic(Characteristic.TargetDoorState)
            .updateValue(targetState);
          break;

        case "doorcontact_state":
          this.contactMap = statusMap;
          const currentState =
            statusMap.value === true
              ? Characteristic.CurrentDoorState.OPEN
              : Characteristic.CurrentDoorState.CLOSED;
          this.service
            .getCharacteristic(Characteristic.CurrentDoorState)
            .updateValue(currentState);
          break;

        case "countdown_alarm":
          this.obstructionMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.ObstructionDetected)
            .updateValue(Boolean(statusMap.value));
          break;
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  /**
   * בניית הפרמטרים למשלוח ל-API
   */
  getSendParam(name, hbValue) {
    const { Characteristic } = this.platform.api.hap;
    let code, value;

    switch (name) {
      case Characteristic.TargetDoorState:
        code = "switch_1";
        // HomeKit: Open=0, Closed=1. Tuya: Open=true, Closed=false.
        value = hbValue === Characteristic.TargetDoorState.OPEN;
        break;
    }

    return { commands: [{ code, value }] };
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default GarageDoorAccessory;
