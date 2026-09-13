module.exports = {
  documentDirectory: '/tmp/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  getInfoAsync: async () => { throw new Error('expo-file-system.getInfoAsync called in a test that should not use it'); },
  readAsStringAsync: async () => { throw new Error('expo-file-system.readAsStringAsync called in a test that should not use it'); },
  writeAsStringAsync: async () => { throw new Error('expo-file-system.writeAsStringAsync called in a test that should not use it'); },
};