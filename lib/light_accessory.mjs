"use strict";

import BaseAccessory from "./base_accessory.mjs";

class LightAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.LIGHTBULB,
      Service.Lightbulb,
    );

    this.statusArr = deviceConfig.status || [];
    this.function_dp_range = this.getDefaultDPRange();

    this.workMode = null;
    this.switchLed = null;
    this.brightValue = null;
    this.tempValue = null;
    this.colourData = null;
    this.colourObj = { h: 0, s: 0, v: 0 };

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    const { Characteristic } = this.platform.api.hap;
    const service = this.service;

    // --- On/Off ---
    service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.switchLed?.value || false)
      .onSet(async (value) => {
        await this.sendTuyaCommand(Characteristic.On, value);
      });

    // --- Brightness ---
    if (this._hasBrightness()) {
      service
        .getCharacteristic(Characteristic.Brightness)
        .onGet(() => {
          if (this.workMode?.value === "colour" && this.colourObj) {
            return this._scaleTuyaToHb(
              this.colourObj.v,
              this.function_dp_range.bright_range,
            );
          }
          return this._scaleTuyaToHb(
            this.brightValue?.value || 0,
            this.function_dp_range.bright_range,
          );
        })
        .onSet(async (value) => {
          await this.sendTuyaCommand(Characteristic.Brightness, value);
        });
    }

    // --- Color Temperature ---
    if (this.tempValue) {
      service
        .getCharacteristic(Characteristic.ColorTemperature)
        .onGet(() => {
          const rawValue = this.tempValue?.value || 0;
          const temp = Math.floor(
            ((rawValue - this.function_dp_range.temp_range.min) * 360) /
              (this.function_dp_range.temp_range.max -
                this.function_dp_range.temp_range.min) +
              140,
          );
          return Math.min(500, Math.max(140, temp));
        })
        .onSet(async (value) => {
          await this.sendTuyaCommand(Characteristic.ColorTemperature, value);
        });
    }

    // --- Hue & Saturation ---
    if (this.colourData) {
      service
        .getCharacteristic(Characteristic.Hue)
        .onGet(() => this.colourObj?.h || 0)
        .onSet(async (value) => {
          this.colourObj.h = value;
          await this.sendTuyaCommand(Characteristic.Hue, value);
        });

      service
        .getCharacteristic(Characteristic.Saturation)
        .onGet(() =>
          this._scaleTuyaToHb(
            this.colourObj?.s || 0,
            this.function_dp_range.saturation_range,
          ),
        )
        .onSet(async (value) => {
          this.colourObj.s = this._scaleHbToTuya(
            value,
            this.function_dp_range.saturation_range,
          );
        });
    }
  }

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

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    for (const statusMap of statusArr) {
      switch (statusMap.code) {
        case "work_mode":
          this.workMode = statusMap;
          break;
        case "switch_led":
        case "switch_led_1":
          this.switchLed = statusMap;
          this.service
            .getCharacteristic(Characteristic.On)
            .updateValue(this.switchLed.value);
          break;
        case "bright_value":
        case "bright_value_v2":
        case "bright_value_1":
          this.brightValue = statusMap;
          this.service
            .getCharacteristic(Characteristic.Brightness)
            .updateValue(
              this._scaleTuyaToHb(
                this.brightValue.value,
                this.function_dp_range.bright_range,
              ),
            );
          break;
        case "colour_data":
        case "colour_data_v2":
          this.colourData = statusMap;
          this.colourObj = statusMap.value
            ? typeof statusMap.value === "string"
              ? JSON.parse(statusMap.value)
              : statusMap.value
            : { h: 0, s: 0, v: 0 };

          this.service
            .getCharacteristic(Characteristic.Hue)
            .updateValue(this.colourObj.h);
          this.service
            .getCharacteristic(Characteristic.Saturation)
            .updateValue(
              this._scaleTuyaToHb(
                this.colourObj.s,
                this.function_dp_range.saturation_range,
              ),
            );
          break;
        case "temp_value":
        case "temp_value_v2":
          this.tempValue = statusMap;
          break;
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  _scaleTuyaToHb(tuyaValue, range) {
    if (!range) return 0;
    return Math.floor(
      ((tuyaValue - range.min) * 100) / (range.max - range.min),
    );
  }

  _scaleHbToTuya(hbValue, range) {
    if (!range) return 0;
    return Math.floor(((range.max - range.min) * hbValue) / 100 + range.min);
  }

  _hasBrightness() {
    return (
      this.statusArr.some((item) => item.code.includes("bright_value")) ||
      this.colourData
    );
  }

  getSendParam(name, value) {
    const { Characteristic } = this.platform.api.hap;
    let code, val;

    switch (name) {
      case Characteristic.On:
        code = this.switchLed.code;
        val = Boolean(value);
        break;
      case Characteristic.Brightness:
        val = this._scaleHbToTuya(value, this.function_dp_range.bright_range);
        if (this.workMode?.value === "colour" || !this.brightValue) {
          code = this.colourData.code;
          val = { ...this.colourObj, v: val };
        } else {
          code = this.brightValue.code;
        }
        break;
      case Characteristic.Hue:
        code = this.colourData.code;
        val = {
          h: value,
          s: this.colourObj.s,
          v: this._scaleHbToTuya(
            this.service.getCharacteristic(Characteristic.Brightness).value,
            this.function_dp_range.bright_range,
          ),
        };
        break;
      case Characteristic.ColorTemperature:
        code = this.tempValue.code;
        val = Math.floor(
          ((value - 140) *
            (this.function_dp_range.temp_range.max -
              this.function_dp_range.temp_range.min)) /
            360 +
            this.function_dp_range.temp_range.min,
        );
        break;
    }

    return { commands: [{ code, value: val }] };
  }

  getDefaultDPRange() {
    let bright = { min: 10, max: 1000 },
      temp = { min: 0, max: 1000 },
      sat = { min: 0, max: 1000 };
    for (const s of this.statusArr) {
      if (
        s.code === "bright_value" &&
        ["dj", "dc"].includes(this.deviceCategorie)
      )
        bright = { min: 25, max: 255 };
      if (
        s.code === "temp_value" &&
        ["dj", "dc"].includes(this.deviceCategorie)
      )
        temp = { min: 0, max: 255 };
      if (
        s.code === "colour_data" &&
        ["dj", "dc"].includes(this.deviceCategorie)
      ) {
        sat = { min: 0, max: 255 };
        bright = { min: 25, max: 255 };
      }
    }
    return { bright_range: bright, temp_range: temp, saturation_range: sat };
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default LightAccessory;
