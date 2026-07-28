/**
 * App registration entry. Metro loads `package.json` `main` → this file. The
 * polyfill import is re-exported through App.tsx so it runs first; importing
 * App here preserves that ordering under Metro's module graph.
 */
import App from './App';

import { registerRootComponent } from 'expo';

registerRootComponent(App);
