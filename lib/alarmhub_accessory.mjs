import BaseAccessory from "./base_accessory.mjs";

export default class AlarmAccessory extends BaseAccessory {
  requiredCharacteristics() {
    return ["master_mode"];
  }

  /**
   * Helper method to verify if the physical device supports a specific capability
   * @param {string} code - The Tuya data point code
   * @returns {boolean}
   */
  hasFeature(code) {
    if (!this.device || !this.device.functions) return false;
    return this.device.functions.some((f) => f.code === code);
  }

  configureServices() {
    const { Service, Characteristic } = this.platform.api.hap;

    // Dictionary to hold dynamically generated services for easy status updates
    this.dynamicServices = new Map();

    // ==========================================================
    // 1. CORE SECURITY SYSTEM (Always initialized)
    // ==========================================================
    this.alarmService =
      this.homebridgeAccessory.getService(Service.SecuritySystem) ||
      this.homebridgeAccessory.addService(
        Service.SecuritySystem,
        this.deviceConfig.name,
      );

    this.alarmService
      .getCharacteristic(Characteristic.SecuritySystemTargetState)
      .onSet(this.setTargetState.bind(this));

    // ==========================================================
    // 2. DYNAMIC BOOLEAN SWITCHES
    // Maps Tuya boolean functionalities to HomeKit Switches
    // ==========================================================
    const booleanFeatures = [
      { code: "sos_state", name: "SOS Panic" },
      { code: "switch_alarm_light", name: "Alarm Light" },
      { code: "switch_alarm_sound", name: "Alarm Sound" },
      { code: "switch_alarm_sms", name: "SMS Alert" },
      { code: "switch_alarm_call", name: "Call Alert" },
      { code: "switch_low_battery", name: "Low Battery Alert" },
      { code: "switch_kb_light", name: "Keypad Light" },
      { code: "switch_kb_sound", name: "Keypad Sound" },
      { code: "switch_mode_light", name: "Mode Light" },
      { code: "switch_mode_sound", name: "Mode Sound" },
      { code: "switch_mode_dl_sound", name: "Delay Sound" },
      { code: "switch_alarm_propel", name: "Propel Alarm" },
      { code: "muffling", name: "Muffling" },
      { code: "factory_reset", name: "Factory Reset" },
    ];

    for (const feature of booleanFeatures) {
      if (this.hasFeature(feature.code)) {
        const service =
          this.homebridgeAccessory.getServiceById(
            Service.Switch,
            feature.code,
          ) ||
          this.homebridgeAccessory.addService(
            Service.Switch,
            `${this.deviceConfig.name} ${feature.name}`,
            feature.code,
          );

        service.getCharacteristic(Characteristic.On).onSet(async (value) => {
          await this.sendCommands([{ code: feature.code, value: value }]);
        });

        this.dynamicServices.set(feature.code, service);
      } else {
        // Cache cleanup: Remove service if physical device doesn't support it
        const staleService = this.homebridgeAccessory.getServiceById(
          Service.Switch,
          feature.code,
        );
        if (staleService) this.homebridgeAccessory.removeService(staleService);
      }
    }

    // ==========================================================
    // 3. NIGHT LIGHT (Lightbulb with optional Brightness)
    // ==========================================================
    if (this.hasFeature("night_light")) {
      this.nightLightService =
        this.homebridgeAccessory.getServiceById(
          Service.Lightbulb,
          "night_light",
        ) ||
        this.homebridgeAccessory.addService(
          Service.Lightbulb,
          `${this.deviceConfig.name} Night Light`,
          "night_light",
        );

      this.nightLightService
        .getCharacteristic(Characteristic.On)
        .onSet(async (value) => {
          const tuyaValue = value ? "light_on" : "light_off";
          await this.sendCommands([{ code: "night_light", value: tuyaValue }]);
        });

      // Bind brightness if supported by the hardware
      if (this.hasFeature("night_light_bright")) {
        this.nightLightService
          .getCharacteristic(Characteristic.Brightness)
          .onSet(async (value) => {
            await this.sendCommands([
              { code: "night_light_bright", value: value },
            ]);
          });
      }
    } else {
      const staleLight = this.homebridgeAccessory.getServiceById(
        Service.Lightbulb,
        "night_light",
      );
      if (staleLight) this.homebridgeAccessory.removeService(staleLight);
    }

    // ==========================================================
    // 4. ALARM VOLUME (Mapped to Fan for UI Slider support)
    // Note: HomeKit hides Speaker services often, Fan is a safer UX workaround for 0-100% sliders
    // ==========================================================
    if (this.hasFeature("alarm_volume_value")) {
      this.volumeService =
        this.homebridgeAccessory.getServiceById(
          Service.Fan,
          "alarm_volume_value",
        ) ||
        this.homebridgeAccessory.addService(
          Service.Fan,
          `${this.deviceConfig.name} Volume`,
          "alarm_volume_value",
        );

      this.volumeService
        .getCharacteristic(Characteristic.On)
        .onSet(async (value) => {
          if (this.hasFeature("switch_alarm_sound")) {
            await this.sendCommands([
              { code: "switch_alarm_sound", value: value },
            ]);
          }
        });

      this.volumeService
        .getCharacteristic(Characteristic.RotationSpeed)
        .onSet(async (value) => {
          await this.sendCommands([
            { code: "alarm_volume_value", value: value },
          ]);
        });
    } else {
      const staleVolume = this.homebridgeAccessory.getServiceById(
        Service.Fan,
        "alarm_volume_value",
      );
      if (staleVolume) this.homebridgeAccessory.removeService(staleVolume);
    }

    // Initialize initial state
    this.updateState(this.device.status);
  }

  // ==========================================================
  // STATE SETTERS
  // ==========================================================

  /**
   * Translates HomeKit Security System states to Tuya string Enums
   */
  async setTargetState(value) {
    const { Characteristic } = this.platform.api.hap;
    let tuyaMode = "disarmed";

    switch (value) {
      case Characteristic.SecuritySystemTargetState.STAY_ARM:
      case Characteristic.SecuritySystemTargetState.NIGHT_ARM:
        tuyaMode = "home";
        break;
      case Characteristic.SecuritySystemTargetState.AWAY_ARM:
        tuyaMode = "arm";
        break;
      case Characteristic.SecuritySystemTargetState.DISARM:
      default:
        tuyaMode = "disarmed";
        break;
    }

    await this.sendCommands([{ code: "master_mode", value: tuyaMode }]);
  }

  // ==========================================================
  // STATE GETTERS (Webhooks / Polling updates)
  // ==========================================================

  /**
   * Parses the status array from Tuya and updates HomeKit characteristics
   * @param {Array} status - Array of objects containing code and value
   */
  updateState(status) {
    const { Characteristic } = this.platform.api.hap;

    // 1. Update Core Security System
    if (this.alarmService) {
      const modeStatus = status.find((item) => item.code === "master_mode");
      const stateStatus = status.find((item) => item.code === "master_state");

      if (modeStatus) {
        let currentState = Characteristic.SecuritySystemCurrentState.DISARMED;
        let targetState = Characteristic.SecuritySystemTargetState.DISARM;

        if (modeStatus.value === "home") {
          currentState = Characteristic.SecuritySystemCurrentState.STAY_ARM;
          targetState = Characteristic.SecuritySystemTargetState.STAY_ARM;
        } else if (modeStatus.value === "arm") {
          currentState = Characteristic.SecuritySystemCurrentState.AWAY_ARM;
          targetState = Characteristic.SecuritySystemTargetState.AWAY_ARM;
        }

        // Override current state if the alarm is actively triggered (siren is sounding)
        if (stateStatus && stateStatus.value === "alarm") {
          currentState =
            Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED;
        }

        this.alarmService.updateCharacteristic(
          Characteristic.SecuritySystemTargetState,
          targetState,
        );
        this.alarmService.updateCharacteristic(
          Characteristic.SecuritySystemCurrentState,
          currentState,
        );
      }
    }

    // 2. Update Dynamic Boolean Switches
    for (const statusItem of status) {
      const dynamicService = this.dynamicServices.get(statusItem.code);
      if (dynamicService) {
        const isTrue = statusItem.value === true || statusItem.value === "true";
        dynamicService.updateCharacteristic(Characteristic.On, isTrue);
      }
    }

    // 3. Update Night Light
    if (this.nightLightService) {
      const lightStatus = status.find((item) => item.code === "night_light");
      const brightStatus = status.find(
        (item) => item.code === "night_light_bright",
      );

      if (lightStatus) {
        const isLightOn = lightStatus.value !== "light_off";
        this.nightLightService.updateCharacteristic(
          Characteristic.On,
          isLightOn,
        );
      }
      if (brightStatus) {
        this.nightLightService.updateCharacteristic(
          Characteristic.Brightness,
          brightStatus.value,
        );
      }
    }

    // 4. Update Alarm Volume (Fan Speed)
    if (this.volumeService) {
      const volumeStatus = status.find(
        (item) => item.code === "alarm_volume_value",
      );
      const soundSwitchStatus = status.find(
        (item) => item.code === "switch_alarm_sound",
      );

      if (volumeStatus) {
        this.volumeService.updateCharacteristic(
          Characteristic.RotationSpeed,
          volumeStatus.value,
        );
      }
      if (soundSwitchStatus) {
        const isOn =
          soundSwitchStatus.value === true ||
          soundSwitchStatus.value === "true";
        this.volumeService.updateCharacteristic(Characteristic.On, isOn);
      }
    }
  }
}
