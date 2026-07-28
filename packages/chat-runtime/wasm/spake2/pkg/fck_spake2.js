/* @ts-self-types="./fck_spake2.d.ts" */

/**
 * Opaque PAKE state handed back to JS.
 *
 * The inner `Spake2` is consumed by `pake_finish`, so the option is `take`n on
 * completion (a second `pake_finish` call returns the `AlreadyConsumed`
 * error). The outgoing share is exposed as a getter so JS does not have to
 * touch the state's interior.
 */
export class PakeState {
  static __wrap(ptr) {
    const obj = Object.create(PakeState.prototype);
    obj.__wbg_ptr = ptr;
    PakeStateFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    PakeStateFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_pakestate_free(ptr, 0);
  }
  /**
   * The 33-byte outgoing share to send to the peer. Returned as a fresh copy
   * so JS owns the buffer.
   * @returns {Uint8Array}
   */
  get outgoing_share() {
    const ret = wasm.pakestate_outgoing_share(this.__wbg_ptr);
    return takeObject(ret);
  }
  /**
   * Which SPAKE2 side this state was started as ('A' or 'B').
   * @returns {number}
   */
  get side() {
    const ret = wasm.pakestate_side(this.__wbg_ptr);
    return ret;
  }
}
if (Symbol.dispose) PakeState.prototype[Symbol.dispose] = PakeState.prototype.free;

/**
 * Complete a SPAKE2 exchange, returning the 32-byte shared secret.
 *
 * Throws a JS `Error` if the peer share is malformed (wrong length / corrupt
 * point), carries the wrong side byte, or the state was already consumed. The
 * thrown message carries a stable prefix (`pake_finish:`) followed by the
 * RustCrypto error name so JS can map it to a typed `PakeError`.
 * @param {PakeState} state
 * @param {Uint8Array} peer_share
 * @returns {Uint8Array}
 */
export function pake_finish(state, peer_share) {
  try {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
    _assertClass(state, PakeState);
    const ptr0 = passArray8ToWasm0(peer_share, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    wasm.pake_finish(retptr, state.__wbg_ptr, ptr0, len0);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
    var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
    if (r3) {
      throw takeObject(r2);
    }
    var v2 = getArrayU8FromWasm0(r0, r1).slice();
    wasm.__wbindgen_export3(r0, r1 * 1, 1);
    return v2;
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
}

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
 * @param {number} role
 * @param {Uint8Array} code
 * @param {Uint8Array} protocol_id
 * @returns {PakeState}
 */
export function pake_start(role, code, protocol_id) {
  try {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passArray8ToWasm0(code, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(protocol_id, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm.pake_start(retptr, role, ptr0, len0, ptr1, len1);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
    if (r2) {
      throw takeObject(r1);
    }
    return PakeState.__wrap(r0);
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
}
function __wbg_get_imports() {
  const import0 = {
    __proto__: null,
    __wbg___wbindgen_is_function_1ff95bcc5517c252: function (arg0) {
      const ret = typeof getObject(arg0) === "function";
      return ret;
    },
    __wbg___wbindgen_is_object_a27215656b807791: function (arg0) {
      const val = getObject(arg0);
      const ret = typeof val === "object" && val !== null;
      return ret;
    },
    __wbg___wbindgen_is_string_ea5e6cc2e4141dfe: function (arg0) {
      const ret = typeof getObject(arg0) === "string";
      return ret;
    },
    __wbg___wbindgen_is_undefined_c05833b95a3cf397: function (arg0) {
      const ret = getObject(arg0) === undefined;
      return ret;
    },
    __wbg___wbindgen_throw_344f42d3211c4765: function (arg0, arg1) {
      throw new Error(getStringFromWasm0(arg0, arg1));
    },
    __wbg_call_a6e5c5dce5018821: function () {
      return handleError(function (arg0, arg1, arg2) {
        const ret = getObject(arg0).call(getObject(arg1), getObject(arg2));
        return addHeapObject(ret);
      }, arguments);
    },
    __wbg_crypto_38df2bab126b63dc: function (arg0) {
      const ret = getObject(arg0).crypto;
      return addHeapObject(ret);
    },
    __wbg_getRandomValues_c44a50d8cfdaebeb: function () {
      return handleError(function (arg0, arg1) {
        getObject(arg0).getRandomValues(getObject(arg1));
      }, arguments);
    },
    __wbg_length_1f0964f4a5e2c6d8: function (arg0) {
      const ret = getObject(arg0).length;
      return ret;
    },
    __wbg_msCrypto_bd5a034af96bcba6: function (arg0) {
      const ret = getObject(arg0).msCrypto;
      return addHeapObject(ret);
    },
    __wbg_new_with_length_e6785c33c8e4cce8: function (arg0) {
      const ret = new Uint8Array(arg0 >>> 0);
      return addHeapObject(ret);
    },
    __wbg_node_84ea875411254db1: function (arg0) {
      const ret = getObject(arg0).node;
      return addHeapObject(ret);
    },
    __wbg_process_44c7a14e11e9f69e: function (arg0) {
      const ret = getObject(arg0).process;
      return addHeapObject(ret);
    },
    __wbg_prototypesetcall_4770620bbe4688a0: function (arg0, arg1, arg2) {
      Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), getObject(arg2));
    },
    __wbg_randomFillSync_6c25eac9869eb53c: function () {
      return handleError(function (arg0, arg1) {
        getObject(arg0).randomFillSync(takeObject(arg1));
      }, arguments);
    },
    __wbg_require_b4edbdcf3e2a1ef0: function () {
      return handleError(function () {
        const ret = module.require;
        return addHeapObject(ret);
      }, arguments);
    },
    __wbg_set_4d7dd76f3dae2926: function (arg0, arg1, arg2) {
      getObject(arg0).set(getArrayU8FromWasm0(arg1, arg2));
    },
    __wbg_static_accessor_GLOBAL_4ef717fb391d88b7: function () {
      const ret = typeof global === "undefined" ? null : global;
      return isLikeNone(ret) ? 0 : addHeapObject(ret);
    },
    __wbg_static_accessor_GLOBAL_THIS_8d1badc68b5a74f4: function () {
      const ret = typeof globalThis === "undefined" ? null : globalThis;
      return isLikeNone(ret) ? 0 : addHeapObject(ret);
    },
    __wbg_static_accessor_SELF_146583524fe1469b: function () {
      const ret = typeof self === "undefined" ? null : self;
      return isLikeNone(ret) ? 0 : addHeapObject(ret);
    },
    __wbg_static_accessor_WINDOW_f2829a2234d7819e: function () {
      const ret = typeof window === "undefined" ? null : window;
      return isLikeNone(ret) ? 0 : addHeapObject(ret);
    },
    __wbg_subarray_3ed232c8a6baee09: function (arg0, arg1, arg2) {
      const ret = getObject(arg0).subarray(arg1 >>> 0, arg2 >>> 0);
      return addHeapObject(ret);
    },
    __wbg_versions_276b2795b1c6a219: function (arg0) {
      const ret = getObject(arg0).versions;
      return addHeapObject(ret);
    },
    __wbindgen_cast_0000000000000001: function (arg0, arg1) {
      // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
      const ret = getArrayU8FromWasm0(arg0, arg1);
      return addHeapObject(ret);
    },
    __wbindgen_cast_0000000000000002: function (arg0, arg1) {
      // Cast intrinsic for `Ref(String) -> Externref`.
      const ret = getStringFromWasm0(arg0, arg1);
      return addHeapObject(ret);
    },
    __wbindgen_object_clone_ref: function (arg0) {
      const ret = getObject(arg0);
      return addHeapObject(ret);
    },
    __wbindgen_object_drop_ref: function (arg0) {
      takeObject(arg0);
    },
  };
  return {
    __proto__: null,
    "./fck_spake2_bg.js": import0,
  };
}

const PakeStateFinalization =
  typeof FinalizationRegistry === "undefined"
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry((ptr) => wasm.__wbg_pakestate_free(ptr, 1));

function addHeapObject(obj) {
  if (heap_next === heap.length) heap.push(heap.length + 1);
  const idx = heap_next;
  heap_next = heap[idx];

  heap[idx] = obj;
  return idx;
}

function _assertClass(instance, klass) {
  if (!(instance instanceof klass)) {
    throw new Error(`expected instance of ${klass.name}`);
  }
}

function dropObject(idx) {
  if (idx < 1028) return;
  heap[idx] = heap_next;
  heap_next = idx;
}

function getArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
  if (
    cachedDataViewMemory0 === null ||
    cachedDataViewMemory0.buffer.detached === true ||
    (cachedDataViewMemory0.buffer.detached === undefined &&
      cachedDataViewMemory0.buffer !== wasm.memory.buffer)
  ) {
    cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
  }
  return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
  return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachedUint8ArrayMemory0;
}

function getObject(idx) {
  return heap[idx];
}

function handleError(f, args) {
  try {
    return f.apply(this, args);
  } catch (e) {
    wasm.__wbindgen_export(addHeapObject(e));
  }
}

let heap = new Array(1024).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function isLikeNone(x) {
  return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 1, 1) >>> 0;
  getUint8ArrayMemory0().set(arg, ptr / 1);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}

function takeObject(idx) {
  const ret = getObject(idx);
  dropObject(idx);
  return ret;
}

let cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
  numBytesDecoded += len;
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
    cachedTextDecoder.decode();
    numBytesDecoded = len;
  }
  return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
  wasmInstance = instance;
  wasm = instance.exports;
  wasmModule = module;
  cachedDataViewMemory0 = null;
  cachedUint8ArrayMemory0 = null;
  return wasm;
}

async function __wbg_load(module, imports) {
  if (typeof Response === "function" && module instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(module, imports);
      } catch (e) {
        const validResponse = module.ok && expectedResponseType(module.type);

        if (validResponse && module.headers.get("Content-Type") !== "application/wasm") {
          console.warn(
            "`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n",
            e,
          );
        } else {
          throw e;
        }
      }
    }

    const bytes = await module.arrayBuffer();
    return await WebAssembly.instantiate(bytes, imports);
  } else {
    const instance = await WebAssembly.instantiate(module, imports);

    if (instance instanceof WebAssembly.Instance) {
      return { instance, module };
    } else {
      return instance;
    }
  }

  function expectedResponseType(type) {
    switch (type) {
      case "basic":
      case "cors":
      case "default":
        return true;
    }
    return false;
  }
}

function initSync(module) {
  if (wasm !== undefined) return wasm;

  if (module !== undefined) {
    if (Object.getPrototypeOf(module) === Object.prototype) {
      ({ module } = module);
    } else {
      console.warn("using deprecated parameters for `initSync()`; pass a single object instead");
    }
  }

  const imports = __wbg_get_imports();
  if (!(module instanceof WebAssembly.Module)) {
    module = new WebAssembly.Module(module);
  }
  const instance = new WebAssembly.Instance(module, imports);
  return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
  if (wasm !== undefined) return wasm;

  if (module_or_path !== undefined) {
    if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
      ({ module_or_path } = module_or_path);
    } else {
      console.warn(
        "using deprecated parameters for the initialization function; pass a single object instead",
      );
    }
  }

  if (module_or_path === undefined) {
    module_or_path = new URL("fck_spake2_bg.wasm", import.meta.url);
  }
  const imports = __wbg_get_imports();

  if (
    typeof module_or_path === "string" ||
    (typeof Request === "function" && module_or_path instanceof Request) ||
    (typeof URL === "function" && module_or_path instanceof URL)
  ) {
    module_or_path = fetch(module_or_path);
  }

  const { instance, module } = await __wbg_load(await module_or_path, imports);

  return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
