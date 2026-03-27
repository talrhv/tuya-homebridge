"use strict";

import {
  baseIdentity,
  pickSupportedCode,
  POWER_CODES,
  BRIGHTNESS_CODES,
  COLOR_TEMP_CODES,
  COLOR_CODES,
  WORK_MODE_CODES,
  getStatusValue,
  readBrightnessPercent,
  readColorTempPercent,
  readHsColor,
  toBoolean,
  percentToMatterLevel,
  matterLevelToPercent,
  colorTempPercentToMireds,
  miredsToColorTempPercent,
  degreesToMatterHue,
  matterHueToDegrees,
  percentToMatterSat,
  matterSatToPercent,
  getNumericRangeForCode,
  percentToRange,
} from "./_shared.mjs";

const CATEGORIES = new Set(["dj", "dd", "fwd", "tgq", "xdd", "dc", "tgkg"]);

export default class LightMatterAccessory {
  static id = "light";

  static matches(device) {
    return CATEGORIES.has(device?.category);
  }

  static create(platform, bridge, device) {
    const powerCode = pickSupportedCode(device, POWER_CODES);
    if (!powerCode) return null;

    const brightnessCode = pickSupportedCode(device, BRIGHTNESS_CODES);
    const tempCode = pickSupportedCode(device, COLOR_TEMP_CODES);
    const colorCode = pickSupportedCode(device, COLOR_CODES);
    const workModeCode = pickSupportedCode(device, WORK_MODE_CODES);

    const supportsBrightness = Boolean(brightnessCode);
    const supportsColorTemp = Boolean(tempCode);
    const supportsColor = Boolean(colorCode);

    const deviceType = supportsColor
      ? platform.api.matter.deviceTypes.ExtendedColorLight
      : supportsColorTemp
        ? platform.api.matter.deviceTypes.ColorTemperatureLight
        : supportsBrightness
          ? platform.api.matter.deviceTypes.DimmableLight
          : platform.api.matter.deviceTypes.OnOffLight;

    const context = {
      matterAccessoryType: this.id,
      powerCode,
      brightnessCode,
      tempCode,
      colorCode,
      workModeCode,
      supportsBrightness,
      supportsColorTemp,
      supportsColor,
    };

    const accessory = {
      ...baseIdentity(bridge, device, context),
      deviceType,
      clusters: {
        onOff: {
          onOff: toBoolean(getStatusValue(device, powerCode), false),
        },
      },
      handlers: this.buildHandlers(platform, bridge, context, device),
    };

    if (supportsBrightness) {
      accessory.clusters.levelControl = {
        currentLevel: percentToMatterLevel(readBrightnessPercent(device, brightnessCode)),
        minLevel: 1,
        maxLevel: 254,
      };
    }

    if (supportsColor || supportsColorTemp) {
      accessory.clusters.colorControl = {};
    }

    if (supportsColorTemp) {
      accessory.clusters.colorControl.colorTemperatureMireds = colorTempPercentToMireds(
        readColorTempPercent(device, tempCode),
      );
      accessory.clusters.colorControl.colorTempPhysicalMinMireds = 147;
      accessory.clusters.colorControl.colorTempPhysicalMaxMireds = 454;
      accessory.clusters.colorControl.colorMode =
        platform.api.matter.types.ColorControl.ColorMode.ColorTemperatureMireds;
    }

    if (supportsColor) {
      const hsColor = readHsColor(device, colorCode);
      if (hsColor) {
        accessory.clusters.colorControl.currentHue = degreesToMatterHue(hsColor.h);
        accessory.clusters.colorControl.currentSaturation = percentToMatterSat(hsColor.s);
        accessory.clusters.colorControl.colorMode =
          platform.api.matter.types.ColorControl.ColorMode.CurrentHueAndCurrentSaturation;
      }
    }

    return accessory;
  }

  static rebind(platform, bridge, accessory, device) {
    accessory.handlers = this.buildHandlers(platform, bridge, accessory.context ?? {}, device);
  }

  static buildHandlers(platform, bridge, context, discoveredDevice) {
    const handlers = {
      onOff: {
        on: async () => bridge.sendCommands(context.deviceId, [{ code: context.powerCode, value: true }]),
        off: async () => bridge.sendCommands(context.deviceId, [{ code: context.powerCode, value: false }]),
      },
    };

    if (context.supportsBrightness && context.brightnessCode) {
      handlers.levelControl = {
        moveToLevelWithOnOff: async ({ level }) => {
          const source = discoveredDevice ?? bridge.latestDevices.get(context.deviceId);
          const range = getNumericRangeForCode(source, context.brightnessCode, 10, 1000);
          const value = percentToRange(matterLevelToPercent(level), range.min, range.max);
          await bridge.sendCommands(context.deviceId, [{ code: context.brightnessCode, value }]);
        },
      };
    }

    if (context.supportsColor || context.supportsColorTemp) {
      handlers.colorControl = {};
    }

    if (context.supportsColorTemp && context.tempCode) {
      handlers.colorControl.moveToColorTemperatureLogic = async ({ colorTemperatureMireds }) => {
        const source = discoveredDevice ?? bridge.latestDevices.get(context.deviceId);
        const range = getNumericRangeForCode(source, context.tempCode, 0, 1000);
        const value = percentToRange(miredsToColorTempPercent(colorTemperatureMireds), range.min, range.max);
        const commands = [{ code: context.tempCode, value }];
        if (context.workModeCode) commands.push({ code: context.workModeCode, value: "white" });
        await bridge.sendCommands(context.deviceId, commands);
      };
    }

    if (context.supportsColor && context.colorCode) {
      handlers.colorControl.moveToHueAndSaturationLogic = async ({ hue, saturation }) => {
        const source = discoveredDevice ?? bridge.latestDevices.get(context.deviceId);
        const brightnessPercent = context.brightnessCode
          ? readBrightnessPercent(source, context.brightnessCode)
          : 100;
        const commands = [{
          code: context.colorCode,
          value: JSON.stringify({
            h: matterHueToDegrees(hue),
            s: Math.max(0, Math.min(1000, Math.round(matterSatToPercent(saturation) * 10))),
            v: Math.max(0, Math.min(1000, Math.round(brightnessPercent * 10))),
          }),
        }];
        if (context.workModeCode) commands.push({ code: context.workModeCode, value: "colour" });
        await bridge.sendCommands(context.deviceId, commands);
      };
    }

    return handlers;
  }

  static async sync(platform, bridge, accessory, device) {
    const uuid = accessory.UUID;
    const context = accessory.context ?? {};

    await bridge.safeUpdateAccessoryState(uuid, platform.api.matter.clusterNames.OnOff, {
      onOff: toBoolean(getStatusValue(device, context.powerCode), false),
    });

    if (context.supportsBrightness && context.brightnessCode) {
      await bridge.safeUpdateAccessoryState(uuid, platform.api.matter.clusterNames.LevelControl, {
        currentLevel: percentToMatterLevel(readBrightnessPercent(device, context.brightnessCode)),
      });
    }

    if ((context.supportsColorTemp || context.supportsColor) && platform.api.matter.clusterNames.ColorControl) {
      const colorState = {};
      if (context.supportsColorTemp && context.tempCode) {
        colorState.colorTemperatureMireds = colorTempPercentToMireds(readColorTempPercent(device, context.tempCode));
      }
      if (context.supportsColor && context.colorCode) {
        const hsColor = readHsColor(device, context.colorCode);
        if (hsColor) {
          colorState.currentHue = degreesToMatterHue(hsColor.h);
          colorState.currentSaturation = percentToMatterSat(hsColor.s);
        }
      }
      if (Object.keys(colorState).length > 0) {
        const workMode = getStatusValue(device, context.workModeCode || WORK_MODE_CODES);
        colorState.colorMode =
          context.supportsColor && (workMode === "colour" || (colorState.currentHue !== undefined && colorState.currentSaturation !== undefined))
            ? platform.api.matter.types.ColorControl.ColorMode.CurrentHueAndCurrentSaturation
            : platform.api.matter.types.ColorControl.ColorMode.ColorTemperatureMireds;

        await bridge.safeUpdateAccessoryState(uuid, platform.api.matter.clusterNames.ColorControl, colorState);
      }
    }
  }
}
