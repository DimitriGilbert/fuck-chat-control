/* tslint:disable */
/* eslint-disable */

/**
 * Opaque PAKE state handed back to JS.
 *
 * The inner `Spake2` is consumed by `pake_finish`, so the option is `take`n on
 * completion (a second `pake_finish` call returns the `AlreadyConsumed`
 * error). The outgoing share is exposed as a getter so JS does not have to
 * touch the state's interior.
 */
export class PakeState {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The 33-byte outgoing share to send to the peer. Returned as a fresh copy
     * so JS owns the buffer.
     */
    readonly outgoing_share: Uint8Array;
    /**
     * Which SPAKE2 side this state was started as ('A' or 'B').
     */
    readonly side: number;
}

/**
 * Complete a SPAKE2 exchange, returning the 32-byte shared secret.
 *
 * Throws a JS `Error` if the peer share is malformed (wrong length / corrupt
 * point), carries the wrong side byte, or the state was already consumed. The
 * thrown message carries a stable prefix (`pake_finish:`) followed by the
 * RustCrypto error name so JS can map it to a typed `PakeError`.
 */
export function pake_finish(state: PakeState, peer_share: Uint8Array): Uint8Array;

/**
 * Begin a SPAKE2 exchange for the given role.
 *
 * `role` must be {@link SIDE_A} (0x41) or {@link SIDE_B} (0x42). `code` is the
 * 6-digit shared password (the SPAKE2 password). `protocol_id` is the ASCII
 * domain-separation tag (e.g. `fuck-eu-chat-control/v1`); it is fed to the
 * crate as both `idA` and `idB`.
 *
 * Returns a {@link PakeState} whose `outgoingShare` getter yields the 33-byte
 * share to send to the peer. The exchange is completed with {@link pake_finish}.
 */
export function pake_start(role: number, code: Uint8Array, protocol_id: Uint8Array): PakeState;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_pakestate_free: (a: number, b: number) => void;
    readonly pake_finish: (a: number, b: number, c: number, d: number) => void;
    readonly pake_start: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pakestate_outgoing_share: (a: number) => number;
    readonly pakestate_side: (a: number) => number;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
