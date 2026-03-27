"use strict";

import { baseIdentity, getStatusValue, toBoolean } from "./_shared.mjs";

export default class GarageDoorMatterAccessory {
  static id = "garage";

  static matches(device) {
    return device?.category === "ckmkzq";
  }

  static create(platform, bridge, device) {
    const commandCode = bridge.hasCode(device, "switch_1") ? "switch_1" : null;
    if (!commandCode) return null;
    return {
      ...baseIdentity(bridge, device, { matterAccessoryType: this.id, commandCode, stateCode: "doorcontact_state" }),
      deviceType: platform.api.matter.deviceTypes.OnOffSwitch,
      clusters: { onOff: { onOff: toBoolean(getStatusValue(device, "doorcontact_state"), false) } },
      handlers: {
        onOff: {
          on: async () => bridge.sendCommands(device.id, [{ code: commandCode, value: true }]),
          off: async () => bridge.sendCommands(device.id, [{ code: commandCode, value: false }]),
        },
      },
    };
  }

  static rebind(platform, bridge, accessory) {
    const code = accessory.context?.commandCode;
    accessory.handlers = {
      onOff: {
        on: async () => bridge.sendCommands(accessory.context.deviceId, [{ code, value: true }]),
        off: async () => bridge.sendCommands(accessory.context.deviceId, [{ code, value: false }]),
      },
    };
  }

  static async sync(platform, bridge, accessory, device) {
    await bridge.safeUpdateAccessoryState(accessory.UUID, platform.api.matter.clusterNames.OnOff, {
      onOff: toBoolean(getStatusValue(device, accessory.context?.stateCode || "doorcontact_state"), false),
    });
  }
}
