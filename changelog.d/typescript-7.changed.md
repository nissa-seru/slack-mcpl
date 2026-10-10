- **Built with TypeScript 7.** The `typescript` dev dependency is now
  `^7.0.2`, the native compiler. `npm ci` installs its binary for the
  machine's platform (the lockfile carries the Linux, macOS and Windows
  builds), and `tsserver` is no longer installed. `tsconfig.json` names the
  Node types (`"types": ["node"]`), which TypeScript 7 no longer includes on
  its own. The emitted JavaScript is unchanged; source maps differ in their
  `mappings` only.
