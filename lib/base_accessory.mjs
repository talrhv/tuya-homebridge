"use strict";

/**
 * Base class of Accessory - Homebridge 1.x & 2.0 Compatibility Edition
 */
export default class BaseAccessory {
  constructor(
    platform,
    homebridgeAccessory,
    deviceConfig,
    categoryType,
    serviceType,
    subServices = [],
  ) {
    this.platform = platform;
    this.deviceId = deviceConfig.id;
    this.categoryType = categoryType;
    this.log = platform.log;

    const { api } = platform;
    const { hap } = api;

    // --- Backward Compatibility Logic ---
    const Categories = hap.Categories || hap.Accessory?.Categories;
    const Characteristic = hap.Characteristic;
    const Service = hap.Service;
    const UUIDGen = hap.uuid;

    this.homebridgeAccessory = homebridgeAccessory;
    this.deviceConfig = deviceConfig;

    // Caching
    this.cachedState = new Map();
    this.validCache = false;

    this.serviceType = serviceType;
    this.subServices = subServices;

    const pluginName = this.platform.PLUGIN_NAME;
    const platformName = this.platform.PLATFORM_NAME;

    let isExisting = true;

    // Accessory Setup
    if (this.homebridgeAccessory) {
      this.homebridgeAccessory.controller = this;
      this.homebridgeAccessory.category = categoryType;
      if (!this.homebridgeAccessory.context.deviceId) {
        this.homebridgeAccessory.context.deviceId = this.deviceId;
      }

      this.log.debug(
        `Existing Accessory found: ${this.homebridgeAccessory.displayName} (${this.deviceId})`,
      );
      this._updateDisplayName(this.deviceConfig.name);
    } else {
      isExisting = false;
      this.log.info(
        `Creating New Accessory: ${this.deviceConfig.name} (${this.deviceId})`,
      );

      const PlatformAccessory = api.platformAccessory;
      this.homebridgeAccessory = new PlatformAccessory(
        this.deviceConfig.name,
        UUIDGen.generate(this.deviceId),
        categoryType,
      );

      this.homebridgeAccessory.context.deviceId = this.deviceId;
      this.homebridgeAccessory.controller = this;
    }

    // Service Setup (Main or Sub-services)
    this._setupServices(Service, Characteristic);

    // Default Identify Handler
    this.homebridgeAccessory.on("identify", async () => {
      this.log.info(
        `Identify requested for ${this.homebridgeAccessory.displayName}`,
      );
    });

    // --- THE FIX: Deferring Registration/Update ---
    // אנו דוחים את העדכון לסוף תור הריצה (Event Loop) כדי לוודא שקלאס ה"בן"
    // (למשל SwitchAccessory) סיים להריץ את initStatus ולחבר את הלחצנים.
    process.nextTick(() => {
      if (!pluginName || !platformName) {
        this.log.error(
          "Cannot sync accessory: PLUGIN_NAME or PLATFORM_NAME is undefined.",
        );
        return;
      }

      if (isExisting) {
        // עדכון האביזר הקיים רק אחרי שכל הלוגיקה נטענה
        this.platform.api.updatePlatformAccessories([this.homebridgeAccessory]);
      } else {
        // רישום אביזר חדש רק אחרי שכל הלוגיקה נטענה
        try {
          this.platform.api.registerPlatformAccessories(
            pluginName,
            platformName,
            [this.homebridgeAccessory],
          );
        } catch (err) {
          this.log.debug(
            `[Sync] Accessory ${this.deviceConfig.name} is already registered in HAP Server. Moving on.`,
          );
        }
      }
    });
  }

  _sanitizeName(name) {
    if (!name) return "Unknown";
    return name.replace(/[^a-zA-Z0-9 'א-ת]/g, " ").trim();
  }

  _setupServices(Service, Characteristic) {
    const cleanDeviceName = this._sanitizeName(this.deviceConfig.name);

    if (this.subServices.length <= 1) {
      this.service =
        this.homebridgeAccessory.getService(this.serviceType) ||
        this.homebridgeAccessory.addService(
          this.serviceType,
          this.deviceConfig.name,
        );

      this.service.setCharacteristic(Characteristic.Name, cleanDeviceName);
    } else {
      for (const subName of this.subServices) {
        const cleanSubName = this._sanitizeName(subName);

        const service =
          this.homebridgeAccessory.getServiceById(this.serviceType, subName) ||
          this.homebridgeAccessory.addService(
            this.serviceType,
            cleanSubName,
            subName,
          );

        service.setCharacteristic(Characteristic.Name, cleanSubName);
      }
    }
  }

  setCachedState(characteristic, value) {
    this.cachedState.set(characteristic, value);
    this.validCache = true;
  }

  getCachedState(characteristic) {
    return this.cachedState.get(characteristic);
  }

  updateCharacteristic(characteristic, value) {
    this.service.getCharacteristic(characteristic).updateValue(value);
    this.setCachedState(characteristic, value);
  }

  _updateDisplayName(name) {
    if (!name) return;
    const { Characteristic, Service } = this.platform.api.hap;

    if (typeof this.homebridgeAccessory.updateDisplayName === "function") {
      this.homebridgeAccessory.updateDisplayName(name);
    } else {
      this.homebridgeAccessory.displayName = name;
    }

    const infoService = this.homebridgeAccessory.getService(
      Service.AccessoryInformation,
    );
    if (infoService) {
      infoService.getCharacteristic(Characteristic.Name).updateValue(name);
      infoService
        .setCharacteristic(Characteristic.Manufacturer, "Tuya")
        .setCharacteristic(
          Characteristic.Model,
          this.deviceConfig.model || "Unknown",
        )
        .setCharacteristic(
          Characteristic.SerialNumber,
          this.deviceId || "Default-SN",
        );
    }
  }

  setOffline(isOffline) {
    const { Characteristic } = this.platform.api.hap;
    const faultValue = isOffline
      ? Characteristic.StatusFault.GENERAL_FAULT
      : Characteristic.StatusFault.NO_FAULT;

    this.homebridgeAccessory.services.forEach((service) => {
      if (service.testCharacteristic(Characteristic.StatusFault)) {
        service.updateCharacteristic(Characteristic.StatusFault, faultValue);
      }
    });
  }

  initStatus() {}
  updateState(device) {}
}
