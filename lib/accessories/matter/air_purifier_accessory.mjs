"use strict";

import { baseIdentity, getStatusValue, toBoolean } from "./_shared.mjs";

export default class AirPurifierMatterAccessory {
  static id = "air_purifier";

  static matches(device) {
    return device?.category === "kj";
  }

  static create(platform, bridge, device) {
    const powerCode = bridge.hasCode(device, "switch") ? "switch" : null;
    if (!powerCode) return null;
    return {
      ...baseIdentity(bridge, device, { matterAccessoryType: this.id, powerCode }),
      deviceType: platform.api.matter.deviceTypes.OnOffSwitch,
      clusters: { onOff: { onOff: toBoolean(getStatusValue(device, powerCode), false) } },
      handlers: {
        onOff: {
          on: async () => bridge.sendCommands(device.id, [{ code: powerCode, value: true }]),
          off: async () => bridge.sendCommands(device.id, [{ code: powerCode, value: false }]),
        },
      },
    };
  }

  static rebind(platform, bridge, accessory) {
    const code = accessory.context?.powerCode;
    accessory.handlers = {
      onOff: {
        on: async () => bridge.sendCommands(accessory.context.deviceId, [{ code, value: true }]),
        off: async () => bridge.sendCommands(accessory.context.deviceId, [{ code, value: false }]),
      },
    };
  }

  static async sync(platform, bridge, accessory, device) {
    await bridge.safeUpdateAccessoryState(accessory.UUID, platform.api.matter.clusterNames.OnOff, {
      onOff: toBoolean(getStatusValue(device, accessory.context?.powerCode), false),
    });
  }
}
