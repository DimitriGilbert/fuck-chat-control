/**
 * App registration entry — the TRUE first module: Metro loads
 * `package.json` `main` → this file. The bare polyfill import MUST be the
 * first import HERE, not only in App.tsx: module evaluation is depth-first
 * in import order, so this edge must resolve before `./App` pulls in the
 * chat-runtime → @noble graph that snapshots `globalThis.crypto` at
 * module-eval time. Keeping it first also guards the ordering if App.tsx's
 * import order ever regresses. See src/chat/rn-crypto-polyfill.ts for the
 * full invariant (this deliberately precedes the external `expo` import).
 */
import "./src/chat/rn-crypto-polyfill";

import { registerRootComponent } from "expo";

import App from "./App";

registerRootComponent(App);
