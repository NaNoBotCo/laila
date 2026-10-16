// sun.mjs — sunrise, sunset and the hours that hang off them.
//
// Field work is daylight work: a document run, a photograph of a shopfront, a
// border trip, a site visit. So the day's length is a scheduling fact, and it
// is worth computing rather than guessing — at 19°N the difference across the
// year is over an hour.
//
// The arithmetic is the standard solar position calculation (NOAA), which is
// accurate to about a minute at these latitudes. Everything is derived from the
// sun's altitude at a place, which is also what the prayer times below use.

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

const julianDay = (dateStr) =>
  Date.parse(`${dateStr}T00:00:00Z`) / 86400000 + 2440587.5

/** Fractional-day angle of the sun for a Julian century. */
function solar(jc) {
  const geomMeanLong = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360
  const geomMeanAnom = 357.52911 + jc * (35999.05029 - 0.0001537 * jc)
  const eccent = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc)
  const eqCentre = Math.sin(geomMeanAnom * RAD) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(2 * geomMeanAnom * RAD) * (0.019993 - 0.000101 * jc) +
    Math.sin(3 * geomMeanAnom * RAD) * 0.000289
  const trueLong = geomMeanLong + eqCentre
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * jc) * RAD)
  const meanObliq = 23 + (26 + ((21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813)))) / 60) / 60
  const obliq = meanObliq + 0.00256 * Math.cos((125.04 - 1934.136 * jc) * RAD)
  const declination = Math.asin(Math.sin(obliq * RAD) * Math.sin(appLong * RAD)) * DEG
  const varY = Math.tan((obliq / 2) * RAD) ** 2
  const eqTime = 4 * DEG * (varY * Math.sin(2 * geomMeanLong * RAD) -
    2 * eccent * Math.sin(geomMeanAnom * RAD) +
    4 * eccent * varY * Math.sin(geomMeanAnom * RAD) * Math.cos(2 * geomMeanLong * RAD) -
    0.5 * varY * varY * Math.sin(4 * geomMeanLong * RAD) -
    1.25 * eccent * eccent * Math.sin(2 * geomMeanAnom * RAD))
  return { declination, eqTime }
}

/**
 * Minutes after local midnight at which the sun reaches an altitude, before
 * and after noon. Returns null when it never does — which at this latitude
 * only happens for the deeper twilight angles, and saying so is better than
 * inventing a time.
 */
export function sunAtAltitude(dateStr, { lat, lng, tzOffsetMinutes = 420, altitude }) {
  const jc = (julianDay(dateStr) - 2451545) / 36525
  const { declination, eqTime } = solar(jc)
  const zenith = (90 - altitude) * RAD
  const cosHour = (Math.cos(zenith) - Math.sin(lat * RAD) * Math.sin(declination * RAD)) /
    (Math.cos(lat * RAD) * Math.cos(declination * RAD))
  if (cosHour > 1 || cosHour < -1) return { rise: null, set: null, noon: null }
  const hourAngle = Math.acos(cosHour) * DEG
  const noon = 720 - 4 * lng - eqTime + tzOffsetMinutes
  return {
    rise: noon - 4 * hourAngle,
    set: noon + 4 * hourAngle,
    noon,
  }
}

export const hhmm = (minutes) => {
  if (minutes == null) return null
  const m = Math.round(((minutes % 1440) + 1440) % 1440)
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** Sunrise, sunset and the length of the day, at the usual -0.833° for the
 *  sun's edge and refraction. */
export function sunTimes(dateStr, place) {
  const { rise, set, noon } = sunAtAltitude(dateStr, { ...place, altitude: -0.833 })
  return {
    sunrise: hhmm(rise),
    noon: hhmm(noon),
    sunset: hhmm(set),
    daylightMinutes: rise == null ? null : Math.round(set - rise),
  }
}

/**
 * The five prayer times for a place and day.
 *
 * Conventions differ in the angles they use for first light and nightfall, and
 * in whether the afternoon prayer falls at one or two shadow lengths, so both
 * are parameters rather than assumptions. The default angles are the Muslim
 * World League's; Asr follows the majority (shadow factor 1).
 */
export function prayerTimes(dateStr, place, {
  fajrAngle = 18, ishaAngle = 17, asrShadow = 1,
} = {}) {
  const { rise, set, noon } = sunAtAltitude(dateStr, { ...place, altitude: -0.833 })
  if (rise == null) return null
  const fajr = sunAtAltitude(dateStr, { ...place, altitude: -fajrAngle })
  const isha = sunAtAltitude(dateStr, { ...place, altitude: -ishaAngle })

  // Asr: the sun's altitude when a shadow is its object's length plus the
  // shadow at noon.
  const jc = (julianDay(dateStr) - 2451545) / 36525
  const { declination } = solar(jc)
  const noonAltitude = 90 - Math.abs(place.lat - declination)
  const asrAltitude = Math.atan(1 / (asrShadow + Math.tan((90 - noonAltitude) * RAD))) * DEG
  const asr = sunAtAltitude(dateStr, { ...place, altitude: asrAltitude })

  return {
    fajr: hhmm(fajr.rise),
    sunrise: hhmm(rise),
    dhuhr: hhmm(noon + 1),          // a minute after the sun passes the meridian
    asr: hhmm(asr.set),
    maghrib: hhmm(set),
    isha: hhmm(isha.set),
  }
}

/** Places these books already know about. Anything else is a lat/lng away. */
export const PLACES = {
  'Chiang Rai': { lat: 19.9105, lng: 99.8406, tzOffsetMinutes: 420 },
  'Chiang Mai': { lat: 18.7883, lng: 98.9853, tzOffsetMinutes: 420 },
  Bangkok: { lat: 13.7563, lng: 100.5018, tzOffsetMinutes: 420 },
}

export const placeFor = (name) => PLACES[name] || PLACES['Chiang Rai']
