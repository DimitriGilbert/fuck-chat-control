const HEX_DIGITS = "0123456789abcdef";
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += HEX_DIGITS[bytes[i] >>> 4] + HEX_DIGITS[bytes[i] & 0x0f];
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`hex string must have even length, got ${hex.length}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const high = parseHexDigit(hex[i * 2]);
    const low = parseHexDigit(hex[i * 2 + 1]);
    out[i] = (high << 4) | low;
  }
  return out;
}

function parseHexDigit(char: string): number {
  const code = char.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  if (code >= 65 && code <= 70) return code - 55;
  throw new Error(`invalid hex digit: ${char}`);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let result = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    result +=
      BASE64_CHARS[b0 >>> 2] +
      BASE64_CHARS[((b0 & 0x03) << 4) | (b1 >>> 4)] +
      BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 >>> 6)] +
      BASE64_CHARS[b2 & 0x3f];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const b0 = bytes[i];
    result += BASE64_CHARS[b0 >>> 2] + BASE64_CHARS[(b0 & 0x03) << 4] + "==";
  } else if (remaining === 2) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    result +=
      BASE64_CHARS[b0 >>> 2] +
      BASE64_CHARS[((b0 & 0x03) << 4) | (b1 >>> 4)] +
      BASE64_CHARS[(b1 & 0x0f) << 2] +
      "=";
  }
  return result;
}

export function base64ToBytes(base64: string, maxBytes?: number): Uint8Array {
  const input = base64.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input) || input.length % 4 !== 0) {
    throw new Error(`malformed base64 input (length ${input.length})`);
  }
  const lookup = buildBase64Lookup();
  const padding = input.endsWith("==") ? 2 : input.endsWith("=") ? 1 : 0;
  const outLength = (input.length / 4) * 3 - padding;
  // Pre-allocation guard (R8/F3): when the caller passes a max-decoded-length
  // budget, refuse the bundle BEFORE allocating the Uint8Array so a hostile
  // base64 string cannot wedge the device in a memory blow-up. The decoded
  // length is fully determined by the input length and padding.
  if (maxBytes !== undefined && outLength > maxBytes) {
    throw new Error(
      `base64 input decodes to ${outLength} bytes, exceeding the limit of ${maxBytes}`,
    );
  }
  const out = new Uint8Array(outLength);
  let outIndex = 0;
  for (let i = 0; i < input.length; i += 4) {
    const c0 = lookup[input.charCodeAt(i)];
    const c1 = lookup[input.charCodeAt(i + 1)];
    const c2 = lookup[input.charCodeAt(i + 2)];
    const c3 = lookup[input.charCodeAt(i + 3)];
    out[outIndex++] = (c0 << 2) | (c1 >>> 4);
    if (outIndex < outLength) {
      out[outIndex++] = ((c1 & 0x0f) << 4) | (c2 >>> 2);
    }
    if (outIndex < outLength) {
      out[outIndex++] = ((c2 & 0x03) << 6) | c3;
    }
  }
  return out;
}

const BASE64_LOOKUP_SIZE = 128;
let cachedBase64Lookup: Uint8Array | null = null;

function buildBase64Lookup(): Uint8Array {
  if (cachedBase64Lookup !== null) return cachedBase64Lookup;
  const lookup = new Uint8Array(BASE64_LOOKUP_SIZE);
  for (let i = 0; i < BASE64_CHARS.length; i++) {
    lookup[BASE64_CHARS.charCodeAt(i)] = i;
  }
  cachedBase64Lookup = lookup;
  return lookup;
}
