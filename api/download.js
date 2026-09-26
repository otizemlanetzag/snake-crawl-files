const WINDOW_SECONDS = 5 * 60;
const MAX_REQUESTS_PER_WINDOW = 1;
const memory = globalThis.__snakeDownloadRateLimit || new Map();
globalThis.__snakeDownloadRateLimit = memory;

function getClientId(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = forwarded ? forwarded.split(",")[0].trim() : (req.headers["x-real-ip"] || "unknown");
  return ip.slice(0, 128);
}

async function redisCommand(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  if (!response.ok) throw new Error("Redis request failed");
  return response.json();
}

async function checkRateLimit(id) {
  const key = `snake-crawl-download:${id}`;

  try {
    const existing = await redisCommand(["GET", key]);
    if (existing?.result) {
      const retryAfter = Math.max(
        1,
        Number(existing.result) - Math.floor(Date.now() / 1000)
      );
      return { allowed: false, retryAfter };
    }

    const retryAt = Math.floor(Date.now() / 1000) + WINDOW_SECONDS;
    await redisCommand(["SET", key, String(retryAt), "EX", WINDOW_SECONDS]);
    return { allowed: true, retryAfter: 0 };
  } catch {
    // Safe fallback when the optional shared Redis store is unavailable.
  }

  const now = Date.now();
  const previous = memory.get(id);

  if (previous && now - previous < WINDOW_SECONDS * 1000) {
    return {
      allowed: false,
      retryAfter: Math.ceil((WINDOW_SECONDS * 1000 - (now - previous)) / 1000)
    };
  }

  memory.set(id, now);

  for (const [key, timestamp] of memory) {
    if (now - timestamp >= WINDOW_SECONDS * 1000) memory.delete(key);
  }

  return { allowed: true, retryAfter: 0 };
}

function securityHeaders(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("X-RateLimit-Limit", String(MAX_REQUESTS_PER_WINDOW));
  res.setHeader("X-RateLimit-Window", String(WINDOW_SECONDS));
}

export default async function handler(req, res) {
  securityHeaders(res);

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const clientId = getClientId(req);
  const limit = await checkRateLimit(clientId);

  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfter));
    return res.status(429).json({
      error: "Download rate limit exceeded",
      message: "DATA.CSV can be downloaded once every 5 minutes per client.",
      retryAfter: limit.retryAfter
    });
  }

  const sourceUrl =
    "https://raw.githubusercontent.com/otizemlanetzag/snake-crawl/main/DATA.CSV";

  let response;
  try {
    response = await fetch(sourceUrl, {
      headers: {
        "User-Agent": "Snake-Crawl-Files/1.0",
        Accept: "text/csv,*/*;q=0.8"
      }
    });
  } catch {
    return res.status(502).json({ error: "Source download failed" });
  }

  if (!response.ok) {
    return res.status(502).json({
      error: "Could not retrieve DATA.CSV",
      status: response.status
    });
  }

  let data;
  try {
    data = await response.arrayBuffer();
  } catch {
    return res.status(502).json({ error: "Could not read DATA.CSV" });
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="DATA.CSV"');
  res.setHeader("Content-Length", String(data.byteLength));
  res.setHeader("X-RateLimit-Remaining", "0");

  if (req.method === "HEAD") return res.end();
  return res.send(Buffer.from(data));
}
