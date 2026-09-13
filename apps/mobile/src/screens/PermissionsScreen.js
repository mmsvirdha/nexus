import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';

const REQUESTED = [
  { key: 'FILE_SEND',        label: 'Send files to your laptop' },
  { key: 'FILE_RECEIVE',     label: 'Receive files from your laptop' },
  { key: 'CLIPBOARD_WRITE',  label: "Write to your laptop's clipboard" },
  { key: 'REMOTE_CONTROL',   label: 'Remote control (volume, media, lock, sleep — sleep still needs laptop confirmation)' },
  { key: 'NOTIFICATIONS',    label: 'Forward phone notifications to your laptop' },
];

export default function PermissionsScreen({ desktopName, onContinue }) {
  const [probing, setProbing] = useState(false);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Permissions</Text>
      <Text style={styles.subtitle}>
        {desktopName} will now decide which of these to grant. Nothing on this phone can grant them.
      </Text>

      {REQUESTED.map((p) => (
        <View key={p.key} style={styles.row}>
          <Text style={styles.rowKey}>{p.key}</Text>
          <Text style={styles.rowLabel}>{p.label}</Text>
          <Text style={styles.rowStatus}>Requested</Text>
        </View>
      ))}

      <View style={styles.note}>
        <Text style={styles.noteTitle}>Approve them on your laptop</Text>
        <Text style={styles.noteBody}>
          Open NEXUS Desktop Agent → Trusted Devices → Permissions. Tick the ones you want this phone to have. There is no way for the phone to approve them for you — that is on purpose.
        </Text>
      </View>

      <TouchableOpacity style={styles.primary} onPress={onContinue}>
        <Text style={styles.primaryText}>Continue to dashboard</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: '#0f1115', padding: 24, paddingTop: 60 },
  title: { color: '#e6e8eb', fontSize: 22, fontWeight: '700' },
  subtitle: { color: '#8a8f98', fontSize: 13, marginTop: 6, marginBottom: 20, lineHeight: 18 },
  row: { borderTopWidth: 1, borderTopColor: '#1a1c21', paddingVertical: 12 },
  rowKey: { color: '#6b7078', fontSize: 11, letterSpacing: 1 },
  rowLabel: { color: '#e6e8eb', fontSize: 14, marginTop: 2 },
  rowStatus: { color: '#f5c563', fontSize: 11, marginTop: 4, textTransform: 'uppercase', letterSpacing: 1 },
  note: { backgroundColor: '#181b21', padding: 12, borderRadius: 8, marginTop: 24 },
  noteTitle: { color: '#e6e8eb', fontWeight: '600', marginBottom: 6 },
  noteBody: { color: '#9aa0a8', fontSize: 12, lineHeight: 17 },
  primary: { marginTop: 24, backgroundColor: '#2b6cff', paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '600' },
});