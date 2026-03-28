"use strict";

import TuyaOpenAPI from "../lib/tuyaopenapi.mjs";
import TuyaSHOpenAPI from "../lib/tuyashopenapi.mjs";
import TuyaOpenMQ from "../lib/tuyamqttapi.mjs";
import TuyaMatterBridge from "../lib/matter_support.mjs";

// Accessories
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

const DEFAULT_PROJECT_TYPE = "1";

class TuyaPlatform {
  constructor(log, config, api) {
    this.api = api;
    this.config = config ?? {};

    this.PLUGIN_NAME = settings.PLUGIN_NAME;
    this.PLATFORM_NAME = settings.PLATFORM_NAME;

    this.log = new LogUtil(log, Boolean(this.config?.options?.debug));
    this.dataUtil = new DataUtil();
    this.matterReady = false;
    this.matterApiLoadPromise = null;
    this.onMQTTMessage = this.onMQTTMessage.bind(this);

    if (!this.config?.options) {
      this.log.warn(
        "The config.json configuration is incorrect, disabling plugin.",
      );
      this.disabled = true;
      return;
    }

    this.disabled = false;

    // HAP caches
    this.accessories = new Map();
    this.deviceAccessories = new Map();

    // Matter cache + logic
    this.matterBridge = new TuyaMatterBridge(this);

    api.on("didFinishLaunching", async () => {
      await this.handleDidFinishLaunching();
    });

    api.on("shutdown", () => {
      this.cleanup();
    });
  }

  async handleDidFinishLaunching() {
    if (this.disabled) {
      return;
    }

    this.log.info("Initializing TuyaPlatform...");

    try {
      await this.loadMatterApi();
      this.matterReady = true;
    } catch (error) {
      this.matterReady = false;
      this.log.warn(
        "[Matter] Failed to load the Matter API. Continuing without Matter support.",
      );
      this.log.debug(error?.stack || String(error));
    }

    await this.initTuyaSDK(this.config);
  }

  async loadMatterApi() {
    if (this.matterApiLoadPromise) {
      return this.matterApiLoadPromise;
    }

    if (typeof this.api?.loadMatterAPI !== "function") {
      throw new Error("Homebridge Matter API is unavailable in this runtime.");
    }

    this.matterApiLoadPromise = this.api.loadMatterAPI();

    try {
      await this.matterApiLoadPromise;
    } catch (error) {
      this.matterApiLoadPromise = null;
      throw error;
    }
  }

  cleanup() {
    this.tuyaOpenMQ?.stop();
    this.matterBridge.cleanup();
  }

  /**
   * Homebridge calls this to restore HAP accessories from cache.
   */
  configureAccessory(accessory) {
    if (this.disabled) {
      return;
    }

    this.log.debug(`Restoring accessory from cache: ${accessory.displayName}`);

    accessory.on("identify", () =>
      this.log.info(`${accessory.displayName} identify requested`),
    );

    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * Homebridge calls this to restore Matter accessories from cache.
   * Cached Matter accessories are re-registered automatically after this callback.
   */
  async configureMatterAccessory(accessory) {
    await this.loadMatterApi();
    if (this.disabled) {
      return;
    }

    this.log.debug(
      `[Matter] Restoring accessory from cache: ${accessory.displayName}`,
    );
    this.matterBridge.restoreAccessory(accessory);
  }

  async initTuyaSDK(config) {
    if (this.disabled) {
      return;
    }

    const options = config.options ?? {};
    const projectType = String(options.projectType ?? DEFAULT_PROJECT_TYPE);

    try {
      this.tuyaOpenApi = await this.createTuyaClient(options, projectType);
    } catch (error) {
      this.log.error("Failed to initialize Tuya API. Check config.json.");
      this.log.error(error);
      return;
    }

    let devices = [];
    try {
      devices = await this.getDevices(projectType);
    } catch (error) {
      this.log.error("Failed to fetch Tuya devices.");
      this.log.error(error);
      return;
    }

    for (const device of devices) {
      this.addAccessory(device);
    }

    await this.registerMatterDevices(devices);
    await this.startRealtimeUpdates(projectType);
  }

  async createTuyaClient(options, projectType) {
    if (projectType === "1") {
      const api = new TuyaOpenAPI(
        options.endPoint,
        options.accessId,
        options.accessKey,
        this.log,
      );

      await api.login(options.username, options.password);
      return api;
    }

    return new TuyaSHOpenAPI(
      options.accessId,
      options.accessKey,
      options.username,
      options.password,
      options.countryCode,
      options.appSchema,
      this.log,
    );
  }

  async getDevices(projectType) {
    return projectType === "1"
      ? this.tuyaOpenApi.getDeviceList()
      : this.tuyaOpenApi.getDevices();
  }

  async registerMatterDevices(devices) {
    if (!this.matterReady) {
      return;
    }

    try {
      await this.matterBridge.registerDevices(devices);
    } catch (error) {
      this.log.error("Failed to register Matter accessories.");
      this.log.error(error);
    }
  }

  async startRealtimeUpdates(projectType) {
    try {
      const msgEncryptedVersion = projectType === "1" ? "2.0" : "1.0";
      const mq = new TuyaOpenMQ(
        this.tuyaOpenApi,
        msgEncryptedVersion,
        this.log,
      );

      this.tuyaOpenMQ = mq;
      mq.start();
      mq.addMessageListener(this.onMQTTMessage);

      this.log.debug(
        "[Matter] Using MQTT events for device -> Home app state synchronization.",
      );
    } catch (error) {
      this.log.error("Failed to start Tuya MQTT.");
      this.log.error(error);
    }
  }

  addAccessory(device) {
    if (this.disabled) {
      return;
    }

    const deviceType = device.category;
    const deviceId = device.id;
    const deviceName = device.name || "unnamed";

    const uuid = this.api.hap.uuid.generate(deviceId);
    if (this.deviceAccessories.has(uuid)) {
      this.log.debug(
        `Accessory already initialized and active: ${deviceName} (${deviceId})`,
      );
      return;
    }

    const ignoreDevices = this.config?.options?.ignoreDevices ?? [];
    if (Array.isArray(ignoreDevices) && ignoreDevices.includes(deviceId)) {
      this.log.debug(`Ignoring device as per config: ${deviceName}`);
      return;
    }

    const homebridgeAccessory = this.accessories.get(uuid);

    this.log.info(
      `Initializing accessory: ${deviceName} (${deviceType} / ${deviceId})`,
    );

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
      case "pc":
        deviceAccessory = new OutletAccessory(
          this,
          homebridgeAccessory,
          device,
          this.dataUtil.getSubService(device.status),
        );
        break;
      case "tdq":
      case "dlq":
        deviceAccessory = new SwitchAccessory(
          this,
          homebridgeAccessory,
          device,
          this.dataUtil.getSubService(device.status),
        );
        break;
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
      case "ckmkzq":
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
      case "szjqr":
        deviceAccessory = new PushAccessory(
          this,
          homebridgeAccessory,
          device,
          this.dataUtil.getSubService(device.status),
        );
        break;
      case "pir": {
        const pirConfig = (this.config?.options?.motion || []).find(
          (entry) => entry?.deviceId === deviceId,
        );

        if (pirConfig) {
          deviceAccessory = new MotionSensorAccessory(
            this,
            homebridgeAccessory,
            device,
            pirConfig.overrideTuya,
          );
        }
        break;
      }
      case "kg": {
        const deviceData = this.dataUtil.getSubService(device.status);
        const valveConfig = (this.config?.options?.valve || []).find(
          (entry) => entry?.deviceId === deviceId && entry?.isActive === true,
        );

        deviceAccessory = valveConfig
          ? new ValveAccessory(this, homebridgeAccessory, device, deviceData)
          : new SwitchAccessory(this, homebridgeAccessory, device, deviceData);
        break;
      }
      default:
        this.log.debug(`Unsupported device type: ${deviceType}`);
        return;
    }

    if (deviceAccessory?.homebridgeAccessory) {
      this.accessories.set(uuid, deviceAccessory.homebridgeAccessory);
      this.deviceAccessories.set(uuid, deviceAccessory);
    }
  }

  async onMQTTMessage(message) {
    const deviceId = message?.devId;
    if (this.disabled || !deviceId) {
      return;
    }

    if (message.bizCode === "delete") {
      const uuid = this.api.hap.uuid.generate(deviceId);
      this.removeAccessory(this.accessories.get(uuid));

      if (!this.matterReady) {
        return;
      }

      try {
        await this.matterBridge.removeDevice(deviceId);
      } catch (error) {
        this.log.error(`Failed to remove Matter accessory for ${deviceId}.`);
        this.log.error(error);
      }
      return;
    }

    const uuid = this.api.hap.uuid.generate(deviceId);
    const deviceAccessory = this.deviceAccessories.get(uuid);
    if (deviceAccessory) {
      try {
        deviceAccessory.updateState(message);
      } catch (error) {
        this.log.error(`Failed to sync HAP state for ${deviceId}.`);
        this.log.error(error);
      }
    }

    if (!this.matterReady) {
      return;
    }

    try {
      await this.matterBridge.syncMessage(message);
    } catch (error) {
      this.log.error(`Failed to sync Matter state for ${deviceId}.`);
      this.log.error(error);
    }
  }

  removeAccessory(accessory) {
    if (!accessory) {
      return;
    }

    this.log.info(`Removing accessory: ${accessory.displayName}`);
    this.api.unregisterPlatformAccessories(
      this.PLUGIN_NAME,
      this.PLATFORM_NAME,
      [accessory],
    );
    this.accessories.delete(accessory.UUID);
    this.deviceAccessories.delete(accessory.UUID);
  }
}

export default TuyaPlatform;
