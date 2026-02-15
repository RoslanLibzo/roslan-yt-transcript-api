import { YouTubeTranscriptApi } from "yt-transcript-api";

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

  try {
    const api = new YouTubeTranscriptApi();
    const transcript = await api.fetch(videoId, ["en"]);

    // Extract the snippet objects from the transcript
    const snippets = transcript.snippets.map((s) => ({
      text: s.text,
      offset: s.start,
      duration: s.duration,
    }));

    return res.status(200).json({ transcript: snippets });
  } catch (e) {
    return res.status(500).json({
      error: "Failed to fetch transcript",
      details: e?.message || String(e),
    });
  }
}
