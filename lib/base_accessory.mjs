"use strict";

let PlatformAccessory;
let Accessory;
let Service;
let Characteristic;
let UUIDGen;

// Base class of Accessory
class BaseAccessory {
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

    PlatformAccessory = platform.api.platformAccessory;
    ({ Accessory, Service, Characteristic, uuid: UUIDGen } = platform.api.hap);

    this.log = platform.log;
    this.homebridgeAccessory = homebridgeAccessory;
    this.deviceConfig = deviceConfig;

    // Setup caching
    this.cachedState = new Map();
    this.validCache = false;

    // Accessory Service
    this.serviceType = serviceType;

    // Accessory subServices
    this.subServices = subServices;

    // Accessory
    if (this.homebridgeAccessory) {
      this.homebridgeAccessory.controller = this;
      if (!this.homebridgeAccessory.context.deviceId) {
        this.homebridgeAccessory.context.deviceId = this.deviceConfig.id;
      }

      this.log.log(
        `Existing Accessory found ${this.homebridgeAccessory.displayName} ${this.homebridgeAccessory.context.deviceId} ${this.homebridgeAccessory.UUID}`,
      );

      this._updateDisplayName(this.deviceConfig.name);
    } else {
      // Create new Accessory
      this.log.log(`Creating New Accessory ${this.deviceConfig.id}`);

      this.homebridgeAccessory = new PlatformAccessory(
        this.deviceConfig.name,
        UUIDGen.generate(this.deviceConfig.id),
        categoryType,
      );

      this.homebridgeAccessory.context.deviceId = this.deviceConfig.id;
      this.homebridgeAccessory.controller = this;
      this.platform.registerPlatformAccessory(this.homebridgeAccessory);
    }

    // Service
    if (this.subServices.length === 0 || this.subServices.length === 1) {
      this.service = this.homebridgeAccessory.getService(this.serviceType);
      if (this.service) {
        this.service.setCharacteristic(
          Characteristic.Name,
          this.deviceConfig.name,
        );
      } else {
        // add new service
        this.service = this.homebridgeAccessory.addService(
          this.serviceType,
          this.deviceConfig.name,
        );
      }
    } else {
      // SubService
      for (const subService of this.subServices) {
        const service = this.homebridgeAccessory.getService(subService);
        if (service) {
          service.setCharacteristic(Characteristic.Name, subService);
        } else {
          // add new subService
          this.homebridgeAccessory.addService(
            this.serviceType,
            subService,
            subService,
          );
        }
      }
    }

    this.homebridgeAccessory.on("identify", (_paired, callback) => callback());
  }

  // Data Util
  dataUtil() {
    return this.deviceConfig || {};
  }

  // Customized characteristics of the device in HomeKit
  initStatus() {
    // override in child classes
  }

  // update mqtt state
  updateState(_device) {
    // override in child classes
  }

  // Update value
  updateCharacteristic(characteristic, value) {
    this.service.updateCharacteristic(characteristic, value);
    this.setCachedState(characteristic, value);
  }

  // Throttle updates to reduce HomeKit spam
  normalAsync(characteristic, value, delayMs = 0) {
    setTimeout(() => {
      this.service.getCharacteristic(characteristic).updateValue(value);
      this.setCachedState(characteristic, value);
    }, delayMs);
  }

  _updateDisplayName(name) {
    if (!name) return;

    // Homebridge v1.9+ has updateDisplayName(); older versions can still set displayName.
    if (typeof this.homebridgeAccessory.updateDisplayName === "function") {
      this.homebridgeAccessory.updateDisplayName(name);
    } else {
      this.homebridgeAccessory.displayName = name;
    }

    const accessoryInformationService =
      this.homebridgeAccessory.getService(Service.AccessoryInformation) ||
      this.homebridgeAccessory.addService(Service.AccessoryInformation);

    const characteristicName =
      accessoryInformationService.getCharacteristic(Characteristic.Name) ||
      accessoryInformationService.addCharacteristic(Characteristic.Name);

    characteristicName?.setValue(name);
  }

  updateAccessory(device) {
    if (device?.name) {
      this._updateDisplayName(device.name);
    }

    // Reachability was removed in Homebridge v2 / HAP-NodeJS v1.
    // If you want to show offline state, update a StatusFault/StatusActive characteristic instead.

    // Update device specific state
    this.updateState(device);
  }

  setCachedState(characteristic, value) {
    this.cachedState.set(characteristic, value);
    this.validCache = true;
  }

  getCachedState(characteristic) {
    return this.cachedState.get(characteristic);
  }

  hasValidCache() {
    return this.validCache && this.cachedState.size > 0;
  }

  invalidateCache() {
    this.validCache = false;
  }
}

export default BaseAccessory;
