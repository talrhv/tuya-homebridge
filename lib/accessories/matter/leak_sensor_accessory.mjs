"use strict";

import { baseIdentity, readLeakDetected } from "./_shared.mjs";

const CATEGORIES = new Set(["rqbj", "jwbj"]);

export default class LeakSensorMatterAccessory {
  static id = "leak";

  static matches(device) {
    return CATEGORIES.has(device?.category);
  }

  static create(platform, bridge, device) {
    return {
      ...baseIdentity(bridge, device, { matterAccessoryType: this.id }),
      deviceType: platform.api.matter.deviceTypes.LeakSensor,
      clusters: {
        booleanState: { stateValue: readLeakDetected(device) },
      },
    };
  }

  static async sync(platform, bridge, accessory, device) {
    await bridge.safeUpdateAccessoryState(
      accessory.UUID,
      platform.api.matter.clusterNames.BooleanState,
      { stateValue: readLeakDetected(device) },
    );
  }
}
