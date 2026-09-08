export function defineCloudProvider(spec) {
  return Object.freeze({
    runtime: "cloud",
    auth: "api-key",
    modelsPath: "/models",
    keyPrefixes: [],
    aliases: [],
    skStyleKey: false,
    thinkingControl: false,
    ...spec,
    keyPrefixes: Object.freeze([...(spec.keyPrefixes || [])]),
    aliases: Object.freeze([...(spec.aliases || [])]),
  });
}
