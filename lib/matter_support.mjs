"use strict";

import { promises as fs } from "node:fs";
import path from "node:path";

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
    this.restoringAccessories = new Set();
    this.postRegistrationTimers = new Map();
    this.runtimeBuckets = new Map();
    this.bootstrapLoaded = false;

    const storageRoot =
      typeof this.api?.user?.storagePath === "function"
        ? this.api.user.storagePath()
        : process.cwd();
    const cacheKey = String(
      this.platform.config?.name || this.platformName || "tuya-matter",
    )
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .slice(0, 80);
    this.bootstrapCacheDir = path.join(storageRoot, ".tuya-matter-bridge");
    this.bootstrapCachePath = path.join(
      this.bootstrapCacheDir,
      `${cacheKey}.json`,
    );
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
    this.restoringAccessories.add(accessory.UUID);
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

  async bootstrapFromLocalCache() {
    if (
      !this.isEnabled() ||
      this.accessories.size > 0 ||
      this.bootstrapLoaded
    ) {
      return;
    }

    const devices = await this.readBootstrapCache();
    this.bootstrapLoaded = true;

    if (devices.length === 0) {
      return;
    }

    let restored = 0;
    for (const device of devices) {
      this.noteDevice(device);
      if (!this.supports(device)) continue;

      const MatterType = this.resolveType(device);
      const created = MatterType?.create?.(this.platform, this, device);
      if (!created) continue;

      const uuid = created.UUID || this.uuidFor(device.id);
      if (this.accessories.has(uuid)) continue;

      try {
        this.pendingRegistrations.add(uuid);
        await this.api.matter.registerPlatformAccessories(
          this.pluginName,
          this.platformName,
          [created],
        );
        this.accessories.set(created.UUID, created);
        if (created.context?.deviceId) {
          this.deviceIndex.set(created.context.deviceId, created.UUID);
        }
        this.schedulePostRegistrationSync(created, { delayMs: 250 });
        restored += 1;
      } catch (error) {
        this.pendingRegistrations.delete(uuid);
        this.log.warn(
          `[Matter] Bootstrap cache registration failed for ${device?.name || device?.id || uuid}: ${error?.message || error}`,
        );
      }
    }

    if (restored > 0) {
      this.log.info(
        `[Matter] Bootstrapped ${restored} accessory${restored === 1 ? "" : "ies"} from local cache.`,
      );
    }
  }

  async readBootstrapCache() {
    try {
      const raw = await fs.readFile(this.bootstrapCachePath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.devices) ? parsed.devices : [];
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.log.warn(
          `[Matter] Failed to read bootstrap cache: ${error?.message || error}`,
        );
      }
      return [];
    }
  }

  async writeBootstrapCache(devices = Array.from(this.latestDevices.values())) {
    try {
      await fs.mkdir(this.bootstrapCacheDir, { recursive: true });
      await fs.writeFile(
        this.bootstrapCachePath,
        JSON.stringify({ version: 1, updatedAt: Date.now(), devices }, null, 2),
        "utf8",
      );
    } catch (error) {
      this.log.warn(
        `[Matter] Failed to write bootstrap cache: ${error?.message || error}`,
      );
    }
  }

  getRuntimeBucket(name) {
    if (!this.runtimeBuckets.has(name)) {
      this.runtimeBuckets.set(name, new Map());
    }
    return this.runtimeBuckets.get(name);
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

    let newAccessories = 0;

    for (const device of devices) {
      this.noteDevice(device);
      if (!this.supports(device)) continue;

      const MatterType = this.resolveType(device);
      const created = MatterType?.create?.(this.platform, this, device);
      if (!created) continue;

      const uuid = this.uuidFor(device.id);
      const existing = this.accessories.get(uuid);

      if (!existing) {
        try {
          this.pendingRegistrations.add(uuid);
          await this.api.matter.registerPlatformAccessories(
            this.pluginName,
            this.platformName,
            [created],
          );
          this.accessories.set(created.UUID, created);
          if (created.context?.deviceId) {
            this.deviceIndex.set(created.context.deviceId, created.UUID);
          }
          this.schedulePostRegistrationSync(created);
          newAccessories += 1;
        } catch (error) {
          this.pendingRegistrations.delete(uuid);
          this.log.error(
            `[Matter] Failed to register ${created.displayName || device.id}: ${error?.message || error}`,
          );
        }
        continue;
      }

      if (this.hasAccessoryStructureChanged(existing, created, MatterType)) {
        await this.removeDevice(device.id);
        try {
          this.pendingRegistrations.add(uuid);
          await this.api.matter.registerPlatformAccessories(
            this.pluginName,
            this.platformName,
            [created],
          );
          this.accessories.set(created.UUID, created);
          if (created.context?.deviceId) {
            this.deviceIndex.set(created.context.deviceId, created.UUID);
          }
          this.schedulePostRegistrationSync(created);
          newAccessories += 1;
        } catch (error) {
          this.pendingRegistrations.delete(uuid);
          this.log.error(
            `[Matter] Failed to re-register ${created.displayName || device.id}: ${error?.message || error}`,
          );
        }
        continue;
      }

      await this.refreshCachedAccessory(existing, created, device, MatterType);
    }

    for (const device of devices) {
      const uuid = this.deviceIndex.get(device.id) || this.uuidFor(device.id);
      if (
        this.pendingRegistrations.has(uuid) ||
        this.restoringAccessories.has(uuid)
      ) {
        continue;
      }
      await this.syncDeviceSnapshot(device);
    }

    await this.writeBootstrapCache(devices);

    this.log.info(
      `Matter support active: ${newAccessories} new accessory${newAccessories === 1 ? "" : "ies"} registered.`,
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

    if (this.restoringAccessories.has(existing.UUID)) {
      this.schedulePostRegistrationSync(existing, {
        restoring: true,
        delayMs: 2500,
      });
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

  schedulePostRegistrationSync(accessory, options = {}) {
    const uuid = accessory?.UUID;
    const deviceId = accessory?.context?.deviceId;
    if (!uuid || !deviceId) return;

    const previous = this.postRegistrationTimers.get(uuid);
    if (previous) clearTimeout(previous);

    const delayMs = Number(options.delayMs ?? 1500);
    const restoring = options.restoring === true;

    const timer = setTimeout(async () => {
      this.postRegistrationTimers.delete(uuid);
      try {
        const snapshot = this.latestDevices.get(deviceId);
        if (snapshot) await this.syncDeviceSnapshot(snapshot);
      } finally {
        if (restoring) {
          this.restoringAccessories.delete(uuid);
        } else {
          this.pendingRegistrations.delete(uuid);
        }
      }
    }, delayMs);

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
    if (
      this.pendingRegistrations.has(uuid) ||
      this.restoringAccessories.has(uuid)
    )
      return;

    await this.syncDeviceSnapshot(merged);
  }

  async syncDeviceSnapshot(device) {
    if (!device?.id) return;
    const uuid = this.deviceIndex.get(device.id) || this.uuidFor(device.id);
    const accessory = this.accessories.get(uuid);
    if (!accessory) return;
    const MatterType = this.resolveType(accessory.context || device);
    if (!MatterType?.sync) return;
    await MatterType.sync(this.platform, this, accessory, device);
  }

  async safeUpdateAccessoryState(uuid, clusterName, patch, options = {}) {
    if (
      this.pendingRegistrations.has(uuid) ||
      this.restoringAccessories.has(uuid)
    ) {
      return;
    }

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
    this.restoringAccessories.delete(uuid);

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
    await this.writeBootstrapCache();
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
