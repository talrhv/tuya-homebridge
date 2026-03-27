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

    // Fallback to OnOffSwitch if WaterValve is not yet exported in this Homebridge beta version
    const deviceType =
      platform.api.matter.deviceTypes.WaterValve ||
      platform.api.matter.deviceTypes.OnOffSwitch;

    const isOpen = toBoolean(getStatusValue(device, switchCode), false);
    const remaining = Number(getStatusValue(device, countdownCode)) || 0;

    return {
      ...baseIdentity(bridge, device, {
        matterAccessoryType: this.id,
        switchCode,
        countdownCode,
      }),
      deviceType,
      clusters: {
        // We include OnOff to satisfy the Matter specification if it falls back to a Switch
        onOff: {
          onOff: isOpen,
        },
        // We include the Valve cluster to give Apple Home the valve properties (Slider, Duration)
        valveConfigurationAndControl: {
          currentState: isOpen ? 1 : 0,
          targetState: isOpen ? 1 : 0,
          openDuration:
            countdownCode && isOpen && remaining > 0 ? remaining : null,
          remainingDuration:
            countdownCode && isOpen && remaining > 0 ? remaining : null,
        },
      },
      handlers: this.buildHandlers(platform, bridge, {
        deviceId: device.id,
        switchCode,
        countdownCode,
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

    return {
      // Handlers for the Switch fallback
      onOff: {
        on: async () => turnOn(),
        off: async () => turnOff(),
      },
      // Handlers for the Valve cluster
      valveConfigurationAndControl: {
        open: async (args) => {
          const reqDuration = args?.request?.openDuration ?? args?.openDuration;
          await turnOn(reqDuration);
        },
        close: async () => turnOff(),
      },
    };
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

    const isOpen = toBoolean(getStatusValue(device, switchCode), false);
    const remaining = countdownCode
      ? Number(getStatusValue(device, countdownCode)) || 0
      : null;

    // 1. Sync the fallback switch state
    await bridge.safeUpdateAccessoryState(
      accessory.UUID,
      platform.api.matter.clusterNames.OnOff,
      { onOff: isOpen },
    );

    // 2. Sync the Valve cluster state safely
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
