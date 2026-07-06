// Netlify serverless function: hämtar SMHI-prognos server-side.
// På servern finns ingen CORS-spärr, så vi hämtar där och skickar vidare
// till appen med rätt headers. Anropas som /api/smhi?lat=..&lon=..
export default async (req) => {
  const url = new URL(req.url);
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return new Response(JSON.stringify({ error: "lat och lon krävs" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const smhiUrl =
    `https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point/` +
    `lon/${lon.toFixed(4)}/lat/${lat.toFixed(4)}/data.json`;

  try {
    const r = await fetch(smhiUrl, {
      headers: { "User-Agent": "Vaderlek/1.0 (vaderapp)" },
    });

    if (r.status === 404) {
      // SMHI svarar 404 för punkter utanför sitt täckningsområde
      return new Response(JSON.stringify({ error: "out_of_area" }), {
        status: 404,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }
    if (!r.ok) {
      return new Response(JSON.stringify({ error: "smhi_error", status: r.status }), {
        status: 502,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }

    const data = await r.text();
    return new Response(data, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        // cacha 30 min på Netlifys kant så vi inte spammar SMHI
        "cache-control": "public, max-age=1800",
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "fetch_failed" }), {
      status: 502,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  }
};

export const config = { path: "/api/smhi" };
