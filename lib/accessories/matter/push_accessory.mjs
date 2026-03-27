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

export default class PushMatterAccessory {
  static id = "push";

  static matches(device) {
    return device?.category === "szjqr";
  }

  static create(platform, bridge, device) {
    const gangCodes = getGangCodes(device);
    if (gangCodes.length === 0) return null;

    const context = {
      matterAccessoryType: this.id,
      gangCodes,
      multiGang: gangCodes.length > 1,
    };

    const makePulseHandler = (deviceId, code, uuid, partId) => async () => {
      await bridge.sendCommands(deviceId, [{ code, value: true }]);
      if (partId) {
        await bridge.safeUpdateAccessoryState(uuid, platform.api.matter.clusterNames.OnOff, { onOff: true }, { partId });
        setTimeout(() => bridge.safeUpdateAccessoryState(uuid, platform.api.matter.clusterNames.OnOff, { onOff: false }, { partId }), 500);
      } else {
        await bridge.safeUpdateAccessoryState(uuid, platform.api.matter.clusterNames.OnOff, { onOff: true });
        setTimeout(() => bridge.safeUpdateAccessoryState(uuid, platform.api.matter.clusterNames.OnOff, { onOff: false }), 500);
      }
    };

    const accessory = {
      ...baseIdentity(bridge, device, context),
      deviceType: platform.api.matter.deviceTypes.OnOffSwitch,
      clusters: gangCodes.length === 1 ? { onOff: { onOff: false } } : {},
      handlers: gangCodes.length === 1
        ? { onOff: { on: makePulseHandler(device.id, gangCodes[0], bridge.uuidFor(device.id)), off: async () => {} } }
        : {},
    };

    if (gangCodes.length > 1) {
      accessory.parts = gangCodes.map((code, index) => ({
        id: toPartId(code, this.id),
        displayName: partLabel("Push", index),
        deviceType: platform.api.matter.deviceTypes.OnOffSwitch,
        clusters: { onOff: { onOff: false } },
        handlers: {
          onOff: {
            on: makePulseHandler(device.id, code, bridge.uuidFor(device.id), toPartId(code, this.id)),
            off: async () => {},
          },
        },
      }));
    }

    return accessory;
  }

  static rebind(platform, bridge, accessory) {
    const deviceId = accessory.context?.deviceId;
    const gangCodes = accessory.context?.gangCodes || [];
    const makePulseHandler = (code, partId) => async () => {
      await bridge.sendCommands(deviceId, [{ code, value: true }]);
      if (partId) {
        await bridge.safeUpdateAccessoryState(accessory.UUID, platform.api.matter.clusterNames.OnOff, { onOff: true }, { partId });
        setTimeout(() => bridge.safeUpdateAccessoryState(accessory.UUID, platform.api.matter.clusterNames.OnOff, { onOff: false }, { partId }), 500);
      } else {
        await bridge.safeUpdateAccessoryState(accessory.UUID, platform.api.matter.clusterNames.OnOff, { onOff: true });
        setTimeout(() => bridge.safeUpdateAccessoryState(accessory.UUID, platform.api.matter.clusterNames.OnOff, { onOff: false }), 500);
      }
    };

    if (!(accessory.context?.multiGang)) {
      accessory.handlers = { onOff: { on: makePulseHandler(gangCodes[0]), off: async () => {} } };
      return;
    }

    accessory.parts = gangCodes.map((code, index) => ({
      id: toPartId(code, this.id),
      displayName: partLabel("Push", index),
      deviceType: platform.api.matter.deviceTypes.OnOffSwitch,
      clusters: { onOff: { onOff: false } },
      handlers: { onOff: { on: makePulseHandler(code, toPartId(code, this.id)), off: async () => {} } },
    }));
  }

  static hasDifferentShape(existing, created) {
    return comparePartShape(existing, created);
  }

  static async sync(platform, bridge, accessory, device) {
    const gangCodes = accessory.context?.gangCodes || [];
    const entries = gangCodes.filter((code) => toBoolean(getStatusValue(device, code), false));
    if (!(accessory.context?.multiGang)) {
      if (entries.length === 0) return;
      await bridge.safeUpdateAccessoryState(accessory.UUID, platform.api.matter.clusterNames.OnOff, { onOff: true });
      setTimeout(() => bridge.safeUpdateAccessoryState(accessory.UUID, platform.api.matter.clusterNames.OnOff, { onOff: false }), 500);
      return;
    }
    for (const code of entries) {
      const partId = toPartId(code, this.id);
      await bridge.safeUpdateAccessoryState(accessory.UUID, platform.api.matter.clusterNames.OnOff, { onOff: true }, { partId });
      setTimeout(() => bridge.safeUpdateAccessoryState(accessory.UUID, platform.api.matter.clusterNames.OnOff, { onOff: false }, { partId }), 500);
    }
  }
}
