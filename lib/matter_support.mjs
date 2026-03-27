"use strict";

import { MATTER_ACCESSORY_TYPES } from "./accessories/matter/index.mjs";
import {
  extractStatusEntries,
  getStatusValue,
  hasCode,
  mergeStatusArrays,
  pickSupportedCode,
  getNumericRangeForCode,
  rangeToPercent,
  percentToRange,
  percentToMatterLevel,
  matterLevelToPercent,
  percentToMatterSat,
  matterSatToPercent,
  degreesToMatterHue,
  matterHueToDegrees,
  colorTempPercentToMireds,
  miredsToColorTempPercent,
  toBoolean,
} from "./accessories/matter/_shared.mjs";

function deepEqual(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
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
    this.pendingRestores = new Set();
    this.postRegistrationTimers = new Map();
    this.runtimeBuckets = new Map();
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

  uuidFor(deviceId) {
    return this.api.matter.uuid.generate(`tuya:${deviceId}`);
  }

  restoreAccessory(accessory) {
    if (!accessory?.UUID) return;
    this.accessories.set(accessory.UUID, accessory);
    if (accessory.context?.deviceId) {
      this.deviceIndex.set(accessory.context.deviceId, accessory.UUID);
    }
    this.pendingRestores.add(accessory.UUID);
    this.rebindHandlers(accessory);
  }

  noteDevice(device) {
    if (device?.id) this.latestDevices.set(device.id, device);
  }

  supports(device) {
    if (!device?.id || !device?.category) return false;
    const ignoreDevices = this.platform.config?.options?.ignoreDevices ?? [];
    if (Array.isArray(ignoreDevices) && ignoreDevices.includes(device.id))
      return false;
    return Boolean(this.resolveType(device));
  }

  resolveType(deviceOrContext) {
    if (!deviceOrContext) return null;
    const forced = deviceOrContext?.matterAccessoryType;
    if (forced) {
      return (
        MATTER_ACCESSORY_TYPES.find((entry) => entry.id === forced) || null
      );
    }
    for (const MatterType of MATTER_ACCESSORY_TYPES) {
      if (
        typeof MatterType.matches === "function" &&
        !MatterType.matches(deviceOrContext)
      ) {
        continue;
      }
      if (
        typeof MatterType.canCreate === "function" &&
        !MatterType.canCreate(this.platform, this, deviceOrContext)
      ) {
        continue;
      }
      return MatterType;
    }
    return null;
  }

  getMotionConfig(deviceId) {
    return (
      (this.platform.config?.options?.motion || []).find(
        (entry) => entry?.deviceId === deviceId,
      ) || null
    );
  }

  isValveDevice(device) {
    const deviceId = typeof device === "string" ? device : device?.id;
    if (!deviceId) return false;
    const cleanId = String(deviceId).trim();

    const configuredValves = this.platform.config?.options?.valve;
    this.log.info(
      `[Valve Debug] Checking ${cleanId}. Config found:`,
      JSON.stringify(configuredValves),
    );

    return Boolean(
      (configuredValves || []).find((entry) => {
        const entryId = String(entry?.deviceId || "").trim();
        const isActive =
          entry?.isActive === true ||
          String(entry?.isActive).toLowerCase() === "true";
        return entryId === cleanId && isActive;
      }),
    );
  }

  getRuntimeBucket(name) {
    if (!this.runtimeBuckets.has(name)) {
      this.runtimeBuckets.set(name, new Map());
    }
    return this.runtimeBuckets.get(name);
  }

  isStartupPending(uuid) {
    return (
      this.pendingRegistrations.has(uuid) || this.pendingRestores.has(uuid)
    );
  }

  async registerNewAccessories(accessories = []) {
    let successCount = 0;
    for (const accessory of accessories) {
      try {
        await this.api.matter.registerPlatformAccessories(
          this.pluginName,
          this.platformName,
          [accessory],
        );

        this.accessories.set(accessory.UUID, accessory);
        if (accessory.context?.deviceId) {
          this.deviceIndex.set(accessory.context.deviceId, accessory.UUID);
        }
        this.schedulePostRegistrationSync(accessory);
        successCount += 1;
      } catch (error) {
        this.pendingRegistrations.delete(accessory.UUID);
        const timer = this.postRegistrationTimers.get(accessory.UUID);
        if (timer) {
          clearTimeout(timer);
          this.postRegistrationTimers.delete(accessory.UUID);
        }
        this.log.error(
          `[Matter] Failed to register ${accessory.displayName || accessory.UUID}: ${error?.message || error}`,
        );
      }
    }
    return successCount;
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

    for (const device of devices) {
      this.noteDevice(device);
      if (!this.supports(device)) continue;

      const MatterType = this.resolveType(device);
      const created = MatterType?.create?.(this.platform, this, device);
      if (!created) continue;

      const uuid = this.uuidFor(device.id);
      const existing = this.accessories.get(uuid);

      if (!existing) {
        this.pendingRegistrations.add(uuid);
        newAccessories.push(created);
        continue;
      }

      if (this.hasAccessoryStructureChanged(existing, created, MatterType)) {
        await this.removeDevice(device.id);
        this.pendingRegistrations.add(uuid);
        this.pendingRestores.delete(uuid);
        newAccessories.push(created);
        continue;
      }

      await this.refreshCachedAccessory(existing, created, device, MatterType);

      if (this.pendingRestores.has(uuid)) {
        this.schedulePostRestoreSync(existing, device);
      }
    }

    let registeredCount = 0;
    if (newAccessories.length > 0) {
      registeredCount = await this.registerNewAccessories(newAccessories);
    }

    for (const device of devices) {
      const uuid = this.deviceIndex.get(device.id) || this.uuidFor(device.id);
      if (this.isStartupPending(uuid)) {
        continue;
      }
      await this.syncDeviceSnapshot(device);
    }

    this.log.info(
      `Matter support active: ${registeredCount} new accessory${registeredCount === 1 ? "" : "ies"} registered.`,
    );
  }

  hasAccessoryStructureChanged(existing, created, MatterType) {
    // Safely check deviceType to avoid triggering on HAP cached accessories
    if (existing?.deviceType && created?.deviceType) {
      if (existing.deviceType !== created.deviceType) return true;
    }

    if (
      (existing?.context?.matterAccessoryType ||
        created?.context?.matterAccessoryType) &&
      existing?.context?.matterAccessoryType !==
        created?.context?.matterAccessoryType
    ) {
      return true;
    }
    if (typeof MatterType?.hasDifferentShape === "function") {
      return MatterType.hasDifferentShape(
        existing,
        created,
        this.platform,
        this,
      );
    }
    const existingParts = Array.isArray(existing?.parts) ? existing.parts : [];
    const createdParts = Array.isArray(created?.parts) ? created.parts : [];
    if (existingParts.length !== createdParts.length) return true;
    for (let i = 0; i < existingParts.length; i += 1) {
      if (existingParts[i]?.id !== createdParts[i]?.id) return true;
    }
    return false;
  }

  async refreshCachedAccessory(existing, created, device, MatterType) {
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

    const existingParts = Array.isArray(existing.parts) ? existing.parts : [];
    const createdParts = Array.isArray(created.parts) ? created.parts : [];
    if (!deepEqual(existingParts, createdParts)) {
      updates.parts = createdParts;
      existing.parts = createdParts;
      changed = true;
    }

    this.accessories.set(existing.UUID, existing);
    this.deviceIndex.set(device.id, existing.UUID);
    this.noteDevice(device);
    this.rebindHandlers(existing, device, MatterType);

    if (changed) {
      await this.api.matter.updatePlatformAccessories([updates]);
    }
  }

  rebindHandlers(accessory, discoveredDevice, MatterType = null) {
    const Resolved = MatterType || this.resolveType(accessory?.context);
    if (!Resolved) return;
    Resolved.rebind?.(
      this.platform,
      this,
      accessory,
      discoveredDevice ?? this.latestDevices.get(accessory.context?.deviceId),
    );
  }

  schedulePostRegistrationSync(accessory) {
    const uuid = accessory?.UUID;
    const deviceId = accessory?.context?.deviceId;
    if (!uuid || !deviceId) return;

    const previous = this.postRegistrationTimers.get(uuid);
    if (previous) clearTimeout(previous);

    const timer = setTimeout(async () => {
      this.postRegistrationTimers.delete(uuid);
      try {
        const snapshot = this.latestDevices.get(deviceId);
        if (snapshot) await this.syncDeviceSnapshot(snapshot);
      } finally {
        this.pendingRegistrations.delete(uuid);
      }
    }, 1500);

    if (typeof timer?.unref === "function") {
      timer.unref();
    }

    this.postRegistrationTimers.set(uuid, timer);
  }

  schedulePostRestoreSync(accessory, discoveredDevice) {
    const uuid = accessory?.UUID;
    const deviceId = discoveredDevice?.id || accessory?.context?.deviceId;
    if (!uuid || !deviceId) return;

    const previous = this.postRegistrationTimers.get(uuid);
    if (previous) clearTimeout(previous);

    const timer = setTimeout(async () => {
      this.postRegistrationTimers.delete(uuid);
      try {
        const snapshot = this.latestDevices.get(deviceId) || discoveredDevice;
        if (snapshot) await this.syncDeviceSnapshot(snapshot);
      } finally {
        this.pendingRestores.delete(uuid);
      }
    }, 1500);

    if (typeof timer?.unref === "function") {
      timer.unref();
    }

    this.postRegistrationTimers.set(uuid, timer);
  }

  async syncMessage(message) {
    const deviceId = message?.devId || message?.deviceId || message?.id;
    if (!deviceId) return;

    if (message.bizCode === "delete") {
      await this.removeDevice(deviceId);
      return;
    }

    const existingDevice = this.latestDevices.get(deviceId) ?? {};
    const merged = {
      ...(existingDevice ?? {}),
      ...(message ?? {}),
      id: deviceId,
      category: message?.category || existingDevice?.category,
      name: message?.name || existingDevice?.name,
    };

    const nextStatus = extractStatusEntries(message);
    if (nextStatus.length > 0) {
      merged.status = mergeStatusArrays(existingDevice?.status, nextStatus);
    }

    this.latestDevices.set(deviceId, merged);

    const uuid = this.deviceIndex.get(deviceId) || this.uuidFor(deviceId);
    if (this.isStartupPending(uuid)) return;

    await this.syncDeviceSnapshot(merged);
  }

  async syncDeviceSnapshot(device) {
    if (!device?.id) return;
    const uuid = this.deviceIndex.get(device.id) || this.uuidFor(device.id);
    if (this.isStartupPending(uuid)) return;
    const accessory = this.accessories.get(uuid);
    if (!accessory) return;
    const MatterType = this.resolveType(accessory.context || device);
    if (!MatterType?.sync) return;
    await MatterType.sync(this.platform, this, accessory, device);
  }

  async safeUpdateAccessoryState(uuid, clusterName, patch, options = {}) {
    const { partId, retries = 2 } = options;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        if (partId) {
          await this.api.matter.updateAccessoryState(
            uuid,
            clusterName,
            patch,
            partId,
          );
        } else {
          await this.api.matter.updateAccessoryState(uuid, clusterName, patch);
        }
        return;
      } catch (error) {
        const text = String(error?.message || error || "");
        const retryable =
          text.includes("not found or not registered") ||
          text.includes("not registered");
        if (this.isStartupPending(uuid) && retryable) {
          return;
        }
        if (!retryable || attempt === retries) {
          this.log.warn(
            `[Matter] Failed to update ${uuid} ${clusterName}${partId ? ` (${partId})` : ""}: ${text}`,
          );
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, 500 * (attempt + 1)),
        );
      }
    }
  }

  async removeDevice(deviceId) {
    const uuid = this.deviceIndex.get(deviceId) || this.uuidFor(deviceId);
    const accessory = this.accessories.get(uuid);

    const timer = this.postRegistrationTimers.get(uuid);
    if (timer) {
      clearTimeout(timer);
      this.postRegistrationTimers.delete(uuid);
    }
    this.pendingRegistrations.delete(uuid);
    this.pendingRestores.delete(uuid);

    for (const bucket of this.runtimeBuckets.values()) {
      const value = bucket.get(uuid);
      if (value) {
        clearTimeout(value);
        clearInterval(value);
        bucket.delete(uuid);
      }
    }

    if (!accessory) {
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

  async sendCommands(deviceId, commands) {
    await this.platform.tuyaOpenApi.sendCommand(deviceId, { commands });
  }

  extractStatusEntries(source) {
    return extractStatusEntries(source);
  }

  getStatusValue(source, ...codes) {
    return getStatusValue(source, ...codes);
  }

  hasCode(device, code) {
    return hasCode(device, code);
  }

  pickSupportedCode(device, candidates) {
    return pickSupportedCode(device, candidates);
  }

  getNumericRangeForCode(deviceIdOrDevice, code, fallbackMin, fallbackMax) {
    const device =
      typeof deviceIdOrDevice === "string"
        ? this.latestDevices.get(deviceIdOrDevice) || { id: deviceIdOrDevice }
        : deviceIdOrDevice;
    return getNumericRangeForCode(device, code, fallbackMin, fallbackMax);
  }

  rangeToPercent(raw, range, fallback = 100) {
    return rangeToPercent(raw, range, fallback);
  }

  percentToRange(percent, min, max) {
    return percentToRange(percent, min, max);
  }

  percentToMatterLevel(percent) {
    return percentToMatterLevel(percent);
  }

  matterLevelToPercent(level) {
    return matterLevelToPercent(level);
  }

  percentToMatterSat(percent) {
    return percentToMatterSat(percent);
  }

  matterSatToPercent(value) {
    return matterSatToPercent(value);
  }

  degreesToMatterHue(degrees) {
    return degreesToMatterHue(degrees);
  }

  matterHueToDegrees(value) {
    return matterHueToDegrees(value);
  }

  colorTempPercentToMireds(percent) {
    return colorTempPercentToMireds(percent);
  }

  miredsToColorTempPercent(mireds) {
    return miredsToColorTempPercent(mireds);
  }

  toBoolean(value, fallback = false) {
    return toBoolean(value, fallback);
  }
}
