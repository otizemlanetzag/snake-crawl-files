const WINDOW_SECONDS = 5 * 60;
const memory = globalThis.__snakeDownloadRateLimit || new Map();
globalThis.__snakeDownloadRateLimit = memory;

function getClientId(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers["x-real-ip"] || "unknown";
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

  if (!response.ok) throw new Error("Redis rate-limit request failed");
  return response.json();
}

async function checkRateLimit(id) {
  const key = `snake-crawl-download:${id}`;

  try {
    const existing = await redisCommand(["GET", key]);

    if (existing?.result) {
      const retryAt = Number(existing.result);
      return { allowed: false, retryAfter: Math.max(1, retryAt - Math.floor(Date.now() / 1000)) };
    }

    const retryAt = Math.floor(Date.now() / 1000) + WINDOW_SECONDS;
    await redisCommand(["SET", key, String(retryAt), "EX", WINDOW_SECONDS]);

    return { allowed: true, retryAfter: 0 };
  } catch {
    // Fall back to per-instance memory if Redis is temporarily unavailable.
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

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = getClientId(req);
  const limit = await checkRateLimit(id);

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-RateLimit-Window", "300");

  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfter));
    return res.status(429).json({
      error: "Download rate limit exceeded",
      message: "You can download DATA.CSV once every 5 minutes.",
      retryAfter: limit.retryAfter
    });
  }

  const sourceUrl =
    "https://raw.githubusercontent.com/otizemlanetzag/snake-crawl/main/DATA.CSV";

  const response = await fetch(sourceUrl, {
    headers: {
      "User-Agent": "Snake-Crawl-Files/1.0"
    }
  });

  if (!response.ok) {
    return res.status(502).json({
      error: "Could not retrieve DATA.CSV",
      status: response.status
    });
  }

  const data = await response.arrayBuffer();

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="DATA.CSV"');
  res.setHeader("Content-Length", String(data.byteLength));
  res.setHeader("X-RateLimit-Remaining", "0");

  if (req.method === "HEAD") return res.end();
  return res.send(Buffer.from(data));
}
