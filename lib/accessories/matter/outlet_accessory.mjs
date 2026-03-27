"use strict";

import {
  baseIdentity,
  comparePartShape,
  getGangCodes,
  getStatusValue,
  partLabel,
  toBoolean,
  toPartId,
} from "./_shared.mjs";

const CATEGORIES = new Set(["cz", "pc"]);

export default class OutletMatterAccessory {
  static id = "outlet";

  static matches(device) {
    return CATEGORIES.has(device?.category);
  }

  static create(platform, bridge, device) {
    const gangCodes = getGangCodes(device);
    if (gangCodes.length === 0) return null;

    const context = {
      matterAccessoryType: this.id,
      gangCodes,
      multiGang: gangCodes.length > 1,
    };

    const accessory = {
      ...baseIdentity(bridge, device, context),
      deviceType: platform.api.matter.deviceTypes.OnOffOutlet,
      clusters: gangCodes.length === 1
        ? { onOff: { onOff: toBoolean(getStatusValue(device, gangCodes[0]), false) } }
        : {},
      handlers: gangCodes.length === 1
        ? {
            onOff: {
              on: async () => bridge.sendCommands(device.id, [{ code: gangCodes[0], value: true }]),
              off: async () => bridge.sendCommands(device.id, [{ code: gangCodes[0], value: false }]),
            },
          }
        : {},
    };

    if (gangCodes.length > 1) {
      accessory.parts = gangCodes.map((code, index) => ({
        id: toPartId(code, this.id),
        displayName: partLabel("Outlet", index),
        deviceType: platform.api.matter.deviceTypes.OnOffOutlet,
        clusters: { onOff: { onOff: toBoolean(getStatusValue(device, code), false) } },
        handlers: {
          onOff: {
            on: async () => bridge.sendCommands(device.id, [{ code, value: true }]),
            off: async () => bridge.sendCommands(device.id, [{ code, value: false }]),
          },
        },
      }));
    }

    return accessory;
  }

  static rebind(platform, bridge, accessory, device) {
    if (!(accessory.context?.multiGang)) {
      const code = accessory.context?.gangCodes?.[0];
      accessory.handlers = {
        onOff: {
          on: async () => bridge.sendCommands(accessory.context.deviceId, [{ code, value: true }]),
          off: async () => bridge.sendCommands(accessory.context.deviceId, [{ code, value: false }]),
        },
      };
      return;
    }

    const gangCodes = accessory.context?.gangCodes || [];
    accessory.parts = gangCodes.map((code, index) => ({
      id: toPartId(code, this.id),
      displayName: partLabel("Outlet", index),
      deviceType: platform.api.matter.deviceTypes.OnOffOutlet,
      clusters: { onOff: { onOff: toBoolean(getStatusValue(device, code), false) } },
      handlers: {
        onOff: {
          on: async () => bridge.sendCommands(accessory.context.deviceId, [{ code, value: true }]),
          off: async () => bridge.sendCommands(accessory.context.deviceId, [{ code, value: false }]),
        },
      },
    }));
  }

  static hasDifferentShape(existing, created) {
    return comparePartShape(existing, created);
  }

  static async sync(platform, bridge, accessory, device) {
    const uuid = accessory.UUID;
    const gangCodes = accessory.context?.gangCodes || [];

    if (!(accessory.context?.multiGang)) {
      const code = gangCodes[0];
      await bridge.safeUpdateAccessoryState(uuid, platform.api.matter.clusterNames.OnOff, {
        onOff: toBoolean(getStatusValue(device, code), false),
      });
      return;
    }

    for (const code of gangCodes) {
      await bridge.safeUpdateAccessoryState(
        uuid,
        platform.api.matter.clusterNames.OnOff,
        { onOff: toBoolean(getStatusValue(device, code), false) },
        { partId: toPartId(code, this.id) },
      );
    }
  }
}
