// Complete runs:Extension Cloud-via-API route boundary.
// The server transport owns its request envelope, response normalization and
// usage capture; this file intentionally imports no Local AI implementation.
import { translateViaServer } from "../transports/server.js";
import { holdLoginRelay } from "../../transports/account-request.js";

export async function translateServerRoute(units, options = {}) {
  // 10495: a Claude/ChatGPT Login turn needs this browser's relay pump for the
  // whole generation; its account token comes only from the account gate.
  const release = await holdLoginRelay(options.ai?.provider, options.base);
  try {
    return await translateViaServer(units, options);
  } finally {
    release();
  }
}
