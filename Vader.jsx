import { useState, useEffect, useRef, useMemo } from "react";

/*
  FJÄLLVÄDER v2 — flerkälls-väderapp
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

const UV_LEVELS = [
  { max: 2.5, label: "Låg", color: "#4C9F70", tip: "Ingen skyddsåtgärd behövs." },
  { max: 5.5, label: "Måttlig", color: "#D98E23", tip: "Solglasögon och kräm om du är ute länge." },
  { max: 7.5, label: "Hög", color: "#E2703A", tip: "Sök skugga mitt på dagen, använd solkräm." },
  { max: 10.5, label: "Mycket hög", color: "#C74B50", tip: "Undvik sol 11–15, täck huden." },
  { max: 99, label: "Extrem", color: "#8E3B60", tip: "Håll dig inomhus mitt på dagen." },
];
const uvLevel = (v) => UV_LEVELS.find((l) => v <= l.max) || UV_LEVELS[0];

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
    `&daily=uv_index_max,sunrise,sunset&hourly=cloud_cover&timezone=auto&forecast_days=7`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("Open-Meteo svarade inte");
  return r.json();
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

// Normaler: samma datum senaste 10 åren (ERA5-återanalys), cachas 30 dagar
async function fetchNormals(lat, lon) {
  const key = `fjallvader_normals_${lat.toFixed(1)}_${lon.toFixed(1)}`;
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
  const acc = {}; // "MM-DD" -> { hi: [], lo: [] }
  (j.daily?.time || []).forEach((t, i) => {
    const k = mmdd(t);
    const hi = j.daily.temperature_2m_max[i];
    const lo = j.daily.temperature_2m_min[i];
    if (hi == null) return;
    (acc[k] ||= { hi: [], lo: [] });
    acc[k].hi.push(hi);
    if (lo != null) acc[k].lo.push(lo);
  });
  const data = {};
  for (const [k, v] of Object.entries(acc)) {
    data[k] = { tmax: mean(v.hi), tmin: mean(v.lo) };
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

// ---------- SVG: samstämmighetsband ----------

function BandChart({ days, ink, muted }) {
  const W = 700, H = 200, PAD = 34;
  const pts = days.map((d) => {
    const highs = Object.values(d.perModel).map((m) => m.tmax).filter((v) => v != null);
    const lows = Object.values(d.perModel).map((m) => m.tmin).filter((v) => v != null);
    // väv in ensemblespannet så bandet är ärligt även bortom modellernas horisont
    if (d.ens?.tmaxP10 != null) { highs.push(d.ens.tmaxP90); lows.push(d.ens.tmaxP10); }
    return {
      hi: highs.length ? Math.max(...highs) : null,
      lo: lows.length ? Math.min(...lows) : null,
      cHi: d.consensus.tmax ?? d.ens?.tmaxP50 ?? null,
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
      setEnsemble(null); setNormals(null);
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
      const s = fineScore(d.consensus);
      if (s > best) { best = s; idx = i; }
    });
    return idx;
  }, [nearDays]);

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

  const uvToday = std?.daily?.uv_index_max?.[0];

  function pickPlace(p) {
    setPlace(p); setQuery(""); setSuggestions([]); setShowSug(false);
  }
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
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ ...display, fontSize: 26, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
              Fjällväder
            </h1>
            <p style={{ margin: "2px 0 0", fontSize: 13, color: T.pageMuted }}>
              Fem prognoskällor. En sanning. Ungefär.
            </p>
          </div>
          <div style={{ position: "relative", flex: "1 1 240px", maxWidth: 320 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => suggestions.length && setShowSug(true)}
                placeholder="Sök ort …"
                aria-label="Sök ort"
                style={{
                  flex: 1, padding: "10px 14px", borderRadius: 12, border: `1px solid ${line}`,
                  fontSize: 14, outline: "none", background: "rgba(255,255,255,0.92)", color: ink, ...font,
                }}
              />
              <button onClick={useMyPosition} title="Använd min position" aria-label="Använd min position"
                style={{
                  padding: "10px 12px", borderRadius: 12, border: `1px solid ${line}`,
                  background: "rgba(255,255,255,0.92)", cursor: "pointer", fontSize: 16,
                }}>📍</button>
            </div>
            {showSug && suggestions.length > 0 && (
              <ul style={{
                position: "absolute", top: "110%", left: 0, right: 0, zIndex: 10,
                background: "#fff", border: `1px solid ${line}`, borderRadius: 12,
                listStyle: "none", margin: 0, padding: 6, boxShadow: "0 8px 24px rgba(22,35,58,0.16)",
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
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 13, color: muted, marginBottom: 2 }}>
                    {place.name}{place.admin ? ` · ${place.admin}` : ""}
                  </div>
                  {optimist && heroOptimist ? (
                    <>
                      <div style={{ ...display, fontSize: 54, fontWeight: 700, lineHeight: 1 }}>
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
                      <div style={{ ...display, fontSize: 54, fontWeight: 700, lineHeight: 1 }}>
                        {fmt0(cur.temperature_2m)}°
                      </div>
                      <div style={{ fontSize: 15, marginTop: 6 }}>
                        {wmoIcon(cur.weather_code)} {wmoLabel(cur.weather_code)} · känns som {fmt0(cur.apparent_temperature)}°
                      </div>
                      <div style={{ fontSize: 13, color: muted, marginTop: 4 }}>
                        Vind {fmt0(cur.wind_speed_10m / 3.6)} m/s · molntäcke {fmt0(cur.cloud_cover)} %
                      </div>
                      {todayDelta != null && Math.abs(todayDelta) >= 0.5 && (
                        <div style={{ fontSize: 13, marginTop: 6, fontWeight: 500, color: todayDelta > 0 ? "#B4552D" : "#2D6FB4" }}>
                          {Math.abs(fmt1(todayDelta))}° {todayDelta > 0 ? "varmare" : "kallare"} än normalt för den {dayDate(days[0].date)}
                          <span style={{ color: muted, fontWeight: 400 }}> (snitt senaste 10 åren)</span>
                        </div>
                      )}
                    </>
                  ) : null}
                </div>
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
              {heroDay?.agreement && !optimist && (
                <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: heroDay.agreement.color, display: "inline-block" }} />
                  <span style={{ color: muted }}>{heroDay.agreement.label} mellan källorna idag</span>
                  {heroDay.ens?.rainProb != null && (
                    <span style={{ color: muted }}>· 💧 {heroDay.ens.rainProb} % regnchans</span>
                  )}
                </div>
              )}
            </section>

            {/* band 16 dagar */}
            <section style={{ ...card, marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6, flexWrap: "wrap", gap: 4 }}>
                <h2 style={{ ...display, fontSize: 16, fontWeight: 700, margin: 0 }}>16 dagar enligt alla källor</h2>
                <span style={{ fontSize: 12, color: muted }}>bandet = källornas + ensemblens spridning</span>
              </div>
              <BandChart days={days} ink={ink} muted={muted} />
            </section>

            {/* dagkort 1–7 */}
            <section style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
              {nearDays.map((d, i) => (
                <div key={d.date} style={{ ...card, padding: 0, overflow: "hidden" }}>
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
                    <div style={{ fontSize: 22 }}>{wmoIcon(d.consensus.code)}</div>
                    <div style={{ fontSize: 13, color: muted }}>
                      {wmoLabel(d.consensus.code)}
                      {d.ens?.rainProb != null && d.ens.rainProb >= 20 && (
                        <span style={{ marginLeft: 6 }}>💧 {d.ens.rainProb} %</span>
                      )}
                      {i === bestDayIdx && (
                        <span style={{
                          marginLeft: 8, fontSize: 11, fontWeight: 600, color: "#0B6E4F",
                          background: "rgba(61,220,151,0.18)", padding: "2px 8px", borderRadius: 999,
                        }}>Veckans finaste ✨</span>
                      )}
                    </div>
                    {d.agreement && (
                      <span title={d.agreement.label} style={{
                        fontSize: 11, color: d.agreement.color, fontWeight: 600, whiteSpace: "nowrap",
                      }}>{d.agreement.short}</span>
                    )}
                    <div style={{ ...display, fontSize: 15, fontWeight: 700, whiteSpace: "nowrap" }}>
                      {fmt0(d.consensus.tmax)}° <span style={{ color: muted, fontWeight: 400 }}>/ {fmt0(d.consensus.tmin)}°</span>
                    </div>
                  </button>
                  {openDay === i && (
                    <div style={{ borderTop: `1px solid ${line}`, padding: "12px 18px 16px", fontSize: 13 }}>
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
              ))}
            </section>

            {/* dag 8–16: lutning, inte löfte */}
            {farDays.length > 0 && (
              <section style={{ ...card, marginBottom: 16, padding: "18px 22px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, flexWrap: "wrap", gap: 4 }}>
                  <h2 style={{ ...display, fontSize: 16, fontWeight: 700, margin: 0 }}>Längre fram</h2>
                  <span style={{ fontSize: 12, color: muted }}>spann och sannolikhet — inte exakta löften</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {farDays.map((d) => (
                    <div key={d.date} style={{
                      display: "grid", gridTemplateColumns: "82px 32px 1fr auto", alignItems: "center",
                      gap: 10, padding: "9px 0", borderTop: `1px solid ${line}`, fontSize: 13, color: ink,
                    }}>
                      <div>
                        <span style={{ fontWeight: 600 }}>{dayName(d.date)}</span>
                        <span style={{ color: muted, marginLeft: 6, fontSize: 12 }}>{dayDate(d.date)}</span>
                      </div>
                      <div style={{ fontSize: 18 }}>{wmoIcon(d.consensus.code)}</div>
                      <div style={{ color: muted }}>
                        {d.ens?.rainProb != null ? `💧 ${d.ens.rainProb} %` : "—"}
                        <span style={{ marginLeft: 10, fontSize: 11 }}>
                          {d.sources} {d.sources === 1 ? "källa" : "källor"}{d.ens ? " + ensemble" : ""}
                        </span>
                      </div>
                      <div style={{ ...display, fontWeight: 700, whiteSpace: "nowrap" }}>
                        {d.ens?.tmaxP10 != null
                          ? `${fmt0(d.ens.tmaxP10)}–${fmt0(d.ens.tmaxP90)}°`
                          : `${fmt0(d.consensus.tmax)}°`}
                      </div>
                    </div>
                  ))}
                </div>
                <p style={{ fontSize: 12, color: muted, margin: "10px 0 0" }}>
                  Temperaturspannet täcker 80 % av ensemblens körningar. Ju bredare spann, desto osäkrare dag.
                </p>
              </section>
            )}

            {/* norrsken + uv */}
            <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
              <div style={{
                ...card,
                background: "linear-gradient(135deg, #101B31 0%, #16233A 55%, #1E3350 100%)",
                color: "#E8EFF6", border: "none", position: "relative", overflow: "hidden",
              }}>
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

              <div style={card}>
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
            </section>

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
