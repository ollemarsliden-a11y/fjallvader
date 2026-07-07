import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

/*
  Kartvy för Väderlek — helskärm.
  • Grundkarta: OpenFreeMap (gratis, keyless, öppen vektorstil)
  • Regnradar: RainViewer (gratis, keyless) som animerat rasterlager
  Props: place {name, lat, lon}, onClose()
*/

const OPENFREEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";
const RAINVIEWER_API = "https://api.rainviewer.com/public/weather-maps.json";

export default function MapView({ place, onClose }) {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const [frames, setFrames] = useState([]); // {time, path, kind}
  const [frameIdx, setFrameIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [ready, setReady] = useState(false);
  const [radarHost, setRadarHost] = useState("");
  const playTimer = useRef(null);

  // initiera kartan en gång
  useEffect(() => {
    if (mapRef.current || !mapContainer.current) return;
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: OPENFREEMAP_STYLE,
      center: [place.lon, place.lat],
      zoom: 6,
      attributionControl: true,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    // markör för vald plats
    new maplibregl.Marker({ color: "#16233A" })
      .setLngLat([place.lon, place.lat])
      .setPopup(new maplibregl.Popup({ offset: 24 }).setText(place.name || "Vald plats"))
      .addTo(map);

    map.on("load", () => setReady(true));
    mapRef.current = map;

    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // hämta radarramar från RainViewer
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const r = await fetch(RAINVIEWER_API);
        const j = await r.json();
        if (cancel) return;
        setRadarHost(j.host);
        const past = (j.radar?.past || []).map((f) => ({ ...f, kind: "past" }));
        const now = (j.radar?.nowcast || []).map((f) => ({ ...f, kind: "forecast" }));
        const all = [...past, ...now];
        setFrames(all);
        setFrameIdx(past.length > 0 ? past.length - 1 : 0); // börja på "nu"
      } catch {
        if (!cancel) setFrames([]);
      }
    })();
    return () => { cancel = true; };
  }, []);

  // lägg till/uppdatera radarlager när ramen ändras
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !frames.length || !radarHost) return;
    const frame = frames[frameIdx];
    if (!frame) return;

    const srcId = "rainviewer";
    const layerId = "rainviewer-layer";
    // 512 = tile-storlek, 4 = färgschema (universal blå→röd), 1 = utjämning, 1 = snö
    const tileUrl = `${radarHost}${frame.path}/512/{z}/{x}/{y}/4/1_1.png`;

    if (map.getSource(srcId)) {
      // uppdatera befintlig källa genom att byta ut den
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      map.removeSource(srcId);
    }
    map.addSource(srcId, { type: "raster", tiles: [tileUrl], tileSize: 512 });
    map.addLayer({
      id: layerId, type: "raster", source: srcId,
      paint: { "raster-opacity": 0.7 },
    });
  }, [frames, frameIdx, ready, radarHost]);

  // uppspelning
  useEffect(() => {
    if (!playing || !frames.length) return;
    playTimer.current = setInterval(() => {
      setFrameIdx((i) => (i + 1) % frames.length);
    }, 700);
    return () => clearInterval(playTimer.current);
  }, [playing, frames]);

  const frame = frames[frameIdx];
  const frameTime = frame ? new Date(frame.time * 1000).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" }) : "";
  const isForecast = frame?.kind === "forecast";

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000, background: "#EEF3F7",
      display: "flex", flexDirection: "column",
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      {/* topplist */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 16px", background: "#16233A", color: "#fff", flexShrink: 0,
      }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Regnradar</div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>{place.name}</div>
        </div>
        <button onClick={onClose} aria-label="Stäng karta" style={{
          border: "none", background: "rgba(255,255,255,0.15)", color: "#fff",
          borderRadius: 10, width: 38, height: 38, cursor: "pointer", fontSize: 20,
        }}>✕</button>
      </div>

      {/* karta */}
      <div style={{ flex: 1, position: "relative" }}>
        <div ref={mapContainer} style={{ position: "absolute", inset: 0 }} />
      </div>

      {/* uppspelningskontroll */}
      <div style={{
        display: "flex", alignItems: "center", gap: 14, padding: "12px 16px",
        background: "#fff", borderTop: "1px solid #DCE5EC", flexShrink: 0,
      }}>
        <button onClick={() => setPlaying(!playing)} aria-label={playing ? "Pausa" : "Spela"} style={{
          border: "none", background: "#16233A", color: "#fff", borderRadius: "50%",
          width: 42, height: 42, cursor: "pointer", fontSize: 16, flexShrink: 0,
        }}>{playing ? "❚❚" : "▶"}</button>
        <div style={{ flex: 1 }}>
          <input type="range" min={0} max={Math.max(0, frames.length - 1)} value={frameIdx}
            onChange={(e) => { setPlaying(false); setFrameIdx(Number(e.target.value)); }}
            style={{ width: "100%" }} aria-label="Tidslinje" />
          <div style={{ fontSize: 12, color: "#5B7089", marginTop: 2 }}>
            {frameTime} {isForecast ? "· prognos" : "· uppmätt"}
          </div>
        </div>
      </div>
    </div>
  );
}
