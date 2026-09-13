import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert } from 'react-native';
import * as Clipboard from 'expo-clipboard';

export default function DashboardScreen({ client, desktop, onRevoke, onSendFile }) {
  const [status, setStatus] = useState(null);
  const [perms, setPerms] = useState({
    FILE_SEND: false, FILE_RECEIVE: false, CLIPBOARD_WRITE: false,
    REMOTE_CONTROL: false, NOTIFICATIONS: false,
  });
  const [probing, setProbing] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const [sendingClip, setSendingClip] = useState(false);
  const [lastClipSent, setLastClipSent] = useState(null);
  const [lastClipReceived, setLastClipReceived] = useState(null);
  const [mediaBusy, setMediaBusy] = useState(null); // which media command is in flight, or null

  useEffect(() => {
    const onStatus = (s) => setStatus(s.status);
    client.on('status', onStatus);
    return () => client.off('status', onStatus);
  }, [client]);

  // Incoming clipboard text from the laptop — write it straight into the
  // phone's own clipboard so it's ready to paste anywhere.
  useEffect(() => {
    const onClipboard = async (c) => {
      try {
        await Clipboard.setStringAsync(c.text || '');
        setLastClipReceived({ text: c.text || '', at: new Date() });
      } catch (e) {
        console.warn('[nexus] failed to write incoming clipboard to phone:', e && e.message);
      }
    };
    // The laptop sends back an ERROR envelope (inResponseTo: 'CLIPBOARD_UPDATE')
    // if this phone doesn't have CLIPBOARD_WRITE permission granted — surface
    // that instead of failing silently.
    const onPeerError = (e) => {
      if (e && e.inResponseTo === 'CLIPBOARD_UPDATE') {
        Alert.alert('Clipboard blocked', e.message || 'The laptop rejected this clipboard update — check CLIPBOARD_WRITE permission.');
      }
    };
    client.on('clipboard', onClipboard);
    client.on('peer-error', onPeerError);
    return () => {
      client.off('clipboard', onClipboard);
      client.off('peer-error', onPeerError);
    };
  }, [client]);

  async function sendClipboardToLaptop() {
    setSendingClip(true);
    try {
      const text = await Clipboard.getStringAsync();
      if (!text) {
        Alert.alert('Nothing to send', 'Your phone clipboard is empty.');
        return;
      }
      client.sendClipboard(desktop.deviceId, text);
      setLastClipSent({ text, at: new Date() });
    } catch (e) {
      Alert.alert('Clipboard error', e && e.message ? e.message : String(e));
    } finally {
      setSendingClip(false);
    }
  }

  async function probe() {
    setProbing(true);
    const next = { ...perms };
    try {
      const r = await client.sendCommand(desktop.deviceId, 'VOLUME_UP');
      next.REMOTE_CONTROL = !!r.ok && !/permission denied/i.test(r.message || '');
      setLastResult(r);
    } catch (e) {
      setLastResult({ ok: false, message: e.message });
    }
    setPerms(next);
    setProbing(false);
  }

  async function sendCommand(cmd) {
    try {
      const r = await client.sendCommand(desktop.deviceId, cmd);
      setLastResult(r);
      if (!r.ok) Alert.alert('Command failed', r.message || 'unknown');
    } catch (e) {
      Alert.alert('Command error', e.message);
    }
  }

  // Same idea as sendCommand() above, but tracks WHICH media button is
  // in flight so we can disable just that one instead of the whole
  // section — media taps tend to happen in quick succession (skip, skip,
  // pause) and locking the entire row for each round trip feels laggy.
  async function sendMediaCommand(cmd) {
    setMediaBusy(cmd);
    try {
      const r = await client.sendCommand(desktop.deviceId, cmd);
      setLastResult(r);
      if (!r.ok) Alert.alert('Media command failed', r.message || 'unknown');
    } catch (e) {
      Alert.alert('Media command error', e.message);
    } finally {
      setMediaBusy(null);
    }
  }

  const preview = (text, n = 60) => (text.length > n ? `${text.slice(0, n)}…` : text);
  const timeOf = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.heading}>Connected to</Text>
      <Text style={styles.deviceName}>{desktop.name}</Text>

      <Section title="Device status">
        {status ? (
          <View>
            <Row k="CPU" v={`${status.cpu}%`} />
            <Row k="Memory" v={`${status.memory}%`} />
            <Row k="Platform" v={status.platform || '—'} />
            <Row k="Hostname" v={status.hostname || '—'} />
          </View>
        ) : (
          <Text style={styles.muted}>Waiting for first status push (desktop sends every 5s)…</Text>
        )}
      </Section>

      <Section title="Files">
        <TouchableOpacity style={styles.action} onPress={onSendFile}>
          <Text style={styles.actionText}>📤  Send file to laptop</Text>
        </TouchableOpacity>
        <Text style={[styles.muted, { marginTop: 8 }]}>
          Files land in <Text style={styles.mono}>~/.nexus/desktop/received/</Text> on your laptop.
        </Text>
      </Section>

      <Section title="Clipboard">
        <TouchableOpacity style={styles.action} onPress={sendClipboardToLaptop} disabled={sendingClip}>
          <Text style={styles.actionText}>{sendingClip ? 'Sending…' : '📋  Send phone clipboard to laptop'}</Text>
        </TouchableOpacity>
        {lastClipSent && (
          <Text style={[styles.muted, { marginTop: 4 }]}>
            Sent at {timeOf(lastClipSent.at)}: "{preview(lastClipSent.text)}"
          </Text>
        )}
        {lastClipReceived && (
          <Text style={[styles.muted, { marginTop: 4 }]}>
            📥 From laptop at {timeOf(lastClipReceived.at)}: "{preview(lastClipReceived.text)}" — copied to this phone's clipboard.
          </Text>
        )}
        {!lastClipSent && !lastClipReceived && (
          <Text style={[styles.muted, { marginTop: 8 }]}>
            Copies text between this phone and your laptop over the encrypted NEXUS session.
          </Text>
        )}
      </Section>

      <Section title="Remote control">
        <TouchableOpacity style={styles.action} onPress={() => sendCommand('VOLUME_UP')}>
          <Text style={styles.actionText}>🔊 Volume Up</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.action} onPress={() => sendCommand('VOLUME_DOWN')}>
          <Text style={styles.actionText}>🔉 Volume Down</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.action} onPress={() => sendCommand('LOCK_PC')}>
          <Text style={styles.actionText}>🔒 Lock</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.action} onPress={() => sendCommand('SLEEP_PC')}>
          <Text style={styles.actionText}>💤 Sleep (desktop will ask for confirmation)</Text>
        </TouchableOpacity>
      </Section>

      <Section title="Media">
        <View style={styles.mediaRow}>
          <MediaButton
            icon="⏮"
            label="Previous"
            busy={mediaBusy === 'MEDIA_PREVIOUS'}
            disabled={!!mediaBusy}
            onPress={() => sendMediaCommand('MEDIA_PREVIOUS')}
          />
          <MediaButton
            icon="⏯"
            label="Play/Pause"
            busy={mediaBusy === 'MEDIA_PLAY_PAUSE'}
            disabled={!!mediaBusy}
            onPress={() => sendMediaCommand('MEDIA_PLAY_PAUSE')}
          />
          <MediaButton
            icon="⏭"
            label="Next"
            busy={mediaBusy === 'MEDIA_NEXT'}
            disabled={!!mediaBusy}
            onPress={() => sendMediaCommand('MEDIA_NEXT')}
          />
        </View>
        <Text style={[styles.muted, { marginTop: 10 }]}>
          Controls whatever's playing on the laptop (Spotify, YouTube, etc.)
          via the OS media keys. There's a single hardware-level play/pause
          toggle rather than distinct play and pause actions on most
          systems, so ⏯ always toggles either way.
        </Text>
      </Section>

      <Section title="Permissions">
        <Text style={styles.muted}>
          The phone cannot grant its own permissions. To change them, open NEXUS Desktop Agent on
          your laptop → Trusted Devices → Permissions.
        </Text>
        <TouchableOpacity style={styles.action} onPress={probe} disabled={probing}>
          <Text style={styles.actionText}>{probing ? 'Probing…' : 'Check remote control'}</Text>
        </TouchableOpacity>
        {lastResult && (
          <Text style={[styles.muted, { marginTop: 8 }]}>
            Last command result: {lastResult.ok ? '✅' : '❌'} {lastResult.message}
          </Text>
        )}
      </Section>

      <Section title="Security">
        <TouchableOpacity style={[styles.action, styles.danger]} onPress={onRevoke}>
          <Text style={[styles.actionText, { color: '#ff8a8a' }]}>Revoke this laptop on the phone</Text>
        </TouchableOpacity>
        <Text style={[styles.muted, { marginTop: 8 }]}>
          (The authoritative revocation is on the desktop. Doing it here just forgets the pairing locally and requires a full re-pair next time.)
        </Text>
      </Section>
    </ScrollView>
  );
}

function Section({ title, children }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}
function Row({ k, v }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowKey}>{k}</Text>
      <Text style={styles.rowVal}>{v}</Text>
    </View>
  );
}
function MediaButton({ icon, label, onPress, busy, disabled }) {
  return (
    <TouchableOpacity
      style={[styles.mediaButton, disabled && styles.mediaButtonDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.mediaIcon}>{busy ? '…' : icon}</Text>
      <Text style={styles.mediaLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: '#0f1115', padding: 20, paddingTop: 60, paddingBottom: 40 },
  heading: { color: '#8a8f98', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 },
  deviceName: { color: '#e6e8eb', fontSize: 22, fontWeight: '700', marginTop: 4, marginBottom: 24 },
  section: { borderTopWidth: 1, borderTopColor: '#1a1c21', paddingVertical: 16 },
  sectionTitle: { color: '#8a8f98', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  rowKey: { color: '#8a8f98', fontSize: 13 },
  rowVal: { color: '#e6e8eb', fontSize: 13 },
  action: { backgroundColor: '#181b21', paddingVertical: 12, paddingHorizontal: 14, borderRadius: 8, marginBottom: 8 },
  actionText: { color: '#e6e8eb', fontSize: 14 },
  danger: { backgroundColor: '#2a1a1c' },
  muted: { color: '#6b7078', fontSize: 12, lineHeight: 17 },
  mono: { fontFamily: 'monospace', color: '#9aa0a8' },
  mediaRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  mediaButton: { flex: 1, backgroundColor: '#181b21', borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
  mediaButtonDisabled: { opacity: 0.5 },
  mediaIcon: { fontSize: 22, color: '#e6e8eb' },
  mediaLabel: { fontSize: 11, color: '#8a8f98', marginTop: 4 },
});