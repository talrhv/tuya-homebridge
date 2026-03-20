"use strict";

import BaseAccessory from "./base_accessory.mjs";

let Accessory;
let Service;
let Characteristic;
let Formats;
let Perms;
let Units;

class ValveAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig, deviceData) {
    ({ Accessory, Characteristic, Service } = platform.api.hap);

    Formats = platform.api.hap.Formats ?? Characteristic.Formats;
    Perms = platform.api.hap.Perms ?? Characteristic.Perms;
    Units = platform.api.hap.Units ?? Characteristic.Units;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Accessory.Categories.SWITCH,
      Service.Valve,
    );

    this.statusArr = deviceConfig.status ? deviceConfig.status : [];
    this.functionArr = deviceConfig.functions ? deviceConfig.functions : [];
    this.deviceCategorie = deviceConfig.category;

    this.deviceData = deviceData;
    this.countdown = null;
    this.switchLed = null;
    this.startTime = null;
    this.duration = 0;
    this.localSetDuration = 0; // הזיכרון שלנו לזמן שהמשתמש בחר
    this.isRefresh = false;

    this._remainingTimer = null;

    this._didInitStatus = false;

    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    const service = this.service;

    // Defaults
    service.setCharacteristic(Characteristic.Active, 0);
    service.setCharacteristic(Characteristic.InUse, 0);

    // Active (On/Off)
    service
      .getCharacteristic(Characteristic.Active)
      .on("get", (callback) => {
        callback(null, this.switchLed?.value ? 1 : 0);
      })
      .on("set", async (value, callback) => {
        try {
          await this.setSwitch(value);
          callback(null);
        } catch (e) {
          this.log?.error?.("Valve Active set failed", e);
          callback(e);
        }
      });

    // RemainingDuration (read-only)
    const remainingChar = service.getCharacteristic(
      Characteristic.RemainingDuration,
    );
    remainingChar.setProps({
      format: Formats.UINT32,
      unit: Units.SECONDS,
      minValue: 0,
      maxValue: this._maxCountdown(),
      minStep: 1, // חייב להיות 1 כדי שהספירה תרד כל שניה
      perms: [Perms.PAIRED_READ, Perms.NOTIFY],
    });

    remainingChar
      .on("get", (callback) => {
        callback(null, this.getCountdown());
      })
      .on("set", (value, callback) => {
        // remaining is derived; ignore writes
        callback(null);
      });

    // SetDuration (The Slider)
    const setDurationChar = service.getCharacteristic(
      Characteristic.SetDuration,
    );
    setDurationChar.setProps({
      format: Formats.UINT32,
      unit: Units.SECONDS,
      minValue: 0,
      maxValue: this._maxCountdown(),
      minStep: 60,
      perms: [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.NOTIFY],
    });

    setDurationChar
      .on("get", (callback) => {
        callback(null, this.localSetDuration);
      })
      .on("set", async (value, callback) => {
        this.localSetDuration = value; // שומרים את בחירת המשתמש מקומית
        try {
          // שולחים לטויה רק אם הברז דולק עכשיו
          if (this.switchLed?.value) {
            await this.setCountdown(value);
          }
          callback(null);
        } catch (e) {
          this.log?.error?.("Valve SetDuration set failed", e);
          callback(e);
        }
      });
  }

  _maxCountdown() {
    return 86400; // 24 hours
  }

  _clearRemainingTimer() {
    if (this._remainingTimer) {
      clearInterval(this._remainingTimer);
      this._remainingTimer = null;
    }
  }

  _startRemainingTimer() {
    this._clearRemainingTimer();

    if (!this.switchLed?.value) return;
    if (
      !this.startTime ||
      !Number.isFinite(this.duration) ||
      this.duration <= 0
    )
      return;

    // Update once per second while active
    this._remainingTimer = setInterval(() => {
      const remaining = this.getCountdown();
      this.service
        .getCharacteristic(Characteristic.RemainingDuration)
        .updateValue(remaining);
      this.setCachedState(Characteristic.RemainingDuration, remaining);

      if (remaining <= 0) {
        this._clearRemainingTimer();
      }
    }, 1000);
  }

  _syncHomeKit() {
    const isOn = Boolean(this.switchLed?.value);

    // These two are shown by HomeKit for Valve
    this.normalAsync(Characteristic.InUse, isOn ? 1 : 0);
    this.normalAsync(Characteristic.Active, isOn ? 1 : 0);

    const remaining = this.getCountdown();
    this.normalAsync(Characteristic.RemainingDuration, remaining);

    if (this.countdown && this.countdown.value > 0) {
      this.localSetDuration = this.countdown.value;
      this.normalAsync(Characteristic.SetDuration, this.localSetDuration);
    }

    if (isOn && remaining > 0) {
      this._startRemainingTimer();
    } else {
      this._clearRemainingTimer();
    }
  }

  // init / refresh AccessoryService
  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    this.isRefresh = isRefresh;

    for (const statusMap of statusArr) {
      if (statusMap.code.includes("countdown")) {
        this.countdown = statusMap;
      }
      if (statusMap.code.includes("switch")) {
        this.switchLed = statusMap;
      }
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

  // Countdown in seconds
  getCountdown() {
    if (
      !this.startTime ||
      !Number.isFinite(this.duration) ||
      this.duration <= 0
    ) {
      return 0;
    }

    const elapsedMs = Date.now() - this.startTime.getTime();
    const remaining = Math.max(0, Math.round(this.duration - elapsedMs / 1000));
    return remaining;
  }

  updateHomeKit() {
    this._syncHomeKit();
  }

  async setCountdown(value) {
    const max = this._maxCountdown();
    const v = Math.max(
      0,
      Math.min(Number(value) || 0, max || Number.MAX_SAFE_INTEGER),
    );

    const countdownCode = this.countdown ? this.countdown.code : "countdown_1";

    await this.platform.tuyaOpenApi.sendCommand(this.deviceId, {
      commands: [{ code: countdownCode, value: v }],
    });

    if (this.countdown) {
      this.countdown.value = v;
      this.duration = v;
      this.startTime = new Date();
    }

    this.updateHomeKit();
  }

  async setSwitch(value) {
    const isOn = value === 1 || value === true;

    const switchCode = this.switchLed ? this.switchLed.code : "switch_1";
    const countdownCode = this.countdown ? this.countdown.code : "countdown_1";

    // בונים את פקודת ההדלקה
    const commands = [{ code: switchCode, value: isOn }];

    // הטריק: אם מדליקים ויש לנו זמן בזיכרון, שולחים אותו יחד עם ההדלקה
    if (isOn && this.localSetDuration > 0) {
      commands.push({ code: countdownCode, value: this.localSetDuration });
      if (this.countdown) this.countdown.value = this.localSetDuration;
      this.duration = this.localSetDuration;
      this.startTime = new Date();
    }

    await this.platform.tuyaOpenApi.sendCommand(this.deviceId, { commands });

    if (this.switchLed) {
      this.switchLed.value = isOn;
    }

    // If turning off, reset countdown state
    if (!isOn) {
      this.duration = 0;
      this.startTime = null;
    }

    this.updateHomeKit();
  }

  getDeviceStatus(code) {
    for (const statusMap of this.statusArr) {
      if (statusMap.code === code) {
        return statusMap;
      }
    }
    return null;
  }

  // update mqtt state
  updateState(device) {
    if (!device || !Array.isArray(device.status)) return;

    // Refresh internal status array with latest values
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
