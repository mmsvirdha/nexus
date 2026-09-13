const store = new Map();
module.exports = {
  WHEN_UNLOCKED: 'whenUnlocked',
  getItemAsync: async (key) => (store.has(key) ? store.get(key) : null),
  setItemAsync: async (key, value) => { store.set(key, value); },
  deleteItemAsync: async (key) => { store.delete(key); },
};