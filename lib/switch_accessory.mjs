"use strict";

import BaseAccessory from "./base_accessory.mjs";

class SwitchAccessory extends BaseAccessory {
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

    this.states = new Map();

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    const { Characteristic } = this.platform.api.hap;

    for (const dpCode of this.subTypeArr) {
      const service = this._getServiceByCode(dpCode);
      if (!service) {
        this.log.warn(
          `[Matter Sync] Could not find mapped service for endpoint: ${dpCode}`,
        );
        continue;
      }

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

  async sendTuyaCommand(dpCode, value) {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    try {
      const isOn = Boolean(value);
      const command = {
        commands: [{ code: dpCode, value: isOn }],
      };

      await this.platform.tuyaOpenApi.sendCommand(this.deviceId, command);

      this.states.set(dpCode, isOn);
      this.log.debug(
        `[${this.deviceConfig.name}] Switch ${dpCode} set to ${isOn}`,
      );
    } catch (error) {
      this.log.error(`[SET][${dpCode}] Failed to send command:`, error);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

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

  _getServiceByCode(dpCode) {
    if (this.subTypeArr.length === 1) {
      return this.homebridgeAccessory.getService(this.serviceType);
    }

    return this.homebridgeAccessory.getServiceById(this.serviceType, dpCode);
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default SwitchAccessory;
