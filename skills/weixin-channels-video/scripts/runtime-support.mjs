export const RUNTIME_PROTOCOL = 3;
export const MIN_NODE_VERSION = "22.22.2";

function versionParts(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts.every((part) => part <= 65535) ? parts : null;
}

export function supportsNodeVersion(value = process.versions.node, minimum = MIN_NODE_VERSION) {
  const actual = versionParts(value);
  const required = versionParts(minimum);
  if (!actual || !required) return false;
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return true;
}
