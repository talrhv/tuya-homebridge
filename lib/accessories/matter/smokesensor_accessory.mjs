"use strict";

import { baseIdentity, readSmokeDetected } from "./_shared.mjs";

export default class SmokeSensorMatterAccessory {
  static id = "smoke";

  static matches(device) {
    return device?.category === "ywbj";
  }

  static create(platform, bridge, device) {
    const SmokeCoAlarmServer =
      platform.api.matter.deviceTypes.SmokeSensor?.requirements?.SmokeCoAlarmServer;
    const smokeDeviceType = SmokeCoAlarmServer?.with
      ? platform.api.matter.deviceTypes.SmokeSensor.with(
          SmokeCoAlarmServer.with("SmokeAlarm"),
        )
      : platform.api.matter.deviceTypes.SmokeSensor;
    const detected = readSmokeDetected(device);

    return {
      ...baseIdentity(bridge, device, { matterAccessoryType: this.id }),
      deviceType: smokeDeviceType,
      clusters: {
        smokeCoAlarm: {
          smokeState: detected ? 2 : 0,
          coState: 0,
          batteryAlert: 0,
          deviceMuted: 0,
          testInProgress: false,
          hardwareFaultAlert: false,
          endOfServiceAlert: 0,
          interconnectSmokeAlarm: 0,
          interconnectCoAlarm: 0,
          contaminationState: 0,
          smokeSensitivityLevel: 1,
          expressedState: detected ? 2 : 0,
        },
      },
    };
  }

  static async sync(platform, bridge, accessory, device) {
    const detected = readSmokeDetected(device);
    await bridge.safeUpdateAccessoryState(
      accessory.UUID,
      platform.api.matter.clusterNames.SmokeCoAlarm,
      { smokeState: detected ? 2 : 0, expressedState: detected ? 2 : 0 },
    );
  }
}
