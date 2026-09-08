import { resolveLocalProviderDefinition } from "../providers/local-registry.js";

export function buildLocalAiCapabilityHints({
  protocol,
  modelsData = null,
  runningData = null,
} = {}) {
  return resolveLocalProviderDefinition(protocol).capabilityHints(
    modelsData,
    runningData,
  );
}
