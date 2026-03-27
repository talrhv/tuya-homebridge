"use strict";

import {
  baseIdentity,
  getStatusValue,
  matterClosedPercent100thsToOpenPercent,
  readWindowOpenPercent,
  windowOpenPercentToMatterClosedPercent100ths,
} from "./_shared.mjs";

const CATEGORIES = new Set(["cl", "clkg"]);

export default class WindowCoveringMatterAccessory {
  static id = "window_covering";

  static matches(device) {
    return CATEGORIES.has(device?.category);
  }

  static create(platform, bridge, device) {
    const fullyOpenDefault =
      getStatusValue(device, "situation_set") === "fully_open" ||
      device.category === "clkg";
    const controlCode =
      getStatusValue(device, "percent_control") !== undefined ||
      bridge.hasCode(device, "percent_control")
        ? "percent_control"
        : bridge.hasCode(device, "position")
          ? "position"
          : "percent_control";
    const positionCode = bridge.hasCode(device, "percent_state")
      ? "percent_state"
      : controlCode;
    const openPercent = readWindowOpenPercent(device, {
      fullyOpenDefault,
      positionCode,
    });
    const closedPercent100ths = windowOpenPercentToMatterClosedPercent100ths(openPercent);

    return {
      ...baseIdentity(bridge, device, {
        matterAccessoryType: this.id,
        fullyOpenDefault,
        controlCode,
        positionCode,
      }),
      deviceType: platform.api.matter.deviceTypes.WindowCovering,
      clusters: {
        windowCovering: {
          currentPositionLiftPercent100ths: closedPercent100ths,
          targetPositionLiftPercent100ths: closedPercent100ths,
          operationalStatus: { global: 0, lift: 0, tilt: 0 },
          endProductType: 0,
          configStatus: {
            operational: true,
            onlineReserved: true,
            liftMovementReversed: false,
            liftPositionAware: true,
            tiltPositionAware: false,
            liftEncoderControlled: true,
            tiltEncoderControlled: false,
          },
        },
      },
      handlers: this.buildHandlers(platform, bridge, {
        deviceId: device.id,
        fullyOpenDefault,
        controlCode,
      }),
    };
  }

  static buildHandlers(platform, bridge, context) {
    return {
      windowCovering: {
        goToLiftPercentage: async ({ liftPercent100thsValue }) => {
          const openPercent = matterClosedPercent100thsToOpenPercent(liftPercent100thsValue);
          const tuyaPercent = context.fullyOpenDefault ? openPercent : 100 - openPercent;
          const value = context.controlCode === "position" ? String(tuyaPercent) : tuyaPercent;
          await bridge.sendCommands(context.deviceId, [{ code: context.controlCode, value }]);
        },
        upOrOpen: async () => {
          const openPercent = 100;
          const tuyaPercent = context.fullyOpenDefault ? openPercent : 100 - openPercent;
          const value = context.controlCode === "position" ? String(tuyaPercent) : tuyaPercent;
          await bridge.sendCommands(context.deviceId, [{ code: context.controlCode, value }]);
        },
        downOrClose: async () => {
          const openPercent = 0;
          const tuyaPercent = context.fullyOpenDefault ? openPercent : 100 - openPercent;
          const value = context.controlCode === "position" ? String(tuyaPercent) : tuyaPercent;
          await bridge.sendCommands(context.deviceId, [{ code: context.controlCode, value }]);
        },
      },
    };
  }

  static rebind(platform, bridge, accessory) {
    accessory.handlers = this.buildHandlers(platform, bridge, accessory.context ?? {});
  }

  static async sync(platform, bridge, accessory, device) {
    const openPercent = readWindowOpenPercent(device, accessory.context ?? {});
    const closedPercent100ths = windowOpenPercentToMatterClosedPercent100ths(openPercent);
    await bridge.safeUpdateAccessoryState(
      accessory.UUID,
      platform.api.matter.clusterNames.WindowCovering,
      {
        currentPositionLiftPercent100ths: closedPercent100ths,
        targetPositionLiftPercent100ths: closedPercent100ths,
      },
    );
  }
}
