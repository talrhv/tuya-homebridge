"use strict";

import TuyaOpenAPI from "../lib/tuyaopenapi.mjs";
import TuyaSHOpenAPI from "../lib/tuyashopenapi.mjs";
import TuyaOpenMQ from "../lib/tuyamqttapi.mjs";

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

class TuyaPlatform {
  constructor(log, config, api) {
    this.api = api;
    this.config = config ?? {};

    // הגדרת משתני PLUGIN ו-PLATFORM ישירות על ה-Instance
    // זה יפתור את ה-Error: 'undefined' ב-BaseAccessory
    this.PLUGIN_NAME = settings.PLUGIN_NAME;
    this.PLATFORM_NAME = settings.PLATFORM_NAME;

    // אתחול לוגר
    this.log = new LogUtil(log, Boolean(this.config?.options?.debug));

    if (!this.config?.options) {
      this.log.warn(
        "The config.json configuration is incorrect, disabling plugin.",
      );
      this.disabled = true;
      return;
    }

    this.disabled = false;
    this.accessories = new Map();
    this.deviceAccessories = new Map();

    // Homebridge 2.0 Discovery
    api.on("didFinishLaunching", async () => {
      this.log.info("Initializing TuyaPlatform...");
      await this.initTuyaSDK(this.config);
    });

    api.on("shutdown", () => {
      this.tuyaOpenMQ?.stop();
    });
  }

  /**
   * Homebridge calls this to restore accessories from cache
   */
  configureAccessory(accessory) {
    if (this.disabled) return;
    this.log.debug(`Restoring accessory from cache: ${accessory.displayName}`);

    // רישום ה-Identify מחדש עבור אביזרים משוחזרים
    accessory.on("identify", () =>
      this.log.info(`${accessory.displayName} identify requested`),
    );

    this.accessories.set(accessory.UUID, accessory);
  }

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
      this.log.error("Failed to initialize Tuya API. Check config.json.");
      this.log.error(e);
      return;
    }

    // הוספת אביזרים
    for (const device of devices) {
      this.addAccessory(device);
    }

    // אתחול MQTT
    try {
      const msgEncryptedVersion = projectType === "1" ? "2.0" : "1.0";
      const mq = new TuyaOpenMQ(api, msgEncryptedVersion, this.log);
      this.tuyaOpenMQ = mq;
      mq.start();
      mq.addMessageListener(this.onMQTTMessage.bind(this));
    } catch (e) {
      this.log.error("Failed to start Tuya MQTT.");
    }
  }

  addAccessory(device) {
    if (this.disabled) return;

    const deviceType = device.category;
    const deviceId = device.id;
    const deviceName = device.name || "unnamed";

    // 1. יצירת UUID ובדיקה האם המכשיר כבר קיים במפה הפנימית (מניעת Already Bridged)
    const uuid = this.api.hap.uuid.generate(deviceId);
    if (this.deviceAccessories.has(uuid)) {
      this.log.debug(
        `Accessory already initialized and active: ${deviceName} (${deviceId})`,
      );
      return;
    }

    // 2. בדיקת רשימת התעלמות (Ignore List)
    const ignoreDevices = this.config?.options?.ignoreDevices ?? [];
    if (Array.isArray(ignoreDevices) && ignoreDevices.includes(deviceId)) {
      this.log.debug(`Ignoring device as per config: ${deviceName}`);
      return;
    }

    // 3. שליפת אביזר מה-Cache של Homebridge (אם קיים)
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
          new DataUtil().getSubService(device.status),
        );
        break;
      case "tdq":
      case "dlq":
        deviceAccessory = new SwitchAccessory(
          this,
          homebridgeAccessory,
          device,
          new DataUtil().getSubService(device.status),
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
          new DataUtil().getSubService(device.status),
        );
        break;
      case "pir": {
        const pirConfig = (this.config?.options?.motion || []).find(
          (v) => v?.deviceId === deviceId,
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
        const deviceData = new DataUtil().getSubService(device.status);
        const valveConfig = (this.config?.options?.valve || []).find(
          (v) => v?.deviceId === deviceId && v?.isActive === true,
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
    if (this.disabled || !message?.devId) return;

    if (message.bizCode === "delete") {
      const uuid = this.api.hap.uuid.generate(message.devId);
      this.removeAccessory(this.accessories.get(uuid));
      return;
    }

    const uuid = this.api.hap.uuid.generate(message.devId);
    const deviceAccessory = this.deviceAccessories.get(uuid);
    if (deviceAccessory) {
      deviceAccessory.updateState(message);
    }
  }

  removeAccessory(accessory) {
    if (!accessory) return;
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
