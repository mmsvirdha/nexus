/**
 * Metro alias target for `ws`. `packages/crypto/index.js` doesn't need
 * it; if anything in the bundle graph reaches for it, we fail loudly
 * rather than silently pulling a Node-only module into Hermes.
 */
module.exports = function wsUnavailable() {
  throw new Error(
    'ws was resolved in the React Native bundle. NEXUS Mobile uses the global WebSocket; ' +
    'if you reached this, something imported core/node.js (the server class) into the app.'
  );
};