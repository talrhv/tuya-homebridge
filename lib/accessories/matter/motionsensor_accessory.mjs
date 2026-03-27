"use strict";

import { baseIdentity, hasCode, readMotionDetected } from "./_shared.mjs";

export default class MotionSensorMatterAccessory {
  static id = "motion";

  static matches(device) {
    return device?.category === "pir";
  }

  static canCreate(platform, bridge, device) {
    return Boolean(bridge.getMotionConfig(device?.id));
  }

  static create(platform, bridge, device) {
    const motionConfig = bridge.getMotionConfig(device.id);
    const MotionSensor = platform.api.matter.deviceTypes.MotionSensor;
    const OccupancySensingServer = MotionSensor?.requirements?.OccupancySensingServer;
    const motionDeviceType = OccupancySensingServer?.with
      ? MotionSensor.with(OccupancySensingServer.with("PassiveInfrared"))
      : MotionSensor;

    return {
      ...baseIdentity(bridge, device, {
        matterAccessoryType: this.id,
        overrideTime: Number(motionConfig?.overrideTuya || 0),
        hasInternalTimeSensor: hasCode(device, "pir_time"),
      }),
      deviceType: motionDeviceType,
      clusters: {
        occupancySensing: {
          occupancy: { occupied: readMotionDetected(device) },
          occupancySensorType: 0,
          occupancySensorTypeBitmap: {
            pir: true,
            ultrasonic: false,
            physicalContact: false,
          },
        },
      },
    };
  }

  static async sync(platform, bridge, accessory, device) {
    const uuid = accessory.UUID;
    const occupied = readMotionDetected(device);
    const overrideTime = Number(accessory.context?.overrideTime || 0);
    const hasInternalTimeSensor = accessory.context?.hasInternalTimeSensor === true;

    if (occupied && overrideTime > 0 && !hasInternalTimeSensor) {
      await bridge.safeUpdateAccessoryState(
        uuid,
        platform.api.matter.clusterNames.OccupancySensing,
        { occupancy: { occupied: true } },
      );

      const bucket = bridge.getRuntimeBucket("motionOffTimers");
      const previous = bucket.get(uuid);
      if (previous) clearTimeout(previous);
      const timer = setTimeout(async () => {
        try {
          await bridge.safeUpdateAccessoryState(
            uuid,
            platform.api.matter.clusterNames.OccupancySensing,
            { occupancy: { occupied: false } },
          );
        } finally {
          bucket.delete(uuid);
        }
      }, overrideTime * 1000);
      bucket.set(uuid, timer);
      return;
    }

    await bridge.safeUpdateAccessoryState(
      uuid,
      platform.api.matter.clusterNames.OccupancySensing,
      { occupancy: { occupied } },
    );
  }
}
