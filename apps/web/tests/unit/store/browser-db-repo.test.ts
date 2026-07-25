import { describe, expect, it } from "vitest";

import { generateAtRestKey } from "@/features/chat/crypto";
import { BrowserDbConversationRepository } from "@/features/chat/store";
import { StoreErrorCode } from "@/features/chat/store";

import { conversationId } from "./_helpers";

describe("BrowserDbConversationRepository (stub — Phase 9/10 wiring)", () => {
  it("constructs with a database name and at-rest key without a browser", () => {
    const key = generateAtRestKey();
    const repo = new BrowserDbConversationRepository({
      databaseName: "fck-chat",
      atRestKey: key,
    });
    expect(repo.databaseName).toBe("fck-chat");
    expect(repo.atRestKey).toBe(key);
  });

  it("throws NotImplemented for every repository operation", async () => {
    const repo = new BrowserDbConversationRepository({
      databaseName: "fck-chat",
      atRestKey: generateAtRestKey(),
    });
    const id = conversationId(1);

    await expect(repo.createConversation(id, 1000)).rejects.toMatchObject({
      code: StoreErrorCode.NotImplemented,
    });
    await expect(repo.getConversation(id)).rejects.toMatchObject({
      code: StoreErrorCode.NotImplemented,
    });
    await expect(repo.listConversations()).rejects.toMatchObject({
      code: StoreErrorCode.NotImplemented,
    });
    await expect(repo.clearAll()).rejects.toMatchObject({
      code: StoreErrorCode.NotImplemented,
    });
  });

  it("documents the persistence backend in its error message", async () => {
    const repo = new BrowserDbConversationRepository({
      databaseName: "profiles/main",
      atRestKey: generateAtRestKey(),
    });
    try {
      await repo.listConversations();
      throw new Error("expected throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("profiles/main");
      expect(message).toContain("wa-sqlite");
      expect(message).toContain("Phase 9/10");
    }
  });
});
