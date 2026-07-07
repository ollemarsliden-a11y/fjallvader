import { useState, useEffect, useRef, useMemo, lazy, Suspense } from "react";
const MapView = lazy(() => import("./MapView.jsx"));

/*
  VÄDERLEK — flerkälls-väderapp
  Nytt i v2:
   • Bakgrund som anpassas efter aktuellt väder + tid på dygnet (gradient, fjällsiluett,
     regn/snö-partiklar, norrskensglöd vid hög chans)
   • 16-dagarsprognos (modellerna räcker olika långt — bandet smalnar ärligt av)
   • Ensemble-sannolikhet (GFS, 31 körningar): regnchans i % och troligt temperaturspann
   • Normaljämförelse: dagens prognos mot snittet för samma datum senaste 10 åren
  Källor (gratis, utan nyckel): Open-Meteo (forecast + ensemble + archive),
  SMHI öppna data, NOAA SWPC.
  Kör i Vite: importera i main.jsx och rendera <VaderApp />
*/

// ---------- konstanter ----------

const MODELS = [
  { key: "ecmwf_ifs025", name: "ECMWF", horizon: 15 },
  { key: "gfs_seamless", name: "GFS", horizon: 16 },
  { key: "icon_seamless", name: "ICON", horizon: 7 },
  { key: "metno_seamless", name: "Yr", horizon: 3 },
];
const SMHI_KEY = "smhi";
const FORECAST_DAYS = 16;
const NEAR_DAYS = 7; // därefter "Längre fram"

const DEFAULT_PLACE = { name: "Saxnäs", admin: "Västerbotten", lat: 64.966, lon: 15.383 };

const WMO = {
  0: ["Klart", "☀️"], 1: ["Mest klart", "🌤️"], 2: ["Halvklart", "⛅"], 3: ["Mulet", "☁️"],
  45: ["Dimma", "🌫️"], 48: ["Frostdimma", "🌫️"],
  51: ["Duggregn", "🌦️"], 53: ["Duggregn", "🌦️"], 55: ["Tätt duggregn", "🌧️"],
  56: ["Underkylt duggregn", "🌧️"], 57: ["Underkylt duggregn", "🌧️"],
  61: ["Lätt regn", "🌦️"], 63: ["Regn", "🌧️"], 65: ["Kraftigt regn", "🌧️"],
  66: ["Underkylt regn", "🌧️"], 67: ["Underkylt regn", "🌧️"],
  71: ["Lätt snöfall", "🌨️"], 73: ["Snöfall", "🌨️"], 75: ["Ymnigt snöfall", "❄️"],
  77: ["Snökorn", "❄️"], 80: ["Regnskurar", "🌦️"], 81: ["Regnskurar", "🌧️"],
  82: ["Kraftiga skurar", "⛈️"], 85: ["Snöbyar", "🌨️"], 86: ["Snöbyar", "❄️"],
  95: ["Åska", "⛈️"], 96: ["Åska med hagel", "⛈️"], 99: ["Åska med hagel", "⛈️"],
};
const wmoLabel = (c) => (WMO[c] || ["Okänt", "🌡️"])[0];
const wmoIcon = (c) => (WMO[c] || ["", "🌡️"])[1];

const SMHI_SYMBOL_TO_WMO = {
  1: 0, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3, 7: 45,
  8: 80, 9: 81, 10: 82, 11: 95, 12: 56, 13: 57, 14: 85, 15: 85, 16: 86,
  17: 96, 18: 61, 19: 63, 20: 65, 21: 95, 22: 66, 23: 67, 24: 71, 25: 73, 26: 75, 27: 75,
};

const DAY_NAMES = ["sön", "mån", "tis", "ons", "tor", "fre", "lör"];
const MONTH_NAMES = ["Januari", "Februari", "Mars", "April", "Maj", "Juni",
  "Juli", "Augusti", "September", "Oktober", "November", "December"];

const UV_LEVELS = [
  { max: 2.5, label: "Låg", color: "#4C9F70", tip: "Ingen skyddsåtgärd behövs." },
  { max: 5.5, label: "Måttlig", color: "#D98E23", tip: "Solglasögon och kräm om du är ute länge." },
  { max: 7.5, label: "Hög", color: "#E2703A", tip: "Sök skugga mitt på dagen, använd solkräm." },
  { max: 10.5, label: "Mycket hög", color: "#C74B50", tip: "Undvik sol 11–15, täck huden." },
  { max: 99, label: "Extrem", color: "#8E3B60", tip: "Håll dig inomhus mitt på dagen." },
];
const uvLevel = (v) => UV_LEVELS.find((l) => v <= l.max) || UV_LEVELS[0];

// ---------- månfas (ren astronomi, inget API) ----------

const SYNODIC = 29.53058867; // dygn mellan två nymånar
function moonPhase(date = new Date()) {
  const ref = Date.UTC(2000, 0, 6, 18, 14); // känd nymåne 6 jan 2000
  const days = (date.getTime() - ref) / 86400000;
  const age = ((days % SYNODIC) + SYNODIC) % SYNODIC; // 0–29.5
  const illum = Math.round(((1 - Math.cos((age / SYNODIC) * 2 * Math.PI)) / 2) * 100);
  const phases = [
    { max: 1.0, name: "Nymåne", emoji: "🌑" },
    { max: 6.4, name: "Växande skära", emoji: "🌒" },
    { max: 8.4, name: "Första kvarteret", emoji: "🌓" },
    { max: 13.8, name: "Växande måne", emoji: "🌔" },
    { max: 15.8, name: "Fullmåne", emoji: "🌕" },
    { max: 21.1, name: "Avtagande måne", emoji: "🌖" },
    { max: 23.1, name: "Sista kvarteret", emoji: "🌗" },
    { max: 28.5, name: "Avtagande skära", emoji: "🌘" },
    { max: 99, name: "Nymåne", emoji: "🌑" },
  ];
  const phase = phases.find((p) => age <= p.max);
  const daysToFull = Math.round((((SYNODIC / 2 - age) % SYNODIC) + SYNODIC) % SYNODIC);
  const daysToNew = Math.round(SYNODIC - age) % Math.round(SYNODIC);
  return { age, illum, name: phase.name, emoji: phase.emoji, daysToFull, daysToNew };
}

// ---------- väderteman ----------

function themeKey(code, isDay) {
  if (code == null) return isDay ? "clearDay" : "clearNight";
  if ([95, 96, 99].includes(code)) return "thunder";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return isDay ? "snowDay" : "snowNight";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return isDay ? "rainDay" : "rainNight";
  if ([45, 48].includes(code)) return "fog";
  if (code === 3) return isDay ? "overcast" : "cloudNight";
  if ([1, 2].includes(code)) return isDay ? "cloudDay" : "cloudNight";
  return isDay ? "clearDay" : "clearNight";
}

const THEMES = {
  clearDay: {
    bg: "linear-gradient(180deg, #7FBFF0 0%, #B7DEF8 42%, #F4E4BD 100%)",
    pageInk: "#132A42", pageMuted: "#3C5D7A",
    fjall: ["#6E9DC4", "#4E7FA8"], particles: null, dark: false,
  },
  cloudDay: {
    bg: "linear-gradient(180deg, #9DBAD3 0%, #C6D8E5 55%, #E4E9ED 100%)",
    pageInk: "#1B2C3D", pageMuted: "#48607A",
    fjall: ["#7C99B4", "#5D7F9E"], particles: null, dark: false,
  },
  overcast: {
    bg: "linear-gradient(180deg, #97A6B4 0%, #B9C3CC 60%, #CFD6DB 100%)",
    pageInk: "#1E2A35", pageMuted: "#4B5B6A",
    fjall: ["#7D8E9E", "#63768A"], particles: null, dark: false,
  },
  rainDay: {
    bg: "linear-gradient(180deg, #5E7590 0%, #7F94AB 55%, #9FAFC0 100%)",
    pageInk: "#F0F4F8", pageMuted: "#D3DDE7",
    fjall: ["#4C6178", "#3B4F66"], particles: "rain", dark: true,
  },
  snowDay: {
    bg: "linear-gradient(180deg, #A9BBCB 0%, #CBD8E2 55%, #EAF0F4 100%)",
    pageInk: "#1B2C3D", pageMuted: "#4B637C",
    fjall: ["#8FA5B8", "#7590A6"], particles: "snow", dark: false,
  },
  thunder: {
    bg: "linear-gradient(180deg, #2B3A4E 0%, #46586E 60%, #5C6E82 100%)",
    pageInk: "#EEF3F8", pageMuted: "#C3CFDB",
    fjall: ["#22303F", "#182430"], particles: "rain", dark: true,
  },
  fog: {
    bg: "linear-gradient(180deg, #AEB9C2 0%, #C8CFD5 50%, #D9DDE1 100%)",
    pageInk: "#25313B", pageMuted: "#5A6873",
    fjall: ["#9AA7B1", "#8795A1"], particles: null, dark: false,
  },
  clearNight: {
    bg: "linear-gradient(180deg, #0B1730 0%, #14243F 55%, #1E3350 100%)",
    pageInk: "#E6EEF7", pageMuted: "#9FB2C8",
    fjall: ["#0E1B33", "#091326"], particles: null, dark: true,
  },
  cloudNight: {
    bg: "linear-gradient(180deg, #16202F 0%, #22303F 60%, #2C3A49 100%)",
    pageInk: "#E3EAF1", pageMuted: "#A3B2C1",
    fjall: ["#131E2B", "#0C1420"], particles: null, dark: true,
  },
  rainNight: {
    bg: "linear-gradient(180deg, #131C28 0%, #1F2C39 60%, #2A3846 100%)",
    pageInk: "#E3EAF1", pageMuted: "#A3B2C1",
    fjall: ["#101823", "#0A111A"], particles: "rain", dark: true,
  },
  snowNight: {
    bg: "linear-gradient(180deg, #1A2433 0%, #2A3848 60%, #3A4A5C 100%)",
    pageInk: "#EAF0F6", pageMuted: "#AEBCCB",
    fjall: ["#16202D", "#0F1722"], particles: "snow", dark: true,
  },
};

// ---------- hjälpfunktioner ----------

const fmt1 = (v) => (v == null || Number.isNaN(v) ? "–" : Math.round(v * 10) / 10);
const fmt0 = (v) => (v == null || Number.isNaN(v) ? "–" : Math.round(v));
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

function dateKey(d) { return d.slice(0, 10); }
function mmdd(iso) { return iso.slice(5, 10); }
function dayName(iso) {
  const d = new Date(iso + "T12:00:00");
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return "Idag";
  if (diff === 1) return "Imorgon";
  return DAY_NAMES[d.getDay()];
}
function dayDate(iso) {
  const d = new Date(iso + "T12:00:00");
  return d.getDate() + "/" + (d.getMonth() + 1);
}

function fineScore(d) {
  if (!d || d.tmax == null) return -999;
  const sunH = (d.sun ?? 0) / 3600;
  const precip = d.precip ?? 0;
  const wind = d.wind ?? 0;
  const t = d.tmax;
  const tempScore = t >= 18 && t <= 26 ? 10 : 10 - Math.min(10, Math.abs(t - 22) * 0.6);
  return sunH * 1.2 + tempScore - precip * 1.5 - wind * 0.25;
}

// ---------- humörläge: kommentarsrad efter väder × läge ----------

// grupperar WMO-koder till väderkategori
function weatherKind(code, tmax) {
  if (code == null) return "default";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  if ([95, 96, 99].includes(code)) return "thunder";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "rain";
  if ([45, 48].includes(code)) return "fog";
  if (code === 3) return "cloud";
  if ([1, 2].includes(code)) return "partly";
  if (code === 0) return tmax != null && tmax < 0 ? "cold" : "clear";
  return "default";
}

const MOOD_LINES = {
  optimist: {
    clear: ["Strålande! Släpp allt och gå ut medan det varar.", "Blå himmel så långt ögat når — passa på!", "En sån dag skriver man dagbok om. Ut med dig!"],
    partly: ["Sol mellan molnen — bästa sortens dag.", "Lite moln bara gör solen extra fin när den kommer fram.", "Halvklart och härligt. Ta en promenad."],
    cloud: ["Mjukt ljus och sval luft — sköna vandringsförhållanden.", "Molnigt men mysigt. Perfekt för en långlunch ute.", "Gråväder är bara sol som spelar svårfångad."],
    rain: ["Perfekt väder för att mysa inne — och tänk vad grönt allt blir!", "Regn betyder att morgondagen luktar underbart.", "Ta paraplyet och stampa i pölarna som ett barn."],
    thunder: ["Åska är naturens eget fyrverkeri — njut från fönstret!", "Kraftfullt väder! Koka te och se skådespelet.", "Snart är luften nytvättad och skön."],
    snow: ["Snö! Allt blir vackert och tyst nu.", "Pudersnö på väg — fram med skidorna!", "Vinterland. Det finns inget mysigare."],
    fog: ["Dimma ger fjället en sagolik stämning — njut av mystiken.", "Allt blir mjukt och hemlighetsfullt idag.", "Perfekt ljus för stämningsfulla foton."],
    cold: ["Krispigt och klart — dra på dig något varmt så blir det härligt!", "Kylan gör luften glasklar. Andas in!", "Kallt men vackert — kaffet smakar dubbelt så gott ute."],
    default: ["Vad vädret än gör så blir det en bra dag!", "Det finns inget dåligt väder, bara härliga överraskningar."],
  },
  normal: {
    clear: ["Klart väder. Fint så.", "Sol och blå himmel idag."],
    partly: ["Växlande molnighet.", "Halvklart, mest uppehåll."],
    cloud: ["Mulet och grått.", "Molnigt större delen av dagen."],
    rain: ["Regn. Ta med paraply.", "Blött ute, klä dig därefter."],
    thunder: ["Risk för åska. Håll koll på himlen.", "Åskskurar väntas."],
    snow: ["Snöfall. Kör försiktigt.", "Snö på väg, räkna med halka."],
    fog: ["Dimma, nedsatt sikt.", "Diktigt väder — kör försiktigt."],
    cold: ["Kallt ute. Klä dig varmt.", "Minusgrader, ta på dig ordentligt."],
    default: ["Väder som väder idag.", "Blandat väder framöver."],
  },
  pessimist: {
    clear: ["Sol nu. Njut lagom — det håller inte.", "Blå himmel. Passa på, imorgon är allt förstört igen.", "Fint väder. Misstänkt fint. Något är på gång."],
    partly: ["Lite sol. Molnen tar snart över, som vanligt.", "Halvklart. Fokusera på molnhalvan.", "Sol ibland. Inte länge nog för att spela roll."],
    cloud: ["Grått. Som insidan av en tvättmaskin.", "Mulet. Precis som själen en måndag.", "Inte en solstråle. Räkna inte med en heller."],
    rain: ["Regn igen. Precis som igår. Precis som imorgon.", "Blött. Dina strumpor vet redan.", "Regn. Naturen gråter, och vem kan klandra den."],
    thunder: ["Åska. Dra ur allt och hoppas på det bästa.", "Blixt och dunder. Idealiskt.", "Storm på väg. Såklart."],
    snow: ["Snö. Nu börjar det. Fem månader kvar.", "Vinter. Skotta nu, skotta imorgon, skotta för evigt.", "Snö. Vackert i tre minuter, sedan bara slask."],
    fog: ["Dimma. Du ser inget. Det finns inget att se ändå.", "Grått töcken. Passande.", "Sikt noll. Som framtidsutsikterna."],
    cold: ["Kallt. Så klart att det är kallt.", "Minusgrader. Sommaren var en lögn.", "Iskallt. Din näsa ger upp först."],
    default: ["Väder. Det blir nog inte bra.", "Något faller från himlen. Det gör det alltid."],
  },
};

// deterministiskt val per dag (samma dag = samma rad, ny dag = ny)
function moodLine(mood, code, tmax, dateStr) {
  const kind = weatherKind(code, tmax);
  const bank = MOOD_LINES[mood] || MOOD_LINES.normal;
  const arr = bank[kind] || bank.default;
  const seed = (dateStr || "").split("-").join("");
  const idx = arr.length ? Number(seed) % arr.length : 0;
  return arr[idx] || "";
}

const SOURCES = [
  { key: "consensus", label: "Konsensus" },
  { key: "smhi", label: "SMHI" },
  { key: "metno_seamless", label: "Yr" },
  { key: "ecmwf_ifs025", label: "ECMWF" },
  { key: "gfs_seamless", label: "GFS" },
  { key: "icon_seamless", label: "ICON" },
];

function agreementForDay(perModel, ens) {
  const temps = Object.values(perModel).map((m) => m?.tmax).filter((v) => v != null);
  if (temps.length >= 2) {
    const precs = Object.values(perModel).map((m) => m?.precip).filter((v) => v != null);
    const tSpread = Math.max(...temps) - Math.min(...temps);
    const pSpread = precs.length ? Math.max(...precs) - Math.min(...precs) : 0;
    const score = tSpread + pSpread * 0.8;
    if (score < 2.5) return { label: "Hög samstämmighet", short: "Säker", color: "#3E8E63" };
    if (score < 6) return { label: "Viss oenighet", short: "Osäker", color: "#D98E23" };
    return { label: "Modellerna spretar", short: "Mycket osäker", color: "#C74B50" };
  }
  // långt fram: bedöm på ensemble-spridningen istället
  if (ens?.tmaxP10 != null && ens?.tmaxP90 != null) {
    const spread = ens.tmaxP90 - ens.tmaxP10;
    if (spread < 4) return { label: "Ensemblen samlad", short: "Säker", color: "#3E8E63" };
    if (spread < 8) return { label: "Ensemblen spretar något", short: "Osäker", color: "#D98E23" };
    return { label: "Stor spridning i ensemblen", short: "Mycket osäker", color: "#C74B50" };
  }
  return null;
}

// ---------- datahämtning ----------

async function geocode(q) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=sv&format=json`;
  const r = await fetch(url);
  const j = await r.json();
  return (j.results || []).map((x) => ({
    name: x.name,
    admin: [x.admin1, x.country].filter(Boolean).join(", "),
    lat: x.latitude, lon: x.longitude,
  }));
}

// Omvänd geokodning: hitta närmaste ortnamn för en koordinat (BigDataCloud, gratis, keyless).
async function reverseGeocode(lat, lon) {
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=sv`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("no");
    const j = await r.json();
    const name = j.city || j.locality || j.principalSubdivision || "Min position";
    const admin = [j.principalSubdivision, j.countryName].filter(Boolean).join(", ");
    return { name, admin };
  } catch {
    return { name: "Min position", admin: "" };
  }
}

async function fetchMultiModel(lat, lon) {
  const daily = "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,weather_code,sunshine_duration";
  const models = MODELS.map((m) => m.key).join(",");
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=${daily}&models=${models}&timezone=auto&forecast_days=${FORECAST_DAYS}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("Open-Meteo svarade inte");
  return r.json();
}

async function fetchStandard(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,cloud_cover,is_day` +
    `&daily=uv_index_max,sunrise,sunset&hourly=cloud_cover,cape,weather_code,snow_depth,temperature_2m,precipitation,precipitation_probability,wind_speed_10m&timezone=auto&past_days=1&forecast_days=7`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("Open-Meteo svarade inte");
  return r.json();
}

// Åskrisk för idag + kommande dygn, från CAPE och åskväderkoder.
// CAPE (J/kg) mäter atmosfärens instabilitet: >1000 = kraftig risk.
function thunderRisk(std) {
  if (!std?.hourly?.cape) return null;
  const { time, cape, weather_code } = std.hourly;
  const now = new Date();
  const buckets = { today: [], tomorrow: [] };
  time.forEach((t, i) => {
    const d = new Date(t);
    const dayDiff = Math.round((new Date(d.toDateString()) - new Date(now.toDateString())) / 86400000);
    if (d < now) return;
    const cp = cape[i] ?? 0;
    const wc = weather_code[i];
    const isThunderCode = [95, 96, 99].includes(wc);
    const entry = { hour: d.getHours(), cape: cp, thunder: isThunderCode };
    if (dayDiff === 0) buckets.today.push(entry);
    else if (dayDiff === 1) buckets.tomorrow.push(entry);
  });
  const assess = (arr) => {
    if (!arr.length) return null;
    const maxCape = Math.max(...arr.map((e) => e.cape));
    const anyCode = arr.some((e) => e.thunder);
    // peak-timme (när CAPE är som högst)
    const peak = arr.reduce((a, b) => (b.cape > a.cape ? b : a), arr[0]);
    let level, label, color;
    if (anyCode || maxCape > 1500) { level = 3; label = "Hög risk"; color = "#C74B50"; }
    else if (maxCape > 800) { level = 2; label = "Måttlig risk"; color = "#D98E23"; }
    else if (maxCape > 300) { level = 1; label = "Låg risk"; color = "#D9B62A"; }
    else { level = 0; label = "Ingen risk"; color = "#4C9F70"; }
    return { level, label, color, maxCape: Math.round(maxCape), peakHour: peak.hour, anyCode };
  };
  return { today: assess(buckets.today), tomorrow: assess(buckets.tomorrow) };
}

// Soltimmar per månad, 10 år, från ERA5-arkivet. Cachas 30 dagar.
async function fetchSunHistory(lat, lon) {
  const key = `fjallvader_sun_${lat.toFixed(1)}_${lon.toFixed(1)}`;
  try {
    const cached = JSON.parse(localStorage.getItem(key) || "null");
    if (cached && Date.now() - cached.t < 30 * 86400000) return cached.data;
  } catch { /* korrupt — hämta om */ }
  const end = new Date(); end.setDate(end.getDate() - 6);
  const start = new Date(end); start.setFullYear(start.getFullYear() - 10);
  start.setMonth(0, 1); // hela år för rättvis månadsjämförelse
  const iso = (d) => d.toISOString().slice(0, 10);
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
    `&start_date=${iso(start)}&end_date=${iso(end)}&daily=sunshine_duration&timezone=auto`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("Arkiv-API svarade inte");
  const j = await r.json();
  // month (0-11) -> year -> summa sekunder
  const acc = {};
  (j.daily?.time || []).forEach((t, i) => {
    const sec = j.daily.sunshine_duration[i];
    if (sec == null) return;
    const d = new Date(t + "T12:00:00");
    const m = d.getMonth(), y = d.getFullYear();
    (acc[m] ||= {});
    acc[m][y] = (acc[m][y] || 0) + sec;
  });
  // till timmar, per månad en lista {year, hours}
  const data = {};
  for (const [m, years] of Object.entries(acc)) {
    const list = Object.entries(years)
      .map(([y, sec]) => ({ year: Number(y), hours: Math.round(sec / 3600) }))
      .sort((a, b) => b.year - a.year);
    data[m] = list;
  }
  try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), data })); } catch { /* fullt */ }
  return data;
}


// Ensemble: 31 parallella GFS-körningar → sannolikheter
async function fetchEnsemble(lat, lon) {
  const url = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,precipitation&models=gfs_seamless&forecast_days=${FORECAST_DAYS}&timezone=auto`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("Ensemble-API svarade inte");
  const j = await r.json();
  const H = j.hourly || {};
  const time = H.time || [];
  const tKeys = Object.keys(H).filter((k) => k.startsWith("temperature_2m"));
  const pKeys = Object.keys(H).filter((k) => k.startsWith("precipitation"));

  // per medlem & dag: max-temp + nederbördssumma
  const byDay = {}; // date -> { tmax: [per medlem], precip: [per medlem] }
  const dayIndex = {}; // date -> lista av timindex
  time.forEach((t, i) => {
    const d = dateKey(t);
    (dayIndex[d] ||= []).push(i);
  });
  for (const [date, idxs] of Object.entries(dayIndex)) {
    const tmaxes = [], precips = [];
    for (const k of tKeys) {
      const arr = H[k];
      let mx = null;
      for (const i of idxs) { const v = arr[i]; if (v != null && (mx == null || v > mx)) mx = v; }
      if (mx != null) tmaxes.push(mx);
    }
    for (const k of pKeys) {
      const arr = H[k];
      let sum = 0, has = false;
      for (const i of idxs) { const v = arr[i]; if (v != null) { sum += v; has = true; } }
      if (has) precips.push(sum);
    }
    if (!tmaxes.length) continue;
    const sorted = [...tmaxes].sort((a, b) => a - b);
    byDay[date] = {
      members: tmaxes.length,
      tmaxP10: quantile(sorted, 0.1),
      tmaxP50: quantile(sorted, 0.5),
      tmaxP90: quantile(sorted, 0.9),
      rainProb: precips.length
        ? Math.round((precips.filter((p) => p > 0.5).length / precips.length) * 100)
        : null,
    };
  }
  return byDay;
}

// Normaler: samma datum senaste 10 åren (ERA5-återanalys), cachas 30 dagar.
// Sparar både snittet och varje enskilt år så man kan fälla ut år-för-år.
async function fetchNormals(lat, lon) {
  const key = `fjallvader_normals_v2_${lat.toFixed(1)}_${lon.toFixed(1)}`;
  try {
    const cached = JSON.parse(localStorage.getItem(key) || "null");
    if (cached && Date.now() - cached.t < 30 * 86400000) return cached.data;
  } catch { /* korrupt cache — hämta om */ }
  const end = new Date(); end.setDate(end.getDate() - 6);
  const start = new Date(end); start.setFullYear(start.getFullYear() - 10);
  const iso = (d) => d.toISOString().slice(0, 10);
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
    `&start_date=${iso(start)}&end_date=${iso(end)}&daily=temperature_2m_max,temperature_2m_min&timezone=auto`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("Arkiv-API svarade inte");
  const j = await r.json();
  const acc = {}; // "MM-DD" -> { hi: [], lo: [], years: [{year, tmax, tmin}] }
  (j.daily?.time || []).forEach((t, i) => {
    const k = mmdd(t);
    const hi = j.daily.temperature_2m_max[i];
    const lo = j.daily.temperature_2m_min[i];
    if (hi == null) return;
    (acc[k] ||= { hi: [], lo: [], years: [] });
    acc[k].hi.push(hi);
    if (lo != null) acc[k].lo.push(lo);
    acc[k].years.push({ year: Number(t.slice(0, 4)), tmax: hi, tmin: lo });
  });
  const data = {};
  for (const [k, v] of Object.entries(acc)) {
    data[k] = {
      tmax: mean(v.hi),
      tmin: mean(v.lo),
      years: v.years.sort((a, b) => b.year - a.year), // nyast först
    };
  }
  try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), data })); } catch { /* fullt */ }
  return data;
}

async function fetchSmhi(lat, lon) {
  // Anropa vår egen Netlify-funktion (proxy) — SMHI direkt blockeras av CORS.
  // Lokalt (npm run dev) finns ingen funktion; då hoppar vi över SMHI tyst.
  const isLocal = typeof location !== "undefined" &&
    (location.hostname === "localhost" || location.hostname === "127.0.0.1");
  if (isLocal) {
    const e = new Error("smhi_local_skip");
    e.code = "local";
    throw e;
  }
  const url = `/api/smhi?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
  const r = await fetch(url);
  if (r.status === 404) {
    const e = new Error("utanför SMHI:s område");
    e.code = "out_of_area";
    throw e;
  }
  if (!r.ok) {
    const e = new Error("SMHI kunde inte nås");
    e.code = "error";
    throw e;
  }
  const j = await r.json();
  const days = {};
  let prev = null;
  const clean = (v) => (v == null || v === 9999 ? null : v); // 9999 = saknat värde
  for (const ts of j.timeSeries) {
    const key = dateKey(ts.time || ts.validTime); // nya API:et: "time"
    // nya API:et: platt data-objekt med läsbara namn; fall tillbaka på gamla format
    const p = ts.data || Object.fromEntries((ts.parameters || []).map((x) => [x.name, x.values[0]]));
    const t = clean(p.air_temperature ?? p.t);
    const pmean = clean(p.precipitation_amount_mean ?? p.pmean);
    const ws = clean(p.wind_speed ?? p.ws);
    const sym = clean(p.symbol_code ?? p.Wsymb2);
    if (!days[key]) days[key] = { temps: [], precip: 0, winds: [], codes: [] };
    const tsTime = new Date(ts.time || ts.validTime);
    const stepH = prev ? clamp((tsTime - prev) / 3600000, 1, 12) : 1;
    prev = tsTime;
    if (t != null) days[key].temps.push(t);
    if (pmean != null) days[key].precip += pmean * stepH;
    if (ws != null) days[key].winds.push(ws);
    if (sym != null) days[key].codes.push(sym);
  }
  const out = {};
  for (const [key, d] of Object.entries(days)) {
    if (!d.temps.length) continue;
    const midCode = d.codes.length ? d.codes[Math.floor(d.codes.length / 2)] : null;
    out[key] = {
      tmax: Math.max(...d.temps),
      tmin: Math.min(...d.temps),
      precip: Math.round(d.precip * 10) / 10,
      wind: d.winds.length ? Math.max(...d.winds) * 3.6 : null,
      code: midCode != null ? SMHI_SYMBOL_TO_WMO[midCode] ?? 3 : null,
      sun: null,
    };
  }
  return out;
}

async function fetchKp() {
  const url = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json";
  const r = await fetch(url);
  if (!r.ok) throw new Error("NOAA svarade inte");
  const rows = await r.json();
  const out = {};
  for (let i = 1; i < rows.length; i++) {
    const [time, kp] = rows[i];
    const d = new Date(time.replace(" ", "T") + "Z");
    const h = d.getUTCHours();
    const nightDate = new Date(d);
    if (h < 6) nightDate.setUTCDate(nightDate.getUTCDate() - 1);
    if (h >= 18 || h < 6) {
      const key = nightDate.toISOString().slice(0, 10);
      const v = parseFloat(kp);
      if (!Number.isNaN(v)) out[key] = Math.max(out[key] ?? 0, v);
    }
  }
  return out;
}

// ---------- luftkvalitet & pollen (Open-Meteo Air Quality, CAMS Europa) ----------

const AQI_LEVELS = [
  { max: 20, label: "Bra", color: "#4C9F70" },
  { max: 40, label: "Godtagbar", color: "#8FB94C" },
  { max: 60, label: "Måttlig", color: "#D9B62A" },
  { max: 80, label: "Dålig", color: "#E2703A" },
  { max: 100, label: "Mycket dålig", color: "#C74B50" },
  { max: 9999, label: "Extremt dålig", color: "#8E3B60" },
];
const aqiLevel = (v) => AQI_LEVELS.find((l) => v <= l.max) || AQI_LEVELS[0];

const POLLEN_SPECIES = [
  { key: "alder_pollen", name: "Al" },
  { key: "birch_pollen", name: "Björk" },
  { key: "grass_pollen", name: "Gräs" },
  { key: "mugwort_pollen", name: "Gråbo" },
  { key: "ragweed_pollen", name: "Ambrosia" },
];
// grova nivåer i korn/m³
function pollenLevel(v) {
  if (v == null) return null;
  if (v < 1) return { label: "Inget", color: "#8FA3B8", level: 0 };
  if (v < 10) return { label: "Låg", color: "#4C9F70", level: 1 };
  if (v < 50) return { label: "Måttlig", color: "#D9B62A", level: 2 };
  return { label: "Hög", color: "#C74B50", level: 3 };
}

async function fetchAir(lat, lon) {
  const hourly = POLLEN_SPECIES.map((p) => p.key).join(",");
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}` +
    `&current=european_aqi,pm10,pm2_5&hourly=${hourly}&timezone=auto&forecast_days=1`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("Luftkvalitets-API svarade inte");
  const j = await r.json();
  // pollen: dagens maxvärde per art
  const pollen = {};
  for (const sp of POLLEN_SPECIES) {
    const arr = j.hourly?.[sp.key];
    if (!arr) continue;
    const vals = arr.filter((v) => v != null);
    pollen[sp.key] = vals.length ? Math.max(...vals) : null;
  }
  return { aqi: j.current?.european_aqi ?? null, pm25: j.current?.pm2_5 ?? null, pollen };
}

// ---------- SMHI vädervarningar ----------

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function pointInGeom(lon, lat, geom) {
  if (!geom) return false;
  if (geom.type === "Polygon") return pointInRing(lon, lat, geom.coordinates[0]);
  if (geom.type === "MultiPolygon") return geom.coordinates.some((p) => pointInRing(lon, lat, p[0]));
  if (geom.type === "GeometryCollection") return (geom.geometries || []).some((g) => pointInGeom(lon, lat, g));
  return false;
}

const WARN_META = {
  RED: { name: "Röd varning", color: "#C74B50", rank: 3 },
  ORANGE: { name: "Orange varning", color: "#E2703A", rank: 2 },
  YELLOW: { name: "Gul varning", color: "#D9B62A", rank: 1 },
};

async function fetchWarnings(lat, lon) {
  const url = "https://opendata-download-warnings.smhi.se/ibww/api/version/1/warning.json";
  const r = await fetch(url);
  if (!r.ok) throw new Error("Varnings-API svarade inte");
  const j = await r.json();
  const hits = [];
  for (const w of Array.isArray(j) ? j : []) {
    const eventName = w.event?.sv || w.event?.en || "Vädervarning";
    for (const area of w.warningAreas || []) {
      const code = (area.warningLevel?.code || "").toUpperCase();
      const meta = WARN_META[code];
      if (!meta) continue; // hoppa över meddelanden utan nivå
      const geom = area.area?.geometry || area.area;
      if (!pointInGeom(lon, lat, geom)) continue;
      hits.push({
        level: code, rank: meta.rank, color: meta.color, levelName: meta.name,
        event: area.eventDescription?.sv || eventName,
        start: area.approximateStart || null,
        end: area.approximateEnd || null,
      });
    }
  }
  return hits.sort((a, b) => b.rank - a.rank);
}

// ---------- normalisering ----------

function buildDays(multi, smhi, ensemble) {
  const dates = multi?.daily?.time || [];
  return dates.map((date, i) => {
    const perModel = {};
    for (const m of MODELS) {
      const g = (f) => multi.daily?.[`${f}_${m.key}`]?.[i] ?? null;
      const tmax = g("temperature_2m_max");
      if (tmax == null) continue;
      perModel[m.key] = {
        tmax,
        tmin: g("temperature_2m_min"),
        precip: g("precipitation_sum"),
        wind: g("wind_speed_10m_max"),
        code: g("weather_code"),
        sun: g("sunshine_duration"),
      };
    }
    if (smhi?.[date]) perModel[SMHI_KEY] = smhi[date];

    const vals = Object.values(perModel);
    const consensus = {
      tmax: mean(vals.map((v) => v.tmax).filter((v) => v != null)),
      tmin: mean(vals.map((v) => v.tmin).filter((v) => v != null)),
      precip: mean(vals.map((v) => v.precip).filter((v) => v != null)),
      wind: mean(vals.map((v) => v.wind).filter((v) => v != null)),
      sun: mean(vals.map((v) => v.sun).filter((v) => v != null)),
    };
    const codes = vals.map((v) => v.code).filter((v) => v != null);
    consensus.code = codes.length ? codes.sort((a, b) =>
      codes.filter((x) => x === a).length - codes.filter((x) => x === b).length).pop() : null;

    let best = null, worst = null;
    for (const [k, v] of Object.entries(perModel)) {
      const s = fineScore(v);
      if (!best || s > best.score) best = { key: k, score: s, ...v };
      if (!worst || s < worst.score) worst = { key: k, score: s, ...v };
    }
    const ens = ensemble?.[date] || null;
    return {
      date, perModel, consensus, best, worst, ens,
      sources: Object.keys(perModel).length,
      agreement: agreementForDay(perModel, ens),
    };
  });
}

function modelName(key) {
  if (key === SMHI_KEY) return "SMHI";
  return MODELS.find((m) => m.key === key)?.name || key;
}

// ---------- bakgrundslager ----------

function Fjall({ colors }) {
  return (
    <svg viewBox="0 0 1440 260" preserveAspectRatio="none" aria-hidden="true"
      style={{ position: "fixed", left: 0, right: 0, bottom: 0, width: "100%", height: "26vh", zIndex: 0, pointerEvents: "none", display: "block" }}>
      <path d="M0,200 L90,150 L200,190 L330,110 L470,180 L600,120 L760,190 L900,140 L1050,185 L1200,125 L1330,175 L1440,150 L1440,260 L0,260 Z"
        fill={colors[0]} opacity="0.55" />
      <path d="M0,235 L120,190 L260,225 L420,160 L580,220 L740,175 L910,225 L1080,180 L1250,222 L1440,190 L1440,260 L0,260 Z"
        fill={colors[1]} opacity="0.85" />
    </svg>
  );
}

function Particles({ kind, wind = 0, reduce }) {
  const drops = useMemo(() => Array.from({ length: kind === "rain" ? 70 : 50 }, (_, i) => ({
    left: Math.random() * 100,
    delay: Math.random() * 5,
    dur: kind === "rain" ? 0.9 + Math.random() * 0.7 : 5 + Math.random() * 6,
    size: kind === "rain" ? 10 + Math.random() * 14 : 3 + Math.random() * 4,
    opacity: 0.25 + Math.random() * 0.4,
    key: i,
  })), [kind]);
  if (reduce || !kind) return null;
  const tilt = clamp(wind / 12, 0, 22); // km/h → grader
  return (
    <div aria-hidden="true" style={{
      position: "fixed", inset: "-10% -5%", zIndex: 0, pointerEvents: "none",
      transform: `rotate(${kind === "rain" ? tilt : tilt * 0.5}deg)`,
    }}>
      {drops.map((d) => kind === "rain" ? (
        <span key={d.key} style={{
          position: "absolute", top: "-5%", left: `${d.left}%`,
          width: 1.5, height: d.size, borderRadius: 2,
          background: "rgba(220,235,250,0.65)", opacity: d.opacity,
          animation: `fv-fall ${d.dur}s linear ${d.delay}s infinite`,
        }} />
      ) : (
        <span key={d.key} style={{
          position: "absolute", top: "-5%", left: `${d.left}%`,
          width: d.size, height: d.size, borderRadius: "50%",
          background: "rgba(255,255,255,0.8)", opacity: d.opacity,
          animation: `fv-snow ${d.dur}s linear ${d.delay}s infinite`,
        }} />
      ))}
    </div>
  );
}

// ---------- animerad väderscen i nulägeskortet ----------
// Vindstyrd: partiklar driver i vindens riktning, lutning/fart efter styrka.
function WeatherScene({ code, isDay, windDir, windKmh, reduce }) {
  const kind = weatherKind(code, null);
  const isSnow = kind === "snow";
  const isRain = ["rain", "thunder"].includes(kind);
  const isThunder = kind === "thunder";
  const isCloud = ["cloud", "partly", "fog"].includes(kind);
  const isClear = kind === "clear";

  const dir = windDir ?? 0;
  const tilt = clamp((windKmh ?? 0) / 3, 0, 32) * (dir > 180 ? 1 : -1);
  const speedFactor = clamp(1 - (windKmh ?? 0) / 120, 0.45, 1);

  const particles = useMemo(() => {
    const n = isSnow ? 34 : isRain ? 54 : 0;
    return Array.from({ length: n }, (_, i) => ({
      left: Math.random() * 110 - 5,
      delay: Math.random() * 4,
      dur: (isSnow ? 5.5 + Math.random() * 5 : 1.0 + Math.random() * 0.7) * speedFactor,
      size: isSnow ? 3 + Math.random() * 4 : 9 + Math.random() * 12,
      op: 0.3 + Math.random() * 0.4,
      key: i,
    }));
  }, [isSnow, isRain, speedFactor]);

  const clouds = useMemo(() => (isCloud ? Array.from({ length: 3 }, (_, i) => ({
    top: 12 + i * 22, scale: 0.7 + Math.random() * 0.5,
    dur: 40 + Math.random() * 30, delay: -Math.random() * 40, op: 0.5 - i * 0.1, key: i,
  })) : []), [isCloud]);

  return (
    <div aria-hidden="true" style={{
      position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", borderRadius: 20,
    }}>
      {isClear && isDay && (
        <div style={{
          position: "absolute", top: "-30%", right: "-10%", width: "70%", height: "120%",
          background: "radial-gradient(circle, rgba(255,214,120,0.5), transparent 65%)",
          animation: reduce ? "none" : "fv-glow 8s ease-in-out infinite alternate",
        }} />
      )}
      {isClear && !isDay && [...Array(18)].map((_, i) => (
        <span key={i} style={{
          position: "absolute", width: 2, height: 2, borderRadius: "50%", background: "#fff",
          top: `${Math.random() * 70}%`, left: `${Math.random() * 100}%`, opacity: 0.5 + Math.random() * 0.4,
          animation: reduce ? "none" : `fv-twinkle ${2 + Math.random() * 3}s ease-in-out ${Math.random() * 3}s infinite`,
        }} />
      ))}
      {clouds.map((c) => (
        <div key={c.key} style={{
          position: "absolute", top: `${c.top}%`, left: "-30%",
          width: 120, height: 34, opacity: c.op,
          transform: `scale(${c.scale})`,
          background: "radial-gradient(50% 100% at 30% 60%, #fff 60%, transparent), radial-gradient(45% 100% at 60% 50%, #fff 60%, transparent), radial-gradient(40% 90% at 80% 65%, #fff 60%, transparent)",
          filter: "blur(2px)",
          animation: reduce ? "none" : `fv-drift ${c.dur}s linear ${c.delay}s infinite`,
        }} />
      ))}
      {(isRain || isSnow) && (
        <div style={{ position: "absolute", inset: "-15% -10%", transform: `rotate(${tilt}deg)` }}>
          {particles.map((p) => isSnow ? (
            <span key={p.key} style={{
              position: "absolute", top: "-6%", left: `${p.left}%`,
              width: p.size, height: p.size, borderRadius: "50%",
              background: "rgba(255,255,255,0.9)", opacity: p.op,
              animation: reduce ? "none" : `fv-scene-snow ${p.dur}s linear ${p.delay}s infinite`,
            }} />
          ) : (
            <span key={p.key} style={{
              position: "absolute", top: "-6%", left: `${p.left}%`,
              width: 1.6, height: p.size, borderRadius: 2,
              background: "rgba(210,228,245,0.7)", opacity: p.op,
              animation: reduce ? "none" : `fv-scene-fall ${p.dur}s linear ${p.delay}s infinite`,
            }} />
          ))}
        </div>
      )}
      {isThunder && !reduce && (
        <div style={{
          position: "absolute", inset: 0, background: "rgba(255,255,255,0.7)",
          animation: "fv-flash 7s steps(1) infinite", opacity: 0,
        }} />
      )}
    </div>
  );
}

function AuroraGlow({ reduce }) {
  return (
    <div aria-hidden="true" style={{
      position: "fixed", left: 0, right: 0, top: 0, height: "45vh", zIndex: 0, pointerEvents: "none",
      background: "radial-gradient(70% 60% at 30% 0%, rgba(61,220,151,0.35), transparent 70%), radial-gradient(60% 55% at 75% 5%, rgba(124,92,255,0.28), transparent 70%)",
      animation: reduce ? "none" : "fv-aurora 14s ease-in-out infinite alternate",
      filter: "blur(6px)",
    }} />
  );
}

// ---------- SVG-ikoner (rena linjeikoner istället för emoji i UI) ----------

function IconMap({ size = 16, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 4 L3 6 V20 L9 18 L15 20 L21 18 V4 L15 6 L9 4 Z" />
      <line x1="9" y1="4" x2="9" y2="18" />
      <line x1="15" y1="6" x2="15" y2="20" />
    </svg>
  );
}

function IconLocate({ size = 18, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="6.5" />
      <circle cx="12" cy="12" r="1.6" fill={color} stroke="none" />
      <line x1="12" y1="1.5" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22.5" />
      <line x1="1.5" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="22.5" y2="12" />
    </svg>
  );
}

function IconStar({ size = 17, filled = false, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24"
      fill={filled ? "#F0A93C" : "none"} stroke={filled ? "#F0A93C" : color}
      strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l2.7 5.6 6.1.8-4.5 4.3 1.1 6-5.4-2.9-5.4 2.9 1.1-6L3.2 9.4l6.1-.8z" />
    </svg>
  );
}

// humörikoner: sol / sol-bakom-moln / regnmoln
function MoodIcon({ kind, size = 17, color = "currentColor" }) {
  if (kind === "optimist") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
        strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <line x1="12" y1="2.5" x2="12" y2="4.5" /><line x1="12" y1="19.5" x2="12" y2="21.5" />
        <line x1="2.5" y1="12" x2="4.5" y2="12" /><line x1="19.5" y1="12" x2="21.5" y2="12" />
        <line x1="5.3" y1="5.3" x2="6.7" y2="6.7" /><line x1="17.3" y1="17.3" x2="18.7" y2="18.7" />
        <line x1="18.7" y1="5.3" x2="17.3" y2="6.7" /><line x1="6.7" y1="17.3" x2="5.3" y2="18.7" />
      </svg>
    );
  }
  if (kind === "pessimist") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
        strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M7 15.5a4 4 0 0 1 .3-7.9 5 5 0 0 1 9.6 1.4A3.3 3.3 0 0 1 16.5 15.5H7z" />
        <line x1="8.5" y1="18.5" x2="7.5" y2="21" /><line x1="12" y1="18.5" x2="11" y2="21" /><line x1="15.5" y1="18.5" x2="14.5" y2="21" />
      </svg>
    );
  }
  // normal: sol bakom moln
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="3" />
      <line x1="8" y1="2.5" x2="8" y2="3.8" /><line x1="2.5" y1="8" x2="3.8" y2="8" /><line x1="4.1" y1="4.1" x2="5" y2="5" />
      <path d="M9 17.5a3.4 3.4 0 0 1 .3-6.7 4.2 4.2 0 0 1 8 1.2A2.8 2.8 0 0 1 16.8 17.5H9z" />
    </svg>
  );
}

function LogoMark({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <defs>
        <linearGradient id="lgAurora" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#3DDC97" />
          <stop offset="100%" stopColor="#7C5CFF" />
        </linearGradient>
      </defs>
      <path d="M6 14 Q 24 2 42 12" fill="none" stroke="url(#lgAurora)" strokeWidth="2.5" strokeLinecap="round" opacity="0.9" />
      <circle cx="33" cy="17" r="5" fill="#F0A93C" />
      <path d="M2 40 L14 24 L22 34 L31 21 L46 40 Z" fill="currentColor" opacity="0.9" />
    </svg>
  );
}

// ---------- SVG: samstämmighetsband ----------

function BandChart({ days, ink, muted, source, optimist }) {
  const isConsensus = !source || source === "consensus";
  const W = 700, H = 200, PAD = 34;
  const pts = days.map((d) => {
    const highs = Object.values(d.perModel).map((m) => m.tmax).filter((v) => v != null);
    const lows = Object.values(d.perModel).map((m) => m.tmin).filter((v) => v != null);
    // väv in ensemblespannet så bandet är ärligt även bortom modellernas horisont
    if (d.ens?.tmaxP10 != null) { highs.push(d.ens.tmaxP90); lows.push(d.ens.tmaxP10); }
    const hi = highs.length ? Math.max(...highs) : null;
    const lo = lows.length ? Math.min(...lows) : null;
    const modelHi = isConsensus ? null : d.perModel?.[source]?.tmax;
    return {
      hi, lo,
      cHi: optimist ? hi
        : (!isConsensus && modelHi != null ? modelHi : (d.consensus.tmax ?? d.ens?.tmaxP50 ?? null)),
      cLo: d.consensus.tmin,
    };
  }).filter((p) => p.hi != null && p.lo != null);
  const all = pts.flatMap((p) => [p.hi, p.lo]);
  if (pts.length < 2) return null;
  const min = Math.floor(Math.min(...all)) - 1;
  const max = Math.ceil(Math.max(...all)) + 1;
  const x = (i) => PAD + (i * (W - PAD * 2)) / (pts.length - 1);
  const y = (v) => H - PAD - ((v - min) * (H - PAD * 2)) / (max - min || 1);
  const labelEvery = pts.length > 9 ? 2 : 1;

  const line = (get) => {
    let s = "";
    pts.forEach((p, i) => { const v = get(p); if (v == null) return; s += `${s ? "L" : "M"}${x(i)},${y(v)}`; });
    return s;
  };
  const band = pts.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.hi)}`).join("") +
    [...pts].reverse().map((p, i) => `L${x(pts.length - 1 - i)},${y(p.lo)}`).join("") + "Z";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}
      role="img" aria-label="Temperaturspann mellan källorna sexton dagar framåt">
      <defs>
        <linearGradient id="bandGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3DDC97" stopOpacity="0.30" />
          <stop offset="100%" stopColor="#7C5CFF" stopOpacity="0.14" />
        </linearGradient>
      </defs>
      {[min, Math.round((min + max) / 2), max].map((t) => (
        <g key={t}>
          <line x1={PAD} x2={W - PAD} y1={y(t)} y2={y(t)} stroke={muted} strokeOpacity="0.25" />
          <text x={PAD - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill={muted}>{t}°</text>
        </g>
      ))}
      <path d={band} fill="url(#bandGrad)" />
      <path d={line((p) => p.cHi)} fill="none" stroke={ink} strokeWidth="2.5" strokeLinecap="round" />
      <path d={line((p) => p.cLo)} fill="none" stroke={muted} strokeWidth="2" strokeDasharray="5 5" strokeLinecap="round" />
      {pts.map((p, i) => (
        <g key={i}>
          {p.cHi != null && <circle cx={x(i)} cy={y(p.cHi)} r="3" fill={ink} />}
          {i % labelEvery === 0 && (
            <text x={x(i)} y={H - 10} textAnchor="middle" fontSize="10" fill={muted}>
              {i === 0 ? "Idag" : dayDate(days[i].date)}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

// ---------- timremsa: timme för timme med temperaturkurva ----------

function HourlyStrip({ std, date, resolution, ink, muted, line, display, extendNext, allDates }) {
  const rows = useMemo(() => {
    const h = std?.hourly;
    if (!h?.temperature_2m) return [];
    const now = new Date();
    const nowLocal = now.toLocaleDateString("sv-SE");
    const cutoff = now.getTime() - 60 * 60 * 1000;
    // vilka datum ska remsan täcka? idag kan sträcka sig in i imorgon
    const wanted = new Set([date]);
    if (extendNext && Array.isArray(allDates)) {
      const idx = allDates.indexOf(date);
      if (idx >= 0 && allDates[idx + 1]) wanted.add(allDates[idx + 1]);
    }
    const out = [];
    h.time.forEach((t, i) => {
      const localDate = t.slice(0, 10);
      if (!wanted.has(localDate)) return;
      const d = new Date(t);
      if (d.getTime() < cutoff) return; // passerade timmar
      if (h.temperature_2m[i] == null) return;
      out.push({ i, hour: d.getHours(), t: h.temperature_2m[i], newDay: localDate !== date });
    });
    // begränsa till ~30 timmar så remsan inte blir orimligt lång
    const capped = out.slice(0, 30);
    if (resolution === 1) return capped;
    return capped.filter((r) => r.hour % 3 === 0).map((r) => ({ ...r, block: true }));
  }, [std, date, resolution, extendNext, allDates]);

  const h = std?.hourly;
  if (!h || rows.length < 2) return null;

  const COL = 62, CURVE_H = 46;
  const temps = rows.map((r) => r.t).filter((v) => v != null);
  const tMin = Math.min(...temps), tMax = Math.max(...temps);
  const y = (v) => 8 + (CURVE_H - 20) * (1 - (v - tMin) / (tMax - tMin || 1));
  const curvePath = rows.map((r, i) => `${i ? "L" : "M"}${i * COL + COL / 2},${y(r.t)}`).join("");

  const precipOf = (r) => {
    if (!h.precipitation) return 0;
    if (resolution === 1) return h.precipitation[r.i] ?? 0;
    let sum = 0;
    for (let k = 0; k < 3; k++) sum += h.precipitation[r.i + k] ?? 0;
    return sum;
  };
  const probOf = (r) => h.precipitation_probability?.[r.i] ?? null;

  return (
    <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch", margin: "0 -6px" }}>
      <div style={{ width: "max-content", padding: "0 6px" }}>
        <svg width={rows.length * COL} height={CURVE_H} style={{ display: "block" }} aria-hidden="true">
          <path d={curvePath} fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />
          {rows.map((r, i) => (
            <circle key={i} cx={i * COL + COL / 2} cy={y(r.t)} r="2.5" fill={ink} />
          ))}
        </svg>
        <div style={{ display: "flex" }}>
          {rows.map((r, i) => {
            const prob = probOf(r);
            const mm = precipOf(r);
            const tint = prob != null ? Math.min(prob / 100, 1) * 0.22 : 0;
            return (
              <div key={i} style={{
                width: COL, textAlign: "center", padding: "6px 2px 8px",
                background: tint > 0.02 ? `rgba(45,111,180,${tint})` : "transparent",
                borderRadius: 8,
              }}>
                <div style={{ fontSize: 12, color: muted, fontWeight: 500 }}>
                  {r.newDay && i > 0 ? dayDate(std.hourly.time[r.i].slice(0, 10)) + " " : ""}
                  {String(r.hour).padStart(2, "0")}{r.block ? "–" + String((r.hour + 3) % 24).padStart(2, "0") : ""}
                </div>
                <div style={{ fontSize: 20, lineHeight: "26px", margin: "2px 0" }}>{wmoIcon(h.weather_code?.[r.i])}</div>
                <div style={{ ...display, fontSize: 16, fontWeight: 700, color: ink }}>{fmt0(r.t)}°</div>
                <div style={{ fontSize: 11, color: "#2D6FB4", minHeight: 14, fontWeight: prob >= 50 ? 700 : 500, marginTop: 2 }}>
                  {prob != null && prob >= 20 ? `${prob} %` : ""}
                </div>
                <div style={{ fontSize: 11, color: muted, minHeight: 13 }}>
                  {mm >= 0.1 ? `${fmt1(mm)} mm` : ""}
                </div>
                <div style={{ fontSize: 11, color: muted }}>
                  {h.wind_speed_10m?.[r.i] != null ? `${fmt0(h.wind_speed_10m[r.i] / 3.6)}` : ""}
                  {h.wind_speed_10m?.[r.i] != null && <span style={{ fontSize: 9, opacity: 0.7 }}> m/s</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------- huvudkomponent ----------

export default function VaderApp() {
  const [place, setPlaceState] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("vaderlek_place") || "null");
      if (saved && typeof saved.lat === "number" && typeof saved.lon === "number") return saved;
    } catch { /* korrupt — använd default */ }
    return DEFAULT_PLACE;
  });
  function setPlace(p) {
    setPlaceState(p);
    try { localStorage.setItem("vaderlek_place", JSON.stringify(p)); } catch { /* fullt */ }
  }
  const [locating, setLocating] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [showSug, setShowSug] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [multi, setMulti] = useState(null);
  const [std, setStd] = useState(null);
  const [smhi, setSmhi] = useState(null);
  const [smhiErr, setSmhiErr] = useState(null);
  const [ensemble, setEnsemble] = useState(null);
  const [normals, setNormals] = useState(null);
  const [kp, setKp] = useState(null);
  const [source, setSourceState] = useState(() => {
    try { return localStorage.getItem("vaderlek_source") || "consensus"; } catch { return "consensus"; }
  });
  function setSource(s) {
    setSourceState(s);
    try { localStorage.setItem("vaderlek_source", s); } catch { /* fullt */ }
  }
  const isConsensus = source === "consensus";
  const [optimist, setOptimistState] = useState(() => {
    try { return localStorage.getItem("vaderlek_optimist") === "1"; } catch { return false; }
  });
  function setOptimist(v) {
    setOptimistState(v);
    try { localStorage.setItem("vaderlek_optimist", v ? "1" : "0"); } catch { /* fullt */ }
  }
  const [openDay, setOpenDay] = useState(null);
  const [showYears, setShowYears] = useState(false);
  const [sunHistory, setSunHistory] = useState(null);
  const [sunMonth, setSunMonth] = useState(new Date().getMonth());
  const [warnings, setWarnings] = useState([]);
  const [air, setAir] = useState(null);
  const [favorites, setFavorites] = useState(() => {
    try { return JSON.parse(localStorage.getItem("fjallvader_favs") || "[]"); } catch { return []; }
  });
  // minimerbara kort: användarens val sparas, säsongsautomatik som grund
  const CARD_LABELS = { aurora: "Norrsken", moon: "Måne", uv: "UV-index", thunder: "Åskrisk", air: "Luft & pollen", sun: "Soltimmar" };
  const [cardPrefs, setCardPrefs] = useState(() => {
    try { return JSON.parse(localStorage.getItem("vaderlek_cards") || "{}"); } catch { return {}; }
  });
  function setCardPref(k, v) {
    const next = { ...cardPrefs, [k]: v };
    setCardPrefs(next);
    try { localStorage.setItem("vaderlek_cards", JSON.stringify(next)); } catch { /* fullt */ }
  }
  const debounce = useRef(null);
  const reduceMotion = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    []
  );

  useEffect(() => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=Inter:wght@400;500;600&display=swap";
    document.head.appendChild(l);
    return () => l.remove();
  }, []);

  useEffect(() => {
    if (query.length < 2) { setSuggestions([]); return; }
    clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      try { setSuggestions(await geocode(query)); setShowSug(true); } catch { /* tyst */ }
    }, 300);
    return () => clearTimeout(debounce.current);
  }, [query]);

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true); setErr(null); setSmhiErr(null);
      setEnsemble(null); setNormals(null); setSunHistory(null); setAir(null); setWarnings([]);
      try {
        const [m, s] = await Promise.all([
          fetchMultiModel(place.lat, place.lon),
          fetchStandard(place.lat, place.lon),
        ]);
        if (cancel) return;
        setMulti(m); setStd(s);
      } catch {
        if (!cancel) setErr("Kunde inte hämta prognosen. Kontrollera anslutningen och försök igen.");
      } finally {
        if (!cancel) setLoading(false);
      }
      fetchSmhi(place.lat, place.lon)
        .then((d) => !cancel && (setSmhi(d), setSmhiErr(false)))
        .catch((e) => { if (!cancel) { setSmhi(null); setSmhiErr(e?.code || "error"); } });
      fetchEnsemble(place.lat, place.lon)
        .then((d) => !cancel && setEnsemble(d))
        .catch(() => !cancel && setEnsemble(null));
      fetchNormals(place.lat, place.lon)
        .then((d) => !cancel && setNormals(d))
        .catch(() => !cancel && setNormals(null));
      fetchSunHistory(place.lat, place.lon)
        .then((d) => !cancel && setSunHistory(d))
        .catch(() => !cancel && setSunHistory(null));
      fetchAir(place.lat, place.lon)
        .then((d) => !cancel && setAir(d))
        .catch(() => !cancel && setAir(null));
      fetchWarnings(place.lat, place.lon)
        .then((d) => !cancel && setWarnings(d))
        .catch(() => !cancel && setWarnings([]));
      fetchKp().then((d) => !cancel && setKp(d)).catch(() => !cancel && setKp(null));
    })();
    return () => { cancel = true; };
  }, [place]);

  const days = useMemo(() => (multi ? buildDays(multi, smhi, ensemble) : []), [multi, smhi, ensemble]);
  const nearDays = days.slice(0, NEAR_DAYS);
  const farDays = days.slice(NEAR_DAYS);

  // vy för en dag: optimist → dagens gladaste modell; annars vald källa (konsensus/modell)
  const sourceView = (d) => {
    if (!d) return null;
    if (optimist) return d.best || d.consensus;
    if (isConsensus) return d.consensus;
    return d.perModel?.[source] || d.consensus;
  };

  const bestDayIdx = useMemo(() => {
    let idx = -1, best = -Infinity;
    nearDays.forEach((d, i) => {
      const v = optimist ? (d.best || d.consensus) : isConsensus ? d.consensus : (d.perModel?.[source] || d.consensus);
      const s = fineScore(v);
      if (s > best) { best = s; idx = i; }
    });
    return idx;
  }, [nearDays, source, isConsensus, optimist]);

  const auroraNights = useMemo(() => {
    if (!kp || !std?.hourly) return [];
    const nights = [];
    const cloudsByHour = std.hourly.time.map((t, i) => ({ t, c: std.hourly.cloud_cover[i] }));
    for (const [date, kpVal] of Object.entries(kp).sort()) {
      const nightClouds = cloudsByHour.filter(({ t }) => {
        const d = dateKey(t); const h = new Date(t).getHours();
        const next = new Date(date + "T12:00:00"); next.setDate(next.getDate() + 1);
        return (d === date && h >= 21) || (d === dateKey(next.toISOString()) && h <= 2);
      }).map((x) => x.c);
      const cloud = nightClouds.length ? mean(nightClouds) : null;
      const latFactor = clamp((place.lat - 52) / 16, 0.15, 1);
      const kpFactor = clamp(kpVal / 7, 0, 1);
      const skyFactor = cloud == null ? 0.5 : 1 - cloud / 100;
      nights.push({ date, kp: kpVal, cloud, chance: Math.round(kpFactor * skyFactor * latFactor * 100) });
    }
    return nights.slice(0, 3);
  }, [kp, std, place.lat]);

  // Bakgrundstemat speglar det verkliga aktuella vädret.
  const cur = std?.current;
  const tKey = themeKey(cur?.weather_code, cur ? cur.is_day === 1 : true);
  const T = THEMES[tKey];
  const auroraTonight = T.dark && (auroraNights[0]?.chance ?? 0) >= 40;

  // vald vy per dag utifrån humörläge

  // normaljämförelse för idag
  const todayNormal = normals?.[mmdd(days[0]?.date || new Date().toISOString())];
  const todayDelta = todayNormal && days[0]?.consensus?.tmax != null
    ? days[0].consensus.tmax - todayNormal.tmax : null;

  // past_days=1 gör att index 0 = igår i std.daily — slå upp dagens index robust
  const todayIdx = useMemo(() => {
    const t = std?.daily?.time;
    if (!t) return 0;
    const local = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD
    const i = t.indexOf(local);
    return i >= 0 ? i : 0;
  }, [std]);

  const uvToday = std?.daily?.uv_index_max?.[todayIdx];

  // säsongsautomatik: göm norrsken när chansen är försumbar hela perioden
  const autoHidden = useMemo(() => {
    const s = new Set();
    if (auroraNights.length && Math.max(...auroraNights.map((n) => n.chance)) < 5) s.add("aurora");
    return s;
  }, [auroraNights]);
  const isCardVisible = (k) =>
    cardPrefs[k] === "shown" ? true : cardPrefs[k] === "hidden" ? false : !autoHidden.has(k);
  const hiddenCards = Object.keys(CARD_LABELS).filter((k) => !isCardVisible(k));
  const risk = useMemo(() => (std ? thunderRisk(std) : null), [std]);

  // dagslängd + förändring sedan igår
  const dayLight = useMemo(() => {
    const sr = std?.daily?.sunrise, ss = std?.daily?.sunset;
    if (!sr || !ss || sr[todayIdx] == null) return null;
    const lenMin = (i) => (new Date(ss[i]) - new Date(sr[i])) / 60000;
    const today = lenMin(todayIdx);
    const delta = todayIdx > 0 ? Math.round(today - lenMin(todayIdx - 1)) : null;
    const fmtT = (iso) => new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
    return {
      rise: fmtT(sr[todayIdx]), set: fmtT(ss[todayIdx]),
      hours: Math.floor(today / 60), mins: Math.round(today % 60), delta,
    };
  }, [std, todayIdx]);

  // aktuellt snödjup (m → cm), visas bara när det ligger snö
  const snowCm = useMemo(() => {
    const h = std?.hourly;
    if (!h?.snow_depth) return null;
    const nowIso = new Date().toISOString().slice(0, 13);
    let idx = h.time.findIndex((t) => t.slice(0, 13) === nowIso);
    if (idx < 0) idx = h.time.length - 1;
    const m = h.snow_depth[idx];
    return m != null && m > 0.005 ? Math.round(m * 100) : null;
  }, [std]);

  // soltimmar för vald månad
  const sunStats = useMemo(() => {
    const list = sunHistory?.[sunMonth];
    if (!list?.length) return null;
    const hrs = list.map((x) => x.hours);
    const avg = mean(hrs);
    const sunniest = list.reduce((a, b) => (b.hours > a.hours ? b : a));
    const dullest = list.reduce((a, b) => (b.hours < a.hours ? b : a));
    const thisYear = new Date().getFullYear();
    const currentYearEntry = list.find((x) => x.year === thisYear);
    return { list, avg, sunniest, dullest, max: Math.max(...hrs), current: currentYearEntry };
  }, [sunHistory, sunMonth]);

  function pickPlace(p) {
    setPlace(p); setQuery(""); setSuggestions([]); setShowSug(false);
  }

  const isFav = favorites.some((f) => Math.abs(f.lat - place.lat) < 0.01 && Math.abs(f.lon - place.lon) < 0.01);
  function toggleFav() {
    let next;
    if (isFav) {
      next = favorites.filter((f) => !(Math.abs(f.lat - place.lat) < 0.01 && Math.abs(f.lon - place.lon) < 0.01));
    } else {
      next = [...favorites, { name: place.name, admin: place.admin, lat: place.lat, lon: place.lon }].slice(0, 8);
    }
    setFavorites(next);
    try { localStorage.setItem("fjallvader_favs", JSON.stringify(next)); } catch { /* fullt */ }
  }

  const MinBtn = ({ k, light }) => (
    <button onClick={() => setCardPref(k, "hidden")} title="Minimera" aria-label={`Minimera ${CARD_LABELS[k]}`}
      style={{
        position: "absolute", top: 12, right: 14, width: 24, height: 24, borderRadius: 8,
        border: "none", cursor: "pointer", fontSize: 15, lineHeight: "22px", padding: 0, zIndex: 2,
        background: light ? "rgba(255,255,255,0.14)" : "rgba(22,35,58,0.06)",
        color: light ? "#C9D6E4" : muted,
      }}>–</button>
  );
  function useMyPosition() {
    if (!navigator.geolocation) {
      setErr("Din enhet stöder inte positionshämtning. Sök på ort istället.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;
        const named = await reverseGeocode(lat, lon);
        setPlace({ name: named.name, admin: named.admin, lat, lon });
        setLocating(false);
      },
      () => {
        setErr("Kunde inte hämta din position. Kontrollera att du gett appen platstillstånd, eller sök på ort istället.");
        setLocating(false);
      },
      { timeout: 8000, enableHighAccuracy: false }
    );
  }

  const heroDay = days[0];

  const ink = "#16233A", muted = "#5B7089", line = "#DCE5EC";
  // nulägeskortets textfärger följer vädertemat (mörk text på ljusa teman, ljus på mörka)
  const heroInk = T.pageInk;
  const heroMuted = T.pageMuted;
  // rutornas bakgrund i hjärtat: ljus på mörka teman, mörk på ljusa
  const heroTile = T.dark ? "rgba(255,255,255,0.12)" : "rgba(22,35,58,0.06)";
  const font = { fontFamily: "'Inter', system-ui, sans-serif" };
  const display = { fontFamily: "'Space Grotesk', 'Inter', sans-serif" };
  const card = {
    background: "rgba(255,255,255,0.88)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
    borderRadius: 20, padding: "20px 22px", color: ink,
    border: "1px solid rgba(255,255,255,0.55)", boxShadow: "0 2px 12px rgba(16,27,49,0.10)",
  };

  return (
    <div style={{ ...font, minHeight: "100vh", background: T.bg, color: T.pageInk, transition: "background 1.2s ease", position: "relative" }}>
      <style>{`
        @keyframes fv-fall { from { transform: translateY(0); } to { transform: translateY(115vh); } }
        @keyframes fv-snow {
          0% { transform: translateY(0) translateX(0); }
          50% { transform: translateY(57vh) translateX(18px); }
          100% { transform: translateY(115vh) translateX(-10px); }
        }
        @keyframes fv-aurora {
          from { opacity: 0.55; transform: translateX(-3%) scaleY(1); }
          to { opacity: 1; transform: translateX(3%) scaleY(1.12); }
        }
        @keyframes fv-scene-fall { from { transform: translateY(-10%); } to { transform: translateY(360px); } }
        @keyframes fv-scene-snow {
          0% { transform: translateY(-10%) translateX(0); }
          50% { transform: translateY(160px) translateX(14px); }
          100% { transform: translateY(360px) translateX(-8px); }
        }
        @keyframes fv-glow { from { opacity: 0.6; transform: scale(1); } to { opacity: 1; transform: scale(1.08); } }
        @keyframes fv-spin { to { transform: rotate(360deg); } }
        @keyframes fv-twinkle { 0%,100% { opacity: 0.2; } 50% { opacity: 0.9; } }
        @keyframes fv-drift { from { transform: translateX(0); } to { transform: translateX(160%); } }
        @keyframes fv-flash {
          0%, 96%, 100% { opacity: 0; }
          97%, 99% { opacity: 0; }
          98% { opacity: 0.55; }
        }
      `}</style>

      <Fjall colors={T.fjall} />
      {auroraTonight && <AuroraGlow reduce={reduceMotion} />}

      <div style={{ maxWidth: 760, margin: "0 auto", padding: "24px 16px 30vh", position: "relative", zIndex: 1 }}>

        {/* header */}
        <header style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 22, textAlign: "center" }}>
          <div style={{ color: T.pageInk, marginBottom: 4 }}>
            <LogoMark size={42} />
          </div>
          <h1 style={{
            ...display, fontSize: 30, fontWeight: 700, margin: 0,
            letterSpacing: "0.06em", textTransform: "uppercase",
          }}>
            Väderlek
          </h1>
          <p style={{ margin: "3px 0 12px", fontSize: 13, color: T.pageMuted, letterSpacing: "0.01em" }}>
            Fem prognoskällor. En sanning. Ungefär.
          </p>
          <button
            onClick={() => setOptimist(!optimist)}
            aria-pressed={optimist}
            style={{
              display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 16,
              padding: "7px 16px", borderRadius: 999, cursor: "pointer", ...font, fontSize: 13,
              fontWeight: 600, transition: "all .2s",
              border: optimist ? "1px solid transparent" : `1px solid ${line}`,
              background: optimist ? "linear-gradient(135deg, #F0A93C, #F5C869)" : "rgba(255,255,255,0.7)",
              color: optimist ? "#fff" : "#3C5D7A",
              boxShadow: optimist ? "0 2px 8px rgba(240,169,60,0.35)" : "none",
            }}>
            <MoodIcon kind="optimist" size={16} color={optimist ? "#fff" : "#3C5D7A"} />
            Optimistläge {optimist ? "på" : "av"}
          </button>
          <div style={{ position: "relative", width: "100%", maxWidth: 400 }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => suggestions.length && setShowSug(true)}
              placeholder="Sök ort …"
              aria-label="Sök ort"
              style={{
                width: "100%", boxSizing: "border-box", padding: "11px 46px 11px 16px",
                borderRadius: 14, border: `1px solid ${line}`,
                fontSize: 14, outline: "none", background: "rgba(255,255,255,0.92)", color: ink, ...font,
              }}
            />
            <button onClick={useMyPosition} disabled={locating} title="Använd min position" aria-label="Använd min position"
              style={{
                position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
                width: 34, height: 34, borderRadius: 10, border: "none",
                background: "transparent", cursor: locating ? "default" : "pointer", color: muted,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
              {locating ? (
                <span style={{
                  width: 16, height: 16, borderRadius: "50%",
                  border: `2px solid ${line}`, borderTopColor: muted,
                  display: "inline-block", animation: "fv-spin 0.7s linear infinite",
                }} />
              ) : <IconLocate />}
            </button>
            {showSug && suggestions.length > 0 && (
              <ul style={{
                position: "absolute", top: "110%", left: 0, right: 0, zIndex: 10,
                background: "#fff", border: `1px solid ${line}`, borderRadius: 12,
                listStyle: "none", margin: 0, padding: 6, boxShadow: "0 8px 24px rgba(22,35,58,0.16)",
                textAlign: "left",
              }}>
                {suggestions.map((s, i) => (
                  <li key={i}>
                    <button onClick={() => pickPlace(s)} style={{
                      display: "block", width: "100%", textAlign: "left", padding: "8px 10px",
                      border: "none", background: "transparent", cursor: "pointer", borderRadius: 8,
                      fontSize: 14, color: ink, ...font,
                    }}
                      onMouseEnter={(e) => e.currentTarget.style.background = "#EEF3F7"}
                      onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                      {s.name} <span style={{ color: muted, fontSize: 12 }}>{s.admin}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button onClick={() => setShowMap(true)} style={{
            display: "inline-flex", alignItems: "center", gap: 7, marginTop: 12,
            padding: "8px 18px", borderRadius: 999, cursor: "pointer", ...font,
            fontSize: 13, fontWeight: 600, color: "#3C5D7A",
            border: `1px solid ${line}`, background: "rgba(255,255,255,0.7)",
          }}>
            <IconMap size={16} color="#3C5D7A" /> Regnradar
          </button>
        </header>

        {showMap && (
          <Suspense fallback={
            <div style={{
              position: "fixed", inset: 0, zIndex: 1000, background: "#16233A", color: "#fff",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, ...font,
            }}>Laddar karta …</div>
          }>
            <MapView place={place} onClose={() => setShowMap(false)} />
          </Suspense>
        )}

        {/* favoritplatser */}
        {favorites.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
            {favorites.map((f, i) => {
              const active = Math.abs(f.lat - place.lat) < 0.01 && Math.abs(f.lon - place.lon) < 0.01;
              return (
                <button key={i} onClick={() => pickPlace(f)} style={{
                  padding: "6px 14px", borderRadius: 999, fontSize: 13, cursor: "pointer", ...font,
                  border: active ? "1px solid transparent" : "1px solid rgba(255,255,255,0.5)",
                  background: active ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.35)",
                  color: active ? ink : T.pageInk, fontWeight: active ? 600 : 400,
                }}>
                  {f.name}
                </button>
              );
            })}
          </div>
        )}

        {/* SMHI-vädervarningar */}
        {warnings.length > 0 && warnings.map((w, i) => (
          <div key={i} style={{
            ...card, marginBottom: 12, borderLeft: `5px solid ${w.color}`,
            display: "flex", gap: 12, alignItems: "flex-start", padding: "14px 18px",
          }}>
            <span style={{ fontSize: 22, lineHeight: 1 }}>⚠️</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: w.color }}>{w.levelName}: {w.event}</div>
              {(w.start || w.end) && (
                <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>
                  {w.start && `Från ${new Date(w.start).toLocaleString("sv-SE", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}`}
                  {w.end && ` till ${new Date(w.end).toLocaleString("sv-SE", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}`}
                </div>
              )}
              <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>Källa: SMHI</div>
            </div>
          </div>
        ))}

        {err && (
          <div style={{ ...card, borderColor: "#C74B50", marginBottom: 16, fontSize: 14 }}>
            {err}
          </div>
        )}

        {loading ? (
          <div style={{ ...card, textAlign: "center", padding: 48, color: muted }}>
            Hämtar prognoser från fem källor …
          </div>
        ) : days.length > 0 && (
          <>
            {/* hero — kortet ÄR vädret: temats bakgrund + textväxling */}
            <section style={{
              ...card, marginBottom: 16, position: "relative", overflow: "hidden",
              background: T.bg,
              border: T.dark ? "1px solid rgba(255,255,255,0.12)" : "1px solid rgba(255,255,255,0.5)",
            }}>
              {cur && (
                <WeatherScene
                  code={cur.weather_code} isDay={cur.is_day === 1}
                  windDir={cur.wind_direction_10m} windKmh={cur.wind_speed_10m}
                  reduce={reduceMotion}
                />
              )}
              {/* mjuk scrim för läsbarhet — mörk på ljusa teman, ljus på mörka */}
              <div aria-hidden="true" style={{
                position: "absolute", inset: 0, borderRadius: 20, pointerEvents: "none",
                background: T.dark
                  ? "linear-gradient(180deg, rgba(10,18,30,0.10) 0%, rgba(10,18,30,0.28) 100%)"
                  : "linear-gradient(180deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.30) 100%)",
              }} />
              <div style={{ position: "relative", zIndex: 1 }}>
              {/* nivå 1: plats + nuläge */}
              <div style={{ fontSize: 13, color: heroMuted, marginBottom: 2, display: "flex", alignItems: "center", gap: 6 }}>
                {place.name}{place.admin ? ` · ${place.admin}` : ""}
                <button onClick={toggleFav} title={isFav ? "Ta bort favorit" : "Spara som favorit"}
                  aria-label={isFav ? "Ta bort favorit" : "Spara som favorit"}
                  style={{
                    border: "none", background: "transparent", cursor: "pointer", padding: 2,
                    lineHeight: 0, color: heroMuted, display: "inline-flex",
                  }}>
                  <IconStar filled={isFav} />
                </button>
              </div>
              {cur ? (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", color: heroInk }}>
                    <div style={{ ...display, fontSize: 56, fontWeight: 700, lineHeight: 1 }}>
                      {fmt0(cur.temperature_2m)}°
                    </div>
                    <div style={{ fontSize: 15 }}>
                      <span style={{ fontSize: 22, marginRight: 6 }}>{wmoIcon(cur.weather_code)}</span>
                      {wmoLabel(cur.weather_code)}
                      <div style={{ fontSize: 13, color: heroMuted }}>känns som {fmt0(cur.apparent_temperature)}°</div>
                    </div>
                  </div>
                  <div style={{ fontSize: 14, marginTop: 10, color: heroMuted }}>
                    {moodLine("normal", cur.weather_code, cur.temperature_2m, heroDay?.date)}
                  </div>

                  {/* nivå 2: mätarrutor */}
                  <div style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                    gap: 8, marginTop: 16, color: heroInk,
                  }}>
                    <div style={{ background: heroTile, borderRadius: 12, padding: "9px 12px" }}>
                      <div style={{ fontSize: 10, color: heroMuted, textTransform: "uppercase", letterSpacing: "0.07em" }}>Vind</div>
                      <div style={{ ...display, fontSize: 16, fontWeight: 700 }}>{fmt0(cur.wind_speed_10m / 3.6)} m/s</div>
                    </div>
                    <div style={{ background: heroTile, borderRadius: 12, padding: "9px 12px" }}>
                      <div style={{ fontSize: 10, color: heroMuted, textTransform: "uppercase", letterSpacing: "0.07em" }}>Molntäcke</div>
                      <div style={{ ...display, fontSize: 16, fontWeight: 700 }}>{fmt0(cur.cloud_cover)} %</div>
                    </div>
                    {dayLight && (
                      <div style={{ background: heroTile, borderRadius: 12, padding: "9px 12px" }}>
                        <div style={{ fontSize: 10, color: heroMuted, textTransform: "uppercase", letterSpacing: "0.07em" }}>Dagsljus</div>
                        <div style={{ ...display, fontSize: 16, fontWeight: 700 }}>
                          {dayLight.hours} t {dayLight.mins} min
                          {dayLight.delta != null && dayLight.delta !== 0 && (
                            <span style={{ fontSize: 12, fontWeight: 600, marginLeft: 5, color: T.dark ? (dayLight.delta > 0 ? "#8FE0B4" : "#9CC2F0") : (dayLight.delta > 0 ? "#3E8E63" : "#2D6FB4") }}>
                              {dayLight.delta > 0 ? "+" : ""}{dayLight.delta}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 11, color: heroMuted }}>{dayLight.rise}–{dayLight.set}</div>
                      </div>
                    )}
                    {todayDelta != null && (
                      <button
                        onClick={() => setShowYears(!showYears)}
                        aria-expanded={showYears}
                        style={{
                          background: heroTile, borderRadius: 12, padding: "9px 12px",
                          border: "none", cursor: "pointer", textAlign: "left", ...font, color: heroInk,
                        }}>
                        <div style={{ fontSize: 10, color: heroMuted, textTransform: "uppercase", letterSpacing: "0.07em" }}>Mot normalt</div>
                        <div style={{
                          ...display, fontSize: 16, fontWeight: 700,
                          color: Math.abs(todayDelta) < 0.5 ? heroInk : T.dark ? (todayDelta > 0 ? "#F0B48C" : "#9CC2F0") : (todayDelta > 0 ? "#B4552D" : "#2D6FB4"),
                        }}>
                          {todayDelta > 0 ? "+" : ""}{fmt1(todayDelta)}°
                          <span style={{
                            fontSize: 11, color: heroMuted, marginLeft: 5, display: "inline-block",
                            transform: showYears ? "rotate(180deg)" : "none", transition: "transform .2s",
                          }}>▾</span>
                        </div>
                        <div style={{ fontSize: 11, color: heroMuted }}>år för år</div>
                      </button>
                    )}
                    {snowCm != null && (
                      <div style={{ background: heroTile, borderRadius: 12, padding: "9px 12px" }}>
                        <div style={{ fontSize: 10, color: heroMuted, textTransform: "uppercase", letterSpacing: "0.07em" }}>Snödjup</div>
                        <div style={{ ...display, fontSize: 16, fontWeight: 700 }}>{snowCm} cm</div>
                      </div>
                    )}
                  </div>

                  {/* utfällning: år för år */}
                  {showYears && todayNormal?.years?.length > 0 && (
                    <div style={{ marginTop: 12, borderTop: `1px solid ${line}`, paddingTop: 10 }}>
                      <div style={{ fontSize: 11, color: muted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                        Den {dayDate(days[0].date)}, år för år · snitt senaste 10 åren
                      </div>
                      {(() => {
                        const yrs = todayNormal.years;
                        const highs = yrs.map((y) => y.tmax);
                        const warmest = Math.max(...highs), coldest = Math.min(...highs);
                        const warmYear = yrs.find((y) => y.tmax === warmest);
                        const coldYear = yrs.find((y) => y.tmax === coldest);
                        return (
                          <>
                            <div style={{ fontSize: 12, marginBottom: 8 }}>
                              <span style={{ color: "#B4552D", fontWeight: 600 }}>Rekord att slå: {fmt1(warmest)}° ({warmYear.year})</span>
                              <span style={{ color: muted }}> · kallast: {fmt1(coldest)}° ({coldYear.year})</span>
                            </div>
                            {yrs.map((y) => {
                              const isWarm = y.tmax === warmest, isCold = y.tmax === coldest;
                              const pct = clamp(((y.tmax - coldest) / (warmest - coldest || 1)) * 100, 0, 100);
                              return (
                                <div key={y.year} style={{ display: "flex", alignItems: "center", gap: 10, padding: "3px 0", fontSize: 13 }}>
                                  <span style={{ width: 34, color: muted, fontVariantNumeric: "tabular-nums" }}>{y.year}</span>
                                  <div style={{ flex: 1, height: 6, background: line, borderRadius: 3, overflow: "hidden" }}>
                                    <div style={{
                                      height: "100%", width: `${pct}%`, borderRadius: 3,
                                      background: isWarm ? "#B4552D" : isCold ? "#2D6FB4" : "#8FA3B8",
                                    }} />
                                  </div>
                                  <span style={{ ...display, width: 44, textAlign: "right", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                                    {fmt1(y.tmax)}°
                                  </span>
                                  <span style={{ width: 16, fontSize: 12 }}>{isWarm ? "🔥" : isCold ? "❄️" : ""}</span>
                                </div>
                              );
                            })}
                          </>
                        );
                      })()}
                      <div style={{ fontSize: 11, color: muted, marginTop: 8 }}>
                        Dagens maxtemp: {fmt1(days[0].consensus.tmax)}°. Staplarna visar dagstemperaturen samma datum varje år.
                      </div>
                    </div>
                  )}

                  {/* nivå 3: statusrad + timgenväg */}
                  <div style={{ marginTop: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 13, flexWrap: "wrap" }}>
                    {heroDay?.agreement ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: heroDay.agreement.color, display: "inline-block" }} />
                        <span style={{ color: heroMuted }}>
                          {heroDay.agreement.label}
                          {heroDay.ens?.rainProb != null && ` · ${heroDay.ens.rainProb} % regnchans`}
                        </span>
                      </div>
                    ) : <span />}
                    <button
                      onClick={() => document.getElementById("timstrip")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                      style={{
                        border: "none", background: "transparent", cursor: "pointer", padding: 0,
                        fontSize: 13, color: T.dark ? "#9CC2F0" : "#2D6FB4", fontWeight: 600, ...font,
                      }}>
                      Timme för timme ▾
                    </button>
                  </div>
                </>
              ) : null}
              </div>
            </section>

            {/* modellväljare — styr prognosen nedan */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ opacity: optimist ? 0.4 : 1, pointerEvents: optimist ? "none" : "auto", transition: "opacity .2s" }}>
              <div style={{
                display: "flex", gap: 6, padding: 5, overflowX: "auto",
                background: "rgba(255,255,255,0.55)", borderRadius: 14,
                border: "1px solid rgba(255,255,255,0.5)", WebkitOverflowScrolling: "touch",
              }}>
                {SOURCES.map((s) => {
                  const active = source === s.key;
                  const available = s.key === "consensus" || (heroDay?.perModel && heroDay.perModel[s.key]);
                  return (
                    <button key={s.key}
                      onClick={() => available && setSource(s.key)}
                      disabled={!available}
                      aria-pressed={active}
                      style={{
                        flex: "0 0 auto", padding: "8px 16px", borderRadius: 999, border: "none",
                        cursor: available ? "pointer" : "default", ...font,
                        fontSize: 13, fontWeight: active ? 700 : 500, whiteSpace: "nowrap",
                        background: active ? "#16233A" : "transparent",
                        color: active ? "#fff" : available ? "#3C5D7A" : "#AEBBC8",
                        boxShadow: active ? "0 1px 4px rgba(22,35,58,0.2)" : "none",
                        transition: "all .2s",
                      }}>
                      {s.label}
                    </button>
                  );
                })}
              </div>
              </div>
              <p style={{ fontSize: 11, color: T.pageMuted, margin: "6px 2px 0", textAlign: "center" }}>
                {optimist
                  ? "Optimistläget visar den gladaste modellen per dag. Stäng av det för att välja källa själv."
                  : isConsensus
                    ? "Visar snittet av alla källor. Välj en modell för att se dagen genom just den."
                    : `Visar prognosen enligt ${SOURCES.find((s) => s.key === source)?.label}. Nuläget står kvar som mätt.`}
              </p>
            </div>

            {/* band 16 dagar */}
            <section style={{ ...card, marginBottom: 16 }}>
              <div style={{ marginBottom: 8 }}>
                <h2 style={{ ...display, fontSize: 16, fontWeight: 700, margin: 0 }}>
                  {optimist
                    ? "16 dagar enligt de gladaste källorna"
                    : isConsensus
                      ? "16 dagar enligt alla källor"
                      : `16 dagar enligt ${SOURCES.find((s) => s.key === source)?.label}`}
                </h2>
              </div>
              <BandChart days={days} ink={ink} muted={muted} source={source} optimist={optimist} />
              <p style={{ fontSize: 11, color: muted, margin: "6px 0 0", textAlign: "center" }}>
                {optimist
                  ? "optimistens linje följer bandets överkant"
                  : isConsensus
                    ? "bandet visar källornas och ensemblens spridning"
                    : `linjen visar ${SOURCES.find((s) => s.key === source)?.label}, bandet övriga källors spridning`}
              </p>
            </section>

            {/* timme för timme — egen sektion */}
            {std?.hourly && (
              <section style={{ ...card, marginBottom: 16 }} id="timstrip">
                <h2 style={{ ...display, fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>Timme för timme</h2>
                <p style={{ fontSize: 11, color: muted, margin: "0 0 10px" }}>
                  Idag och imorgon, timme för timme. Färgen bakom visar regnchansen.
                </p>
                <HourlyStrip std={std} date={days[0]?.date} resolution={1}
                  extendNext allDates={days.map((x) => x.date)}
                  ink={ink} muted={muted} line={line} display={display} />
              </section>
            )}

            {/* dagkort 1–7 */}
            <section style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
              {nearDays.map((d, i) => {
                const view = sourceView(d);
                const showModelNote = !isConsensus && d.perModel?.[source];
                return (
                <div key={d.date} id={`day-${i}`} style={{ ...card, padding: 0, overflow: "hidden", scrollMarginTop: 12 }}>
                  <button
                    onClick={() => setOpenDay(openDay === i ? null : i)}
                    aria-expanded={openDay === i}
                    style={{
                      display: "grid", gridTemplateColumns: "82px 32px 1fr auto auto", alignItems: "center",
                      gap: 10, width: "100%", padding: "13px 18px", border: "none",
                      background: "transparent", cursor: "pointer", textAlign: "left", ...font, color: ink,
                    }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{dayName(d.date)}</div>
                      <div style={{ fontSize: 12, color: muted }}>{dayDate(d.date)}</div>
                    </div>
                    <div style={{ fontSize: 22 }}>{wmoIcon(view.code)}</div>
                    <div style={{ fontSize: 13, color: muted }}>
                      {wmoLabel(view.code)}
                      {optimist && d.best && (
                        <span style={{ marginLeft: 6, fontSize: 11, color: "#B8860B" }}>{modelName(d.best.key)} ☀️</span>
                      )}
                      {!optimist && isConsensus && d.ens?.rainProb != null && d.ens.rainProb >= 20 && (
                        <span style={{ marginLeft: 6 }}>💧 {d.ens.rainProb} %</span>
                      )}
                      {i === bestDayIdx && (
                        <span style={{
                          marginLeft: 8, fontSize: 11, fontWeight: 600, color: "#0B6E4F",
                          background: "rgba(61,220,151,0.18)", padding: "2px 8px", borderRadius: 999,
                        }}>Veckans finaste ✨</span>
                      )}
                    </div>
                    {!optimist && isConsensus && d.agreement ? (
                      <span title={d.agreement.label} style={{
                        fontSize: 11, color: d.agreement.color, fontWeight: 600, whiteSpace: "nowrap",
                      }}>{d.agreement.short}</span>
                    ) : <span />}
                    <div style={{ ...display, fontSize: 15, fontWeight: 700, whiteSpace: "nowrap" }}>
                      {fmt0(view.tmax)}° <span style={{ color: muted, fontWeight: 400 }}>/ {fmt0(view.tmin)}°</span>
                    </div>
                  </button>
                  {openDay === i && (
                    <div style={{ borderTop: `1px solid ${line}`, padding: "12px 18px 16px", fontSize: 13 }}>
                      <div style={{ fontSize: 11, color: muted, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 6px" }}>
                        {i <= 1 ? "Timme för timme" : "Var tredje timme"}
                      </div>
                      <HourlyStrip std={std} date={d.date} resolution={i <= 1 ? 1 : 3}
                        extendNext={i === 0} allDates={days.map((x) => x.date)}
                        ink={ink} muted={muted} line={line} display={display} />
                      <div style={{ marginTop: 10, color: muted, fontSize: 12, display: "flex", flexDirection: "column", gap: 3 }}>
                        {d.ens && (
                          <span>
                            Ensemble ({d.ens.members} GFS-körningar): maxtemp troligen {fmt0(d.ens.tmaxP10)}–{fmt0(d.ens.tmaxP90)}°
                            {d.ens.rainProb != null ? ` · ${d.ens.rainProb} % av körningarna ger regn` : ""}
                          </span>
                        )}
                        {normals?.[mmdd(d.date)] && (
                          <span>Normalt för den {dayDate(d.date)}: {fmt0(normals[mmdd(d.date)].tmax)}° / {fmt0(normals[mmdd(d.date)].tmin)}°</span>
                        )}
                        {smhiErr === "out_of_area" && <span>SMHI täcker inte den här platsen — visar övriga källor.</span>}
                      </div>
                    </div>
                  )}
                </div>
                );
              })}
            </section>

            {/* dag 8–16: lutning, inte löfte */}
            {farDays.length > 0 && (
              <section style={{ ...card, marginBottom: 16, padding: "18px 22px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, flexWrap: "wrap", gap: 4 }}>
                  <h2 style={{ ...display, fontSize: 16, fontWeight: 700, margin: 0 }}>Längre fram</h2>
                  <span style={{ fontSize: 12, color: muted }}>
                    spann och sannolikhet — inte exakta löften
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {farDays.map((d) => {
                    const mv = sourceView(d);
                    const viewCode = mv.code;
                    return (
                    <div key={d.date} style={{
                      display: "grid", gridTemplateColumns: "82px 32px 1fr auto", alignItems: "center",
                      gap: 10, padding: "9px 0", borderTop: `1px solid ${line}`, fontSize: 13, color: ink,
                    }}>
                      <div>
                        <span style={{ fontWeight: 600 }}>{dayName(d.date)}</span>
                        <span style={{ color: muted, marginLeft: 6, fontSize: 12 }}>{dayDate(d.date)}</span>
                      </div>
                      <div style={{ fontSize: 18 }}>{wmoIcon(viewCode)}</div>
                      <div style={{ color: muted }}>
                        {d.ens?.rainProb != null ? `💧 ${d.ens.rainProb} %` : "—"}
                        <span style={{ marginLeft: 10, fontSize: 11 }}>
                          {d.sources} {d.sources === 1 ? "källa" : "källor"}{d.ens ? " + ensemble" : ""}
                        </span>
                      </div>
                      <div style={{ ...display, fontWeight: 700, whiteSpace: "nowrap" }}>
                        {optimist && d.ens?.tmaxP90 != null
                          ? `upp till ${fmt0(d.ens.tmaxP90)}°`
                          : optimist && d.best?.tmax != null
                            ? `${fmt0(d.best.tmax)}°`
                            : !isConsensus && d.perModel?.[source]?.tmax != null
                              ? `${fmt0(d.perModel[source].tmax)}°`
                              : d.ens?.tmaxP10 != null
                                ? `${fmt0(d.ens.tmaxP10)}–${fmt0(d.ens.tmaxP90)}°`
                                : `${fmt0(d.consensus.tmax)}°`}
                      </div>
                    </div>
                    );
                  })}
                </div>
                <p style={{ fontSize: 12, color: muted, margin: "10px 0 0" }}>
                  {optimist
                    ? "Visar ensemblens soligaste tiondel. Vi säger inte att det stämmer. Vi säger att det är möjligt."
                    : isConsensus
                      ? "Temperaturspannet täcker 80 % av ensemblens körningar. Ju bredare spann, desto osäkrare dag."
                      : `Enligt ${SOURCES.find((s) => s.key === source)?.label} där den räcker, annars ensemblens spann.`}
                </p>
              </section>
            )}

            {/* norrsken + uv */}
            <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
              {isCardVisible("aurora") && (
              <div style={{
                ...card,
                background: "linear-gradient(135deg, #101B31 0%, #16233A 55%, #1E3350 100%)",
                color: "#E8EFF6", border: "none", position: "relative", overflow: "hidden",
              }}>
                <MinBtn k="aurora" light />
                <div style={{
                  position: "absolute", inset: 0, opacity: 0.35, pointerEvents: "none",
                  background: "radial-gradient(60% 45% at 70% 0%, #3DDC9766, transparent 70%), radial-gradient(50% 40% at 20% 10%, #7C5CFF55, transparent 70%)",
                }} />
                <h2 style={{ ...display, fontSize: 16, fontWeight: 700, margin: "0 0 10px", position: "relative" }}>
                  Norrskenschans
                </h2>
                {auroraNights.length ? auroraNights.map((n) => (
                  <div key={n.date} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", position: "relative", fontSize: 13 }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{dayName(n.date)} natt</div>
                      <div style={{ fontSize: 11, opacity: 0.65 }}>
                        Kp {fmt1(n.kp)}{n.cloud != null ? ` · ${fmt0(n.cloud)} % moln` : ""}
                      </div>
                    </div>
                    <div style={{ ...display, fontSize: 20, fontWeight: 700, color: n.chance >= 40 ? "#3DDC97" : n.chance >= 15 ? "#B9C7D9" : "#7688A0" }}>
                      {n.chance} %
                    </div>
                  </div>
                )) : (
                  <p style={{ fontSize: 13, opacity: 0.7, position: "relative", margin: 0 }}>
                    Kp-prognosen kunde inte hämtas just nu.
                  </p>
                )}
                <p style={{ fontSize: 11, opacity: 0.55, marginTop: 8, position: "relative" }}>
                  Kp-index från NOAA vägt mot molntäcke och latitud. Vid hög chans glöder appens natthimmel — håll utkik.
                </p>
              </div>
              )}

              {isCardVisible("uv") && (
              <div style={{ ...card, position: "relative" }}>
                <MinBtn k="uv" />
                <h2 style={{ ...display, fontSize: 16, fontWeight: 700, margin: "0 0 10px" }}>UV-index idag</h2>
                {uvToday != null ? (
                  <>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                      <span style={{ ...display, fontSize: 40, fontWeight: 700, color: uvLevel(uvToday).color }}>
                        {fmt1(uvToday)}
                      </span>
                      <span style={{ fontWeight: 600, color: uvLevel(uvToday).color }}>{uvLevel(uvToday).label}</span>
                    </div>
                    <div style={{ height: 6, borderRadius: 3, background: line, marginTop: 12, overflow: "hidden" }}>
                      <div style={{
                        height: "100%", width: `${clamp((uvToday / 11) * 100, 4, 100)}%`,
                        background: uvLevel(uvToday).color, borderRadius: 3,
                      }} />
                    </div>
                    <p style={{ fontSize: 13, color: muted, marginTop: 10, marginBottom: 0 }}>
                      {uvLevel(uvToday).tip}
                    </p>
                  </>
                ) : <p style={{ fontSize: 13, color: muted }}>Ingen UV-data för platsen.</p>}
              </div>
              )}

              {/* åskrisk */}
              {isCardVisible("thunder") && (
              <div style={{ ...card, position: "relative" }}>
                <MinBtn k="thunder" />
                <h2 style={{ ...display, fontSize: 16, fontWeight: 700, margin: "0 0 10px" }}>Åskrisk</h2>
                {risk?.today ? (
                  <>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                      <span style={{ fontSize: 30 }}>{risk.today.level >= 2 ? "⛈️" : risk.today.level === 1 ? "🌦️" : "🌤️"}</span>
                      <span style={{ ...display, fontSize: 22, fontWeight: 700, color: risk.today.color }}>
                        {risk.today.label}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 4, marginTop: 12 }}>
                      {[1, 2, 3].map((lv) => (
                        <div key={lv} style={{
                          flex: 1, height: 6, borderRadius: 3,
                          background: risk.today.level >= lv ? risk.today.color : line,
                        }} />
                      ))}
                    </div>
                    <p style={{ fontSize: 13, color: muted, marginTop: 10, marginBottom: 0 }}>
                      {risk.today.level === 0
                        ? "Stabil luft idag — inga åskbyar väntas."
                        : `${risk.today.anyCode ? "Åska i prognosen" : "Instabil luft"} idag, störst risk runt kl ${risk.today.peakHour}. `}
                      {risk.tomorrow && risk.tomorrow.level >= 2 && `Imorgon: ${risk.tomorrow.label.toLowerCase()}.`}
                    </p>
                    <p style={{ fontSize: 11, color: muted, marginTop: 6, marginBottom: 0 }}>
                      Bygger på CAPE ({risk.today.maxCape} J/kg) och åskväderkoder — en riskindikator, inte registrerade nedslag.
                    </p>
                  </>
                ) : <p style={{ fontSize: 13, color: muted }}>Ingen åskdata för platsen.</p>}
              </div>
              )}

              {/* månfas */}
              {isCardVisible("moon") && (() => {
                const moon = moonPhase();
                return (
                  <div style={{
                    ...card,
                    background: "linear-gradient(135deg, #14203A 0%, #1B2A47 60%, #24365A 100%)",
                    color: "#E8EFF6", border: "none", position: "relative", overflow: "hidden",
                  }}>
                    <MinBtn k="moon" light />
                    <div style={{
                      position: "absolute", inset: 0, opacity: 0.25, pointerEvents: "none",
                      background: "radial-gradient(45% 40% at 78% 18%, #F5EFD8AA, transparent 70%)",
                    }} />
                    <h2 style={{ ...display, fontSize: 16, fontWeight: 700, margin: "0 0 10px", position: "relative" }}>
                      Månen
                    </h2>
                    <div style={{ display: "flex", alignItems: "center", gap: 14, position: "relative" }}>
                      <span style={{ fontSize: 44, lineHeight: 1 }}>{moon.emoji}</span>
                      <div>
                        <div style={{ ...display, fontSize: 20, fontWeight: 700 }}>{moon.name}</div>
                        <div style={{ fontSize: 13, opacity: 0.75 }}>{moon.illum} % belyst</div>
                      </div>
                    </div>
                    <div style={{ fontSize: 13, marginTop: 12, position: "relative" }}>
                      {moon.daysToFull === 0 ? "Fullmåne inatt 🌕" :
                        moon.daysToNew === 0 ? "Nymåne inatt — mörkast möjliga himmel" :
                        moon.daysToFull < moon.daysToNew
                          ? `Fullmåne om ${moon.daysToFull} ${moon.daysToFull === 1 ? "dag" : "dagar"}`
                          : `Nymåne om ${moon.daysToNew} ${moon.daysToNew === 1 ? "dag" : "dagar"}`}
                    </div>
                    <p style={{ fontSize: 11, opacity: 0.55, marginTop: 8, marginBottom: 0, position: "relative" }}>
                      {moon.illum >= 70
                        ? "Ljus måne bleker svagt norrsken — starka utbrott syns ändå."
                        : moon.illum <= 20
                          ? "Mörk himmel — bästa läget för norrsken och stjärnor."
                          : "Månljuset stör stjärn- och norrskensspaning måttligt just nu."}
                    </p>
                  </div>
                );
              })()}

              {/* luftkvalitet & pollen */}
              {isCardVisible("air") && (
              <div style={{ ...card, position: "relative" }}>
                <MinBtn k="air" />
                <h2 style={{ ...display, fontSize: 16, fontWeight: 700, margin: "0 0 10px" }}>Luft & pollen</h2>
                {air ? (
                  <>
                    {air.aqi != null && (
                      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                        <span style={{ ...display, fontSize: 30, fontWeight: 700, color: aqiLevel(air.aqi).color }}>
                          {fmt0(air.aqi)}
                        </span>
                        <span style={{ fontWeight: 600, color: aqiLevel(air.aqi).color }}>{aqiLevel(air.aqi).label}</span>
                        <span style={{ fontSize: 11, color: muted }}>europeiskt luftindex</span>
                      </div>
                    )}
                    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 5 }}>
                      {POLLEN_SPECIES.map((sp) => {
                        const lv = pollenLevel(air.pollen?.[sp.key]);
                        if (!lv) return null;
                        return (
                          <div key={sp.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                            <span style={{ width: 70 }}>{sp.name}</span>
                            <div style={{ display: "flex", gap: 3, flex: 1, maxWidth: 90 }}>
                              {[1, 2, 3].map((n) => (
                                <div key={n} style={{
                                  flex: 1, height: 5, borderRadius: 3,
                                  background: lv.level >= n ? lv.color : line,
                                }} />
                              ))}
                            </div>
                            <span style={{ fontSize: 12, color: lv.level >= 2 ? lv.color : muted, fontWeight: lv.level >= 2 ? 600 : 400 }}>
                              {lv.label}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <p style={{ fontSize: 11, color: muted, marginTop: 10, marginBottom: 0 }}>
                      Pollen: dagens toppnivå (CAMS Europa). Grova nivåer — känsliga kan reagera även på Låg.
                    </p>
                  </>
                ) : <p style={{ fontSize: 13, color: muted, margin: 0 }}>Hämtar luftdata …</p>}
              </div>
              )}
            </section>

            {/* soltimmar per månad, 10 års historik */}
            {isCardVisible("sun") && (
            <section style={{ ...card, marginTop: 12, position: "relative" }}>
              <MinBtn k="sun" />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 12, paddingRight: 30 }}>
                <h2 style={{ ...display, fontSize: 16, fontWeight: 700, margin: 0 }}>Soltimmar per år</h2>
                <select
                  value={sunMonth}
                  onChange={(e) => setSunMonth(Number(e.target.value))}
                  aria-label="Välj månad"
                  style={{
                    padding: "6px 12px", borderRadius: 10, border: `1px solid ${line}`,
                    fontSize: 14, background: "rgba(255,255,255,0.92)", color: ink, cursor: "pointer", ...font,
                  }}>
                  {MONTH_NAMES.map((m, i) => <option key={i} value={i}>{m}</option>)}
                </select>
              </div>
              {sunStats ? (
                <>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 14, fontSize: 13 }}>
                    <div>
                      <div style={{ color: muted, fontSize: 12 }}>Snitt {MONTH_NAMES[sunMonth].toLowerCase()}</div>
                      <div style={{ ...display, fontSize: 22, fontWeight: 700 }}>{fmt0(sunStats.avg)} h</div>
                    </div>
                    <div>
                      <div style={{ color: muted, fontSize: 12 }}>Soligast 🔆</div>
                      <div style={{ ...display, fontSize: 22, fontWeight: 700, color: "#D98E23" }}>
                        {sunStats.sunniest.hours} h <span style={{ fontSize: 13, color: muted, fontWeight: 400 }}>{sunStats.sunniest.year}</span>
                      </div>
                    </div>
                    <div>
                      <div style={{ color: muted, fontSize: 12 }}>Mulnast ☁️</div>
                      <div style={{ ...display, fontSize: 22, fontWeight: 700, color: "#5B7089" }}>
                        {sunStats.dullest.hours} h <span style={{ fontSize: 13, color: muted, fontWeight: 400 }}>{sunStats.dullest.year}</span>
                      </div>
                    </div>
                  </div>
                  {sunStats.list.map((y) => {
                    const pct = clamp((y.hours / sunStats.max) * 100, 2, 100);
                    const isMax = y.year === sunStats.sunniest.year;
                    const isMin = y.year === sunStats.dullest.year;
                    return (
                      <div key={y.year} style={{ display: "flex", alignItems: "center", gap: 10, padding: "3px 0", fontSize: 13 }}>
                        <span style={{ width: 34, color: muted, fontVariantNumeric: "tabular-nums" }}>{y.year}</span>
                        <div style={{ flex: 1, height: 14, background: line, borderRadius: 4, overflow: "hidden" }}>
                          <div style={{
                            height: "100%", width: `${pct}%`, borderRadius: 4,
                            background: isMax
                              ? "linear-gradient(90deg, #F0A93C, #F5C869)"
                              : isMin ? "#9DB0C4" : "#C9A94E",
                          }} />
                        </div>
                        <span style={{ ...display, width: 46, textAlign: "right", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                          {y.hours} h
                        </span>
                      </div>
                    );
                  })}
                  <p style={{ fontSize: 11, color: muted, marginTop: 10, marginBottom: 0 }}>
                    Beräknade soltimmar (ERA5), summerade per månad. Modelldata — kan skilja något från officiella stationsmätningar.
                  </p>
                </>
              ) : (
                <p style={{ fontSize: 13, color: muted, margin: 0 }}>
                  {sunHistory === null ? "Hämtar solhistorik …" : "Ingen solhistorik för platsen."}
                </p>
              )}
            </section>
            )}

            {/* dolda kort som chips */}
            {hiddenCards.length > 0 && (
              <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12, color: T.pageMuted }}>
                <span>Dolda:</span>
                {hiddenCards.map((k) => (
                  <button key={k} onClick={() => setCardPref(k, "shown")}
                    title={`Visa ${CARD_LABELS[k]}`}
                    style={{
                      padding: "5px 12px", borderRadius: 999, fontSize: 12, cursor: "pointer", ...font,
                      border: "1px solid rgba(255,255,255,0.45)", background: "rgba(255,255,255,0.30)",
                      color: T.pageInk,
                    }}>
                    {CARD_LABELS[k]} +
                  </button>
                ))}
              </div>
            )}

            <footer style={{ marginTop: 20, fontSize: 11, color: T.pageMuted, textAlign: "center", position: "relative" }}>
              Data: Open-Meteo (ECMWF · GFS · ICON · MET Norway + ensemble + ERA5-arkiv) · SMHI öppna data · NOAA SWPC.
              Normaler är modellbaserad återanalys, inte stationsmätningar. Ingen prognos är ett löfte.
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
