/**
 * NEXUS Mobile — root.
 *
 * Phases: loading → pairing → permissions → dashboard → sendFile.
 */

import 'fast-text-encoding';
import 'react-native-get-random-values';
import React, { useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  View, Text, ActivityIndicator, StyleSheet, ScrollView, TouchableOpacity,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { NexusClient } from './src/NexusClient';
import {
  loadOrCreateIdentity, loadTrustedDevice, saveTrustedDevice, clearTrustedDevice,
} from './src/storage';
import PairingScreen from './src/screens/PairingScreen';
import PermissionsScreen from './src/screens/PermissionsScreen';
import DashboardScreen from './src/screens/DashboardScreen';
import SendFileScreen from './src/screens/SendFileScreen';

const CRASH_KEY = 'nexus.lastCrash.v1';
const previousHandler =
  (global.ErrorUtils && global.ErrorUtils.getGlobalHandler && global.ErrorUtils.getGlobalHandler()) ||
  null;

if (global.ErrorUtils && typeof global.ErrorUtils.setGlobalHandler === 'function') {
  global.ErrorUtils.setGlobalHandler((error, isFatal) => {
    const payload = {
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack ? error.stack : '(no stack)',
      isFatal: !!isFatal,
      when: new Date().toISOString(),
    };
    try { AsyncStorage.setItem(CRASH_KEY, JSON.stringify(payload)); } catch (_) {}
    try { console.error('[nexus CRASH]', payload.message, '\n', payload.stack); } catch (_) {}
    if (previousHandler) previousHandler(error, isFatal);
  });
}

export default function App() {
  const [identity, setIdentity] = useState(null);
  const [trusted, setTrusted] = useState(null);
  const [phase, setPhase] = useState('loading');
  const [client, setClient] = useState(null);
  const [fatal, setFatal] = useState(null);
  const [lastCrash, setLastCrash] = useState(null);
  const clientRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(CRASH_KEY);
        if (raw) setLastCrash(JSON.parse(raw));
      } catch (_) {}
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const id = await loadOrCreateIdentity();
        if (cancelled) return;
        setIdentity(id);
      } catch (e) {
        console.error('[nexus] identity init failed:', e);
        setFatal({ stage: 'identity', message: e && e.message ? e.message : String(e), stack: e && e.stack });
        return;
      }
      try {
        const t = await loadTrustedDevice();
        if (cancelled) return;
        setTrusted(t);
        setPhase(t && t.deviceId ? 'dashboard' : 'pairing');
      } catch (e) {
        console.error('[nexus] trusted-device load failed:', e);
        setFatal({ stage: 'storage', message: e && e.message ? e.message : String(e), stack: e && e.stack });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!identity) return;
    let c;
    try {
      c = new NexusClient({
        identity,
        deviceName: 'NEXUS Android',
        trustedDeviceHint: trusted || null,
      });
      c.on('error', (e) => console.warn('[NEXUS MOBILE]', e && e.message));
      c.on('log', (m) => console.log('[NEXUS MOBILE]', m));

      const persist = async (d) => {
        const t = {
          deviceId: d.deviceId,
          name: d.name,
          host: d.host,
          port: d.port,
        };
        try {
          await saveTrustedDevice(t);
          // Only call setTrusted when the *content* actually changed.
          // Otherwise every paired/session-resumed event creates a new
          // object identity, which re-runs the auto-connect effect and
          // triggers a redundant WebSocket connect — tearing down the
          // session we just established.
          setTrusted((prev) => {
            if (
              prev &&
              prev.deviceId === t.deviceId &&
              prev.name === t.name &&
              prev.host === t.host &&
              prev.port === t.port
            ) {
              return prev;
            }
            return t;
          });
        } catch (e) {
          console.warn('[nexus] failed to save trusted device:', e && e.message);
        }
      };

      c.on('paired', persist);
      c.on('session-resumed', (d) => {
        persist(d);
        setPhase('dashboard');
      });
    } catch (e) {
      console.error('[nexus] client construct failed:', e);
      setFatal({ stage: 'client', message: e && e.message ? e.message : String(e), stack: e && e.stack });
      return;
    }
    clientRef.current = c;
    setClient(c);
    return () => { c.close(); };
  }, [identity]);

  // Keep client._trustedDeviceHint in sync with `trusted` state.
  useEffect(() => {
    if (!client) return;
    client._trustedDeviceHint = trusted || null;
  }, [client, trusted]);

  useEffect(() => {
    if (phase !== 'dashboard' || !client || !trusted) return;
    if (!trusted.host || !trusted.port) return;
    // If the client already has a live trusted session, don't reconnect.
    if (client._trusted && client.ws && client.ws.readyState === 1) return;
    const ws = client.ws;
    // 0 = CONNECTING, 1 = OPEN.
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    try {
      client.connect(trusted.host, trusted.port);
    } catch (e) {
      console.warn('[nexus] auto-connect failed:', e && e.message);
    }
  }, [phase, client, trusted]);

  if (lastCrash) {
    return (
      <ScrollView contentContainerStyle={styles.errorWrap}>
        <StatusBar style="light" />
        <Text style={styles.errorTitle}>Last crash</Text>
        <Text style={styles.errorStage}>{lastCrash.when}</Text>
        <Text style={styles.errorBody}>{lastCrash.message}</Text>
        {lastCrash.stack ? <Text style={styles.errorStack}>{lastCrash.stack}</Text> : null}
        <TouchableOpacity
          style={styles.clearBtn}
          onPress={async () => {
            try { await AsyncStorage.removeItem(CRASH_KEY); } catch (_) {}
            setLastCrash(null);
          }}
        >
          <Text style={styles.clearBtnText}>Clear and continue</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  if (fatal) {
    return (
      <ScrollView contentContainerStyle={styles.errorWrap}>
        <StatusBar style="light" />
        <Text style={styles.errorTitle}>NEXUS failed to start</Text>
        <Text style={styles.errorStage}>stage: {fatal.stage}</Text>
        <Text style={styles.errorBody}>{fatal.message}</Text>
        {fatal.stack ? <Text style={styles.errorStack}>{fatal.stack}</Text> : null}
      </ScrollView>
    );
  }

  if (phase === 'loading' || !client) {
    return (
      <View style={styles.center}>
        <StatusBar style="light" />
        <ActivityIndicator color="#3ecf8e" />
        <Text style={styles.loading}>Starting NEXUS…</Text>
      </View>
    );
  }

  if (phase === 'pairing') {
    return (
      <View style={styles.root}>
        <StatusBar style="light" />
        <PairingScreen
          client={client}
          onPaired={async (d) => {
            const t = {
              deviceId: d.deviceId,
              name: d.name,
              host: d.host,
              port: d.port,
            };
            await saveTrustedDevice(t);
            setTrusted(t);
            setPhase('permissions');
          }}
        />
      </View>
    );
  }

  if (phase === 'permissions') {
    return (
      <View style={styles.root}>
        <StatusBar style="light" />
        <PermissionsScreen
          desktopName={trusted ? trusted.name : 'your laptop'}
          onContinue={() => setPhase('dashboard')}
        />
      </View>
    );
  }

  if (phase === 'sendFile') {
    return (
      <View style={styles.root}>
        <StatusBar style="light" />
        <SendFileScreen
          client={client}
          desktop={trusted || {}}
          onBack={() => setPhase('dashboard')}
        />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <DashboardScreen
        client={client}
        desktop={trusted || {}}
        onSendFile={() => setPhase('sendFile')}
        onRevoke={async () => {
          await clearTrustedDevice();
          setTrusted(null);
          if (clientRef.current) clientRef.current.close();
          setPhase('pairing');
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0f1115' },
  center: { flex: 1, backgroundColor: '#0f1115', alignItems: 'center', justifyContent: 'center' },
  loading: { color: '#8a8f98', marginTop: 12, fontSize: 13 },
  errorWrap: { backgroundColor: '#0f1115', padding: 20, paddingTop: 60, paddingBottom: 40, flexGrow: 1 },
  errorTitle: { color: '#ff8a8a', fontSize: 20, fontWeight: '700', marginBottom: 12 },
  errorStage: { color: '#8a8f98', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 },
  errorBody: { color: '#e6e8eb', fontSize: 14, lineHeight: 20, marginBottom: 16 },
  errorStack: { color: '#9aa0a8', fontSize: 11, lineHeight: 15, fontFamily: 'monospace' },
  clearBtn: { marginTop: 20, backgroundColor: '#2b6cff', paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  clearBtnText: { color: '#fff', fontWeight: '600' },
});