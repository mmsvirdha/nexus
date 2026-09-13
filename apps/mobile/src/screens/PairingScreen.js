import React, { useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ActivityIndicator, StyleSheet, ScrollView,
} from 'react-native';

const STATES = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  DISCOVERED: 'discovered',
  PAIRING: 'pairing',
  SUCCESS: 'success',
  INVALID_CODE: 'invalid-code',
  UNAVAILABLE: 'unavailable',
};

export default function PairingScreen({ client, onPaired }) {
  const [state, setState] = useState(STATES.IDLE);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('8342');
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  // Captured at discovery time; render must NEVER read client._remote.
  const [remoteId, setRemoteId] = useState(null);
  const [remoteName, setRemoteName] = useState(null);
  const inputs = useRef([]);
  // Hold onPaired in a ref so our setTimeout callback can't recurse into
  // a stale prop reference. The previous version of this file had a
  // closure bug that produced "Maximum call stack size exceeded".
  const onPairedRef = useRef(onPaired);
  onPairedRef.current = onPaired;

  const normalizedCode = code.replace(/\s+/g, '').slice(0, 6);

  function connect() {
    setError(null);
    setState(STATES.CONNECTING);
    const cleanup = [];
    const onDiscovered = (d) => {
      cleanup.forEach((fn) => fn());
      setRemoteId(d.deviceId);
      setRemoteName(d.name);
      setState(STATES.DISCOVERED);
    };
    const onError = (e) => {
      cleanup.forEach((fn) => fn());
      setError(e && e.message ? e.message : String(e));
      setState(STATES.UNAVAILABLE);
    };
    client.once('device-discovered', onDiscovered);
    client.once('error', onError);
    cleanup.push(() => client.off('device-discovered', onDiscovered));
    cleanup.push(() => client.off('error', onError));
    try {
      client.connect(host.trim(), Number(port));
    } catch (e) {
      onError(e);
    }
  }

  function pair() {
    if (normalizedCode.length !== 6 || !remoteId) return;
    setState(STATES.PAIRING);

    const onRejected = (r) => {
      client.off('paired', onSuccess);
      setError(r && r.reason === 'invalid_or_expired_code'
        ? 'The pairing code is invalid or expired.'
        : `Pairing failed: ${(r && r.reason) || 'unknown'}`);
      setState(STATES.INVALID_CODE);
    };
    const onSuccess = (d) => {
      client.off('pair-rejected', onRejected);
      setState(STATES.SUCCESS);
      // Read from the ref at timeout-fire time, not at closure-creation time.
      // This is what prevents the "Maximum call stack size exceeded" we saw
      // when the old version of this file used a plain variable that ended
      // up referring to itself.
      const cb = onPairedRef.current;
      setTimeout(() => {
        if (cb) cb({ deviceId: d.deviceId, name: d.name, host: d.host, port: d.port });
      }, 800);
    };

    client.once('paired', onSuccess);
    client.once('pair-rejected', onRejected);
    client.requestPairing(remoteId, normalizedCode, [
      'FILE_RECEIVE', 'FILE_SEND', 'REMOTE_CONTROL', 'NOTIFICATIONS', 'CLIPBOARD_WRITE',
    ]);
  }

  // ---- render ----
  if (state === STATES.IDLE || state === STATES.CONNECTING || state === STATES.UNAVAILABLE) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>NEXUS</Text>
        <Text style={styles.subtitle}>Connect your laptop</Text>
        <Text style={styles.hint}>
          Make sure the NEXUS Desktop Agent is running, and enter the laptop's LAN address below.
          {"\n"}Do not use localhost — that means this phone.
        </Text>
        <TextInput
          style={styles.input}
          placeholder="Laptop address (e.g. 192.168.8.145)"
          placeholderTextColor="#6b7078"
          value={host}
          onChangeText={setHost}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="numbers-and-punctuation"
        />
        <TextInput
          style={styles.input}
          placeholder="Port (8342)"
          placeholderTextColor="#6b7078"
          value={port}
          onChangeText={setPort}
          keyboardType="number-pad"
        />
        {state === STATES.CONNECTING && <ActivityIndicator color="#3ecf8e" style={{ marginTop: 16 }} />}
        {state === STATES.CONNECTING && <Text style={styles.status}>Connecting…</Text>}
        {state === STATES.UNAVAILABLE && (
          <View style={styles.errorBox}>
            <Text style={styles.errorTitle}>Laptop not found</Text>
            <Text style={styles.errorBody}>{error || 'Check that the desktop agent is running and on the same Wi-Fi.'}</Text>
          </View>
        )}
        <TouchableOpacity
          style={[styles.primary, (!host || state === STATES.CONNECTING) && styles.disabled]}
          onPress={connect}
          disabled={!host || state === STATES.CONNECTING}
        >
          <Text style={styles.primaryText}>{state === STATES.UNAVAILABLE ? 'Retry' : 'Connect'}</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  if (state === STATES.DISCOVERED || state === STATES.PAIRING || state === STATES.INVALID_CODE) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>{remoteName || 'your laptop'}</Text>
        <Text style={styles.subtitle}>
          Enter the 6-digit code shown on your laptop.
        </Text>
        <View style={styles.codeRow}>
          {Array.from({ length: 6 }).map((_, i) => (
            <TextInput
              key={i}
              ref={(el) => (inputs.current[i] = el)}
              style={styles.codeBox}
              keyboardType="number-pad"
              maxLength={1}
              value={code[i] || ''}
              onChangeText={(v) => {
                const clean = v.replace(/\D/g, '');
                const next = (code.slice(0, i) + clean + code.slice(i + 1)).slice(0, 6);
                setCode(next);
                if (clean && i < 5) inputs.current[i + 1] && inputs.current[i + 1].focus();
              }}
              onKeyPress={(e) => {
                if (e.nativeEvent.key === 'Backspace' && !code[i] && i > 0) {
                  inputs.current[i - 1] && inputs.current[i - 1].focus();
                }
              }}
            />
          ))}
        </View>
        <TextInput
          style={[styles.input, { marginTop: 16 }]}
          placeholder="Or paste: 432 280"
          placeholderTextColor="#6b7078"
          value={code}
          onChangeText={(v) => setCode(v.replace(/\s+/g, '').slice(0, 6))}
          keyboardType="number-pad"
        />
        {state === STATES.INVALID_CODE && (
          <View style={styles.errorBox}>
            <Text style={styles.errorTitle}>Pairing failed</Text>
            <Text style={styles.errorBody}>{error}</Text>
          </View>
        )}
        {state === STATES.PAIRING ? (
          <View style={{ marginTop: 24, alignItems: 'center' }}>
            <ActivityIndicator color="#3ecf8e" />
            <Text style={styles.status}>Securing connection…</Text>
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.primary, (normalizedCode.length !== 6 || !remoteId) && styles.disabled]}
            onPress={pair}
            disabled={normalizedCode.length !== 6 || !remoteId}
          >
            <Text style={styles.primaryText}>Pair Device</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    );
  }

  if (state === STATES.SUCCESS) {
    return (
      <View style={styles.container}>
        <Text style={styles.successMark}>✓</Text>
        <Text style={styles.title}>{remoteName || 'your laptop'}</Text>
        <Text style={styles.subtitle}>Laptop paired</Text>
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: '#0f1115', alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { color: '#e6e8eb', fontSize: 24, fontWeight: '700', letterSpacing: 1 },
  subtitle: { color: '#8a8f98', fontSize: 15, marginTop: 6, marginBottom: 20, textAlign: 'center' },
  hint: { color: '#6b7078', fontSize: 12, textAlign: 'center', lineHeight: 18, marginBottom: 20, maxWidth: 300 },
  input: { width: '100%', maxWidth: 320, backgroundColor: '#181b21', color: '#e6e8eb', borderRadius: 8, padding: 12, marginTop: 8 },
  codeRow: { flexDirection: 'row', gap: 6, marginVertical: 8 },
  codeBox: { width: 42, height: 52, backgroundColor: '#181b21', color: '#e6e8eb', borderRadius: 8, textAlign: 'center', fontSize: 20, fontWeight: '600' },
  primary: { marginTop: 24, backgroundColor: '#2b6cff', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 },
  primaryText: { color: '#fff', fontWeight: '600' },
  disabled: { opacity: 0.5 },
  status: { color: '#8a8f98', marginTop: 8, fontSize: 13 },
  errorBox: { marginTop: 16, backgroundColor: '#2a1a1c', padding: 12, borderRadius: 8, maxWidth: 320 },
  errorTitle: { color: '#ff8a8a', fontWeight: '600', marginBottom: 4 },
  errorBody: { color: '#c8ccd2', fontSize: 12, lineHeight: 16 },
  successMark: { color: '#3ecf8e', fontSize: 44, marginBottom: 8 },
});