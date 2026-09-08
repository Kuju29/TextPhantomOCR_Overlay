// Complete runs:Extension Cloud-via-API route boundary.
// The server transport owns its request envelope, response normalization and
// usage capture; this file intentionally imports no Local AI implementation.
import { translateViaServer } from "../transports/server.js";

export function translateServerRoute(units, options = {}) {
  return translateViaServer(units, options);
}

