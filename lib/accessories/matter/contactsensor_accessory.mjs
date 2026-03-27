"use strict";

import { baseIdentity, readContactOpen } from "./_shared.mjs";

export default class ContactSensorMatterAccessory {
  static id = "contact";

  static matches(device) {
    return device?.category === "mcs";
  }

  static create(platform, bridge, device) {
    return {
      ...baseIdentity(bridge, device, { matterAccessoryType: this.id }),
      deviceType: platform.api.matter.deviceTypes.ContactSensor,
      clusters: {
        booleanState: { stateValue: !readContactOpen(device) },
      },
    };
  }

  static async sync(platform, bridge, accessory, device) {
    await bridge.safeUpdateAccessoryState(
      accessory.UUID,
      platform.api.matter.clusterNames.BooleanState,
      { stateValue: !readContactOpen(device) },
    );
  }
}
