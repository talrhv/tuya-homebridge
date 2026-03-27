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

    // Explicitly define the Water Valve device type
    const deviceType = platform.api.matter.deviceTypes.WaterValve;

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
        // Replace OnOff with the native Matter Valve cluster
        valveConfigurationAndControl: {
          currentState: isOpen ? 1 : 0, // 1 = Open, 0 = Closed
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
    return {
      // Handlers must match the new cluster name and commands
      valveConfigurationAndControl: {
        open: async (args) => {
          const commands = [{ code: context.switchCode, value: true }];

          // Matter passes the requested duration (from the slider) inside the command request
          const reqDuration = args?.request?.openDuration ?? args?.openDuration;

          if (
            context.countdownCode &&
            typeof reqDuration === "number" &&
            reqDuration > 0
          ) {
            commands.push({ code: context.countdownCode, value: reqDuration });
          }

          await bridge.sendCommands(context.deviceId, commands);
        },
        close: async () => {
          await bridge.sendCommands(context.deviceId, [
            { code: context.switchCode, value: false },
          ]);
        },
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

    // Use a hardcoded string fallback in case clusterNames.ValveConfigurationAndControl isn't fully exported in your beta version
    const clusterName =
      platform.api.matter.clusterNames.ValveConfigurationAndControl ||
      "valveConfigurationAndControl";

    await bridge.safeUpdateAccessoryState(accessory.UUID, clusterName, {
      currentState: isOpen ? 1 : 0,
      targetState: isOpen ? 1 : 0,
      openDuration: isOpen && remaining > 0 ? remaining : null,
      remainingDuration: isOpen && remaining > 0 ? remaining : null,
    });
  }
}
