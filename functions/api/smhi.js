// Cloudflare Pages Function: hämtar SMHI-prognos server-side.
// Filens sökväg (functions/api/smhi.js) ger automatiskt URL:en /api/smhi.
// På servern finns ingen CORS-spärr, så vi hämtar där och skickar vidare.
export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));

  const json = (body, status) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return json({ error: "lat och lon krävs" }, 400);
  }

  const smhiUrl =
    `https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point/` +
    `lon/${lon.toFixed(4)}/lat/${lat.toFixed(4)}/data.json`;

  try {
    const r = await fetch(smhiUrl, {
      headers: { "User-Agent": "Vaderlek/1.0 (vaderapp)" },
      // Cloudflare cachar svaret på kanten i 30 min
      cf: { cacheTtl: 1800, cacheEverything: true },
    });

    if (r.status === 404) {
      return json({ error: "out_of_area" }, 404); // utanför SMHI:s område
    }
    if (!r.ok) {
      return json({ error: "smhi_error", status: r.status }, 502);
    }

    const data = await r.text();
    return new Response(data, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=1800",
      },
    });
  } catch (e) {
    return json({ error: "fetch_failed" }, 502);
  }
}
