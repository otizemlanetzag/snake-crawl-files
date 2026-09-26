export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || "";

  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return res.status(500).json({ error: "GITHUB_TOKEN is not configured" });
  }

  const sourceUrl =
    "https://raw.githubusercontent.com/otizemlanetzag/snake-crawl/main/DATA.CSV";

  const sourceResponse = await fetch(sourceUrl, {
    headers: {
      "User-Agent": "Snake-Crawl-Vercel-Sync/1.0"
    }
  });

  if (!sourceResponse.ok) {
    return res.status(502).json({
      error: "Could not download source DATA.CSV",
      status: sourceResponse.status
    });
  }

  const sourceBuffer = Buffer.from(await sourceResponse.arrayBuffer());

  if (sourceBuffer.length === 0) {
    return res.status(502).json({ error: "Downloaded DATA.CSV is empty" });
  }

  const githubHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Snake-Crawl-Vercel-Sync/1.0"
  };

  const targetApi =
    "https://api.github.com/repos/otizemlanetzag/snake-crawl-files/contents/DATA.CSV";

  const currentResponse = await fetch(targetApi, {
    headers: githubHeaders
  });

  let currentSha = null;

  if (currentResponse.status === 200) {
    const current = await currentResponse.json();
    currentSha = current.sha;
  } else if (currentResponse.status !== 404) {
    return res.status(502).json({
      error: "Could not inspect target DATA.CSV",
      status: currentResponse.status
    });
  }

  const content = sourceBuffer.toString("base64");

  const updateBody = {
    message: "Sync DATA.CSV from snake-crawl",
    content,
    branch: "main"
  };

  if (currentSha) {
    updateBody.sha = currentSha;
  }

  const updateResponse = await fetch(targetApi, {
    method: "PUT",
    headers: {
      ...githubHeaders,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(updateBody)
  });

  const result = await updateResponse.json();

  if (!updateResponse.ok) {
    return res.status(502).json({
      error: "Could not update target DATA.CSV",
      status: updateResponse.status,
      details: result
    });
  }

  return res.status(200).json({
    ok: true,
    message: "DATA.CSV synchronized",
    bytes: sourceBuffer.length,
    commit: result.commit?.sha || null
  });
}
