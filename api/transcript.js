import { YouTubeTranscriptApi } from "yt-transcript-api";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

// --- Simple in-memory rate limiter ---
// Note: This works within a single serverless instance. Each cold start
// resets the map, but it still helps throttle abuse from warm instances.
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 20;
const rateLimitMap = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return false;
  }

  entry.count++;
  if (entry.count > MAX_REQUESTS_PER_WINDOW) {
    return true;
  }

  return false;
}

// Clean up stale entries periodically to avoid memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW_MS);

// YouTube video IDs are 11 characters: letters, numbers, hyphens, underscores
const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

export default async function handler(req, res) {
  // Only allow GET requests
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Authenticate via API key (passed as ?apiKey= query param or x-api-key header)
  const apiKey = req.headers["x-api-key"] || req.query.apiKey;
  if (!process.env.API_SECRET_KEY) {
    return res.status(500).json({ error: "Server misconfigured: missing API key" });
  }
  if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ error: "Unauthorized: invalid or missing API key" });
  }

  // Rate limiting by IP
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Too many requests. Try again later." });
  }

  const { videoId } = req.query;

  if (!videoId) {
    return res.status(400).json({ error: "Missing videoId" });
  }

  // Validate videoId format to prevent injection / abuse
  if (!VIDEO_ID_REGEX.test(videoId)) {
    return res.status(400).json({ error: "Invalid videoId format" });
  }

  // Vercel Hobby plan has a 60-second function limit.
  // 5 retries with 8s delays + 10s request timeouts fits within that budget.
  // Proxy errors (502/429) typically fail fast (~1-2s), so in practice
  // this completes well under 60s.
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 8_000;
  let lastError = null;
  const attemptErrors = [];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const clientConfig = {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        },
        timeout: 10000,
      };

      if (process.env.PROXY_URL) {
        const agent = new HttpsProxyAgent(process.env.PROXY_URL);
        clientConfig.httpAgent = agent;
        clientConfig.httpsAgent = agent;
      }

      const httpClient = axios.create(clientConfig);
      const api = new YouTubeTranscriptApi({ httpClient });
      const transcript = await api.fetch(videoId, ["en"]);

      const snippets = transcript.map((s) => ({
        text: s.text,
        start: s.start,
        duration: s.duration,
      }));

      return res.status(200).json({ transcript: snippets });
    } catch (e) {
      lastError = e;
      const status = e?.response?.status;
      attemptErrors.push({
        attempt,
        status: status || null,
        message: e?.message || String(e),
      });

      // Only retry on transient proxy/rate-limit errors
      if ((status === 429 || status === 502 || status === 503) && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }

      break;
    }
  }

  return res.status(500).json({
    error: `Failed to fetch transcript after ${attemptErrors.length} of ${MAX_RETRIES} retries`,
    details: lastError?.message || String(lastError),
    attempts: attemptErrors,
  });
}
