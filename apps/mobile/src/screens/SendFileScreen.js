/**
 * NEXUS Mobile — Send File screen.
 *
 * Pick a file from the phone, send it to the paired laptop over the
 * existing encrypted channel. The laptop shows an accept dialog before
 * any bytes are sent. Progress is live. Errors are shown inline.
 */

import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';

const STATES = {
  IDLE: 'idle',
  PICKING: 'picking',
  WAITING: 'waiting',
  SENDING: 'sending',
  SENT: 'sent',
  REJECTED: 'rejected',
  FAILED: 'failed',
};

export default function SendFileScreen({ client, desktop, onBack }) {
  const [state, setState] = useState(STATES.IDLE);
  const [fileName, setFileName] = useState(null);
  const [fileSize, setFileSize] = useState(0);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const [sentCount, setSentCount] = useState(0);

  async function pickAndSend() {
    setError(null);
    setState(STATES.PICKING);
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled) {
        setState(STATES.IDLE);
        return;
      }
      const asset = picked.assets && picked.assets[0];
      if (!asset || !asset.uri) throw new Error('No file selected');
      const name = asset.name || 'file.bin';
      const size = typeof asset.size === 'number' ? asset.size : 0;
      setFileName(name);
      setFileSize(size);
      setProgress(0);
      setState(STATES.WAITING);

      // Resolves once the laptop accepts. Rejects if the laptop declines
      // or if the timeout fires.
      await client.sendFile(desktop.deviceId, asset.uri, { fileName: name });

      // Accepted — chunks are streaming. Attach progress listener.
      const onProgress = (p) => {
        const pct = Math.round(((p.chunkIndex + 1) / p.totalChunks) * 100);
        setProgress(pct);
      };
      client.on('file-progress', onProgress);
      setState(STATES.SENDING);

      // Wait for the "file-sent" event (all chunks + FILE_COMPLETE sent)
      // or for a "file-error".
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          client.off('file-sent', onSent);
          client.off('file-error', onError);
          client.off('file-progress', onProgress);
        };
        const onSent = () => { cleanup(); resolve(); };
        const onError = (e) => { cleanup(); reject(new Error(e.reason || 'transfer failed')); };
        client.on('file-sent', onSent);
        client.on('file-error', onError);
      });

      setState(STATES.SENT);
      setSentCount((n) => n + 1);
    } catch (e) {
      console.warn('[nexus] send file failed:', e && e.message);
      const msg = e && e.message ? e.message : String(e);
      setError(msg);
      // A rejection from the laptop (e.g. "declined the file") shows a
      // friendlier, distinct state from a network / timeout failure.
      if (/declined|rejected|not granted/i.test(msg)) {
        setState(STATES.REJECTED);
      } else {
        setState(STATES.FAILED);
      }
    }
  }

  function reset() {
    setState(STATES.IDLE);
    setFileName(null);
    setFileSize(0);
    setProgress(0);
    setError(null);
  }

  const humanSize = (bytes) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.heading}>Send file to</Text>
      <Text style={styles.deviceName}>{desktop.name || 'your laptop'}</Text>

      {state === STATES.IDLE && sentCount > 0 && (
        <View style={styles.successBox}>
          <Text style={styles.successTitle}>✓ Sent</Text>
          <Text style={styles.successBody}>Last file was delivered to your laptop.</Text>
        </View>
      )}

      {state === STATES.PICKING && (
        <View style={styles.centerRow}>
          <ActivityIndicator color="#3ecf8e" />
          <Text style={styles.status}>Opening file picker…</Text>
        </View>
      )}

      {state === STATES.WAITING && (
        <View>
          <View style={styles.centerRow}>
            <ActivityIndicator color="#3ecf8e" />
            <Text style={styles.status}>Waiting for the laptop to accept…</Text>
          </View>
          <View style={styles.fileBox}>
            <Text style={styles.fileName}>{fileName}</Text>
            <Text style={styles.fileMeta}>{humanSize(fileSize)}</Text>
          </View>
          <Text style={styles.muted}>
            A dialog should be showing on your laptop. Click "Save as…" to
            choose where to save this file.
          </Text>
        </View>
      )}

      {state === STATES.SENDING && (
        <View style={styles.progressBox}>
          <Text style={styles.fileName}>{fileName}</Text>
          <Text style={styles.fileMeta}>{humanSize(fileSize)}</Text>
          <View style={styles.progressOuter}>
            <View style={[styles.progressInner, { width: `${progress}%` }]} />
          </View>
          <Text style={styles.progressText}>{progress}%</Text>
        </View>
      )}

      {state === STATES.SENT && (
        <View style={styles.successBox}>
          <Text style={styles.successTitle}>✓ File sent</Text>
          <Text style={styles.successBody}>
            {fileName} ({humanSize(fileSize)}) was delivered to your laptop.
          </Text>
        </View>
      )}

      {state === STATES.REJECTED && (
        <View style={styles.warnBox}>
          <Text style={styles.warnTitle}>Laptop declined the file</Text>
          <Text style={styles.warnBody}>{error}</Text>
        </View>
      )}

      {state === STATES.FAILED && (
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>Send failed</Text>
          <Text style={styles.errorBody}>{error}</Text>
        </View>
      )}

      {state === STATES.IDLE && (
        <TouchableOpacity style={styles.primary} onPress={pickAndSend}>
          <Text style={styles.primaryText}>Pick a file to send</Text>
        </TouchableOpacity>
      )}

      {(state === STATES.SENT || state === STATES.REJECTED || state === STATES.FAILED) && (
        <TouchableOpacity style={styles.primary} onPress={reset}>
          <Text style={styles.primaryText}>Send another file</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity
        style={styles.secondary}
        onPress={onBack}
        disabled={state === STATES.SENDING || state === STATES.WAITING}
      >
        <Text style={styles.secondaryText}>Back to dashboard</Text>
      </TouchableOpacity>

      <Text style={styles.hint}>
        Files are sent over the encrypted NEXUS session. Your laptop asks
        where to save each file before any bytes are sent.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: '#0f1115', padding: 20, paddingTop: 60, paddingBottom: 40 },
  heading: { color: '#8a8f98', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 },
  deviceName: { color: '#e6e8eb', fontSize: 22, fontWeight: '700', marginTop: 4, marginBottom: 24 },
  primary: { marginTop: 16, backgroundColor: '#2b6cff', paddingVertical: 14, borderRadius: 8, alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  secondary: { marginTop: 10, backgroundColor: '#181b21', paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  secondaryText: { color: '#c8ccd2', fontSize: 14 },
  status: { color: '#8a8f98', marginLeft: 8, fontSize: 13 },
  muted: { color: '#6b7078', fontSize: 12, marginTop: 12, lineHeight: 17 },
  centerRow: { flexDirection: 'row', alignItems: 'center', marginTop: 16 },
  fileBox: { backgroundColor: '#181b21', borderRadius: 10, padding: 16, marginTop: 16 },
  fileName: { color: '#e6e8eb', fontSize: 15, fontWeight: '600' },
  fileMeta: { color: '#8a8f98', fontSize: 12, marginTop: 2 },
  progressBox: { backgroundColor: '#181b21', borderRadius: 10, padding: 16, marginTop: 8 },
  progressOuter: { height: 8, backgroundColor: '#0f1115', borderRadius: 4, overflow: 'hidden', marginTop: 12 },
  progressInner: { height: '100%', backgroundColor: '#3ecf8e' },
  progressText: { color: '#8a8f98', fontSize: 12, marginTop: 6, textAlign: 'right' },
  successBox: { backgroundColor: '#122a20', borderRadius: 10, padding: 16, marginTop: 8, borderWidth: 1, borderColor: '#1f4a36' },
  successTitle: { color: '#3ecf8e', fontSize: 15, fontWeight: '700' },
  successBody: { color: '#c8ccd2', fontSize: 13, marginTop: 4, lineHeight: 18 },
  warnBox: { backgroundColor: '#2a2410', borderRadius: 10, padding: 16, marginTop: 8, borderWidth: 1, borderColor: '#4a3a14' },
  warnTitle: { color: '#f5c563', fontSize: 15, fontWeight: '700' },
  warnBody: { color: '#c8ccd2', fontSize: 13, marginTop: 4, lineHeight: 18 },
  errorBox: { backgroundColor: '#2a1a1c', borderRadius: 10, padding: 16, marginTop: 8 },
  errorTitle: { color: '#ff8a8a', fontSize: 15, fontWeight: '700' },
  errorBody: { color: '#c8ccd2', fontSize: 13, marginTop: 4, lineHeight: 18 },
  hint: { color: '#6b7078', fontSize: 12, marginTop: 24, lineHeight: 17, fontStyle: 'italic' },
});