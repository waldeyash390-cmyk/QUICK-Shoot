// Netlify equivalent of the Express /turn-credentials route in server/index.js.
export default async () => {
  const subdomain = Netlify.env.get("METERED_SUBDOMAIN") || "";
  const apiKey = Netlify.env.get("METERED_API_KEY") || "";
  if (!subdomain || !apiKey) {
    return Response.json({ error: "Metered TURN not configured" }, { status: 503 });
  }
  try {
    const url = `https://${subdomain}.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) {
      console.error("[TURN] Metered API error:", response.status);
      return Response.json({ error: "Failed to fetch TURN credentials from Metered" }, { status: 502 });
    }
    return Response.json(await response.json());
  } catch (err) {
    console.error("[TURN] Failed to fetch Metered credentials:", err.message);
    return Response.json({ error: "Failed to fetch TURN credentials" }, { status: 502 });
  }
};

export const config = { path: "/turn-credentials" };
