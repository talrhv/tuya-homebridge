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

  static createMatterAccessory(platform, device, bridge) {
    const powerCodes = this.getMatterPowerCodes(device, bridge);
    if (powerCodes.length === 0) {
      bridge.log.warn(
        `Skipping Matter switch for ${device?.name || device?.id}: no switch datapoint found.`,
      );
      return null;
    }

    const primaryPowerCode = powerCodes[0];
    const partStates = this.readMatterPartStates(device, powerCodes, bridge);
    const identity = bridge.baseIdentity(device, {
      powerCode: primaryPowerCode,
      powerCodes,
      multiGang: powerCodes.length > 1,
      matterService: "switch",
    });

    const accessory = {
      ...identity,
      deviceType: bridge.api.matter.deviceTypes.OnOffSwitch,
      clusters: {
        onOff: {
          onOff: this.anyPartOn(partStates),
        },
      },
      handlers: this.buildMatterHandlers(platform, identity.context),
    };

    if (powerCodes.length > 1) {
      accessory.parts = powerCodes.map((dpCode, index) => ({
        id: dpCode,
        displayName: this.buildMatterPartName(device, dpCode, index),
        deviceType: bridge.api.matter.deviceTypes.OnOffSwitch,
        clusters: {
          onOff: {
            onOff: partStates.get(dpCode) || false,
          },
        },
        handlers: this.buildMatterPartHandlers(
          platform,
          identity.context,
          dpCode,
        ),
      }));
    }

    return accessory;
  }

  static rebindMatterAccessory(platform, accessory) {
    if (!accessory?.context) {
      return;
    }

    accessory.handlers = this.buildMatterHandlers(platform, accessory.context);

    if (Array.isArray(accessory.parts)) {
      for (const part of accessory.parts) {
        if (!part?.id) {
          continue;
        }
        part.handlers = this.buildMatterPartHandlers(
          platform,
          accessory.context,
          part.id,
        );
      }
    }
  }

  static buildMatterHandlers(platform, context) {
    return {
      onOff: {
        on: async () => {
          await this.setMatterPower(platform, context, true);
        },
        off: async () => {
          await this.setMatterPower(platform, context, false);
        },
      },
    };
  }

  static buildMatterPartHandlers(platform, context, dpCode) {
    return {
      onOff: {
        on: async () => {
          await this.setMatterPartPower(platform, context, dpCode, true);
        },
        off: async () => {
          await this.setMatterPartPower(platform, context, dpCode, false);
        },
      },
    };
  }

  static async syncMatterState(bridge, accessory, device) {
    if (!accessory?.UUID || !accessory?.context) {
      return;
    }

    const powerCodes = this.getMatterPowerCodesFromContext(
      accessory.context,
      device,
      bridge,
    );
    if (powerCodes.length === 0) {
      return;
    }

    const partStates = this.readMatterPartStates(device, powerCodes, bridge);
    const anyOn = this.anyPartOn(partStates);

    await bridge.api.matter.updateAccessoryState(
      accessory.UUID,
      bridge.api.matter.clusterNames.OnOff,
      { onOff: anyOn },
    );

    if (!Array.isArray(accessory.parts) || accessory.parts.length === 0) {
      return;
    }

    for (const dpCode of powerCodes) {
      await bridge.api.matter.updateAccessoryState(
        accessory.UUID,
        bridge.api.matter.clusterNames.OnOff,
        { onOff: partStates.get(dpCode) || false },
        dpCode,
      );
    }
  }

  static hasDifferentMatterShape(existing, created) {
    const existingParts = Array.isArray(existing?.parts) ? existing.parts : [];
    const createdParts = Array.isArray(created?.parts) ? created.parts : [];

    if (existingParts.length !== createdParts.length) {
      return true;
    }

    for (let i = 0; i < existingParts.length; i += 1) {
      if (existingParts[i]?.id !== createdParts[i]?.id) {
        return true;
      }
    }

    return false;
  }

  static getMatterPowerCodes(device, bridge) {
    const entries = bridge.extractStatusEntries(device);
    const functions = Array.isArray(device?.functions)
      ? device.functions
      : Array.isArray(device?.function)
        ? device.function
        : [];

    const codes = new Set();
    const isSwitchCode = (code) =>
      typeof code === "string" && /^(switch(?:_\d+)?)$/.test(code);

    for (const entry of [...entries, ...functions]) {
      const code = entry?.code;
      if (isSwitchCode(code)) {
        codes.add(code);
      }
    }

    if (codes.size === 0) {
      const fallback = bridge.pickSupportedCode(device, ["switch_1", "switch"]);
      if (fallback) {
        codes.add(fallback);
      }
    }

    return Array.from(codes).sort(this.compareMatterPowerCodes);
  }

  static getMatterPowerCodesFromContext(context, device, bridge) {
    if (Array.isArray(context?.powerCodes) && context.powerCodes.length > 0) {
      return [...context.powerCodes].sort(this.compareMatterPowerCodes);
    }

    return this.getMatterPowerCodes(device, bridge);
  }

  static compareMatterPowerCodes(a, b) {
    const rank = (code) => {
      if (code === "switch") {
        return 0;
      }

      const match = /^switch_(\d+)$/.exec(code || "");
      if (match) {
        return Number(match[1]);
      }

      return Number.MAX_SAFE_INTEGER;
    };

    return rank(a) - rank(b) || String(a).localeCompare(String(b));
  }

  static readMatterPartStates(device, powerCodes, bridge) {
    const states = new Map();

    for (const dpCode of powerCodes) {
      states.set(
        dpCode,
        bridge.toBoolean(bridge.getStatusValue(device, dpCode), false),
      );
    }

    return states;
  }

  static anyPartOn(partStates) {
    for (const value of partStates.values()) {
      if (value) {
        return true;
      }
    }

    return false;
  }

  static buildMatterPartName(device, dpCode, index) {
    const baseName = device?.name || "Switch";
    if (dpCode === "switch") {
      return baseName;
    }

    const match = /^switch_(\d+)$/.exec(dpCode || "");
    if (match) {
      return `${baseName} ${match[1]}`;
    }

    return `${baseName} ${index + 1}`;
  }

  static async setMatterPower(platform, context, value) {
    const powerCodes = this.getMatterPowerCodesFromContext(context, null, {
      extractStatusEntries: () => [],
      pickSupportedCode: () => null,
    });

    const commands =
      powerCodes.length > 1
        ? powerCodes.map((code) => ({ code, value }))
        : [{ code: context?.powerCode || powerCodes[0], value }].filter(
            (command) => command.code,
          );

    if (commands.length === 0) {
      throw new Error(
        `No Tuya switch datapoint found for device ${context?.deviceId}`,
      );
    }

    await platform.tuyaOpenApi.sendCommand(context.deviceId, { commands });
  }

  static async setMatterPartPower(platform, context, dpCode, value) {
    if (!dpCode) {
      throw new Error(
        `No Tuya switch datapoint found for device ${context?.deviceId}`,
      );
    }

    await platform.tuyaOpenApi.sendCommand(context.deviceId, {
      commands: [{ code: dpCode, value }],
    });
  }
}

export default SwitchAccessory;
