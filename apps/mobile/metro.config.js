/**
 * Metro config for NEXUS Mobile.
 *
 * We deliberately make Metro watch the monorepo's `packages/` and `core/`
 * directories so the phone imports the SAME protocol envelope and crypto
 * module the desktop does — not a copy that could drift. This is the
 * whole reason the jest interop test can run the mobile client against
 * the real core/node.js: both sides resolve to the same source of truth.
 *
 * `ws` is aliased to a stub because React Native has a global WebSocket
 * and `packages/crypto/index.js` (which we import) does not itself need
 * `ws` — but `core/node.js` does, and if anything in the import graph
 * reaches it, Metro would try to bundle a Node-only module. The alias
 * prevents that.
 */
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

config.resolver.extraNodeModules = {
  ws: path.resolve(projectRoot, 'src/shims/ws-stub.js'),
};

module.exports = config;