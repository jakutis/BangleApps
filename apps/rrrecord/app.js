const storage = require("Storage");

const config = storage.readJSON("rrrecord.json")
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
      Bangle.beep(),
      Bangle.buzz()
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

// START
const getPPISamples = (buffer) => {
  const data = []
  for (let i = 0; i < buffer.length; i++) {
    data.push(buffer[i])
  }
  const convertByteArrayToUnsignedLong = (data, offset, length) => {
    let result = 0
    for (let i = 0; i < length; ++i) {
      const x = data[i + offset]
      result |= x << i * 8
    }
    return result
  }
  const TYPE_PPI = 3;

  const object = {}
  object.type = data[0]
  object.timeStamp = convertByteArrayToUnsignedLong(data, 1, 8)
  object.frameType = data[9]
  object.content = data.slice(10, data.length)
  if (object.type === TYPE_PPI && object.frameType === 0) {
    object.ppiSamples = []
    let offset = 0
    while (offset < object.content.length) {
      const size = 6
      const bytes = object.content.slice(offset, offset + size)
      const sample = {
        timestamp: object.timeStamp,
        hr: bytes[0] & 0xFF,
        ppInMs: convertByteArrayToUnsignedLong(bytes, 1, 2),
        ppErrorEstimate: convertByteArrayToUnsignedLong(bytes, 3, 2),
        blockerBit: bytes[5] & 0x01,
        skinContactStatus: (bytes[5] & 0x02) >> 1,
        skinContactSupported: (bytes[5] & 0x04) >> 2,
      }
      /*
Polar ppi data
- timestamp N/A always 0
- hr in BPM
- ppInMs Pulse to Pulse interval in milliseconds. The value indicates the quality of PP-intervals. When error estimate is below 10ms the PP-intervals are probably very accurate. Error estimate values over 30ms may be caused by movement artefact or too loose sensor-skin contact.
- ppErrorEstimate estimate of the expected absolute error in PP-interval in milliseconds
- blockerBit = 1 if PP measurement was invalid due to acceleration or other reason
- skinContactStatus = 0 if the device detects poor or no contact with the skin
- skinContactSupported = 1 if the Sensor Contact feature is supported.
      */
      object.ppiSamples.push(sample)
      offset += size
    }
    return object.ppiSamples
  }
  throw new Error('data type is not PPI')
}
const connectPMDNotifications = (device) => Promise.resolve(device).then(function(device) {
    console.log('CONNECTING_TO_DEVICE')
    return device.gatt.connect({
      minInterval: 500,
      maxInterval: 1000
    }).then(gatt => ({gatt: gatt, device: device}));
  }).then(function(ctx) {
    console.log('RETRIEVING_SERVICE');
    return ctx.gatt.getPrimaryService('fb005c80-02e7-f387-1cad-8acd2d8df0c8').then(service => Object.assign({}, ctx, {service: service}));
  }).then(function(ctx) {
    console.log('RETRIEVING_CHARACTERISTIC for a request');
    return ctx.service.getCharacteristic("fb005c81-02e7-f387-1cad-8acd2d8df0c8").then(requestCharacteristic => Object.assign({}, ctx, {requestCharacteristic: requestCharacteristic}))
  }).then(function(ctx) {
    let packet = new Uint8Array(2)
    packet[0]=2
    packet[1]=3
    return ctx.requestCharacteristic.writeValue(packet).then(() => ctx)
  }).then(function(ctx) {
    console.log('RETRIEVING_CHARACTERISTIC for notifications');

    // TODO for requesting ppi streaming, get all characteristics and choose, or try to use this characteristic immediately
    //    val PMD_CP: UUID = UUID.fromString("FB005C81-02E7-F387-1CAD-8ACD2D8DF0C8")
    return ctx.service.getCharacteristic('fb005c82-02e7-f387-1cad-8acd2d8df0c8').then(notificationsCharacteristic => Object.assign({}, ctx, {notificationsCharacteristic: notificationsCharacteristic}))
  }).then(function(ctx) {
    console.log('REQUESTING_FOR_DATA');
    ctx.notificationsCharacteristic.on('characteristicvaluechanged', e => consumePPISamples(getPPISamples(e.target.value.buffer)), false);
    return ctx.notificationsCharacteristic.startNotifications().then(() => ctx);
  })
const sqr = x => x * x
const mean = xs => xs.reduce((sum, x) => sum + x, 0) / xs.length
const sd = xs => {
  const av = mean(xs)
  const sum = xs.reduce((sum, x) => sum + sqr(x - av), 0)
  return Math.sqrt(sum / (xs.length - 1))
}
function isGood(ppiSample) {
  return ppiSample.blockerBit !== 1 && ppiSample.ppErrorEstimate <= 30
}
function sum(ns) {
  return ns.reduce((sum, n) => {
    return sum + n
  }, 0)
}
function formatDurationInSeconds(duration) {
  return (duration / 1000).toFixed(1) + 's'
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
const min = xs => {
  var min = xs[0]
  for(let i = 1; i < xs.length; i++) {
    if (min > xs[i]) {
      min = xs[i]
    }
  }
  return min;
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
const deltas = xs => {
  const ds = []
  for (let i = 1; i < xs.length; i++) {
    ds.push(xs[i] - xs[i - 1])
  }
  return ds
}
const nn = (xs, ms) => deltas(xs).filter(d => d > ms).length
function takeLastWindow(ns, window) {
  const newNs = []
  let first
  let last = ns.length - 1
  for (let sum = 0, i = last; i >= 0 && sum <= window; i--) {
    first = i
    const n = ns[i]
    newNs.unshift(n)
    sum += n
  }
  return sum < window ? undefined : {ns: newNs, first: first, last: last};
}
function formatTime(date) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(n => n.toString().padStart(2, '0'))
    .join(':')
}
const features = {
  nn20: rrs => nn(rrs, 20),
  pnn20: rrs => nn(rrs, 20) / rrs.length,
  nn50: rrs => nn(rrs, 50),
  pnn50: rrs => nn(rrs, 50) / rrs.length,
  sdnn: rrs => sd(rrs),
  avnn: rrs => mean(rrs) || null,
  sdsd: rrs => sd(deltas(rrs)),
  ebc: rrs => max(rrs) - min(rrs),
  lnrmssd: rrs => Math.log(features.rmssd(rrs)),
  si: rrs => {
    const out = {}
    const sortedRrs = rrs.slice()
    sortedRrs.sort((a, b) => a - b)
    out.binsAmo = binsSorted(sortedRrs, 50)
    out.AMo = max(out.binsAmo.map(a => a.count)) / rrs.length
    out.Mn = min(rrs)
    out.Mx = max(rrs)
    out.MxDMn = out.Mx - out.Mn
    out.Mo = medianSorted(rrs)
    out.SI = (out.AMo * 100) / (2 * (out.Mo / 1000) * (out.MxDMn / 1000))
    return Math.sqrt(out.SI)
  },
  rmssd: rrs => {
    const sum = deltas(rrs).reduce((sum, d) => sum + sqr(d), 0)
    return Math.sqrt(sum / rrs.length)
  },
  stressIndex: stressIndex,
}
let lastSave = 0
let fileName = 'windows-' + Date.now()
let fileToSave = {
  chunksOfGoodPPISamples: [{rrs: []}]
}
let lastWindow
let badSamplesSinceLastChunk = []
let previousBadSamplesSinceLastChunk = []
function getLatestChunkOfGoodPPISamples() {
  return fileToSave.chunksOfGoodPPISamples[fileToSave.chunksOfGoodPPISamples.length - 1]
}
function consumePPISamples(ppiSamples) {
  //console.log('ppiSamples', ppiSamples)
  let ppiSample
  ppiSamples.forEach(p => {
    const chunk = getLatestChunkOfGoodPPISamples()
    if (isGood(p)) {
      ppiSample = p
      if (chunk.rrs.length === 0) {
        chunk.start = Date.now()
      }
      chunk.rrs.push(ppiSample.ppInMs)
      if (badSamplesSinceLastChunk.length > 0) {
        previousBadSamplesSinceLastChunk = badSamplesSinceLastChunk
      }
      badSamplesSinceLastChunk = []
    } else {
      ppiSample = undefined
      if (chunk.rrs.length > 0) {
        fileToSave.chunksOfGoodPPISamples.push({rrs: []})
      }
      badSamplesSinceLastChunk.push([p.blockerBit, p.ppErrorEstimate])
    }
  })
  if (badSamplesSinceLastChunk === 1) {
    // TODO modify that one bad one by interpolating?
  }

  const topLeft = {x: 0, y: 0}
  const bottomRight = {x: 176, y: 176}
  const dimensions = {
    x: (bottomRight.x - topLeft.x),
    y: (bottomRight.y - topLeft.y),
  }
  const fontSize = dimensions.x * 0.11
  const margin = {top: 25, left: 5}
  const backgroundColor = '#FFFFFF'
  const fontColor = '#000000'

  const lines = []
  if (ppiSample === undefined) {
    lines.push(formatTime(new Date()))
    lines.push(badSamplesSinceLastChunk.length.toString() + 'i' + badSamplesSinceLastChunk.slice().reverse().join('i'))
  } else {
    const chunk = getLatestChunkOfGoodPPISamples()
    lines.push(formatTime(new Date()) + ' ' + formatDurationInSeconds(sum(chunk.rrs)))
    lines.push(ppiSample.hr.toString() + 'bpm')
    const window = takeLastWindow(chunk.rrs, 30000)
    if (window !== undefined) {
      lastWindow = {
        date: Date.now(),
        stressIndex: features.stressIndex(window.ns),
        rmssd: features.rmssd(window.ns),
      }
    }
  }
  lines.push(previousBadSamplesSinceLastChunk.length.toString() + 'i' + previousBadSamplesSinceLastChunk.slice().reverse().join('i'))
  if (lastWindow === undefined) {
    lines.push('-')
    lines.push('-')
    lines.push('-')
  } else {
    lines.push('time ' + formatTime(new Date(lastWindow.date)))
    lines.push('stress ' + lastWindow.stressIndex.toFixed(2))
    lines.push('HRV ' + lastWindow.rmssd.toFixed(2))
    if (Date.now() - lastSave >= 4 * 60 * 60 * 1000) {
      lastSave = Date.now()
      const chunk = fileToSave.chunksOfGoodPPISamples.pop()
      storage.writeJSON(fileName, fileToSave)
      fileToSave = {
        chunksOfGoodPPISamples: [chunk]
      }
      fileName = 'windows-' + Date.now()
    }
  }
  const mem = process.memory()
  const freeBytes = mem.blocksize * mem.free
  lines.push(freeBytes + 'b free')

  g.reset();
  g.setColor(backgroundColor)
  g.fillRect(topLeft.x, topLeft.y, bottomRight.x, bottomRight.y);
  g.setFont("Vector", fontSize);
  g.setColor(fontColor)
  lines.forEach((line, i) => {
    g.drawString(line, margin.left, margin.top + i * fontSize);
  })
  Bangle.drawWidgets();
}
//Bangle.setUI("clock");
const scan = () => new Promise(resolve => {
  NRF.setScan();
  console.log('LOOKING_FOR_DEVICE');
  NRF.setScan(d => {
    NRF.setScan();
    resolve(d)
  }, { filters: [{id: config.deviceId}], timeout: 20000});
});
// FINISH

//PmdMeasurementType_PPI = 3
//PmdControlPointCommand_REQUEST_MEASUREMENT_START = 2

/*
# after getPPICharacteristic
let packet = new Uint8Array(2)
packet[0]=2
packet[1]=3
characteristic.writeValue(packet).then(a => console.log('resp', a))

# pushing from bangle to browser
http://forum.espruino.com/conversations/336567/

# bluetootctl
connect A0:9E:1A:8C:CC:5C
menu gatt
select-attribute fb005c81-02e7-f387-1cad-8acd2d8df0c8
notify on
attribute-info
write 0x02 0x03
// reply: f0 02 3f 02
read
// reply: 0f 6e 02 00 00 00 00 00 00 00 00 00 00 00 00 00 00
*/

const main = () => scan().then(connectPMDNotifications);

/*
E.on('kill',()=> {
  cleanup();
});
setWatch(() => {
  cleanup()
  Bangle.showLauncher()
}, BTN2);
*/

Bangle.loadWidgets();
Bangle.setUI("clock");
g.clear();
main()
