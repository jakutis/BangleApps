const storage = require("Storage");

const config = storage.readJSON("rrrecord.json")
const t = config.t
const WINDOW_DURATION = 30 * 1000
const MAX_RRS_COUNT = 2 * 1024
const NOTIFICATION_TIMEOUT = 20 * 1000
const WIDTH = 176
const HEIGHT = 176

let running = false
const onExit = []
let lastNotification
let fileToSave = {
  chunksOfGoodPPISamples: [{rrs: [], blockerBits: []}]
}
const metricsData = {
  items: [],
  lastItem: undefined
}

const ensureMaxMetricsItems = () => {
  if (metricsData.items.length > WIDTH) {
    metricsData.items.shift()
  }
}
const metrics = {
  count: () => metricsData.items.length,
  skip: () => {
    if (last(metricsData.items)) {
      metricsData.items.push(null)
    }
    ensureMaxMetricsItems()
  },
  add: metric => {
    metricsData.items.push(metric)
    metricsData.lastItem = metric
    ensureMaxMetricsItems()
  },
  getLast: () => metricsData.lastItem
}
const appendJSONLine = (filename, json) => {
  const file = storage.open(filename, 'a')
  file.write(JSON.stringify(json) + '\n')
}
const logToFile = (type, text) => appendJSONLine('rrrecord-log', {date: new Date().toISOString(), type, text})
const cleanup = () => {
  onExit.forEach(f => {try{f()}catch(e){}})
  onExit.length = 0
}
const convertByteArrayToUnsignedLong = (data, offset, length) => {
  let result = 0
  for (let i = 0; i < length; ++i) {
    const x = data[i + offset]
    result |= x << i * 8
  }
  return result
}
const getPPISamples = (buffer) => {
  const data = []
  for (let i = 0; i < buffer.length; i++) {
    data.push(buffer[i])
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
    onExit.push(() => ctx.gatt.disconnect())
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
    onExit.push(() => ctx.notificationsCharacteristic.stopNotifications())
    ctx.notificationsCharacteristic.on('characteristicvaluechanged', e => {
      lastNotification = Date.now()
      try {
        consumePPISamples(getPPISamples(e.target.value.buffer))
      } catch (err) {
        cleanup()
        running = false
        logToFile('consumePPISamplesFailure', errorToString(err))
      }
    }, false);
    return ctx.notificationsCharacteristic.startNotifications().then(() => ctx);
  })
const sqr = x => x * x
const mean = xs => sum(xs) / xs.length
const sd = xs => {
  const av = mean(xs)
  return Math.sqrt(sum(xs.map(x => sqr(x - av))) / (xs.length - 1))
}
function isGood(ppiSample) {
  return ppiSample.ppErrorEstimate <= 30
}
function sum(ns) {
  return ns.reduce((sum, n) => {
    return sum + n
  }, 0)
}
function last(ns) {
  return ns[ns.length - 1]
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
    out.Mx = last(sortedRrs)
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
  for (let start = array[0]; start <= last(array); start += width) {
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
  rmssd: rrs => Math.sqrt(sum(deltas(rrs).map(sqr)) / rrs.length),
  stressIndex: stressIndex,
}
const getRRSCountToSave = () => sum(fileToSave.chunksOfGoodPPISamples.map(c => c.rrs.length))
function consumePPISamples(ppiSamples) {
  let ppiSample
  ppiSamples.forEach(p => {
    const chunk = last(fileToSave.chunksOfGoodPPISamples)
    if (isGood(p)) {
      ppiSample = p
      if (chunk.rrs.length === 0) {
        chunk.start = Date.now()
      }
      chunk.rrs.push(ppiSample.ppInMs)
      chunk.blockerBits.push(ppiSample.blockerBit)
    } else {
      ppiSample = undefined
      if (chunk.rrs.length > 0) {
        fileToSave.chunksOfGoodPPISamples.push({rrs: [], blockerBits: []})
      }
    }
  })

  const topLeft = {x: 0, y: 0}
  const bottomRight = {x: WIDTH, y: HEIGHT}
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
    metrics.skip()
  } else {
    const chunk = last(fileToSave.chunksOfGoodPPISamples)
    lines.push(formatTime(new Date()) + ' ' + formatDurationInSeconds(sum(chunk.rrs)))
    lines.push(ppiSample.hr.toString() + 'bpm')
    const window = takeLastWindow(chunk.rrs, WINDOW_DURATION)
    if (window === undefined) {
      metrics.skip()
    } else {
      metrics.add({
        date: Date.now(),
        stressIndex: features.stressIndex(window.ns),
        rmssd: features.rmssd(window.ns),
      })
    }
  }
  lines.push('metrics ' + metrics.count())
  const lastMetric = metrics.getLast()
  if (lastMetric) {
    lines.push('time ' + formatTime(new Date(lastMetric.date)))
    lines.push('stress ' + lastMetric.stressIndex.toFixed(2))
    lines.push('HRV ' + lastMetric.rmssd.toFixed(2))
    if (getRRSCountToSave() > MAX_RRS_COUNT) {
      const chunk = fileToSave.chunksOfGoodPPISamples.pop()
      appendJSONLine('rrrecord-data', fileToSave)
      fileToSave = {
        chunksOfGoodPPISamples: [chunk]
      }
    }
  } else {
    lines.push('-')
    lines.push('-')
    lines.push('-')
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
const findDevice = () => new Promise(resolve => {
  NRF.setScan();
  console.log('LOOKING_FOR_DEVICE');
  NRF.setScan(d => {
    NRF.setScan();
    resolve(d)
  }, { filters: [{id: config.deviceId}] });
});
const errorToString = error => {
  if (!error || typeof error !== 'object') {
    return String(error)
  }
  return 'Message=' + String(error.message) + '; Stack=' + String(error.stack)
}

process.on('uncaughtException', err => {
  cleanup()
  running = false
  logToFile('uncaughtException', errorToString(err))
})
const run = () => findDevice().then(connectPMDNotifications).catch(err => {
  cleanup()
  running = false
  logToFile('runFailure', errorToString(err))
})
const checkIfRunning = () => {
  if (lastNotification !== undefined && lastNotification + NOTIFICATION_TIMEOUT < Date.now()) {
    cleanup()
    running = false
    logToFile('notificationTimeout', 'last notification was more than ' + NOTIFICATION_TIMEOUT + 'ms ago')
  }
  if (!running) {
    lastNotification = undefined
    running = true
    run()
  }
  setTimeout(checkIfRunning, 1000)
}

Bangle.loadWidgets();
Bangle.setUI("clock");
g.clear();
checkIfRunning()
