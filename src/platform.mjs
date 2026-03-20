"use strict";

import TuyaOpenAPI from "../lib/tuyaopenapi.mjs";
import TuyaSHOpenAPI from "../lib/tuyashopenapi.mjs";
import TuyaOpenMQ from "../lib/tuyamqttapi.mjs";

import OutletAccessory from "../lib/outlet_accessory.mjs";
import LightAccessory from "../lib/light_accessory.mjs";
import SwitchAccessory from "../lib/switch_accessory.mjs";
import SmokeSensorAccessory from "../lib/smokesensor_accessory.mjs";
import Fanv2Accessory from "../lib/fanv2_accessory.mjs";
import HeaterAccessory from "../lib/heater_accessory.mjs";
import GarageDoorAccessory from "../lib/garagedoor_accessory.mjs";
import AirPurifierAccessory from "../lib/air_purifier_accessory.mjs";
import WindowCoveringAccessory from "../lib/window_covering_accessory.mjs";
import ContactSensorAccessory from "../lib/contactsensor_accessory.mjs";
import LeakSensorAccessory from "../lib/leak_sensor_accessory.mjs";
import PushAccessory from "../lib/push_accessory.mjs";
import MotionSensorAccessory from "../lib/motionsensor_accessory.mjs";
import ValveAccessory from "../lib/valve_accessory.mjs";

import LogUtil from "../util/logutil.mjs";
import DataUtil from "../util/datautil.mjs";

import settings from "./settings.mjs";

/**
 * Homebridge Dynamic Platform Plugin
 */
class TuyaPlatform {
  /**
   * @param {import('homebridge').Logger} log
   * @param {any} config
   * @param {import('homebridge').API} api
   */
  constructor(log, config, api) {
    this.api = api;

    // Config can be missing / invalid, Homebridge will still construct the plugin.
    // We must not throw here.
    this.config = config ?? {};
    this.log = new LogUtil(log, Boolean(this.config?.options?.debug));

    if (!this.config?.options) {
      this.log.warn(
        "The config.json configuration is incorrect, disabling plugin.",
      );
      this.disabled = true;
      return;
    }

    this.disabled = false;

    /** @type {Map<string, import('homebridge').PlatformAccessory>} */
    this.accessories = new Map();

    /** @type {Map<string, any>} */
    this.deviceAccessories = new Map();

    api.on("didFinishLaunching", async () => {
      this.log.info("Initializing TuyaPlatform...");
      await this.initTuyaSDK(this.config);
    });

    // Clean shutdown: stop MQTT to avoid lingering sockets.
    api.on("shutdown", () => {
      try {
        this.tuyaOpenMQ?.stop();
      } catch (e) {
        // ignore
      }
    });
  }

  /**
   * Called by Homebridge to restore cached accessories.
   * @param {import('homebridge').PlatformAccessory} accessory
   */
  configureAccessory(accessory) {
    if (this.disabled) return;

    accessory.on("identify", (_paired, callback) => callback());

    // In Homebridge v2 / HAP-NodeJS v1, reachability was removed.
    // Do not touch accessory.reachable / updateReachability().

    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * Initialize Tuya APIs and MQTT, then discover devices.
   * @param {any} config
   */
  async initTuyaSDK(config) {
    if (this.disabled) return;

    let devices = [];
    let api;

    const options = config.options;
    const projectType = String(options.projectType ?? "1");

    try {
      if (projectType === "1") {
        api = new TuyaOpenAPI(
          options.endPoint,
          options.accessId,
          options.accessKey,
          this.log,
        );
        this.tuyaOpenApi = api;

        // Login before everything starts
        await api.login(options.username, options.password);

        devices = await api.getDeviceList();
      } else {
        api = new TuyaSHOpenAPI(
          options.accessId,
          options.accessKey,
          options.username,
          options.password,
          options.countryCode,
          options.appSchema,
          this.log,
        );
        this.tuyaOpenApi = api;

        devices = await api.getDevices();
      }
    } catch (e) {
      this.log.error(
        "Failed to initialize Tuya API. Please check config.json.",
      );
      this.log.error(e);
      return;
    }

    // Discover / add devices
    for (const device of devices) {
      this.addAccessory(device);
    }

    // MQTT
    try {
      const msgEncryptedVersion = projectType === "1" ? "2.0" : "1.0";
      const mq = new TuyaOpenMQ(api, msgEncryptedVersion, this.log);
      this.tuyaOpenMQ = mq;
      mq.start();
      mq.addMessageListener(this.onMQTTMessage.bind(this));
    } catch (e) {
      this.log.error("Failed to start Tuya MQTT.");
      this.log.debug(e);
    }
  }

  /**
   * Add / update an accessory for a Tuya device.
   * @param {any} device
   */
  addAccessory(device) {
    if (this.disabled) return;

    const deviceType = device.category;
    const deviceName = device.name || "unnamed";

    // ignore accessories
    const ignoreDevices = this.config?.options?.ignoreDevices ?? [];
    if (Array.isArray(ignoreDevices) && ignoreDevices.includes(device.id))
      return;

    this.log.info(`Adding: ${deviceName} (${deviceType} / ${device.id})`);

    // Get UUID
    const uuid = this.api.hap.uuid.generate(device.id);
    const homebridgeAccessory = this.accessories.get(uuid);

    let deviceAccessory;

    switch (deviceType) {
      case "kj":
        deviceAccessory = new AirPurifierAccessory(
          this,
          homebridgeAccessory,
          device,
        );
        break;

      case "dj":
      case "dd":
      case "fwd":
      case "tgq":
      case "xdd":
      case "dc":
      case "tgkg":
        deviceAccessory = new LightAccessory(this, homebridgeAccessory, device);
        break;

      case "cz":
      case "pc": {
        const deviceData = new DataUtil().getSubService(device.status);
        deviceAccessory = new OutletAccessory(
          this,
          homebridgeAccessory,
          device,
          deviceData,
        );
        break;
      }

      case "tdq":
      case "dlq": {
        const deviceData = new DataUtil().getSubService(device.status);
        deviceAccessory = new SwitchAccessory(
          this,
          homebridgeAccessory,
          device,
          deviceData,
        );
        break;
      }

      case "fs":
      case "fskg":
        deviceAccessory = new Fanv2Accessory(this, homebridgeAccessory, device);
        break;

      case "ywbj":
        deviceAccessory = new SmokeSensorAccessory(
          this,
          homebridgeAccessory,
          device,
        );
        break;

      case "qn":
        deviceAccessory = new HeaterAccessory(
          this,
          homebridgeAccessory,
          device,
        );
        break;

      case "ckmkzq": // garage_door_opener
        deviceAccessory = new GarageDoorAccessory(
          this,
          homebridgeAccessory,
          device,
        );
        break;

      case "cl":
      case "clkg":
        deviceAccessory = new WindowCoveringAccessory(
          this,
          homebridgeAccessory,
          device,
        );
        break;

      case "mcs":
        deviceAccessory = new ContactSensorAccessory(
          this,
          homebridgeAccessory,
          device,
        );
        break;

      case "rqbj":
      case "jwbj":
        deviceAccessory = new LeakSensorAccessory(
          this,
          homebridgeAccessory,
          device,
        );
        break;

      case "szjqr": {
        const deviceData = new DataUtil().getSubService(device.status);
        deviceAccessory = new PushAccessory(
          this,
          homebridgeAccessory,
          device,
          deviceData,
        );
        break;
      }

      case "pir": {
        const motionList = Array.isArray(this.config?.options?.motion)
          ? this.config.options.motion
          : [];
        const accPir = motionList.find((v) => v?.deviceId === device.id);
        if (accPir != null) {
          deviceAccessory = new MotionSensorAccessory(
            this,
            homebridgeAccessory,
            device,
            accPir.overrideTuya,
          );
        }
        break;
      }

      case "kg": {
        const deviceData = new DataUtil().getSubService(device.status);
        const valveList = Array.isArray(this.config?.options?.valve)
          ? this.config.options.valve
          : [];
        const accKg = valveList.find(
          (v) => v?.deviceId === device.id && v?.isActive === true,
        );
        deviceAccessory =
          accKg != null
            ? new ValveAccessory(this, homebridgeAccessory, device, deviceData)
            : new SwitchAccessory(
                this,
                homebridgeAccessory,
                device,
                deviceData,
              );
        break;
      }

      default:
        // Unsupported device type.
        return;
    }

    if (!deviceAccessory?.homebridgeAccessory) return;

    this.accessories.set(uuid, deviceAccessory.homebridgeAccessory);
    this.deviceAccessories.set(uuid, deviceAccessory);
  }

  /**
   * Handle device deletion, addition, status update.
   * @param {any} message
   */
  async onMQTTMessage(message) {
    if (this.disabled) return;

    if (message?.bizCode) {
      if (message.bizCode === "delete") {
        const uuid = this.api.hap.uuid.generate(message.devId);
        const homebridgeAccessory = this.accessories.get(uuid);
        this.removeAccessory(homebridgeAccessory);
        return;
      }

      if (message.bizCode === "bindUser") {
        try {
          const deviceInfo = await this.tuyaOpenApi.getDeviceInfo(
            message.bizData.devId,
          );
          const functions = await this.tuyaOpenApi.getDeviceFunctions(
            message.bizData.devId,
          );
          const device = Object.assign(deviceInfo, functions);
          this.addAccessory(device);
        } catch (e) {
          this.log.debug(e);
        }
        return;
      }

      return;
    }

    await this.refreshDeviceStates(message);
  }

  /**
   * Refresh accessory status.
   * @param {any} message
   */
  async refreshDeviceStates(message) {
    const uuid = this.api.hap.uuid.generate(message.devId);
    const deviceAccessory = this.deviceAccessories.get(uuid);
    if (deviceAccessory) {
      deviceAccessory.updateState(message);
    }
  }

  /**
   * Called from device classes.
   * @param {import('homebridge').PlatformAccessory} platformAccessory
   */
  registerPlatformAccessory(platformAccessory) {
    this.log.info(
      `Register Platform Accessory ${platformAccessory.displayName}`,
    );
    this.api.registerPlatformAccessories(
      settings.PLUGIN_NAME,
      settings.PLATFORM_NAME,
      [platformAccessory],
    );
  }

  /**
   * Remove accessory dynamically from outside events.
   * @param {import('homebridge').PlatformAccessory | undefined} accessory
   */
  removeAccessory(accessory) {
    if (!accessory) return;

    this.log.info(`Remove Accessory ${accessory.displayName}`);

    this.api.unregisterPlatformAccessories(
      settings.PLUGIN_NAME,
      settings.PLATFORM_NAME,
      [accessory],
    );

    this.accessories.delete(accessory.UUID);
    this.deviceAccessories.delete(accessory.UUID);
  }
}

export default {
  TuyaPlatform,
};
