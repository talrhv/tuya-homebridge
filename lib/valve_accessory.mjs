"use strict";

import BaseAccessory from "./base_accessory.mjs";

class ValveAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig, deviceData) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.FAUCET,
      Service.Valve,
    );

    this.statusArr = deviceConfig.status ? deviceConfig.status : [];
    this.deviceData = deviceData;

    this.countdown = null;
    this.switchLed = null;
    this.startTime = null;
    this.duration = 0;
    this.localSetDuration = 0;

    this._remainingTimer = null;
    this._didInitStatus = false;

    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    const { Characteristic, HapStatusError, HAPStatus } = this.platform.api.hap;
    const service = this.service;

    service
      .getCharacteristic(Characteristic.Active)
      .updateValue(Characteristic.Active.INACTIVE);
    service
      .getCharacteristic(Characteristic.InUse)
      .updateValue(Characteristic.InUse.NOT_IN_USE);

    service.getCharacteristic(Characteristic.ValveType).updateValue(1);

    // --- Active (On/Off) ---
    service
      .getCharacteristic(Characteristic.Active)
      .onGet(() => {
        return this.switchLed?.value
          ? Characteristic.Active.ACTIVE
          : Characteristic.Active.INACTIVE;
      })
      .onSet(async (value) => {
        try {
          await this.setSwitch(value);
        } catch (e) {
          this.log.error("Valve Active set failed:", e);
          throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      });

    // --- RemainingDuration ---
    service
      .getCharacteristic(Characteristic.RemainingDuration)
      .setProps({
        minValue: 0,
        maxValue: 86400,
        format: "uint32",
      })
      .onGet(() => {
        return this.getCountdown();
      });

    // --- SetDuration (The Slider) ---
    service
      .getCharacteristic(Characteristic.SetDuration)
      .setProps({
        format: "uint32",
        maxValue: 86400, // 24 hours
        minValue: 0,
        minStep: 60,
      })
      .onGet(() => {
        return this.localSetDuration;
      })
      .onSet(async (value) => {
        this.localSetDuration = value;
        try {
          if (this.switchLed?.value) {
            await this.setCountdown(value);
          }
        } catch (e) {
          this.log.error("Valve SetDuration set failed:", e);
          throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      });
  }

  _maxCountdown() {
    return 86400;
  }

  _clearRemainingTimer() {
    if (this._remainingTimer) {
      clearInterval(this._remainingTimer);
      this._remainingTimer = null;
    }
  }

  _startRemainingTimer() {
    this._clearRemainingTimer();
    const { Characteristic } = this.platform.api.hap;

    if (!this.switchLed?.value || !this.startTime || this.duration <= 0) return;

    this._remainingTimer = setInterval(() => {
      const remaining = this.getCountdown();

      this.service
        .getCharacteristic(Characteristic.RemainingDuration)
        .updateValue(remaining);

      // תיקון הבאג הויזואלי: ברגע שהגענו ל-0, מעדכנים את המתג
      if (remaining <= 0) {
        this.log.info("⏰ Timer finished, turning off valve UI.");
        this._clearRemainingTimer();

        // עדכון אקטיבי של ה-UI
        this.service
          .getCharacteristic(Characteristic.Active)
          .updateValue(Characteristic.Active.INACTIVE);
        this.service
          .getCharacteristic(Characteristic.InUse)
          .updateValue(Characteristic.InUse.NOT_IN_USE);

        // עדכון מצב פנימי
        if (this.switchLed) this.switchLed.value = false;
        this.duration = 0;
        this.startTime = null;
      }
    }, 1000);
  }

  _syncHomeKit() {
    const { Characteristic } = this.platform.api.hap;
    const isOn = Boolean(this.switchLed?.value);

    this.service
      .getCharacteristic(Characteristic.InUse)
      .updateValue(isOn ? 1 : 0);
    this.service
      .getCharacteristic(Characteristic.Active)
      .updateValue(isOn ? 1 : 0);

    const remaining = this.getCountdown();
    this.service
      .getCharacteristic(Characteristic.RemainingDuration)
      .updateValue(remaining);

    if (this.countdown && this.countdown.value > 0) {
      this.localSetDuration = this.countdown.value;
      this.service
        .getCharacteristic(Characteristic.SetDuration)
        .updateValue(this.localSetDuration);
    }

    if (isOn && remaining > 0) {
      this._startRemainingTimer();
    } else {
      this._clearRemainingTimer();
    }
  }

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    this.isRefresh = isRefresh;

    for (const statusMap of statusArr) {
      if (statusMap.code.includes("countdown")) this.countdown = statusMap;
      if (statusMap.code.includes("switch")) this.switchLed = statusMap;
    }

    if (this.countdown && !this.isRefresh) {
      this.duration = this.countdown.value;
      this.startTime = new Date();
    }

    if (this.isRefresh && this.countdown && Number(this.countdown.value) <= 0) {
      this.duration = this.countdown.value;
      this.startTime = new Date();
    }

    if (this.isRefresh && this.switchLed && !this.switchLed.value) {
      this.duration = 0;
      this.startTime = null;
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }

    this._syncHomeKit();
  }

  getCountdown() {
    if (
      !this.startTime ||
      !Number.isFinite(this.duration) ||
      this.duration <= 0
    )
      return 0;
    const elapsedMs = Date.now() - this.startTime.getTime();
    return Math.max(0, Math.round(this.duration - elapsedMs / 1000));
  }

  async setCountdown(value) {
    const countdownCode = this.countdown ? this.countdown.code : "countdown_1";
    await this.platform.tuyaOpenApi.sendCommand(this.deviceId, {
      commands: [{ code: countdownCode, value: value }],
    });

    if (this.countdown) {
      this.countdown.value = value;
      this.duration = value;
      this.startTime = new Date();
    }
    this._syncHomeKit();
  }

  async setSwitch(value) {
    const { Characteristic } = this.platform.api.hap;
    const isOn = value === Characteristic.Active.ACTIVE || value === true;
    const switchCode = this.switchLed ? this.switchLed.code : "switch_1";
    const countdownCode = this.countdown ? this.countdown.code : "countdown_1";

    const commands = [{ code: switchCode, value: isOn }];

    if (isOn && this.localSetDuration > 0) {
      commands.push({ code: countdownCode, value: this.localSetDuration });
      if (this.countdown) this.countdown.value = this.localSetDuration;
      this.duration = this.localSetDuration;
      this.startTime = new Date();
    }

    await this.platform.tuyaOpenApi.sendCommand(this.deviceId, { commands });

    if (this.switchLed) this.switchLed.value = isOn;
    if (!isOn) {
      this.duration = 0;
      this.startTime = null;
    }
    this._syncHomeKit();
  }

  updateState(device) {
    if (!device || !Array.isArray(device.status)) return;
    for (const statusMap of device.status) {
      for (const statusMap1 of this.statusArr) {
        if (statusMap.code === statusMap1.code) {
          statusMap1.value = statusMap.value;
        }
      }
    }
    this.refreshAccessoryServiceIfNeed(this.statusArr, true);
  }
}

export default ValveAccessory;
