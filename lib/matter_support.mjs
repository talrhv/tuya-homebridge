"use strict";

const LIGHT_CATEGORIES = new Set([
  "dj",
  "dd",
  "fwd",
  "tgq",
  "xdd",
  "dc",
  "tgkg",
]);
const OUTLET_CATEGORIES = new Set(["cz", "pc"]);
const SWITCH_CATEGORIES = new Set(["tdq", "dlq", "kg", "qn"]);
const VALVE_CATEGORIES = new Set(["kg"]);
const WINDOW_CATEGORIES = new Set(["cl", "clkg"]);
const CONTACT_CATEGORIES = new Set(["mcs"]);
const LEAK_CATEGORIES = new Set(["rqbj", "jwbj"]);
const SMOKE_CATEGORIES = new Set(["ywbj"]);
const MOTION_CATEGORIES = new Set(["pir"]);

const POWER_CODES = ["switch_led", "switch_1", "switch"];
const COUNTDOWN_CODES = ["countdown_1", "countdown"];
const BRIGHTNESS_CODES = ["bright_value_v2", "bright_value"];
const COLOR_TEMP_CODES = ["temp_value_v2", "temp_value"];
const COLOR_CODES = ["colour_data_v2", "colour_data"];
const WORK_MODE_CODES = ["work_mode"];
const WINDOW_POSITION_CODES = ["percent_state", "position", "cur_pos"];
const WINDOW_TARGET_CODES = [
  "percent_control",
  "percent_state",
  "position",
  "cur_pos",
];
const WINDOW_CONTROL_CODES = ["control"];

function deepEqual(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
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

    this.pendingRegistrations = new Set();
    this.deferredSyncTimers = new Map();

    this.motionStates = new Map();
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
        this.log.info(
          "Matter is available but disabled for this bridge instance.",
        );
      }
      return;
    }

    const newAccessories = [];
    const existingDevices = [];

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
        this.pendingRegistrations.add(device.id);
        newAccessories.push(created);
        continue;
      }

      if (this.needsRecreation(existing, created)) {
        await this.api.matter.unregisterPlatformAccessories(
          this.pluginName,
          this.platformName,
          [{ UUID: existing.UUID }],
        );
        this.accessories.delete(existing.UUID);
        this.deviceIndex.delete(device.id);
        this.pendingRegistrations.add(device.id);
        newAccessories.push(created);
        continue;
      }

      existingDevices.push(device);
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
          this.scheduleDeferredSync(accessory.context.deviceId);
        }
      }
    }

    for (const device of existingDevices) {
      await this.syncDeviceSnapshot(device);
    }

    this.log.info(
      `Matter support active: ${newAccessories.length} new accessory${newAccessories.length === 1 ? "" : "ies"} registered.`,
    );
  }

  needsRecreation(existing, created) {
    const previous = existing?.context ?? {};
    const next = created?.context ?? {};

    if ((previous.profile || "") !== (next.profile || "")) {
      return true;
    }

    const existingParts = this.partsSignature(existing?.parts);
    const createdParts = this.partsSignature(created?.parts);
    return existingParts !== createdParts;
  }

  partsSignature(parts) {
    if (!Array.isArray(parts) || parts.length === 0) {
      return "";
    }

    return JSON.stringify(
      parts.map((part) => ({
        id: part?.id,
        displayName: part?.displayName,
        deviceType:
          part?.deviceType?.name ||
          part?.deviceType?.deviceClass ||
          String(part?.deviceType || ""),
      })),
    );
  }

  clearDeferredSync(deviceId) {
    const timer = this.deferredSyncTimers.get(deviceId);
    if (timer) {
      clearTimeout(timer);
      this.deferredSyncTimers.delete(deviceId);
    }
  }

  scheduleDeferredSync(deviceId, delayMs = 1500) {
    if (!deviceId) {
      return;
    }

    this.clearDeferredSync(deviceId);

    const timer = setTimeout(async () => {
      this.deferredSyncTimers.delete(deviceId);

      try {
        this.pendingRegistrations.delete(deviceId);
        const device = this.latestDevices.get(deviceId);
        if (device) {
          await this.syncDeviceSnapshot(device);
        }
      } catch (error) {
        this.log.warn(
          `[Matter] Deferred sync failed for ${deviceId}: ${error?.message || error}`,
        );
      }
    }, delayMs);

    if (typeof timer?.unref === "function") {
      timer.unref();
    }

    this.deferredSyncTimers.set(deviceId, timer);
  }

  isPendingRegistration(deviceId) {
    return Boolean(deviceId) && this.pendingRegistrations.has(deviceId);
  }

  isAccessoryNotReadyError(error) {
    const message = String(error?.message || error || "").toLowerCase();
    return (
      message.includes("not found or not registered") ||
      message.includes("not registered")
    );
  }

  async updateAccessoryStateSafely(
    uuid,
    clusterName,
    attributes,
    options = {},
  ) {
    const retries = Number.isInteger(options.retries) ? options.retries : 3;
    const retryDelayMs = Number.isFinite(options.retryDelayMs)
      ? options.retryDelayMs
      : 400;
    const partId = options.partId;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.api.matter.updateAccessoryState(
          uuid,
          clusterName,
          attributes,
          partId,
        );
        return true;
      } catch (error) {
        if (!this.isAccessoryNotReadyError(error) || attempt === retries) {
          throw error;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, retryDelayMs * (attempt + 1)),
        );
      }
    }

    return false;
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

    if (
      this.partsSignature(existing.parts) !== this.partsSignature(created.parts)
    ) {
      updates.parts = created.parts;
      existing.parts = created.parts;
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

    const device =
      discoveredDevice ?? this.latestDevices.get(accessory.context.deviceId);

    accessory.handlers = this.buildHandlers(accessory.context, device);

    if (this.hasComposedPartsContext(accessory.context)) {
      accessory.parts = this.buildPartsForContext(accessory.context, device);
    }
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

    if (MOTION_CATEGORIES.has(category)) {
      return Boolean(this.getMotionConfig(device.id));
    }

    return (
      LIGHT_CATEGORIES.has(category) ||
      OUTLET_CATEGORIES.has(category) ||
      SWITCH_CATEGORIES.has(category) ||
      WINDOW_CATEGORIES.has(category) ||
      CONTACT_CATEGORIES.has(category) ||
      LEAK_CATEGORIES.has(category) ||
      SMOKE_CATEGORIES.has(category)
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
      firmwareRevision: String(
        device.version || device.firmwareVersion || "1.0.0",
      ),
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
      this.log.warn(
        `Skipping Matter light for ${device.name}: no power datapoint found.`,
      );
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
    const brightnessPercent = this.readBrightnessPercent(
      device,
      brightnessCode,
    );
    const colorTempPercent = this.readColorTempPercent(device, tempCode);
    const hsColor = this.readHsColor(device, colorCode);

    const context = {
      profile: `light:${deviceType?.name || "light"}:${powerCode}:${brightnessCode || ""}:${tempCode || ""}:${colorCode || ""}`,
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
          ? this.api.matter.types.ColorControl.ColorMode
              .CurrentHueAndCurrentSaturation
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
        colorMode:
          this.api.matter.types.ColorControl.ColorMode
            .CurrentHueAndCurrentSaturation,
        currentHue: this.degreesToMatterHue(hsColor.h),
        currentSaturation: this.percentToMatterSat(hsColor.s),
      };
    }

    accessory.handlers = this.buildHandlers(accessory.context, device);
    return accessory;
  }

  createOutletAccessory(device) {
    const powerCodes = this.getEndpointPowerCodes(device);
    if (powerCodes.length === 0) {
      this.log.warn(
        `Skipping Matter outlet for ${device.name}: no power datapoint found.`,
      );
      return null;
    }

    if (powerCodes.length > 1) {
      return this.createComposedOnOffAccessory(device, {
        kind: "outlet",
        deviceType: this.api.matter.deviceTypes.OnOffOutlet,
        powerCodes,
      });
    }

    const powerCode = powerCodes[0];
    const accessory = {
      ...this.baseIdentity(device, {
        profile: `outlet:${powerCode}`,
        powerCode,
        powerCodes,
        endpointKind: "outlet",
      }),
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
    const powerCodes = this.getEndpointPowerCodes(device);
    if (powerCodes.length === 0) {
      this.log.warn(
        `Skipping Matter switch for ${device.name}: no power datapoint found.`,
      );
      return null;
    }

    if (this.isValveDevice(device)) {
      if (powerCodes.length !== 1) {
        this.log.warn(
          `[Matter] ${device.name} is configured as valve, but multi-gang devices are not supported as valves. Falling back to switch parts.`,
        );
      } else {
        return this.createValveAccessory(device, powerCodes[0]);
      }
    }

    if (powerCodes.length > 1) {
      return this.createComposedOnOffAccessory(device, {
        kind: "switch",
        deviceType: this.api.matter.deviceTypes.OnOffSwitch,
        powerCodes,
      });
    }

    const powerCode = powerCodes[0];
    const accessory = {
      ...this.baseIdentity(device, {
        profile: `switch:${powerCode}`,
        powerCode,
        powerCodes,
        endpointKind: "switch",
      }),
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

  createComposedOnOffAccessory(device, options) {
    const powerCodes = unique(options?.powerCodes);
    const primaryPowerCode = powerCodes[0];
    const context = {
      profile: `${options.kind}-parts:${powerCodes.join(",")}`,
      endpointKind: options.kind,
      endpointMode: "parts",
      powerCode: primaryPowerCode,
      powerCodes,
    };

    const accessory = {
      ...this.baseIdentity(device, context),
      deviceType: options.deviceType,
      clusters: {
        onOff: {
          onOff: this.toBoolean(
            this.getStatusValue(device, primaryPowerCode),
            false,
          ),
        },
      },
    };

    accessory.handlers = this.buildHandlers(accessory.context, device);
    accessory.parts = this.buildPartsForContext(accessory.context, device);
    return accessory;
  }

  buildPartsForContext(context, device) {
    const powerCodes = unique(context?.powerCodes);
    if (powerCodes.length <= 1) {
      return undefined;
    }

    const partDeviceType =
      context?.endpointKind === "outlet"
        ? this.api.matter.deviceTypes.OnOffOutlet
        : this.api.matter.deviceTypes.OnOffSwitch;

    return powerCodes.slice(1).map((powerCode, index) => ({
      id: powerCode,
      displayName: this.getGangDisplayName(device, powerCode, index + 2),
      deviceType: partDeviceType,
      clusters: {
        onOff: {
          onOff: this.toBoolean(this.getStatusValue(device, powerCode), false),
        },
      },
      handlers: {
        onOff: {
          on: async () => this.setPower(context.deviceId, powerCode, true),
          off: async () => this.setPower(context.deviceId, powerCode, false),
        },
      },
    }));
  }

  hasComposedPartsContext(context) {
    return Array.isArray(context?.powerCodes) && context.powerCodes.length > 1;
  }

  createValveAccessory(device, powerCode) {
    const countdownCode = this.pickSupportedCode(device, COUNTDOWN_CODES);
    const remainingDuration = this.readCountdownSeconds(device, countdownCode);
    const isOpen = this.toBoolean(
      this.getStatusValue(device, powerCode),
      false,
    );

    const valveClusterName =
      this.api.matter.clusterNames?.ValveConfigurationAndControl ||
      "valveConfigurationAndControl";
    const valveStateType =
      this.api.matter.types?.ValveConfigurationAndControl?.ValveState;

    const currentState = isOpen
      ? (valveStateType?.Open ?? 1)
      : (valveStateType?.Closed ?? 0);

    const commonContext = {
      profile: `valve:${powerCode}:${countdownCode || ""}`,
      endpointKind: "valve",
      powerCode,
      countdownCode,
      powerCodes: [powerCode],
    };

    if (
      this.api.matter.deviceTypes?.WaterValve &&
      this.api.matter.clusterNames?.ValveConfigurationAndControl
    ) {
      return {
        ...this.baseIdentity(device, commonContext),
        deviceType: this.api.matter.deviceTypes.WaterValve,
        clusters: {
          valveConfigurationAndControl: {
            openDuration: remainingDuration,
            defaultOpenDuration: remainingDuration,
            remainingDuration: isOpen ? remainingDuration : null,
            currentState,
            targetState: null,
            valveFault: {},
          },
        },
        handlers: {
          valveConfigurationAndControl: {
            open: async (args = {}) => {
              await this.openValve(
                device.id,
                powerCode,
                countdownCode,
                args?.openDuration,
              );
            },
            close: async () => {
              await this.closeValve(device.id, powerCode);
            },
          },
        },
      };
    }

    this.log.warn(
      `[Matter] WaterValve is not available in this Homebridge/Matter build. ${device.name} will be exposed as an OnOffSwitch.`,
    );

    const accessory = {
      ...this.baseIdentity(device, {
        ...commonContext,
        profile: `valve-fallback:${powerCode}:${countdownCode || ""}`,
      }),
      deviceType: this.api.matter.deviceTypes.OnOffSwitch,
      clusters: {
        onOff: {
          onOff: isOpen,
        },
      },
    };

    accessory.handlers = this.buildHandlers(accessory.context, device);
    return accessory;
  }

  createContactAccessory(device) {
    const isOpen = this.readContactOpen(device);

    return {
      ...this.baseIdentity(device, {
        profile: "contact",
      }),
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
      ...this.baseIdentity(device, {
        profile: "leak",
      }),
      deviceType: this.api.matter.deviceTypes.LeakSensor,
      clusters: {
        booleanState: {
          stateValue: this.readLeakDetected(device),
        },
      },
    };
  }

  createSmokeAccessory(device) {
    const SmokeCoAlarmServer =
      this.api.matter.deviceTypes.SmokeSensor?.requirements?.SmokeCoAlarmServer;
    const smokeDeviceType = SmokeCoAlarmServer?.with
      ? this.api.matter.deviceTypes.SmokeSensor.with(
          SmokeCoAlarmServer.with("SmokeAlarm"),
        )
      : this.api.matter.deviceTypes.SmokeSensor;

    return {
      ...this.baseIdentity(device, {
        profile: "smoke",
      }),
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
    const OccupancySensingServer =
      MotionSensor?.requirements?.OccupancySensingServer;
    const motionDeviceType = OccupancySensingServer?.with
      ? MotionSensor.with(OccupancySensingServer.with("PassiveInfrared"))
      : MotionSensor;

    const motionConfig = this.getMotionConfig(device.id);
    const overrideSeconds = this.getMotionOverrideSeconds(device.id);
    const hasInternalTimer = this.hasMotionInternalTimer(device);
    const initialDetected = this.readMotionDetected(device);
    const occupied = this.consumeMotionState(device.id, initialDetected, {
      overrideSeconds,
      hasInternalTimer,
      isRefresh: false,
    });

    return {
      ...this.baseIdentity(device, {
        profile: `motion:${overrideSeconds}:${hasInternalTimer ? "internal" : "override"}`,
        motionConfig: motionConfig ?? null,
        motionOverrideSeconds: overrideSeconds,
        hasInternalTimer,
      }),
      deviceType: motionDeviceType,
      clusters: {
        occupancySensing: {
          occupancy: {
            occupied,
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
    const matterClosedPercent100ths =
      this.openPercentToMatterClosed100ths(currentPosition);

    const accessory = {
      ...this.baseIdentity(device, {
        profile: `window:${controlCode || ""}:${targetCode || ""}`,
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

    if (
      context?.endpointKind === "outlet" ||
      context?.endpointKind === "switch" ||
      OUTLET_CATEGORIES.has(category) ||
      SWITCH_CATEGORIES.has(category)
    ) {
      return {
        onOff: {
          on: async () =>
            this.setPower(context.deviceId, context.powerCode, true),
          off: async () =>
            this.setPower(context.deviceId, context.powerCode, false),
        },
      };
    }

    if (context?.endpointKind === "valve") {
      if (
        this.api.matter.deviceTypes?.WaterValve &&
        this.api.matter.clusterNames?.ValveConfigurationAndControl
      ) {
        return {
          valveConfigurationAndControl: {
            open: async (args = {}) => {
              await this.openValve(
                context.deviceId,
                context.powerCode,
                context.countdownCode,
                args?.openDuration,
              );
            },
            close: async () => {
              await this.closeValve(context.deviceId, context.powerCode);
            },
          },
        };
      }

      return {
        onOff: {
          on: async () =>
            this.setPower(context.deviceId, context.powerCode, true),
          off: async () =>
            this.setPower(context.deviceId, context.powerCode, false),
        },
      };
    }

    if (WINDOW_CATEGORIES.has(category)) {
      return {
        windowCovering: {
          upOrOpen: async () =>
            this.sendWindowControl(
              context.deviceId,
              context.controlCode,
              "open",
            ),
          downOrClose: async () =>
            this.sendWindowControl(
              context.deviceId,
              context.controlCode,
              "close",
            ),
          stopMotion: async () =>
            this.sendWindowControl(
              context.deviceId,
              context.controlCode,
              "stop",
            ),
          goToLiftPercentage: async ({ liftPercent100thsValue }) => {
            const openPercent = this.matterClosed100thsToOpenPercent(
              liftPercent100thsValue,
            );
            await this.setWindowTarget(
              context.deviceId,
              context.targetCode,
              openPercent,
            );
          },
        },
      };
    }

    return {};
  }

  buildLightHandlers(context, discoveredDevice) {
    const handlers = {
      onOff: {
        on: async () =>
          this.setPower(context.deviceId, context.powerCode, true),
        off: async () =>
          this.setPower(context.deviceId, context.powerCode, false),
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
      handlers.colorControl.moveToColorTemperatureLogic = async ({
        colorTemperatureMireds,
      }) => {
        await this.setColorTempPercent(
          context.deviceId,
          context.tempCode,
          this.miredsToColorTempPercent(colorTemperatureMireds),
        );
        if (context.workModeCode) {
          await this.setWorkMode(
            context.deviceId,
            context.workModeCode,
            "white",
          );
        }
      };
    }

    if (context.supportsColor && context.colorCode) {
      handlers.colorControl.moveToHueAndSaturationLogic = async ({
        hue,
        saturation,
      }) => {
        await this.setHsColor(context.deviceId, context.colorCode, {
          h: this.matterHueToDegrees(hue),
          s: this.matterSatToPercent(saturation),
          v: this.readBrightnessPercent(
            discoveredDevice ?? this.latestDevices.get(context.deviceId),
            context.brightnessCode,
          ),
        });

        if (context.workModeCode) {
          await this.setWorkMode(
            context.deviceId,
            context.workModeCode,
            "colour",
          );
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

    if (this.isPendingRegistration(deviceId)) {
      this.scheduleDeferredSync(deviceId);
      return;
    }

    await this.syncDeviceSnapshot(merged);
  }

  mergeDeviceSnapshot(device, message) {
    const merged = {
      ...(device ?? {}),
      ...(message ?? {}),
      id: message?.devId || message?.deviceId || message?.id || device?.id,
      category: message?.category || device?.category,
      name: message?.name || device?.name,
      functions: device?.functions ?? message?.functions,
      function: device?.function ?? message?.function,
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

    if (this.isPendingRegistration(device.id)) {
      this.scheduleDeferredSync(device.id);
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

    if (
      this.isValveDevice(device) &&
      accessory.context?.endpointKind === "valve"
    ) {
      await this.syncValveState(accessory, device);
      return;
    }

    if (
      OUTLET_CATEGORIES.has(device.category) ||
      SWITCH_CATEGORIES.has(device.category)
    ) {
      await this.syncMultiGangOnOffState(accessory, device);
      return;
    }

    if (CONTACT_CATEGORIES.has(device.category)) {
      await this.updateAccessoryStateSafely(
        uuid,
        this.api.matter.clusterNames.BooleanState,
        { stateValue: !this.readContactOpen(device) },
      );
      return;
    }

    if (LEAK_CATEGORIES.has(device.category)) {
      await this.updateAccessoryStateSafely(
        uuid,
        this.api.matter.clusterNames.BooleanState,
        { stateValue: this.readLeakDetected(device) },
      );
      return;
    }

    if (SMOKE_CATEGORIES.has(device.category)) {
      const detected = this.readSmokeDetected(device);
      await this.updateAccessoryStateSafely(
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
      const occupied = this.consumeMotionState(
        device.id,
        this.readMotionDetected(device),
        {
          overrideSeconds: Number(
            accessory.context?.motionOverrideSeconds || 0,
          ),
          hasInternalTimer: Boolean(accessory.context?.hasInternalTimer),
          isRefresh: true,
        },
      );

      await this.updateAccessoryStateSafely(
        uuid,
        this.api.matter.clusterNames.OccupancySensing,
        {
          occupancy: {
            occupied,
          },
        },
      );
      return;
    }

    if (WINDOW_CATEGORIES.has(device.category)) {
      const position = this.openPercentToMatterClosed100ths(
        this.readWindowOpenPercent(device),
      );
      await this.updateAccessoryStateSafely(
        uuid,
        this.api.matter.clusterNames.WindowCovering,
        {
          currentPositionLiftPercent100ths: position,
          targetPositionLiftPercent100ths: position,
        },
      );
    }
  }

  async syncMultiGangOnOffState(accessory, device) {
    const uuid = accessory.UUID;
    const powerCodes = unique(accessory.context?.powerCodes);

    if (powerCodes.length <= 1) {
      await this.syncOnOffState(accessory, device, accessory.context.powerCode);
      return;
    }

    await this.updateAccessoryStateSafely(
      uuid,
      this.api.matter.clusterNames.OnOff,
      {
        onOff: this.toBoolean(
          this.getStatusValue(device, powerCodes[0]),
          false,
        ),
      },
    );

    for (const powerCode of powerCodes.slice(1)) {
      await this.updateAccessoryStateSafely(
        uuid,
        this.api.matter.clusterNames.OnOff,
        {
          onOff: this.toBoolean(this.getStatusValue(device, powerCode), false),
        },
        { partId: powerCode },
      );
    }
  }

  async syncValveState(accessory, device) {
    const uuid = accessory.UUID;
    const powerCode = accessory.context?.powerCode;
    const countdownCode = accessory.context?.countdownCode;

    if (
      !this.api.matter.deviceTypes?.WaterValve ||
      !this.api.matter.clusterNames?.ValveConfigurationAndControl
    ) {
      await this.syncOnOffState(accessory, device, powerCode);
      return;
    }

    const valveStateType =
      this.api.matter.types?.ValveConfigurationAndControl?.ValveState;
    const isOpen = this.toBoolean(
      this.getStatusValue(device, powerCode),
      false,
    );
    const remainingDuration = this.readCountdownSeconds(device, countdownCode);

    await this.updateAccessoryStateSafely(
      uuid,
      this.api.matter.clusterNames.ValveConfigurationAndControl,
      {
        openDuration: remainingDuration,
        defaultOpenDuration: remainingDuration,
        remainingDuration: isOpen ? remainingDuration : null,
        currentState: isOpen
          ? (valveStateType?.Open ?? 1)
          : (valveStateType?.Closed ?? 0),
        targetState: null,
      },
    );
  }

  async syncOnOffState(accessory, device, powerCode) {
    const uuid = accessory.UUID;
    const onOff = this.toBoolean(
      this.getStatusValue(device, powerCode || POWER_CODES[0]),
      false,
    );

    await this.updateAccessoryStateSafely(
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

      await this.updateAccessoryStateSafely(
        uuid,
        this.api.matter.clusterNames.LevelControl,
        { currentLevel },
      );
    }

    if (
      (context.supportsColorTemp || context.supportsColor) &&
      this.api.matter.clusterNames.ColorControl
    ) {
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
        const workMode = this.getStatusValue(
          device,
          context.workModeCode || "work_mode",
        );
        colorState.colorMode = this.determineColorMode(
          workMode,
          context,
          colorState,
        );

        await this.updateAccessoryStateSafely(
          uuid,
          this.api.matter.clusterNames.ColorControl,
          colorState,
        );
      }
    }
  }

  determineColorMode(workMode, context, colorState) {
    if (
      context.supportsColor &&
      (workMode === "colour" ||
        (colorState.currentHue !== undefined &&
          colorState.currentSaturation !== undefined))
    ) {
      return this.api.matter.types.ColorControl.ColorMode
        .CurrentHueAndCurrentSaturation;
    }

    return this.api.matter.types.ColorControl.ColorMode.ColorTemperatureMireds;
  }

  async removeDevice(deviceId) {
    const uuid = this.deviceIndex.get(deviceId) || this.uuidFor(deviceId);
    const accessory = this.accessories.get(uuid);

    this.clearDeferredSync(deviceId);
    this.pendingRegistrations.delete(deviceId);
    this.clearMotionRuntime(deviceId);

    if (!accessory) {
      this.deviceIndex.delete(deviceId);
      this.latestDevices.delete(deviceId);
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
    const actualCode =
      code ||
      this.pickSupportedCode(this.latestDevices.get(deviceId), POWER_CODES);
    if (!actualCode) {
      throw new Error(`No Tuya power datapoint found for device ${deviceId}`);
    }

    await this.sendCommands(deviceId, [{ code: actualCode, value }]);
  }

  async openValve(deviceId, powerCode, countdownCode, openDuration) {
    const commands = [{ code: powerCode, value: true }];
    const duration = Number(openDuration);

    if (countdownCode && Number.isFinite(duration) && duration > 0) {
      commands.push({
        code: countdownCode,
        value: Math.max(1, Math.round(duration)),
      });
    }

    await this.sendCommands(deviceId, commands);
  }

  async closeValve(deviceId, powerCode) {
    await this.sendCommands(deviceId, [{ code: powerCode, value: false }]);
  }

  async setBrightnessPercent(deviceId, code, percent) {
    if (!code) {
      throw new Error(
        `No Tuya brightness datapoint found for device ${deviceId}`,
      );
    }

    const range = this.getNumericRangeForCode(deviceId, code, 10, 1000);
    const value = this.percentToRange(percent, range.min, range.max);
    await this.sendCommands(deviceId, [{ code, value }]);
  }

  async setColorTempPercent(deviceId, code, percent) {
    if (!code) {
      throw new Error(
        `No Tuya colour temperature datapoint found for device ${deviceId}`,
      );
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

    await this.sendCommands(deviceId, [
      { code, value: JSON.stringify(payload) },
    ]);
  }

  async setWorkMode(deviceId, code, value) {
    if (!code) {
      return;
    }

    await this.sendCommands(deviceId, [{ code, value }]);
  }

  async setWindowTarget(deviceId, code, openPercent) {
    if (!code) {
      throw new Error(
        `No Tuya window target datapoint found for device ${deviceId}`,
      );
    }

    await this.sendCommands(deviceId, [
      { code, value: Math.max(0, Math.min(100, Math.round(openPercent))) },
    ]);
  }

  async sendWindowControl(deviceId, code, action) {
    if (!code) {
      throw new Error(
        `No Tuya window control datapoint found for device ${deviceId}`,
      );
    }

    await this.sendCommands(deviceId, [{ code, value: action }]);
  }

  async sendCommands(deviceId, commands) {
    await this.platform.tuyaOpenApi.sendCommand(deviceId, { commands });
  }

  getValveConfig(deviceId) {
    const entries = this.platform.config?.options?.valve ?? [];
    return Array.isArray(entries)
      ? entries.find(
          (entry) => entry?.deviceId === deviceId && entry?.isActive === true,
        ) || null
      : null;
  }

  isValveDevice(device) {
    return Boolean(
      device?.id &&
      VALVE_CATEGORIES.has(device?.category) &&
      this.getValveConfig(device.id),
    );
  }

  getMotionConfig(deviceId) {
    const entries = this.platform.config?.options?.motion ?? [];
    return Array.isArray(entries)
      ? entries.find((entry) => entry?.deviceId === deviceId) || null
      : null;
  }

  getMotionOverrideSeconds(deviceId) {
    const motionConfig = this.getMotionConfig(deviceId);
    const value = Number(motionConfig?.overrideTuya ?? 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  hasMotionInternalTimer(device) {
    return this.hasCode(device, "pir_time");
  }

  consumeMotionState(deviceId, detected, options = {}) {
    const overrideSeconds = Number(options?.overrideSeconds || 0);
    const hasInternalTimer = Boolean(options?.hasInternalTimer);
    const isRefresh = options?.isRefresh === true;

    let runtime = this.motionStates.get(deviceId);
    if (!runtime) {
      runtime = {
        occupied: false,
        timer: null,
      };
      this.motionStates.set(deviceId, runtime);
    }

    if (detected && overrideSeconds > 0 && !hasInternalTimer) {
      runtime.occupied = true;

      if (runtime.timer) {
        clearTimeout(runtime.timer);
      }

      runtime.timer = setTimeout(async () => {
        const state = this.motionStates.get(deviceId);
        if (!state) {
          return;
        }

        state.timer = null;
        state.occupied = false;

        try {
          const uuid = this.deviceIndex.get(deviceId) || this.uuidFor(deviceId);
          const accessory = this.accessories.get(uuid);
          if (!accessory || this.isPendingRegistration(deviceId)) {
            return;
          }

          await this.updateAccessoryStateSafely(
            uuid,
            this.api.matter.clusterNames.OccupancySensing,
            {
              occupancy: {
                occupied: false,
              },
            },
          );
        } catch (error) {
          this.log.warn(
            `[Matter] Failed to auto-reset motion state for ${deviceId}: ${error?.message || error}`,
          );
        }
      }, overrideSeconds * 1000);

      if (typeof runtime.timer?.unref === "function") {
        runtime.timer.unref();
      }

      return true;
    }

    if (
      !detected &&
      runtime.timer &&
      overrideSeconds > 0 &&
      !hasInternalTimer &&
      !isRefresh
    ) {
      // ignore transient false during the hold period for message-only updates
      return runtime.occupied;
    }

    if (
      !detected &&
      runtime.timer &&
      overrideSeconds > 0 &&
      !hasInternalTimer
    ) {
      clearTimeout(runtime.timer);
      runtime.timer = null;
    }

    runtime.occupied = Boolean(detected);
    return runtime.occupied;
  }

  clearMotionRuntime(deviceId) {
    const runtime = this.motionStates.get(deviceId);
    if (runtime?.timer) {
      clearTimeout(runtime.timer);
    }
    this.motionStates.delete(deviceId);
  }

  getEndpointPowerCodes(device) {
    const directCodes = this.extractEndpointPowerCodes(device);
    if (directCodes.length > 0) {
      return directCodes;
    }

    const fallback = this.pickSupportedCode(device, POWER_CODES);
    return fallback ? [fallback] : [];
  }

  extractEndpointPowerCodes(device) {
    const entries = [
      ...this.extractStatusEntries(device),
      ...this.extractFunctionEntries(device),
    ];

    const switchCodes = entries
      .map((entry) => entry?.code)
      .filter((code) => /^switch(?:_\d+)?$/.test(code || ""));

    const deduped = unique(switchCodes);

    deduped.sort(
      (a, b) => this.powerCodeSortValue(a) - this.powerCodeSortValue(b),
    );
    return deduped;
  }

  powerCodeSortValue(code) {
    if (code === "switch") {
      return 1;
    }

    const match = /^switch_(\d+)$/.exec(code || "");
    if (match) {
      return Number(match[1]);
    }

    return 9999;
  }

  extractFunctionEntries(device) {
    return Array.isArray(device?.functions)
      ? device.functions.filter(Boolean)
      : Array.isArray(device?.function)
        ? device.function.filter(Boolean)
        : [];
  }

  getGangDisplayName(device, powerCode, position) {
    const base = device?.name || "Switch";
    const match = /^switch_(\d+)$/.exec(powerCode || "");
    const suffix = match?.[1] || String(position || 1);
    return `${base} ${suffix}`;
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

    const functions = this.extractFunctionEntries(device);
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

  readCountdownSeconds(source, code) {
    const raw = this.getStatusValue(source, code || COUNTDOWN_CODES);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      return null;
    }
    return Math.round(value);
  }

  readBrightnessPercent(source, code) {
    const raw = this.getStatusValue(source, code || BRIGHTNESS_CODES);
    return this.rangeToPercent(
      raw,
      this.getNumericRangeForCode(source?.id, code, 10, 1000),
    );
  }

  readColorTempPercent(source, code) {
    const raw = this.getStatusValue(source, code || COLOR_TEMP_CODES);
    return this.rangeToPercent(
      raw,
      this.getNumericRangeForCode(source?.id, code, 0, 1000),
    );
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
    const value = this.getStatusValue(source, [
      "doorcontact_state",
      "contact_state",
      "door_open",
    ]);

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
    const value = this.getStatusValue(source, [
      "watersensor_state",
      "watersensor_status",
      "leak_state",
      "sensor_state",
    ]);

    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value > 0;
    }
    if (typeof value === "string") {
      const normalized = value.toLowerCase();
      return [
        "alarm",
        "warn",
        "warning",
        "true",
        "1",
        "leak",
        "detected",
        "wet",
      ].includes(normalized);
    }

    return false;
  }

  readSmokeDetected(source) {
    const value = this.getStatusValue(source, [
      "smoke_sensor_state",
      "smoke_state",
      "smoke_sensor_status",
      "smoke_alarm",
    ]);

    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value > 0;
    }
    if (typeof value === "string") {
      const normalized = value.toLowerCase();
      return [
        "alarm",
        "warn",
        "warning",
        "true",
        "1",
        "detected",
        "smoke",
      ].includes(normalized);
    }

    return false;
  }

  readMotionDetected(source) {
    const value = this.getStatusValue(source, [
      "pir",
      "pir_state",
      "presence_state",
      "motion_state",
    ]);

    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value > 0;
    }
    if (typeof value === "string") {
      const normalized = value.toLowerCase();
      return [
        "pir",
        "presence",
        "motion",
        "alarm",
        "detected",
        "true",
        "1",
      ].includes(normalized);
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
    const functions = this.extractFunctionEntries(device);

    const match = functions.find((entry) => entry?.code === code);
    const values = match?.values;

    if (typeof values === "string") {
      try {
        const parsed = JSON.parse(values);
        return {
          min: Number.isFinite(Number(parsed.min))
            ? Number(parsed.min)
            : fallbackMin,
          max: Number.isFinite(Number(parsed.max))
            ? Number(parsed.max)
            : fallbackMax,
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
    const safe = (((Number(degrees) || 0) % 360) + 360) % 360;
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
      return [
        "true",
        "1",
        "on",
        "opened",
        "open",
        "pir",
        "presence",
        "motion",
      ].includes(value.toLowerCase());
    }
    return fallback;
  }
}
