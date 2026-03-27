"use strict";

const LIGHT_CATEGORIES = new Set(["dj", "dd", "fwd", "tgq", "xdd", "dc", "tgkg"]);
const OUTLET_CATEGORIES = new Set(["cz", "pc"]);
const SWITCH_CATEGORIES = new Set(["tdq", "dlq", "kg", "qn"]);
const WINDOW_CATEGORIES = new Set(["cl", "clkg"]);
const CONTACT_CATEGORIES = new Set(["mcs"]);
const LEAK_CATEGORIES = new Set(["rqbj", "jwbj"]);
const SMOKE_CATEGORIES = new Set(["ywbj"]);
const MOTION_CATEGORIES = new Set(["pir"]);

const POWER_CODES = ["switch_led", "switch_1", "switch"];
const BRIGHTNESS_CODES = ["bright_value_v2", "bright_value"];
const COLOR_TEMP_CODES = ["temp_value_v2", "temp_value"];
const COLOR_CODES = ["colour_data_v2", "colour_data"];
const WORK_MODE_CODES = ["work_mode"];
const WINDOW_POSITION_CODES = ["percent_state", "position", "cur_pos"];
const WINDOW_TARGET_CODES = ["percent_control", "percent_state", "position", "cur_pos"];
const WINDOW_CONTROL_CODES = ["control"];

function deepEqual(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export default class TuyaMatterBridge {
  constructor(platform) {
    this.platform = platform;
    this.api = platform.api;
    this.log = platform.log;
    this.pluginName = platform.PLUGIN_NAME;
    this.platformName = platform.PLATFORM_NAME;

    this.accessories = new Map();
    this.deviceIndex = new Map();
    this.latestDevices = new Map();
  }

  isAvailable() {
    return typeof this.api?.isMatterAvailable === "function"
      ? this.api.isMatterAvailable()
      : Boolean(this.api?.matter);
  }

  isEnabled() {
    return typeof this.api?.isMatterEnabled === "function"
      ? this.api.isMatterEnabled()
      : Boolean(this.api?.matter);
  }

  restoreAccessory(accessory) {
    if (!accessory?.UUID) {
      return;
    }

    this.accessories.set(accessory.UUID, accessory);

    if (accessory.context?.deviceId) {
      this.deviceIndex.set(accessory.context.deviceId, accessory.UUID);
    }

    this.rebindHandlers(accessory);
  }

  noteDevice(device) {
    if (device?.id) {
      this.latestDevices.set(device.id, device);
    }
  }

  async registerDevices(devices = []) {
    if (!this.isEnabled()) {
      if (this.isAvailable()) {
        this.log.info("Matter is available but disabled for this bridge instance.");
      }
      return;
    }

    const newAccessories = [];

    for (const device of devices) {
      this.noteDevice(device);

      if (!this.supports(device)) {
        continue;
      }

      const uuid = this.uuidFor(device.id);
      const existing = this.accessories.get(uuid);
      const created = this.createAccessory(device);

      if (!created) {
        continue;
      }

      if (!existing) {
        newAccessories.push(created);
        continue;
      }

      await this.refreshCachedAccessory(existing, created, device);
    }

    if (newAccessories.length > 0) {
      await this.api.matter.registerPlatformAccessories(
        this.pluginName,
        this.platformName,
        newAccessories,
      );

      for (const accessory of newAccessories) {
        this.accessories.set(accessory.UUID, accessory);
        if (accessory.context?.deviceId) {
          this.deviceIndex.set(accessory.context.deviceId, accessory.UUID);
        }
      }
    }

    for (const device of devices) {
      await this.syncDeviceSnapshot(device);
    }

    this.log.info(
      `Matter support active: ${newAccessories.length} new accessory${newAccessories.length === 1 ? "" : "ies"} registered.`,
    );
  }

  async refreshCachedAccessory(existing, created, device) {
    const nextContext = created.context ?? {};
    const previousContext = existing.context ?? {};
    const updates = { UUID: existing.UUID };
    let changed = false;

    if (existing.displayName !== created.displayName) {
      updates.displayName = created.displayName;
      existing.displayName = created.displayName;
      changed = true;
    }

    if (!deepEqual(previousContext, nextContext)) {
      updates.context = nextContext;
      existing.context = nextContext;
      changed = true;
    }

    this.accessories.set(existing.UUID, existing);
    this.deviceIndex.set(device.id, existing.UUID);
    this.noteDevice(device);
    this.rebindHandlers(existing, device);

    if (changed) {
      await this.api.matter.updatePlatformAccessories([updates]);
    }
  }

  rebindHandlers(accessory, discoveredDevice) {
    if (!accessory?.context?.category) {
      return;
    }

    const device = discoveredDevice ?? this.latestDevices.get(accessory.context.deviceId);
    accessory.handlers = this.buildHandlers(accessory.context, device);
  }

  supports(device) {
    if (!device?.id || !device?.category) {
      return false;
    }

    const ignoreDevices = this.platform.config?.options?.ignoreDevices ?? [];
    if (Array.isArray(ignoreDevices) && ignoreDevices.includes(device.id)) {
      return false;
    }

    const category = device.category;
    return (
      LIGHT_CATEGORIES.has(category) ||
      OUTLET_CATEGORIES.has(category) ||
      SWITCH_CATEGORIES.has(category) ||
      WINDOW_CATEGORIES.has(category) ||
      CONTACT_CATEGORIES.has(category) ||
      LEAK_CATEGORIES.has(category) ||
      SMOKE_CATEGORIES.has(category) ||
      MOTION_CATEGORIES.has(category)
    );
  }

  uuidFor(deviceId) {
    return this.api.matter.uuid.generate(`tuya:${deviceId}`);
  }

  createAccessory(device) {
    const category = device.category;

    if (LIGHT_CATEGORIES.has(category)) {
      return this.createLightAccessory(device);
    }
    if (OUTLET_CATEGORIES.has(category)) {
      return this.createOutletAccessory(device);
    }
    if (SWITCH_CATEGORIES.has(category)) {
      return this.createSwitchAccessory(device);
    }
    if (WINDOW_CATEGORIES.has(category)) {
      return this.createWindowAccessory(device);
    }
    if (CONTACT_CATEGORIES.has(category)) {
      return this.createContactAccessory(device);
    }
    if (LEAK_CATEGORIES.has(category)) {
      return this.createLeakAccessory(device);
    }
    if (SMOKE_CATEGORIES.has(category)) {
      return this.createSmokeAccessory(device);
    }
    if (MOTION_CATEGORIES.has(category)) {
      return this.createMotionAccessory(device);
    }

    return null;
  }

  baseIdentity(device, extraContext = {}) {
    return {
      UUID: this.uuidFor(device.id),
      displayName: device.name || "unnamed",
      serialNumber: String(device.id),
      manufacturer: "Tuya",
      model:
        device.product_name ||
        device.product_id ||
        device.model ||
        device.category ||
        "Unknown",
      firmwareRevision: String(device.version || device.firmwareVersion || "1.0.0"),
      hardwareRevision: String(device.product_id || device.category || "1.0.0"),
      context: {
        deviceId: device.id,
        category: device.category,
        ...extraContext,
      },
    };
  }

  createLightAccessory(device) {
    const powerCode = this.pickSupportedCode(device, POWER_CODES);
    if (!powerCode) {
      this.log.warn(`Skipping Matter light for ${device.name}: no power datapoint found.`);
      return null;
    }

    const brightnessCode = this.pickSupportedCode(device, BRIGHTNESS_CODES);
    const tempCode = this.pickSupportedCode(device, COLOR_TEMP_CODES);
    const colorCode = this.pickSupportedCode(device, COLOR_CODES);
    const workModeCode = this.pickSupportedCode(device, WORK_MODE_CODES);

    const supportsBrightness = Boolean(brightnessCode);
    const supportsColorTemp = Boolean(tempCode);
    const supportsColor = Boolean(colorCode);

    const deviceType = supportsColor
      ? this.api.matter.deviceTypes.ExtendedColorLight
      : supportsColorTemp
        ? this.api.matter.deviceTypes.ColorTemperatureLight
        : supportsBrightness
          ? this.api.matter.deviceTypes.DimmableLight
          : this.api.matter.deviceTypes.OnOffLight;

    const power = this.toBoolean(this.getStatusValue(device, powerCode), false);
    const brightnessPercent = this.readBrightnessPercent(device, brightnessCode);
    const colorTempPercent = this.readColorTempPercent(device, tempCode);
    const hsColor = this.readHsColor(device, colorCode);

    const context = {
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
      ...this.baseIdentity(device, context),
      deviceType,
      clusters: {
        onOff: {
          onOff: power,
        },
      },
      handlers: {},
    };

    if (supportsBrightness) {
      accessory.clusters.levelControl = {
        currentLevel: this.percentToMatterLevel(brightnessPercent),
        minLevel: 1,
        maxLevel: 254,
      };
    }

    if (supportsColor || supportsColorTemp) {
      accessory.clusters.colorControl = {
        colorMode: supportsColor
          ? this.api.matter.types.ColorControl.ColorMode.CurrentHueAndCurrentSaturation
          : this.api.matter.types.ColorControl.ColorMode.ColorTemperatureMireds,
      };
    }

    if (supportsColorTemp) {
      const mireds = this.colorTempPercentToMireds(colorTempPercent);
      accessory.clusters.colorControl = {
        ...accessory.clusters.colorControl,
        colorTemperatureMireds: mireds,
        colorTempPhysicalMinMireds: 147,
        colorTempPhysicalMaxMireds: 454,
      };
    }

    if (supportsColor && hsColor) {
      accessory.clusters.colorControl = {
        ...accessory.clusters.colorControl,
        colorMode: this.api.matter.types.ColorControl.ColorMode.CurrentHueAndCurrentSaturation,
        currentHue: this.degreesToMatterHue(hsColor.h),
        currentSaturation: this.percentToMatterSat(hsColor.s),
      };
    }

    accessory.handlers = this.buildHandlers(accessory.context, device);
    return accessory;
  }

  createOutletAccessory(device) {
    const powerCode = this.pickSupportedCode(device, POWER_CODES);
    if (!powerCode) {
      this.log.warn(`Skipping Matter outlet for ${device.name}: no power datapoint found.`);
      return null;
    }

    const accessory = {
      ...this.baseIdentity(device, { powerCode }),
      deviceType: this.api.matter.deviceTypes.OnOffOutlet,
      clusters: {
        onOff: {
          onOff: this.toBoolean(this.getStatusValue(device, powerCode), false),
        },
      },
    };

    accessory.handlers = this.buildHandlers(accessory.context, device);
    return accessory;
  }

  createSwitchAccessory(device) {
    const powerCode = this.pickSupportedCode(device, POWER_CODES);
    if (!powerCode) {
      this.log.warn(`Skipping Matter switch for ${device.name}: no power datapoint found.`);
      return null;
    }

    const accessory = {
      ...this.baseIdentity(device, { powerCode }),
      deviceType: this.api.matter.deviceTypes.OnOffSwitch,
      clusters: {
        onOff: {
          onOff: this.toBoolean(this.getStatusValue(device, powerCode), false),
        },
      },
    };

    accessory.handlers = this.buildHandlers(accessory.context, device);
    return accessory;
  }

  createContactAccessory(device) {
    const isOpen = this.readContactOpen(device);

    return {
      ...this.baseIdentity(device),
      deviceType: this.api.matter.deviceTypes.ContactSensor,
      clusters: {
        booleanState: {
          stateValue: !isOpen,
        },
      },
    };
  }

  createLeakAccessory(device) {
    return {
      ...this.baseIdentity(device),
      deviceType: this.api.matter.deviceTypes.LeakSensor,
      clusters: {
        booleanState: {
          stateValue: this.readLeakDetected(device),
        },
      },
    };
  }

  createSmokeAccessory(device) {
    const SmokeCoAlarmServer = this.api.matter.deviceTypes.SmokeSensor?.requirements?.SmokeCoAlarmServer;
    const smokeDeviceType = SmokeCoAlarmServer?.with
      ? this.api.matter.deviceTypes.SmokeSensor.with(
          SmokeCoAlarmServer.with("SmokeAlarm"),
        )
      : this.api.matter.deviceTypes.SmokeSensor;

    return {
      ...this.baseIdentity(device),
      deviceType: smokeDeviceType,
      clusters: {
        smokeCoAlarm: {
          smokeState: this.readSmokeDetected(device) ? 2 : 0,
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
          expressedState: this.readSmokeDetected(device) ? 2 : 0,
        },
      },
    };
  }

  createMotionAccessory(device) {
    const MotionSensor = this.api.matter.deviceTypes.MotionSensor;
    const OccupancySensingServer = MotionSensor?.requirements?.OccupancySensingServer;
    const motionDeviceType = OccupancySensingServer?.with
      ? MotionSensor.with(OccupancySensingServer.with("PassiveInfrared"))
      : MotionSensor;

    return {
      ...this.baseIdentity(device),
      deviceType: motionDeviceType,
      clusters: {
        occupancySensing: {
          occupancy: {
            occupied: this.readMotionDetected(device),
          },
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

  createWindowAccessory(device) {
    const controlCode = this.pickSupportedCode(device, WINDOW_CONTROL_CODES);
    const targetCode = this.pickSupportedCode(device, WINDOW_TARGET_CODES);
    const currentPosition = this.readWindowOpenPercent(device);
    const matterClosedPercent100ths = this.openPercentToMatterClosed100ths(currentPosition);

    const accessory = {
      ...this.baseIdentity(device, {
        controlCode,
        targetCode,
      }),
      deviceType: this.api.matter.deviceTypes.WindowCovering,
      clusters: {
        windowCovering: {
          currentPositionLiftPercent100ths: matterClosedPercent100ths,
          targetPositionLiftPercent100ths: matterClosedPercent100ths,
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
    };

    accessory.handlers = this.buildHandlers(accessory.context, device);
    return accessory;
  }

  buildHandlers(context, discoveredDevice) {
    const category = context?.category;

    if (LIGHT_CATEGORIES.has(category)) {
      return this.buildLightHandlers(context, discoveredDevice);
    }

    if (OUTLET_CATEGORIES.has(category) || SWITCH_CATEGORIES.has(category)) {
      return {
        onOff: {
          on: async () => this.setPower(context.deviceId, context.powerCode, true),
          off: async () => this.setPower(context.deviceId, context.powerCode, false),
        },
      };
    }

    if (WINDOW_CATEGORIES.has(category)) {
      return {
        windowCovering: {
          upOrOpen: async () => this.sendWindowControl(context.deviceId, context.controlCode, "open"),
          downOrClose: async () => this.sendWindowControl(context.deviceId, context.controlCode, "close"),
          stopMotion: async () => this.sendWindowControl(context.deviceId, context.controlCode, "stop"),
          goToLiftPercentage: async ({ liftPercent100thsValue }) => {
            const openPercent = this.matterClosed100thsToOpenPercent(liftPercent100thsValue);
            await this.setWindowTarget(context.deviceId, context.targetCode, openPercent);
          },
        },
      };
    }

    return {};
  }

  buildLightHandlers(context, discoveredDevice) {
    const handlers = {
      onOff: {
        on: async () => this.setPower(context.deviceId, context.powerCode, true),
        off: async () => this.setPower(context.deviceId, context.powerCode, false),
      },
    };

    if (context.supportsBrightness && context.brightnessCode) {
      handlers.levelControl = {
        moveToLevelWithOnOff: async ({ level }) => {
          await this.setBrightnessPercent(
            context.deviceId,
            context.brightnessCode,
            this.matterLevelToPercent(level),
          );
        },
      };
    }

    if (context.supportsColorTemp || context.supportsColor) {
      handlers.colorControl = {};
    }

    if (context.supportsColorTemp && context.tempCode) {
      handlers.colorControl.moveToColorTemperatureLogic = async ({ colorTemperatureMireds }) => {
        await this.setColorTempPercent(
          context.deviceId,
          context.tempCode,
          this.miredsToColorTempPercent(colorTemperatureMireds),
        );
        if (context.workModeCode) {
          await this.setWorkMode(context.deviceId, context.workModeCode, "white");
        }
      };
    }

    if (context.supportsColor && context.colorCode) {
      handlers.colorControl.moveToHueAndSaturationLogic = async ({ hue, saturation }) => {
        await this.setHsColor(
          context.deviceId,
          context.colorCode,
          {
            h: this.matterHueToDegrees(hue),
            s: this.matterSatToPercent(saturation),
            v: this.readBrightnessPercent(discoveredDevice ?? this.latestDevices.get(context.deviceId), context.brightnessCode),
          },
        );

        if (context.workModeCode) {
          await this.setWorkMode(context.deviceId, context.workModeCode, "colour");
        }
      };
    }

    return handlers;
  }

  async syncMessage(message) {
    const deviceId = message?.devId || message?.deviceId || message?.id;
    if (!deviceId) {
      return;
    }

    if (message.bizCode === "delete") {
      await this.removeDevice(deviceId);
      return;
    }

    const existingDevice = this.latestDevices.get(deviceId) ?? {};
    const merged = this.mergeDeviceSnapshot(existingDevice, message);
    this.latestDevices.set(deviceId, merged);
    await this.syncDeviceSnapshot(merged);
  }

  mergeDeviceSnapshot(device, message) {
    const merged = {
      ...(device ?? {}),
      ...(message ?? {}),
      id: message?.devId || message?.deviceId || message?.id || device?.id,
      category: message?.category || device?.category,
      name: message?.name || device?.name,
    };

    const nextStatus = this.extractStatusEntries(message);
    if (nextStatus.length > 0) {
      merged.status = this.mergeStatusArrays(device?.status, nextStatus);
    }

    return merged;
  }

  async syncDeviceSnapshot(device) {
    if (!device?.id) {
      return;
    }

    const uuid = this.deviceIndex.get(device.id) || this.uuidFor(device.id);
    const accessory = this.accessories.get(uuid);

    if (!accessory) {
      return;
    }

    if (LIGHT_CATEGORIES.has(device.category)) {
      await this.syncLightState(accessory, device);
      return;
    }

    if (OUTLET_CATEGORIES.has(device.category) || SWITCH_CATEGORIES.has(device.category)) {
      await this.syncOnOffState(accessory, device, accessory.context.powerCode);
      return;
    }

    if (CONTACT_CATEGORIES.has(device.category)) {
      await this.api.matter.updateAccessoryState(
        uuid,
        this.api.matter.clusterNames.BooleanState,
        { stateValue: !this.readContactOpen(device) },
      );
      return;
    }

    if (LEAK_CATEGORIES.has(device.category)) {
      await this.api.matter.updateAccessoryState(
        uuid,
        this.api.matter.clusterNames.BooleanState,
        { stateValue: this.readLeakDetected(device) },
      );
      return;
    }

    if (SMOKE_CATEGORIES.has(device.category)) {
      const detected = this.readSmokeDetected(device);
      await this.api.matter.updateAccessoryState(
        uuid,
        this.api.matter.clusterNames.SmokeCoAlarm,
        {
          smokeState: detected ? 2 : 0,
          expressedState: detected ? 2 : 0,
        },
      );
      return;
    }

    if (MOTION_CATEGORIES.has(device.category)) {
      await this.api.matter.updateAccessoryState(
        uuid,
        this.api.matter.clusterNames.OccupancySensing,
        {
          occupancy: {
            occupied: this.readMotionDetected(device),
          },
        },
      );
      return;
    }

    if (WINDOW_CATEGORIES.has(device.category)) {
      const position = this.openPercentToMatterClosed100ths(this.readWindowOpenPercent(device));
      await this.api.matter.updateAccessoryState(
        uuid,
        this.api.matter.clusterNames.WindowCovering,
        {
          currentPositionLiftPercent100ths: position,
          targetPositionLiftPercent100ths: position,
        },
      );
    }
  }

  async syncOnOffState(accessory, device, powerCode) {
    const uuid = accessory.UUID;
    const onOff = this.toBoolean(this.getStatusValue(device, powerCode || POWER_CODES[0]), false);

    await this.api.matter.updateAccessoryState(
      uuid,
      this.api.matter.clusterNames.OnOff,
      { onOff },
    );
  }

  async syncLightState(accessory, device) {
    const uuid = accessory.UUID;
    const context = accessory.context ?? {};

    await this.syncOnOffState(accessory, device, context.powerCode);

    if (context.supportsBrightness && context.brightnessCode) {
      const currentLevel = this.percentToMatterLevel(
        this.readBrightnessPercent(device, context.brightnessCode),
      );

      await this.api.matter.updateAccessoryState(
        uuid,
        this.api.matter.clusterNames.LevelControl,
        { currentLevel },
      );
    }

    if ((context.supportsColorTemp || context.supportsColor) && this.api.matter.clusterNames.ColorControl) {
      const colorState = {};

      if (context.supportsColorTemp && context.tempCode) {
        colorState.colorTemperatureMireds = this.colorTempPercentToMireds(
          this.readColorTempPercent(device, context.tempCode),
        );
      }

      if (context.supportsColor && context.colorCode) {
        const hsColor = this.readHsColor(device, context.colorCode);
        if (hsColor) {
          colorState.currentHue = this.degreesToMatterHue(hsColor.h);
          colorState.currentSaturation = this.percentToMatterSat(hsColor.s);
        }
      }

      if (Object.keys(colorState).length > 0) {
        const workMode = this.getStatusValue(device, context.workModeCode || "work_mode");
        colorState.colorMode = this.determineColorMode(workMode, context, colorState);

        await this.api.matter.updateAccessoryState(
          uuid,
          this.api.matter.clusterNames.ColorControl,
          colorState,
        );
      }
    }
  }

  determineColorMode(workMode, context, colorState) {
    if (context.supportsColor && (workMode === "colour" || (colorState.currentHue !== undefined && colorState.currentSaturation !== undefined))) {
      return this.api.matter.types.ColorControl.ColorMode.CurrentHueAndCurrentSaturation;
    }

    return this.api.matter.types.ColorControl.ColorMode.ColorTemperatureMireds;
  }

  async removeDevice(deviceId) {
    const uuid = this.deviceIndex.get(deviceId) || this.uuidFor(deviceId);
    const accessory = this.accessories.get(uuid);

    if (!accessory) {
      return;
    }

    await this.api.matter.unregisterPlatformAccessories(
      this.pluginName,
      this.platformName,
      [{ UUID: uuid }],
    );

    this.accessories.delete(uuid);
    this.deviceIndex.delete(deviceId);
    this.latestDevices.delete(deviceId);
  }

  async setPower(deviceId, code, value) {
    const actualCode = code || this.pickSupportedCode(this.latestDevices.get(deviceId), POWER_CODES);
    if (!actualCode) {
      throw new Error(`No Tuya power datapoint found for device ${deviceId}`);
    }

    await this.sendCommands(deviceId, [{ code: actualCode, value }]);
  }

  async setBrightnessPercent(deviceId, code, percent) {
    if (!code) {
      throw new Error(`No Tuya brightness datapoint found for device ${deviceId}`);
    }

    const range = this.getNumericRangeForCode(deviceId, code, 10, 1000);
    const value = this.percentToRange(percent, range.min, range.max);
    await this.sendCommands(deviceId, [{ code, value }]);
  }

  async setColorTempPercent(deviceId, code, percent) {
    if (!code) {
      throw new Error(`No Tuya colour temperature datapoint found for device ${deviceId}`);
    }

    const range = this.getNumericRangeForCode(deviceId, code, 0, 1000);
    const value = this.percentToRange(percent, range.min, range.max);
    await this.sendCommands(deviceId, [{ code, value }]);
  }

  async setHsColor(deviceId, code, hsColor) {
    if (!code) {
      throw new Error(`No Tuya colour datapoint found for device ${deviceId}`);
    }

    const payload = {
      h: Math.max(0, Math.min(360, Math.round(hsColor.h ?? 0))),
      s: Math.max(0, Math.min(1000, Math.round((hsColor.s ?? 0) * 10))),
      v: Math.max(0, Math.min(1000, Math.round((hsColor.v ?? 100) * 10))),
    };

    await this.sendCommands(deviceId, [{ code, value: JSON.stringify(payload) }]);
  }

  async setWorkMode(deviceId, code, value) {
    if (!code) {
      return;
    }

    await this.sendCommands(deviceId, [{ code, value }]);
  }

  async setWindowTarget(deviceId, code, openPercent) {
    if (!code) {
      throw new Error(`No Tuya window target datapoint found for device ${deviceId}`);
    }

    await this.sendCommands(deviceId, [{ code, value: Math.max(0, Math.min(100, Math.round(openPercent))) }]);
  }

  async sendWindowControl(deviceId, code, action) {
    if (!code) {
      throw new Error(`No Tuya window control datapoint found for device ${deviceId}`);
    }

    await this.sendCommands(deviceId, [{ code, value: action }]);
  }

  async sendCommands(deviceId, commands) {
    await this.platform.tuyaOpenApi.sendCommand(deviceId, { commands });
  }

  pickSupportedCode(device, candidates) {
    for (const code of candidates) {
      if (this.hasCode(device, code)) {
        return code;
      }
    }
    return null;
  }

  hasCode(device, code) {
    if (!device || !code) {
      return false;
    }

    const statusEntries = this.extractStatusEntries(device);
    if (statusEntries.some((entry) => entry?.code === code)) {
      return true;
    }

    const functions = Array.isArray(device?.functions)
      ? device.functions
      : Array.isArray(device?.function)
        ? device.function
        : [];

    if (functions.some((entry) => entry?.code === code)) {
      return true;
    }

    return false;
  }

  extractStatusEntries(source) {
    if (!source) {
      return [];
    }

    if (Array.isArray(source.status)) {
      return source.status.filter(Boolean);
    }
    if (Array.isArray(source.data?.status)) {
      return source.data.status.filter(Boolean);
    }
    if (Array.isArray(source.statusList)) {
      return source.statusList.filter(Boolean);
    }
    if (Array.isArray(source.bizData?.status)) {
      return source.bizData.status.filter(Boolean);
    }
    return [];
  }

  mergeStatusArrays(existing = [], incoming = []) {
    const map = new Map();

    for (const entry of existing ?? []) {
      if (entry?.code) {
        map.set(entry.code, entry);
      }
    }

    for (const entry of incoming ?? []) {
      if (entry?.code) {
        map.set(entry.code, entry);
      }
    }

    return Array.from(map.values());
  }

  getStatusValue(source, ...codes) {
    const entries = this.extractStatusEntries(source);

    for (const code of codes.flat().filter(Boolean)) {
      const entry = entries.find((candidate) => candidate?.code === code);
      if (entry) {
        return entry.value;
      }
    }

    return undefined;
  }

  readBrightnessPercent(source, code) {
    const raw = this.getStatusValue(source, code || BRIGHTNESS_CODES);
    return this.rangeToPercent(raw, this.getNumericRangeForCode(source?.id, code, 10, 1000));
  }

  readColorTempPercent(source, code) {
    const raw = this.getStatusValue(source, code || COLOR_TEMP_CODES);
    return this.rangeToPercent(raw, this.getNumericRangeForCode(source?.id, code, 0, 1000));
  }

  readHsColor(source, code) {
    const raw = this.getStatusValue(source, code || COLOR_CODES);
    if (!raw) {
      return null;
    }

    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (typeof parsed === "object" && parsed) {
        return {
          h: Number(parsed.h ?? 0),
          s: Math.round(Number(parsed.s ?? 0) / 10),
          v: Math.round(Number(parsed.v ?? 1000) / 10),
        };
      }
    } catch {
      // ignore parse failure
    }

    return null;
  }

  readContactOpen(source) {
    const value = this.getStatusValue(source, ["doorcontact_state", "contact_state", "door_open"]);

    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value > 0;
    }
    if (typeof value === "string") {
      const normalized = value.toLowerCase();
      return ["open", "opened", "true", "1"].includes(normalized);
    }

    return false;
  }

  readLeakDetected(source) {
    const value = this.getStatusValue(source, ["watersensor_state", "watersensor_status", "leak_state", "sensor_state"]);

    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value > 0;
    }
    if (typeof value === "string") {
      const normalized = value.toLowerCase();
      return ["alarm", "warn", "warning", "true", "1", "leak", "detected", "wet"].includes(normalized);
    }

    return false;
  }

  readSmokeDetected(source) {
    const value = this.getStatusValue(source, ["smoke_sensor_state", "smoke_state", "smoke_sensor_status", "smoke_alarm"]);

    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value > 0;
    }
    if (typeof value === "string") {
      const normalized = value.toLowerCase();
      return ["alarm", "warn", "warning", "true", "1", "detected", "smoke"].includes(normalized);
    }

    return false;
  }

  readMotionDetected(source) {
    const value = this.getStatusValue(source, ["pir", "pir_state", "presence_state", "motion_state"]);

    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value > 0;
    }
    if (typeof value === "string") {
      const normalized = value.toLowerCase();
      return ["pir", "presence", "motion", "alarm", "detected", "true", "1"].includes(normalized);
    }

    return false;
  }

  readWindowOpenPercent(source) {
    const raw = this.getStatusValue(source, WINDOW_POSITION_CODES);
    const number = Number(raw);
    if (Number.isFinite(number)) {
      return Math.max(0, Math.min(100, Math.round(number)));
    }
    return 100;
  }

  getNumericRangeForCode(deviceId, code, fallbackMin, fallbackMax) {
    const device = this.latestDevices.get(deviceId) || deviceId;
    const functions = Array.isArray(device?.functions)
      ? device.functions
      : Array.isArray(device?.function)
        ? device.function
        : [];

    const match = functions.find((entry) => entry?.code === code);
    const values = match?.values;

    if (typeof values === "string") {
      try {
        const parsed = JSON.parse(values);
        return {
          min: Number.isFinite(Number(parsed.min)) ? Number(parsed.min) : fallbackMin,
          max: Number.isFinite(Number(parsed.max)) ? Number(parsed.max) : fallbackMax,
        };
      } catch {
        // ignore JSON parsing issues
      }
    }

    return { min: fallbackMin, max: fallbackMax };
  }

  rangeToPercent(raw, range) {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      return 100;
    }

    const min = Number(range?.min ?? 0);
    const max = Number(range?.max ?? 1000);
    if (max <= min) {
      return 100;
    }

    const percent = ((value - min) / (max - min)) * 100;
    return Math.max(0, Math.min(100, Math.round(percent)));
  }

  percentToRange(percent, min, max) {
    const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
    return Math.round(min + ((max - min) * safePercent) / 100);
  }

  percentToMatterLevel(percent) {
    const safe = Math.max(0, Math.min(100, Number(percent) || 0));
    return Math.max(1, Math.min(254, Math.round((safe / 100) * 254)));
  }

  matterLevelToPercent(level) {
    const safe = Math.max(1, Math.min(254, Number(level) || 1));
    return Math.max(0, Math.min(100, Math.round((safe / 254) * 100)));
  }

  percentToMatterSat(percent) {
    const safe = Math.max(0, Math.min(100, Number(percent) || 0));
    return Math.max(0, Math.min(254, Math.round((safe / 100) * 254)));
  }

  matterSatToPercent(value) {
    const safe = Math.max(0, Math.min(254, Number(value) || 0));
    return Math.max(0, Math.min(100, Math.round((safe / 254) * 100)));
  }

  degreesToMatterHue(degrees) {
    const safe = ((Number(degrees) || 0) % 360 + 360) % 360;
    return Math.max(0, Math.min(254, Math.round((safe / 360) * 254)));
  }

  matterHueToDegrees(value) {
    const safe = Math.max(0, Math.min(254, Number(value) || 0));
    return Math.max(0, Math.min(360, Math.round((safe / 254) * 360)));
  }

  colorTempPercentToMireds(percent) {
    const safe = Math.max(0, Math.min(100, Number(percent) || 0));
    const minMireds = 147;
    const maxMireds = 454;
    return Math.round(maxMireds - ((maxMireds - minMireds) * safe) / 100);
  }

  miredsToColorTempPercent(mireds) {
    const safe = Math.max(147, Math.min(454, Number(mireds) || 454));
    const minMireds = 147;
    const maxMireds = 454;
    return Math.round(((maxMireds - safe) / (maxMireds - minMireds)) * 100);
  }

  openPercentToMatterClosed100ths(openPercent) {
    const safe = Math.max(0, Math.min(100, Number(openPercent) || 0));
    return Math.round((100 - safe) * 100);
  }

  matterClosed100thsToOpenPercent(closedPercent100ths) {
    const safe = Math.max(0, Math.min(10000, Number(closedPercent100ths) || 0));
    return Math.round(100 - safe / 100);
  }

  toBoolean(value, fallback = false) {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value > 0;
    }
    if (typeof value === "string") {
      return ["true", "1", "on", "opened", "open"].includes(value.toLowerCase());
    }
    return fallback;
  }
}
