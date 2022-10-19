const BaseAccessory = require('./base_accessory');

let Accessory;
let Service;
let Characteristic;
let UUIDGen;
let service;
let subtype;


class ValveAccessory extends BaseAccessory {

  constructor(platform, homebridgeAccessory, deviceConfig, deviceData) {
    ({ Accessory, Characteristic, Service } = platform.api.hap);
    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Accessory.Categories.SWITCH,
      Service.Valve,
      deviceData.subType
    );
    this.statusArr = deviceConfig.status;
    this.subTypeArr = deviceData.subType;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  //initiate or refresh the accessory status.
  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    if (!statusArr)
      return;

    this.isRefresh = isRefresh;

    for (const statusItem of statusArr) {
     
      //set the service instance, according to switch size (single, double etc...)
      if (/\d/.test(statusItem.code)){
      service = this.getServiceInstance(statusItem.code);
      subtype = this.getSubType(service);
      }

      //turning on or off the boiler.
      if (statusItem.code.includes('switch')) {
        const value = statusItem.value;

        this.switchValue = statusItem;

        //put the device status on the cache array.
        this.setCachedState(service.displayName, value);

        //only if it's a refresh call and not initialization.
        if (this.isRefresh) {
          //updates the device status in the homekit app.
          service
            .getCharacteristic(this.platform.api.hap.Characteristic.Active)
            .updateValue(value);
          service
            .getCharacteristic(this.platform.api.hap.Characteristic.InUse)
            .updateValue(value);
          service
            .getCharacteristic(this.platform.api.hap.Characteristic.ValveType)
            .updateValue(0);

        }
        else {
          //register all events.
          this.getAccessoryCharacteristic(service,subtype)

          //define timer maximum hours.
          service.getCharacteristic(Characteristic.SetDuration)
            .setProps({
              format: Characteristic.Formats.UINT32,
              maxValue: 86340,
              minValue: 0,
              minStep: 60,
              perms: [Characteristic.Perms.READ, Characteristic.Perms.WRITE, Characteristic.Perms.NOTIFY]
            });

          service.getCharacteristic(Characteristic.RemainingDuration)
            .setProps({
              maxValue: 86340,
              minValue: 0,
              minStep: 1
            });
        }

      }
      //if this is a timer call
      if (statusItem.code.includes('countdown')) {

        if (this.hasValidCache()) {

          //if homebridge instance was killed and boiler is runing with time - restore time left.
          if (this.getCachedState(statusItem.code) == null && statusItem.value > 1) {
            service.startTime = new Date().getTime();
            service.duration = statusItem.value;
          }
          service
            .getCharacteristic(this.platform.api.hap.Characteristic.RemainingDuration)
            .getValue();
        }
      }
      if (!statusItem) {
        continue;
      }



    }
  }


  getAccessoryCharacteristic(service,subtype) {

    //Get Events

    //showing the remaining timer.
    service.getCharacteristic(Characteristic.RemainingDuration)
      .onGet(async () => {

        if (service.startTime != null && service.duration > 0) {
          const setTime = service.duration  * 1000; 
          return (service.startTime - new Date().getTime() + setTime) / 1000;
        }
        return 0;
      });

      //showing if the switch is active
    service.getCharacteristic(Characteristic.Active)
      .onGet(async () => {
        const state = this.getCachedState(service.displayName);

        if (state != null)
          return state == true ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;

        return this.switchValue.value ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;

      })

      //showing if the switch is active
    service.getCharacteristic(Characteristic.InUse)
      .onGet(async () => {
        const state = this.getCachedState(service.displayName);
        if (state != null)
          return state == true? Characteristic.InUse.IN_USE : Characteristic.InUse.NOT_IN_USE;

        return this.switchValue.value ? Characteristic.InUse.IN_USE : Characteristic.InUse.NOT_IN_USE;
      })

      
    service.getCharacteristic(Characteristic.SetDuration)
      .onGet(async () => {
        return service.duration == null ? 0 : service.duration;    
      })

    //set events

    //set the timer.
    service.getCharacteristic(Characteristic.SetDuration)
      .onSet(async (value) => {
    
        service.lastDuration = value;

        if (this.hasValidCache() && (this.getCachedState('countdown_' + subtype.slice(-1)) > 0 || value > 0) && this.getCachedState(service.displayName) == true) {
          this.setCachedState('countdown_' + subtype.slice(-1), value);

          const param = this.getSendParam(null, service);

          await this.platform.tuyaOpenApi.sendCommand(this.deviceId, param);

          //update the duration (timer) for the specific switch. 
          service.duration = value;

          if (value == 0)
            service.startTime = null;
          else
            service.startTime = new Date().getTime();

          this.updateHomeKit(service);
        }
        else {
          this.setCachedState('countdown_' + subtype.slice(-1), value);
          service.duration = value;
        }
      });

      //activate switch
    service.getCharacteristic(Characteristic.Active)
      .onSet(async (value) => {
        let param = '';

        if (value == Characteristic.Active.INACTIVE)
          this.modifyCountdown(subtype, service);
        else
          if (service.lastDuration != null) 
            await service.getCharacteristic(Characteristic.SetDuration).setValue(service.lastDuration);
          
        param = this.getSendParam(value, service);
        await this.platform.tuyaOpenApi.sendCommand(this.deviceId, param);
        service.startTime = new Date().getTime();
        this.setCachedState(service.displayName, value);
        this.updateHomeKit(service);
      })
  }

  //get Command SendData
  getSendParam(value, service) {
    let valuesToSend = [];
    let code;

    const isOn = value? true : false;

    //for single switch the displayName will be it's custom name that we chose. for double it will always be 'switch + number'.
    if (this.subTypeArr.length == 1) {
      code = this.switchValue.code;
    } else {
      code = service.displayName;
    }

    if (value != null)
    valuesToSend.push({ 'code': code, 'value': isOn });

      //if there is an active timer and we are turning off the switch then disable the timer.
    if (!isOn && service !== null)
      service.duration = 0;

    if (this.hasValidCache()) {

      this.cachedState.forEach((val, key) => {

        if (key.includes('countdown') && (key.replace( /^\D+/g, '') === code.replace( /^\D+/g, ''))) //if there is timer update the correct switch
        valuesToSend.push({ "code": key, "value": val });
      });

    }
    return {
      "commands": valuesToSend
    };
  }

  //reset the countdown value in the cache.
  modifyCountdown(subtype, service) {
    if (this.hasValidCache()) {

      this.cachedState.forEach((val, key) => {
        subtype = this.getSubType(service);

        if (key.includes('countdown') && (key.replace( /^\D+/g, '') === subtype.replace( /^\D+/g, ''))) {
          
          this.cachedState.set(key, 0);
          service.startTime = null;
          service.duration = 0;
        }
      });
    }
  }

  //update device status
  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }

  //update homekit
  updateHomeKit(service) {
    service
      .getCharacteristic(this.platform.api.hap.Characteristic.RemainingDuration)
      .getValue();
    service
      .getCharacteristic(this.platform.api.hap.Characteristic.Active)
      .getValue();
    service
      .getCharacteristic(this.platform.api.hap.Characteristic.InUse)
      .getValue();
  }

  getSubType(service) {
    //returns if the device is one switch or more (double, triple etc...)
    return this.subTypeArr != null && this.subTypeArr.length == 1 ? this.subTypeArr[0] : service.subtype;
  }

  //get the current switch
  getServiceInstance(statusCode){
    if (this.subTypeArr.length == 1) 
      return this.service;
    else
      return this.homebridgeAccessory.getService('switch_' + statusCode.slice(-1));
  }

}

module.exports = ValveAccessory;