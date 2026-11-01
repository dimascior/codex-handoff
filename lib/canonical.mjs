// Canonical JSON for content identities: object keys sorted by UTF-16 code units, no whitespace,
// undefined members dropped. For the strings, integers, booleans and nulls these identities hold,
// this is the JCS (RFC 8785) form HeliosEntitlementAuthority signs.
import { sha256 } from './files.mjs';

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
    .join(',')}}`;
}

export const contentId = (value) => `sha256:${sha256(canonicalJson(value))}`;
