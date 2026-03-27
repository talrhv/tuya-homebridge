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
    const deviceType = platform.api.matter.deviceTypes.WaterValve || platform.api.matter.deviceTypes.OnOffSwitch;

    return {
      ...baseIdentity(bridge, device, {
        matterAccessoryType: this.id,
        switchCode,
        countdownCode,
      }),
      deviceType,
      clusters: {
        onOff: {
          onOff: toBoolean(getStatusValue(device, switchCode), false),
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
      onOff: {
        on: async () => {
          const commands = [{ code: context.switchCode, value: true }];
          const currentDevice = bridge.latestDevices.get(context.deviceId);
          const countdownValue = context.countdownCode ? getStatusValue(currentDevice, context.countdownCode) : undefined;
          if (context.countdownCode && Number.isFinite(Number(countdownValue)) && Number(countdownValue) > 0) {
            commands.push({ code: context.countdownCode, value: Number(countdownValue) });
          }
          await bridge.sendCommands(context.deviceId, commands);
        },
        off: async () => bridge.sendCommands(context.deviceId, [{ code: context.switchCode, value: false }]),
      },
    };
  }

  static rebind(platform, bridge, accessory) {
    accessory.handlers = this.buildHandlers(platform, bridge, accessory.context ?? {});
  }

  static async sync(platform, bridge, accessory, device) {
    await bridge.safeUpdateAccessoryState(accessory.UUID, platform.api.matter.clusterNames.OnOff, {
      onOff: toBoolean(getStatusValue(device, accessory.context?.switchCode), false),
    });
  }
}
