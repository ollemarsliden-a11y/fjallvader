import { useState, useEffect, useRef, useMemo } from "react";

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
    `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,cloud_cover,is_day` +
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
  const url = `https://opendata-download-metfcst.smhi.se/api/category/pmp3g/version/2/geotype/point/lon/${lon.toFixed(4)}/lat/${lat.toFixed(4)}/data.json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("utanför SMHI:s område");
  const j = await r.json();
  const days = {};
  let prev = null;
  for (const ts of j.timeSeries) {
    const key = dateKey(ts.validTime);
    const p = Object.fromEntries(ts.parameters.map((x) => [x.name, x.values[0]]));
    if (!days[key]) days[key] = { temps: [], precip: 0, winds: [], codes: [] };
    const stepH = prev ? clamp((new Date(ts.validTime) - prev) / 3600000, 1, 12) : 1;
    prev = new Date(ts.validTime);
    if (p.t != null) days[key].temps.push(p.t);
    if (p.pmean != null) days[key].precip += p.pmean * stepH;
    if (p.ws != null) days[key].winds.push(p.ws);
    if (p.Wsymb2 != null) days[key].codes.push(p.Wsymb2);
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

    let best = null;
    for (const [k, v] of Object.entries(perModel)) {
      const s = fineScore(v);
      if (!best || s > best.score) best = { key: k, score: s, ...v };
    }
    const ens = ensemble?.[date] || null;
    return {
      date, perModel, consensus, best, ens,
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

function BandChart({ days, ink, muted, optimist }) {
  const W = 700, H = 200, PAD = 34;
  const pts = days.map((d) => {
    const highs = Object.values(d.perModel).map((m) => m.tmax).filter((v) => v != null);
    const lows = Object.values(d.perModel).map((m) => m.tmin).filter((v) => v != null);
    // väv in ensemblespannet så bandet är ärligt även bortom modellernas horisont
    if (d.ens?.tmaxP10 != null) { highs.push(d.ens.tmaxP90); lows.push(d.ens.tmaxP10); }
    const hi = highs.length ? Math.max(...highs) : null;
    const lo = lows.length ? Math.min(...lows) : null;
    return {
      hi, lo,
      // optimisten surfar på bandets överkant
      cHi: optimist ? hi : (d.consensus.tmax ?? d.ens?.tmaxP50 ?? null),
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

  const COL = 48, CURVE_H = 42;
  const temps = rows.map((r) => r.t).filter((v) => v != null);
  const tMin = Math.min(...temps), tMax = Math.max(...temps);
  const y = (v) => 6 + (CURVE_H - 16) * (1 - (v - tMin) / (tMax - tMin || 1));
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
            // regnchans-toning: ljus vid uppehåll, blågrå ton när körningarna spretar mot regn
            const tint = prob != null ? Math.min(prob / 100, 1) * 0.22 : 0;
            return (
              <div key={i} style={{
                width: COL, textAlign: "center", padding: "5px 2px 7px",
                background: tint > 0.02 ? `rgba(45,111,180,${tint})` : "transparent",
                borderRadius: 8,
              }}>
                <div style={{ fontSize: 10, color: muted }}>
                  {r.newDay && i > 0 ? dayDate(std.hourly.time[r.i].slice(0, 10)) + " " : ""}
                  {String(r.hour).padStart(2, "0")}{r.block ? "–" + String((r.hour + 3) % 24).padStart(2, "0") : ""}
                </div>
                <div style={{ fontSize: 15, lineHeight: "20px" }}>{wmoIcon(h.weather_code?.[r.i])}</div>
                <div style={{ ...display, fontSize: 13, fontWeight: 700, color: ink }}>{fmt0(r.t)}°</div>
                <div style={{ fontSize: 9.5, color: "#2D6FB4", minHeight: 12, fontWeight: prob >= 50 ? 600 : 400 }}>
                  {prob != null && prob >= 20 ? `${prob} %` : ""}
                </div>
                <div style={{ fontSize: 9.5, color: muted, minHeight: 11 }}>
                  {mm >= 0.1 ? `${fmt1(mm)} mm` : ""}
                </div>
                <div style={{ fontSize: 9.5, color: muted }}>
                  {h.wind_speed_10m?.[r.i] != null ? `${fmt0(h.wind_speed_10m[r.i] / 3.6)} m/s` : ""}
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
  const [place, setPlace] = useState(DEFAULT_PLACE);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [showSug, setShowSug] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [multi, setMulti] = useState(null);
  const [std, setStd] = useState(null);
  const [smhi, setSmhi] = useState(null);
  const [smhiErr, setSmhiErr] = useState(false);
  const [ensemble, setEnsemble] = useState(null);
  const [normals, setNormals] = useState(null);
  const [kp, setKp] = useState(null);
  const [optimist, setOptimist] = useState(false);
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
      setLoading(true); setErr(null); setSmhiErr(false);
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
        .then((d) => !cancel && setSmhi(d))
        .catch(() => { if (!cancel) { setSmhi(null); setSmhiErr(true); } });
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

  const bestDayIdx = useMemo(() => {
    let idx = -1, best = -Infinity;
    nearDays.forEach((d, i) => {
      const s = fineScore(optimist && d.best ? d.best : d.consensus);
      if (s > best) { best = s; idx = i; }
    });
    return idx;
  }, [nearDays, optimist]);

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

  // tema utifrån aktuellt väder (Optimistläget tvingar solsken)
  const cur = std?.current;
  const tKey = optimist ? "clearDay" : themeKey(cur?.weather_code, cur ? cur.is_day === 1 : true);
  const T = THEMES[tKey];
  const auroraTonight = !optimist && T.dark && (auroraNights[0]?.chance ?? 0) >= 40;

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
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setPlace({ name: "Min position", admin: "", lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => setErr("Kunde inte hämta din position. Sök på ort istället."),
      { timeout: 8000 }
    );
  }

  const heroDay = days[0];
  const heroOptimist = heroDay?.best;

  const ink = "#16233A", muted = "#5B7089", line = "#DCE5EC";
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
      `}</style>

      <Fjall colors={T.fjall} />
      <Particles kind={T.particles} wind={cur?.wind_speed_10m ?? 0} reduce={reduceMotion} />
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
          <p style={{ margin: "3px 0 16px", fontSize: 13, color: T.pageMuted, letterSpacing: "0.01em" }}>
            Fem prognoskällor. En sanning. Ungefär.
          </p>
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
            <button onClick={useMyPosition} title="Använd min position" aria-label="Använd min position"
              style={{
                position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
                width: 34, height: 34, borderRadius: 10, border: "none",
                background: "transparent", cursor: "pointer", color: muted,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
              <IconLocate />
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
        </header>

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
            {/* hero */}
            <section style={{ ...card, marginBottom: 16 }}>
              {/* nivå 1: plats + nuläge */}
              <div style={{ fontSize: 13, color: muted, marginBottom: 2, display: "flex", alignItems: "center", gap: 6 }}>
                {place.name}{place.admin ? ` · ${place.admin}` : ""}
                <button onClick={toggleFav} title={isFav ? "Ta bort favorit" : "Spara som favorit"}
                  aria-label={isFav ? "Ta bort favorit" : "Spara som favorit"}
                  style={{
                    border: "none", background: "transparent", cursor: "pointer", padding: 2,
                    lineHeight: 0, color: muted, display: "inline-flex",
                  }}>
                  <IconStar filled={isFav} />
                </button>
              </div>
              {optimist && heroOptimist ? (
                <>
                  <div style={{ ...display, fontSize: 56, fontWeight: 700, lineHeight: 1 }}>
                    {fmt0(heroOptimist.tmax)}°
                  </div>
                  <div style={{ fontSize: 15, marginTop: 6 }}>
                    {wmoIcon(heroOptimist.code)} {wmoLabel(heroOptimist.code)} — enligt <strong>{modelName(heroOptimist.key)}</strong>, dagens gladaste modell
                  </div>
                  <div style={{ fontSize: 13, color: muted, marginTop: 4 }}>
                    Vi säger inte att det stämmer. Vi säger att det är möjligt. ☀️
                  </div>
                </>
              ) : cur ? (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                    <div style={{ ...display, fontSize: 56, fontWeight: 700, lineHeight: 1 }}>
                      {fmt0(cur.temperature_2m)}°
                    </div>
                    <div style={{ fontSize: 15 }}>
                      <span style={{ fontSize: 22, marginRight: 6 }}>{wmoIcon(cur.weather_code)}</span>
                      {wmoLabel(cur.weather_code)}
                      <div style={{ fontSize: 13, color: muted }}>känns som {fmt0(cur.apparent_temperature)}°</div>
                    </div>
                  </div>

                  {/* nivå 2: mätarrutor */}
                  <div style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                    gap: 8, marginTop: 16,
                  }}>
                    <div style={{ background: "rgba(22,35,58,0.04)", borderRadius: 12, padding: "9px 12px" }}>
                      <div style={{ fontSize: 10, color: muted, textTransform: "uppercase", letterSpacing: "0.07em" }}>Vind</div>
                      <div style={{ ...display, fontSize: 16, fontWeight: 700 }}>{fmt0(cur.wind_speed_10m / 3.6)} m/s</div>
                    </div>
                    <div style={{ background: "rgba(22,35,58,0.04)", borderRadius: 12, padding: "9px 12px" }}>
                      <div style={{ fontSize: 10, color: muted, textTransform: "uppercase", letterSpacing: "0.07em" }}>Molntäcke</div>
                      <div style={{ ...display, fontSize: 16, fontWeight: 700 }}>{fmt0(cur.cloud_cover)} %</div>
                    </div>
                    {dayLight && (
                      <div style={{ background: "rgba(22,35,58,0.04)", borderRadius: 12, padding: "9px 12px" }}>
                        <div style={{ fontSize: 10, color: muted, textTransform: "uppercase", letterSpacing: "0.07em" }}>Dagsljus</div>
                        <div style={{ ...display, fontSize: 16, fontWeight: 700 }}>
                          {dayLight.hours} t {dayLight.mins} min
                          {dayLight.delta != null && dayLight.delta !== 0 && (
                            <span style={{ fontSize: 12, fontWeight: 600, marginLeft: 5, color: dayLight.delta > 0 ? "#3E8E63" : "#2D6FB4" }}>
                              {dayLight.delta > 0 ? "+" : ""}{dayLight.delta}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 11, color: muted }}>{dayLight.rise}–{dayLight.set}</div>
                      </div>
                    )}
                    {todayDelta != null && (
                      <button
                        onClick={() => setShowYears(!showYears)}
                        aria-expanded={showYears}
                        style={{
                          background: "rgba(22,35,58,0.04)", borderRadius: 12, padding: "9px 12px",
                          border: "none", cursor: "pointer", textAlign: "left", ...font,
                        }}>
                        <div style={{ fontSize: 10, color: muted, textTransform: "uppercase", letterSpacing: "0.07em" }}>Mot normalt</div>
                        <div style={{
                          ...display, fontSize: 16, fontWeight: 700,
                          color: Math.abs(todayDelta) < 0.5 ? ink : todayDelta > 0 ? "#B4552D" : "#2D6FB4",
                        }}>
                          {todayDelta > 0 ? "+" : ""}{fmt1(todayDelta)}°
                          <span style={{
                            fontSize: 11, color: muted, marginLeft: 5, display: "inline-block",
                            transform: showYears ? "rotate(180deg)" : "none", transition: "transform .2s",
                          }}>▾</span>
                        </div>
                        <div style={{ fontSize: 11, color: muted }}>år för år</div>
                      </button>
                    )}
                    {snowCm != null && (
                      <div style={{ background: "rgba(22,35,58,0.04)", borderRadius: 12, padding: "9px 12px" }}>
                        <div style={{ fontSize: 10, color: muted, textTransform: "uppercase", letterSpacing: "0.07em" }}>Snödjup</div>
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
                        <span style={{ color: muted }}>
                          {heroDay.agreement.label}
                          {heroDay.ens?.rainProb != null && ` · ${heroDay.ens.rainProb} % regnchans`}
                        </span>
                      </div>
                    ) : <span />}
                    <button
                      onClick={() => {
                        setOpenDay(0);
                        setTimeout(() => document.getElementById("day-0")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
                      }}
                      style={{
                        border: "none", background: "transparent", cursor: "pointer", padding: 0,
                        fontSize: 13, color: "#2D6FB4", fontWeight: 500, ...font,
                      }}>
                      Timme för timme ▾
                    </button>
                  </div>
                </>
              ) : null}
            </section>

            {/* band 16 dagar */}
            <section style={{ ...card, marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
                <h2 style={{ ...display, fontSize: 16, fontWeight: 700, margin: 0 }}>
                  {optimist ? "16 dagar enligt de gladaste källorna" : "16 dagar enligt alla källor"}
                </h2>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}>
                  <span style={{ fontSize: 13, color: muted }}>Optimistläge</span>
                  <button
                    role="switch" aria-checked={optimist}
                    onClick={() => setOptimist(!optimist)}
                    style={{
                      width: 46, height: 26, borderRadius: 13, border: "none", cursor: "pointer",
                      background: optimist ? "linear-gradient(90deg, #F0A93C, #3DDC97)" : line,
                      position: "relative", transition: "background .25s",
                    }}>
                    <span style={{
                      position: "absolute", top: 3, left: optimist ? 23 : 3, width: 20, height: 20,
                      borderRadius: "50%", background: "#fff", transition: "left .25s",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
                    }} />
                  </button>
                </label>
              </div>
              <BandChart days={days} ink={ink} muted={muted} optimist={optimist} />
              <p style={{ fontSize: 11, color: muted, margin: "6px 0 0", textAlign: "center" }}>
                {optimist ? "optimistens linje följer bandets överkant" : "bandet visar källornas och ensemblens spridning"}
              </p>
            </section>

            {/* dagkort 1–7 */}
            <section style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
              {nearDays.map((d, i) => {
                const view = optimist && d.best ? d.best : d.consensus;
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
                        <span style={{ marginLeft: 6, fontSize: 11, color: "#B8860B" }}>enligt {modelName(d.best.key)} ☀️</span>
                      )}
                      {!optimist && d.ens?.rainProb != null && d.ens.rainProb >= 20 && (
                        <span style={{ marginLeft: 6 }}>💧 {d.ens.rainProb} %</span>
                      )}
                      {i === bestDayIdx && (
                        <span style={{
                          marginLeft: 8, fontSize: 11, fontWeight: 600, color: "#0B6E4F",
                          background: "rgba(61,220,151,0.18)", padding: "2px 8px", borderRadius: 999,
                        }}>Veckans finaste ✨</span>
                      )}
                    </div>
                    {!optimist && d.agreement ? (
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
                      <div style={{ fontSize: 11, color: muted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
                        {i <= 1 ? "Timme för timme" : "Var tredje timme"}
                      </div>
                      <HourlyStrip std={std} date={d.date} resolution={i <= 1 ? 1 : 3}
                        extendNext={i === 0} allDates={days.map((x) => x.date)}
                        ink={ink} muted={muted} line={line} display={display} />
                      <div style={{ fontSize: 11, color: muted, textTransform: "uppercase", letterSpacing: "0.05em", margin: "12px 0 4px" }}>
                        Källorna
                      </div>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                          <tr style={{ color: muted, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                            <th style={{ textAlign: "left", padding: "4px 0" }}>Källa</th>
                            <th style={{ textAlign: "right" }}>Max</th>
                            <th style={{ textAlign: "right" }}>Min</th>
                            <th style={{ textAlign: "right" }}>Nederbörd</th>
                            <th style={{ textAlign: "right" }}>Vind</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(d.perModel).map(([k, m]) => (
                            <tr key={k} style={{ borderTop: `1px solid ${line}` }}>
                              <td style={{ padding: "6px 0", fontWeight: d.best?.key === k ? 600 : 400 }}>
                                {modelName(k)}{d.best?.key === k ? " ☀️" : ""}
                              </td>
                              <td style={{ textAlign: "right" }}>{fmt1(m.tmax)}°</td>
                              <td style={{ textAlign: "right" }}>{fmt1(m.tmin)}°</td>
                              <td style={{ textAlign: "right" }}>{fmt1(m.precip)} mm</td>
                              <td style={{ textAlign: "right" }}>{m.wind != null ? fmt0(m.wind / 3.6) + " m/s" : "–"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div style={{ marginTop: 8, color: muted, fontSize: 12, display: "flex", flexDirection: "column", gap: 3 }}>
                        {d.ens && (
                          <span>
                            Ensemble ({d.ens.members} GFS-körningar): maxtemp troligen {fmt0(d.ens.tmaxP10)}–{fmt0(d.ens.tmaxP90)}°
                            {d.ens.rainProb != null ? ` · ${d.ens.rainProb} % av körningarna ger regn` : ""}
                          </span>
                        )}
                        {normals?.[mmdd(d.date)] && (
                          <span>Normalt för den {dayDate(d.date)}: {fmt0(normals[mmdd(d.date)].tmax)}° / {fmt0(normals[mmdd(d.date)].tmin)}°</span>
                        )}
                        <span>☀️ = dagens optimist. {smhiErr && "SMHI saknas för den här platsen (utanför deras täckningsområde)."}</span>
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
                    {optimist ? "så bra kan det bli, om allt vill sig väl" : "spann och sannolikhet — inte exakta löften"}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {farDays.map((d) => {
                    const viewCode = optimist && d.best ? d.best.code : d.consensus.code;
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
                        {optimist
                          ? <span style={{ color: "#B8860B", fontSize: 12 }}>bästa fallet ☀️</span>
                          : (d.ens?.rainProb != null ? `💧 ${d.ens.rainProb} %` : "—")}
                        <span style={{ marginLeft: 10, fontSize: 11 }}>
                          {d.sources} {d.sources === 1 ? "källa" : "källor"}{d.ens ? " + ensemble" : ""}
                        </span>
                      </div>
                      <div style={{ ...display, fontWeight: 700, whiteSpace: "nowrap" }}>
                        {optimist && d.ens?.tmaxP90 != null
                          ? `upp till ${fmt0(d.ens.tmaxP90)}°`
                          : d.ens?.tmaxP10 != null
                            ? `${fmt0(d.ens.tmaxP10)}–${fmt0(d.ens.tmaxP90)}°`
                            : `${fmt0(optimist && d.best ? d.best.tmax : d.consensus.tmax)}°`}
                      </div>
                    </div>
                    );
                  })}
                </div>
                <p style={{ fontSize: 12, color: muted, margin: "10px 0 0" }}>
                  {optimist
                    ? "Visar ensemblens soligaste tiondel. Vi säger inte att det stämmer. Vi säger att det är möjligt."
                    : "Temperaturspannet täcker 80 % av ensemblens körningar. Ju bredare spann, desto osäkrare dag."}
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
