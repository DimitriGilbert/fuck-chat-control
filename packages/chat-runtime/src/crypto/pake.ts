import {
  PAKE_CONFIRM_LABEL,
  PAKE_PROTOCOL_ID,
  PAKE_ROLE_A,
  PAKE_ROLE_B,
  PAKE_SHARE_BYTES,
} from "../protocol/limits";
import { Role } from "../protocol/types";

import { PakeError, PakeErrorCode } from "./errors";
import { hmacSha256, hkdfSha256 } from "./primitives";

/**
 * The lazy-loaded WASM module surface, declared locally so a SafetyNumberOnly
 * session never pays the dynamic-import cost and so this file type-checks
 * without a static import of the committed `pkg/` bindings. The concrete
 * shape mirrors `src/wasm/spake2/pkg/fck_spake2.d.ts` exactly.
 */
export interface PakeWasmModule {
  pake_start(role: number, code: Uint8Array, protocol_id: Uint8Array): PakeStateHandle;
  pake_finish(state: PakeStateHandle, peer_share: Uint8Array): Uint8Array;
}

/**
 * Typed view of the committed `pkg/fck_spake2.js` default (async init) plus
 * the named `pake_start` / `pake_finish` exports, and the synchronous
 * `initSync` entry used by Node tests (the browser path uses the async
 * default export).
 */
interface PakeWasmModuleBinding extends PakeWasmModule {
  default(): Promise<unknown>;
  initSync(module: { module: WebAssembly.Module } | BufferSource): void;
}

/**
 * SPAKE2 (RFC 9383) PAKE session, wrapping the committed WASM module at
 * `../wasm/spake2/pkg`.
 *
 * Roles are mapped from the deterministic identity-key comparison already used
 * for ECDH session roles ({@link Role} from `deriveRole`): the session
 * {@link Role.Initiator} plays SPAKE2 side A, the session
 * {@link Role.Responder} plays side B. Roles are NEVER trusted from the broker.
 *
 * The 6-digit `code` is the SPAKE2 password. It is never logged, never
 * persisted, and never crosses the wire — only the 33-byte share does. After
 * {@link pakeFinish} the WASM state is dropped (its internal `Spake2` is
 * consumed by the crate); the caller should also drop the {@link PakeSession}
 * reference.
 *
 * The WASM module is lazy-loaded only when a `~code` invitation is actually
 * used; a `SafetyNumberOnly` session MUST NOT trigger the import (the
 * orchestrator is responsible for only constructing a {@link PakeSession} when
 * the parsed invitation carried a code).
 */
export interface PakeSession {
  /** The SPAKE2 side byte the local peer plays ('A'=0x41 or 'B'=0x42). */
  readonly sideByte: number;
  /** The opaque WASM state; `null` once {@link pakeFinish} has consumed it. */
  state: PakeStateHandle | null;
}

/**
 * Opaque handle for the WASM `PakeState`. The concrete shape comes from the
 * committed `pkg/` bindings; we type it structurally to avoid a static import
 * of the WASM module (which would defeat the lazy load).
 */
export interface PakeStateHandle {
  readonly side: number;
  readonly outgoing_share: Uint8Array;
  free(): void;
}

/**
 * Default specifier of the committed WASM module, resolved relative to THIS
 * file (`packages/chat-runtime/src/crypto/pake.ts`). Two `../` segments climb
 * from `crypto/` → `src/` → `chat-runtime/`, then `wasm/spake2/pkg/...` lands
 * at the committed `packages/chat-runtime/wasm/spake2/pkg/` artifacts.
 *
 * This default is only used when no override has been registered via
 * {@link setSpake2ModuleUrl}. The web app overrides it at boot with the
 * absolute URL its build serves (`/wasm/spake2/pkg/fck_spake2.js`, the path
 * the `emit-spake2-pkg` vite plugin emits); native apps override with their
 * platform's asset URL. Keeping a relative fallback lets Node tests resolve
 * the committed pkg directly from the source tree.
 */
const DEFAULT_SPAKE2_MODULE_SPECIFIER = "../../wasm/spake2/pkg/fck_spake2.js";

/**
 * Override for the SPAKE2 module specifier, set by {@link setSpake2ModuleUrl}.
 * When non-null, {@link loadWasm} imports from this URL instead of the
 * relative default — this is how each platform points the loader at its own
 * served/assets location without the runtime core taking a DOM dependency.
 */
let spake2ModuleUrl: string | null = null;

/**
 * Register the URL/specifier the SPAKE2 loader imports from. Each platform
 * calls this once at boot BEFORE any PAKE handshake runs:
 *  - web: `setSpake2ModuleUrl("/wasm/spake2/pkg/fck_spake2.js")` (the path
 *    the `emit-spake2-pkg` vite plugin emits the pkg to);
 *  - native: the platform's asset URL (e.g. a bundled resource URI).
 *
 * If never called, the loader falls back to the relative default that
 * resolves against this file in the source tree (used by Node tests).
 */
export function setSpake2ModuleUrl(url: string): void {
  spake2ModuleUrl = url;
}

let wasmModulePromise: Promise<PakeWasmModule> | null = null;

/**
 * Lazily import and initialize the committed SPAKE2 WASM module. The module's
 * default export is the async init function (see `pkg/fck_spake2.js`); the
 * named exports `pake_start` / `pake_finish` become callable once init resolves.
 * The browser resolves the `.wasm` asset via `import.meta.url` baked into the
 * pkg by wasm-pack.
 *
 * The dynamic `import()` uses a constant string identifier (not a literal) so
 * the bundler emits it as a separate chunk that a `SafetyNumberOnly` session
 * never fetches. The result is cast to the local {@link PakeWasmModuleBinding}
 * view; the committed `pkg/fck_spake2.d.ts` provides the underlying shapes.
 */
async function loadWasm(): Promise<PakeWasmModule> {
  if (wasmModulePromise === null) {
    // The dynamic `import(specifier)` is hidden behind `new Function` so every
    // bundler's static analyzer (Metro, Vite, webpack) treats it as an opaque
    // runtime eval — invisible to the transformer. Metro's transformer rejects
    // `import(variable)` outright, AND Metro's resolver fails on
    // `import(literalPathOnBlockList)` instead of dropping it; routing through
    // `new Function` sidesteps both. At runtime it is a plain `import()`.
    //
    // React Native v1 is safety-number-only and NEVER reaches this code path
    // (no `~code` invitation reaches `createPakeSession`), so the runtime
    // branch never fires on native — keeping the import hidden is sufficient.
    //
    // Web calls `setSpake2ModuleUrl` BEFORE the first PAKE handshake so the
    // override URL is the one resolved at runtime. Node tests bypass this
    // entirely via `__setWasmModuleForTests`.
    const specifier = spake2ModuleUrl ?? DEFAULT_SPAKE2_MODULE_SPECIFIER;
    const mod = (await dynamicImport(specifier)) as unknown as PakeWasmModuleBinding;
    await mod.default();
    wasmModulePromise = Promise.resolve(mod as PakeWasmModule);
  }
  return wasmModulePromise;
}

/**
 * Runtime dynamic `import()` hidden from bundler static analysis. Constructed
 * via `new Function` so the call site never appears as a syntactic `import()`
 * in this file's AST — Metro, Vite, webpack, etc. cannot resolve, block, or
 * reject what they cannot see. The body is a perfectly normal dynamic import.
 */
const dynamicImport = new Function(
  "specifier",
  "return import(specifier)",
) as (specifier: string) => Promise<unknown>;

/**
 * Test-only synchronous initializer. Node-based unit tests cannot rely on the
 * browser's `fetch(new URL(...))` init path baked into `pkg/fck_spake2.js`, so
 * the test imports the pkg directly, calls `initSync` on it with the compiled
 * `WebAssembly.Module`, then hands the initialized binding to this setter so
 * the wrapper's lazy cache is seeded and `loadWasm` short-circuits. Browser
 * callers never need this — `loadWasm` handles initialization there.
 */
export function __setWasmModuleForTests(binding: PakeWasmModule): void {
  wasmModulePromise = Promise.resolve(binding);
}

/**
 * Map a session {@link Role} to the SPAKE2 side byte. The session initiator
 * plays SPAKE2 side A; the responder plays side B. Both are derived from the
 * deterministic identity-key comparison in `deriveRole`, so both peers agree
 * without any broker input.
 */
export function roleToSideByte(role: Role): number {
  return role === Role.Initiator ? PAKE_ROLE_A : PAKE_ROLE_B;
}

/**
 * Derive a PAKE confirmation tag. After both peers complete `pakeFinish`, each
 * computes a MAC over the transcript hash keyed by an HKDF-derived confirmation
 * key seeded with the SPAKE2 shared secret. Because the SPAKE2 secret is
 * identical iff the two codes match, a tag mismatch proves a wrong-code attack
 * — the handshake aborts and there is no path to Connected under divergent
 * traffic keys.
 *
 * The `role` parameter binds each tag to its sender's role so the two
 * directional tags (initiator→responder and responder→initiator) cannot be
 * replayed against the opposite side.
 */
export async function derivePakeConfirmationTag(
  pakeSecret: Uint8Array,
  transcriptHash: Uint8Array,
  role: Role,
): Promise<Uint8Array> {
  const roleByte = role === Role.Initiator ? PAKE_ROLE_A : PAKE_ROLE_B;
  const confirmKey = await hkdfSha256(
    pakeSecret,
    new Uint8Array(0),
    new TextEncoder().encode(PAKE_CONFIRM_LABEL),
    32,
  );
  const message = new Uint8Array(1 + transcriptHash.length);
  message[0] = roleByte;
  message.set(transcriptHash, 1);
  return hmacSha256(confirmKey, message);
}

/**
 * Begin a SPAKE2 exchange for the given session role and 6-digit code.
 *
 * Lazy-loads the WASM module on first use. Returns a {@link PakeSession}
 * whose {@link PakeSession.state} carries the 33-byte outgoing share
 * (`state.outgoing_share`) to send to the peer.
 *
 * Never log or persist the `code`; the caller drops the {@link PakeSession}
 * reference after {@link pakeFinish}.
 */
export async function createPakeSession(code: string, role: Role): Promise<PakeSession> {
  if (code.length === 0) {
    throw new PakeError(PakeErrorCode.InvalidShare, "PAKE code must be non-empty");
  }
  const sideByte = roleToSideByte(role);
  const wasm = await loadWasm();
  const codeBytes = new TextEncoder().encode(code);
  const protocolIdBytes = new TextEncoder().encode(PAKE_PROTOCOL_ID);
  let state: PakeStateHandle;
  try {
    state = wasm.pake_start(sideByte, codeBytes, protocolIdBytes);
  } catch (err) {
    throw mapWasmError(err, "pake_start");
  } finally {
    codeBytes.fill(0);
  }
  return { sideByte, state };
}

/**
 * Read the 33-byte outgoing share from a {@link PakeSession}. The share is
 * safe to send in cleartext over the data channel — that is the whole point of
 * SPAKE2. Throws {@link PakeError} if the session has already been finished.
 */
export function pakeOutgoingShare(session: PakeSession): Uint8Array {
  if (session.state === null) {
    throw new PakeError(PakeErrorCode.Abort, "pakeOutgoingShare: session already finished");
  }
  const share = session.state.outgoing_share;
  if (share.length !== PAKE_SHARE_BYTES) {
    throw new PakeError(
      PakeErrorCode.InvalidShare,
      `outgoing share must be ${PAKE_SHARE_BYTES} bytes, got ${share.length}`,
    );
  }
  return share;
}

/**
 * Complete the SPAKE2 exchange, returning the 32-byte shared secret. Throws a
 * typed {@link PakeError} on any failure (wrong code → `Mismatch`, malformed
 * peer share → `InvalidShare`, protocol abort → `Abort`).
 *
 * After this call the WASM state is consumed; the caller should drop the
 * {@link PakeSession} reference.
 */
export async function pakeFinish(
  session: PakeSession,
  peerShare: Uint8Array,
): Promise<Uint8Array> {
  if (session.state === null) {
    throw new PakeError(PakeErrorCode.Abort, "pakeFinish: session already finished");
  }
  if (peerShare.length !== PAKE_SHARE_BYTES) {
    throw new PakeError(
      PakeErrorCode.InvalidShare,
      `peer share must be ${PAKE_SHARE_BYTES} bytes, got ${peerShare.length}`,
    );
  }
  const wasm = await loadWasm();
  const state = session.state;
  session.state = null;
  try {
    return wasm.pake_finish(state, peerShare);
  } catch (err) {
    throw mapWasmError(err, "pake_finish");
  } finally {
    try {
      state.free();
    } catch {
      // best-effort; the crate's finalizer is idempotent
    }
  }
}

/**
 * Map a raw WASM-thrown `Error` to a typed {@link PakeError}, using the stable
 * `pake_finish:` / `pake_start:` prefix in the message to recover the
 * RustCrypto error name. A `BadSide` (reflected message / wrong-side share)
 * indicates a protocol abort; `CorruptMessage` / `WrongLength` indicate a
 * malformed peer share; anything else from `pake_finish` (a successfully
 * completed exchange that produced a different secret because the codes
 * differed) is reported as `Mismatch` — SPAKE2 does not itself detect a wrong
 * password, so the orchestrator detects it by comparing the two sides' derived
 * traffic keys (or, equivalently, a confirmation MAC). This wrapper surfaces
 * the post-hoc mismatch when the peer share was technically valid.
 */
function mapWasmError(err: unknown, where: "pake_start" | "pake_finish"): PakeError {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("BadSide")) {
    return new PakeError(PakeErrorCode.Abort, `${where}: bad SPAKE2 side (reflected message)`);
  }
  if (message.includes("CorruptMessage")) {
    return new PakeError(PakeErrorCode.InvalidShare, `${where}: peer share point is malformed`);
  }
  if (message.includes("WrongLength")) {
    return new PakeError(PakeErrorCode.InvalidShare, `${where}: peer share has wrong length`);
  }
  if (message.includes("AlreadyConsumed")) {
    return new PakeError(PakeErrorCode.Abort, `${where}: SPAKE2 state already consumed`);
  }
  return new PakeError(PakeErrorCode.Mismatch, `${where}: ${message}`);
}
