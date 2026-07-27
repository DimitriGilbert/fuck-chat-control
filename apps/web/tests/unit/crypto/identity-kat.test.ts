import { p256 } from "@noble/curves/p256";
import { describe, expect, it } from "vitest";

// CR-12: ECDSA P-256 known-answer test against an RFC 6979 deterministic
// signature vector. ECDSA is normally randomized, so a published (sk, msg,
// signature) triple is only reproducible under deterministic ECDSA (RFC 6979),
// which @noble/curves implements by default. A KAT is only meaningful if the
// expected (r, s) are literals from the RFC, not computed by the project's own
// sign at test time.
//
// Encoding note: the project signs transcripts with
//   p256.sign(sha256(transcript), privateKey).toBytes("compact")
// — "compact" is IEEE P1363 (r||s, 64 bytes, no DER wrapping). See
// identity.ts signTranscript. RFC 6979 publishes (r, s) as two big-endian
// 32-byte integers, which concatenates to exactly the IEEE P1363 compact form.
// The KAT therefore drives `p256.sign(digest, sk)` — the exact primitive call
// the project's signTranscript makes — with a hardcoded digest literal, so the
// test never depends on the project's own sign to produce its expected value.
//
// Source: RFC 6979, Appendix A.2.5 (P-256, SHA-256), first sample.
// (https://www.rfc-editor.org/rfc/rfc6979#appendix-A.2.5)
//   private key (x): C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721
//   message: "sample" (ASCII)
//   r = EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716
//   s = F7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8
//
// The project's signTranscript feeds p256.sign a SHA-256 digest of the
// transcript. To mirror that against an RFC vector whose (r, s) are defined
// over the message "sample", we precompute SHA-256("sample") ONCE — as an
// inline hex literal — and feed that fixed digest to p256.sign. This reproduces
// the project's exact signing call while keeping the KAT non-circular: neither
// the digest, nor the (r, s), nor the private key come from the project.
// SHA-256("sample") = af2bdbe1aa9b6ec1e2ade1d694f41fc71a831d0268e9891562113d8a62add1bf
// (a standalone reference value, verifiable via `openssl dgst -sha256`).
const PRIVATE_KEY_HEX = "C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721";
const SHA256_OF_SAMPLE_HEX = "af2bdbe1aa9b6ec1e2ade1d694f41fc71a831d0268e9891562113d8a62add1bf";
// IEEE P1363 compact = r (32 bytes BE) || s (32 bytes BE) = 64 bytes.
const EXPECTED_R_HEX = "EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716";
const EXPECTED_S_HEX = "F7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

describe("ECDSA P-256 known-answer test (RFC 6979 Appendix A.2.5, IEEE P1363 compact)", () => {
  it("reproduces the RFC 6979 deterministic signature over 'sample' in IEEE P1363 compact form", () => {
    const privateKey = hexToBytes(PRIVATE_KEY_HEX);
    // Precomputed SHA-256("sample") — a reference literal, NOT computed via
    // the project's primitives at test time. Feeding it to p256.sign mirrors
    // the project's signTranscript call shape (digest in, compact out).
    const digest = hexToBytes(SHA256_OF_SAMPLE_HEX);

    const sig = p256.sign(digest, privateKey).toBytes("compact");

    // IEEE P1363 compact = r (32 bytes) || s (32 bytes).
    expect(sig.length).toBe(64);
    const r = bytesToHex(sig.subarray(0, 32));
    const s = bytesToHex(sig.subarray(32, 64));
    expect(r).toBe(EXPECTED_R_HEX.toLowerCase());
    expect(s).toBe(EXPECTED_S_HEX.toLowerCase());
  });

  it("verifies the RFC 6979 vector signature against the matching public key", () => {
    const privateKey = hexToBytes(PRIVATE_KEY_HEX);
    const publicKey = p256.getPublicKey(privateKey, false); // 65-byte SEC1
    // Rebuild the IEEE P1363 signature literal from the RFC r||s.
    const signature = hexToBytes(EXPECTED_R_HEX + EXPECTED_S_HEX);
    const digest = hexToBytes(SHA256_OF_SAMPLE_HEX);

    // p256.verify with { format: "compact" } matches the project's verify path
    // (identity.ts verifyTranscript).
    const ok = p256.verify(signature, digest, publicKey, { format: "compact" });
    expect(ok).toBe(true);
  });
});
