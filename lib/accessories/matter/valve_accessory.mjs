"use strict";

import {
  baseIdentity,
  getGangCodes,
  getCountdownCodes,
  getStatusValue,
  toBoolean,
} from "./_shared.mjs";

export default class ValveMatterAccessory {
  static id = "valve";

  static matches(device) {
    return device?.category === "kg";
  }

  static canCreate(platform, bridge, device) {
    return bridge.isValveDevice(device);
  }

  static create(platform, bridge, device) {
    const switchCode = getGangCodes(device)[0] || "switch_1";
    const countdownCode = getCountdownCodes(device)[0] || null;

    // Dynamically check if the Homebridge beta supports WaterValve yet
    const supportsValve = !!platform.api.matter.deviceTypes.WaterValve;
    const deviceType = supportsValve
      ? platform.api.matter.deviceTypes.WaterValve
      : platform.api.matter.deviceTypes.OnOffSwitch;

    const isOpen = toBoolean(getStatusValue(device, switchCode), false);
    const remaining = Number(getStatusValue(device, countdownCode)) || 0;

    const clusters = {
      onOff: { onOff: isOpen },
    };

    // Only inject the Valve cluster if the framework explicitly supports it
    if (supportsValve) {
      clusters.valveConfigurationAndControl = {
        currentState: isOpen ? 1 : 0,
        targetState: isOpen ? 1 : 0,
        openDuration:
          countdownCode && isOpen && remaining > 0 ? remaining : null,
        remainingDuration:
          countdownCode && isOpen && remaining > 0 ? remaining : null,
      };
    }

    return {
      ...baseIdentity(bridge, device, {
        matterAccessoryType: this.id,
        switchCode,
        countdownCode,
        supportsValve,
      }),
      deviceType,
      clusters,
      handlers: this.buildHandlers(platform, bridge, {
        deviceId: device.id,
        switchCode,
        countdownCode,
        supportsValve,
      }),
    };
  }

  static buildHandlers(platform, bridge, context) {
    const turnOn = async (reqDuration = null) => {
      const commands = [{ code: context.switchCode, value: true }];
      if (
        context.countdownCode &&
        typeof reqDuration === "number" &&
        reqDuration > 0
      ) {
        commands.push({ code: context.countdownCode, value: reqDuration });
      }
      await bridge.sendCommands(context.deviceId, commands);
    };

    const turnOff = async () => {
      await bridge.sendCommands(context.deviceId, [
        { code: context.switchCode, value: false },
      ]);
    };

    const handlers = {
      onOff: {
        on: async () => turnOn(),
        off: async () => turnOff(),
      },
    };

    if (context.supportsValve) {
      handlers.valveConfigurationAndControl = {
        open: async (args) => {
          const reqDuration = args?.request?.openDuration ?? args?.openDuration;
          await turnOn(reqDuration);
        },
        close: async () => turnOff(),
      };
    }

    return handlers;
  }

  static rebind(platform, bridge, accessory) {
    accessory.handlers = this.buildHandlers(
      platform,
      bridge,
      accessory.context ?? {},
    );
  }

  static async sync(platform, bridge, accessory, device) {
    const switchCode = accessory.context?.switchCode;
    const countdownCode = accessory.context?.countdownCode;
    const supportsValve = accessory.context?.supportsValve;

    const isOpen = toBoolean(getStatusValue(device, switchCode), false);
    const remaining = countdownCode
      ? Number(getStatusValue(device, countdownCode)) || 0
      : null;

    // 1. Always safely sync the Switch status
    await bridge.safeUpdateAccessoryState(
      accessory.UUID,
      platform.api.matter.clusterNames.OnOff,
      { onOff: isOpen },
    );

    // 2. Only sync the Valve cluster if it was successfully created during initialization
    if (supportsValve) {
      const valveCluster =
        platform.api.matter.clusterNames.ValveConfigurationAndControl ||
        "valveConfigurationAndControl";
      await bridge.safeUpdateAccessoryState(accessory.UUID, valveCluster, {
        currentState: isOpen ? 1 : 0,
        targetState: isOpen ? 1 : 0,
        openDuration: isOpen && remaining > 0 ? remaining : null,
        remainingDuration: isOpen && remaining > 0 ? remaining : null,
      });
    }
  }
}
