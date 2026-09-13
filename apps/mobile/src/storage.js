/**
 * NEXUS Mobile — identity + trusted-device persistence.
 *
 * The identity keypair (deviceId + publicKey + privateKey) is the ONE
 * thing on the phone that must never leak. It goes in expo-secure-store
 * (Keychain on iOS, EncryptedSharedPreferences on Android).
 *
 * Everything else — which laptop we trust, its name, the port we last
 * reached it on, the permissions we requested — is non-secret and goes
 * in AsyncStorage so it can be read cheaply at startup.
 *
 * Shape mirrors core/store.js's per-device record closely enough that
 * nothing downstream has to special-case the phone.
 */

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as rnCrypto from './rn-crypto';

const IDENTITY_KEY = 'nexus.identity.v1';
const TRUSTED_DEVICE_KEY = 'nexus.trustedDevice.v1';

export async function loadOrCreateIdentity() {
  const stored = await SecureStore.getItemAsync(IDENTITY_KEY);
  if (stored) {
    const identity = JSON.parse(stored);
    // Defensive: if the publicKey ever went missing, regenerate rather than
    // silently producing a device with an undefined deviceId.
    if (identity && identity.publicKey && identity.privateKey) {
      if (!identity.deviceId) identity.deviceId = rnCrypto.deriveDeviceId(identity.publicKey);
      return identity;
    }
  }
  const { publicKey, privateKey } = rnCrypto.generateDeviceKeyPair();
  const identity = {
    deviceId: rnCrypto.deriveDeviceId(publicKey),
    publicKey,
    privateKey,
  };
  await SecureStore.setItemAsync(IDENTITY_KEY, JSON.stringify(identity), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
  });
  return identity;
}

export async function clearIdentity() {
  await SecureStore.deleteItemAsync(IDENTITY_KEY);
}

export async function loadTrustedDevice() {
  const raw = await AsyncStorage.getItem(TRUSTED_DEVICE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveTrustedDevice(device) {
  await AsyncStorage.setItem(TRUSTED_DEVICE_KEY, JSON.stringify(device));
}

export async function clearTrustedDevice() {
  await AsyncStorage.removeItem(TRUSTED_DEVICE_KEY);
}