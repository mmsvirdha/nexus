module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/__mocks__/'],
  moduleFileExtensions: ['js', 'jsx', 'json', 'node'],
  modulePaths: ['<rootDir>/node_modules'],
  moduleNameMapper: {
    '^expo-file-system$': '<rootDir>/__mocks__/expo-file-system.js',
    '^expo-secure-store$': '<rootDir>/__mocks__/expo-secure-store.js',
    '^@react-native-async-storage/async-storage$': '<rootDir>/__mocks__/async-storage.js',
    '^react-native-get-random-values$': '<rootDir>/__mocks__/noop.js',
  },
  transform: {
    '^.+\\.jsx?$': 'babel-jest',
  },
  // Files under our src/ are transformed (they use ESM import syntax).
  // Everything else, including core/node.js and packages/*, is loaded
  // as-is by Node's require().
  transformIgnorePatterns: [
    'node_modules/(?!(?:@noble)/)',
    '<rootDir>/../../core/',
    '<rootDir>/../../packages/',
  ],
  setupFiles: ['<rootDir>/__mocks__/jest-setup.js'],
};