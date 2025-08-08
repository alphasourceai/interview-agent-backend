// test-utc.js
const { utcToZonedTime } = require('date-fns-tz');

const now = new Date();
const chicagoTime = utcToZonedTime(now, 'America/Chicago');

console.log('Chicago Time:', chicagoTime);
