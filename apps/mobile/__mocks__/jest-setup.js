if (typeof globalThis.crypto === 'undefined') {
  const nodeCrypto = require('crypto');
  globalThis.crypto = {
    getRandomValues: (arr) => nodeCrypto.randomFillSync(arr),
    randomUUID: () => nodeCrypto.randomUUID(),
  };
}