import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

export default async function handler(req, res) {
  // Authenticate via API key
  const apiKey = req.headers["x-api-key"] || req.query.apiKey;
  if (!process.env.API_SECRET_KEY) {
    return res.status(500).json({ error: "Server misconfigured: missing API key" });
  }
  if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ error: "Unauthorized: invalid or missing API key" });
  }

  const results = {
    proxyConfigured: !!process.env.PROXY_URL,
    proxyUrl: process.env.PROXY_URL
      ? process.env.PROXY_URL.replace(/:([^@:]+)@/, ":****@") // mask password
      : null,
  };

  // Check Vercel's direct outgoing IP (no proxy)
  try {
    const directResponse = await axios.get("https://api.ipify.org?format=json", {
      timeout: 5000,
    });
    results.directIp = directResponse.data.ip;
  } catch (e) {
    results.directIp = `Error: ${e.message}`;
  }

  // Check outgoing IP through the proxy
  if (process.env.PROXY_URL) {
    try {
      const agent = new HttpsProxyAgent(process.env.PROXY_URL);
      const proxyAxios = axios.create({
        httpAgent: agent,
        httpsAgent: agent,
        timeout: 10000,
      });
      const proxyResponse = await proxyAxios.get("https://api.ipify.org?format=json");
      results.proxyIp = proxyResponse.data.ip;
      results.proxyWorking = results.directIp !== results.proxyIp;
    } catch (e) {
      results.proxyIp = `Error: ${e.message}`;
      results.proxyWorking = false;
    }
  } else {
    results.proxyIp = "No proxy configured";
    results.proxyWorking = false;
  }

  return res.status(200).json(results);
}
