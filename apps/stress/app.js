const storage = require("Storage");

const config = storage.readJSON("stress.json")
const t = config.t

const decode = (data) => {
  // ported from https://github.com/polarofficial/polar-ble-sdk/blob/master/sources/Android/android-communications/src/main/java/com/androidcommunications/polar/api/ble/model/gatt/client/BleHrClient.java
  let cumulative_rr = 0
  const hrFormat = data[0] & 0x01
  const sensorContact = ((data[0] & 0x06) >> 1) === 3
  const contactSupported = !((data[0] & 0x06) === 0)
  const energyExpended = (data[0] & 0x08) >> 3
  const rrPresent = ((data[0] & 0x10) >> 4) === 1
  const polar_32bit_rr = (data[0] & 0x20) >> 5
  const heartRate = (hrFormat === 1 ? (data[1] + (data[2] << 8)) : data[1]) & (hrFormat === 1 ? 0x0000FFFF : 0x000000FF)
  let offset = hrFormat + 2
  let energy = 0
  if (energyExpended === 1) {
    energy = (data[offset] & 0xFF) + ((data[offset + 1] & 0xFF) << 8)
    offset += 2
  }
  const rrs = []
  if (rrPresent) {
    while (offset < data.length) {
      const rrValue = ((data[offset] & 0xFF) + ((data[offset + 1] & 0xFF) << 8))
      offset += 2;
      rrs.push(rrValue);
    }
  } else if (polar_32bit_rr == 1 && (offset + 3) < data.length) {
    cumulative_rr = ((data[offset] & 0xFF) + ((data[offset + 1] & 0xFF) << 8) + ((data[offset + 2] & 0xFF) << 16) + ((data[offset + 3] & 0xFF) << 24))
  }
  const finalCumulative_rr = cumulative_rr;
  const finalEnergy = energy;
  return {
    heartRate: heartRate, sensorContact: sensorContact, energy: finalEnergy, rrs: rrs, contactSupported: contactSupported, cumulativeRR: finalCumulative_rr, rrPresent: rrPresent
  };
}

const stressIndex = rrs => {
    const out = {}
    const sortedRrs = rrs.slice()
    sortedRrs.sort((a, b) => a - b)
    out.binsAmo = binsSorted(sortedRrs, 50)
    out.AMo = max(out.binsAmo.map(a => a.count)) / rrs.length
    out.Mn = sortedRrs[0]
    out.Mx = sortedRrs[sortedRrs.length - 1]
    out.MxDMn = out.Mx - out.Mn
    out.Mo = medianSorted(rrs)
    out.SI = (out.AMo * 100) / (2 * (out.Mo / 1000) * (out.MxDMn / 1000))
    return Math.sqrt(out.SI)
}
const max = xs => {
  var max = xs[0]
  for(let i = 1; i < xs.length; i++) {
    if (max < xs[i]) {
      max = xs[i]
    }
  }
  return max;
}
const medianSorted = (array) => {
  if (array.length % 2 === 0) {
    return (array[array.length / 2 - 1] + array[array.length / 2]) / 2
  } else {
    return array[Math.floor(array.length / 2)]
  }
}
const binsSorted = (array, width) => {
  const bins = []
  for (let start = array[0]; start <= array[array.length - 1]; start += width) {
    bins.push({
      start: start,
      end: start + width,
      count: 0
    })
  }
  array.forEach(value => {
    const bin = bins.find(bin => bin.start <= value && value < bin.end)
    bin.count++
  })
  return bins
}

let rrs = []
let duration = 0
let beeping = false

const handleDeviceData = (data) => {
  rrs.push.apply(rrs, data.rrs)
  duration += data.rrs.reduce((sum, rr) => sum + rr, 0)
  while (duration >= config.maxInterval) {
    duration -= rrs.shift()
  }
  const stress = stressIndex(rrs)
  const stressString = String(Math.round(stress * 10) / 10)
  const interval = t.INTERVAL + ': ' + String(Math.round(duration / 1000)) + 's'
  const bpm = t.BPM + ': ' + String(data.heartRate) + 'bpm'

  g.clear();
  g.setFontAlign(0, 0);
  g.setFont("Vector", 20);
  g.drawString(interval, g.getWidth()/2, 20);
  g.drawString(bpm, g.getWidth()/2, 40);
  if (!isFinite(stress)) {
    return
  }
  g.drawString(t.STRESS, g.getWidth()/2, 60+10);
  g.setFont("Vector", 80);
  g.drawString(stressString, g.getWidth()/2, g.getHeight()/2+10);
  g.flip();

  if (!beeping && duration >= config.beepSince && stress > config.beepThreshold) {
    beeping = true
    Promise.all([
      Bangle.beep(600),
      Bangle.buzz(600)
    ]).then(() => {beeping = false})
  }
};

const inform = message => {
  g.clear();
  g.setFontAlign(0, 0);
  g.setFont("Vector", 20);
  g.drawString(message, g.getWidth()/2, g.getHeight()/2);
  g.flip();
}

const onExit = []
const cleanup = () => {
  onExit.forEach(f => {try{f()}catch(e){}})
  onExit = []
}

E.on('kill',()=> {
  cleanup();
});
setWatch(() => {
  cleanup()
  Bangle.showLauncher()
}, BTN2);

const connect = (device) => Promise.resolve(device)
  .then(function(device) {
    inform(t.CONNECTING_TO_DEVICE)
    return device.gatt.connect({
      minInterval: 500,
      maxInterval: 1000
    });
  })
  .then(function(gatt) {
    inform(t.RETRIEVING_SERVICE);
    onExit.push(() => gatt.disconnect())
    return gatt.getPrimaryService('0000180d-0000-1000-8000-00805f9b34fb');
  })
  .then(function(service) {
    inform(t.RETRIEVING_CHARACTERISTIC);
    return service.getCharacteristic('00002a37-0000-1000-8000-00805f9b34fb');
  })
  .then(function(characteristic) {
    inform(t.REQUESTING_FOR_DATA);
    characteristic.on('characteristicvaluechanged', e => handleDeviceData(decode(e.target.value.buffer)), false);
    onExit.push(() => characteristic.stopNotifications())
    return characteristic.startNotifications();
  })
  .catch(main);

const scan = () => new Promise(resolve => {
  NRF.setScan();
  inform(t.LOOKING_FOR_DEVICE);
  NRF.setScan(device => {
    NRF.setScan();
    resolve(device);
  }, { filters: [{id: config.deviceId}], timeout: 20000});
});

const main = () => scan().then(connect);

main()
