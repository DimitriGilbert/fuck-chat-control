import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  decryptFrame,
  encryptFrame,
  generateAtRestKey,
  generateEphemeralKeyPair,
  generateIdentityKeyPair,
  ReplayWindow,
  wrapKey,
} from "@fuck-eu-chat-control/chat-runtime/crypto";
import { PROTOCOL_VERSION } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import { FrameType } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { FrameAad } from "@fuck-eu-chat-control/chat-runtime/protocol/types";

import { sessionId } from "./_helpers";

const CRYPTO_SRC_DIR = fileURLToPath(
  new URL("../../../../../packages/chat-runtime/src/crypto/", import.meta.url),
);

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("crypto randomness source (no Math.random)", () => {
  it("crypto source files never reference Math.random", () => {
    const files = listTsFiles(CRYPTO_SRC_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src, `${file} must not use Math.random`).not.toMatch(/\bMath\.random\b/);
    }
  });

  it("crypto operations succeed with Math.random neutralized", async () => {
    const original = Math.random;
    Math.random = function throwIfUsed(): number {
      throw new Error("crypto must not use Math.random");
    };
    try {
      const id = await generateIdentityKeyPair();
      const ecdh = await generateEphemeralKeyPair();
      const key = generateAtRestKey();
      expect(id.publicKey.length).toBe(65);
      expect(ecdh.publicKey.length).toBe(65);
      expect(key.length).toBe(32);

      const aad: FrameAad = {
        protocolVersion: PROTOCOL_VERSION,
        senderSessionId: sessionId(1),
        senderSequence: 0,
        frameType: FrameType.Text,
        transferId: 0,
        chunkId: 0,
      };
      const enc = await encryptFrame(key, aad, new Uint8Array([1, 2, 3]));
      await decryptFrame(key, new ReplayWindow(), aad, enc.nonce, enc.ciphertext);
      await wrapKey("passphrase", key);
      new ReplayWindow().observe(0);
    } finally {
      Math.random = original;
    }
  });
});
