const { app, BrowserWindow, ipcMain, dialog, Notification, clipboard } = require('electron');
const path = require('path');
const { DesktopAgent } = require('./agent');

let mainWindow;
let agent;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 680,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

const FRIENDLY_COMMAND_NAMES = {
  LOCK_PC: 'lock this PC',
  SLEEP_PC: 'put this PC to sleep',
  VOLUME_UP: 'turn the volume up',
  VOLUME_DOWN: 'turn the volume down',
  VOLUME_SET: 'change the volume',
  MEDIA_PLAY_PAUSE: 'play or pause media',
  MEDIA_NEXT: 'skip to the next track',
  MEDIA_PREVIOUS: 'go to the previous track',
};

app.whenReady().then(() => {
  agent = new DesktopAgent({});
  agent.start();

  const forward = (channel) => (payload) => mainWindow && mainWindow.webContents.send(channel, payload);
  agent.node.on('device-discovered', forward('nexus:device-discovered'));
  agent.node.on('paired', forward('nexus:paired'));
  agent.node.on('permission-request', forward('nexus:permission-request'));
  agent.node.on('device-connected', forward('nexus:device-connected'));
  agent.node.on('device-disconnected', forward('nexus:device-disconnected'));
  agent.node.on('device-revoked', forward('nexus:device-revoked'));
  agent.node.on('revoked-by-peer', forward('nexus:revoked-by-peer'));
  agent.node.on('file-progress', forward('nexus:file-progress'));
  agent.node.on('file-offer-pending', forward('nexus:file-offer-pending'));
  agent.node.on('file-received', forward('nexus:file-received'));
  agent.node.on('file-offer-rejected', forward('nexus:file-offer-rejected'));
  agent.node.on('clipboard', forward('nexus:clipboard'));
  agent.node.on('status', forward('nexus:status'));

  // Incoming clipboard text from the phone gets written straight into
  // Windows' real clipboard, not just logged.
  agent.node.on('clipboard', ({ from, text }) => {
    try {
      clipboard.writeText(text || '');
      console.log(`[nexus] Clipboard from ${from} written to the system clipboard (${(text || '').length} chars)`);
    } catch (e) {
      console.error('[nexus] failed to write incoming clipboard to system clipboard:', e);
    }
  });

  // A completed transfer gets a real native OS notification too, same as
  // forwarded phone notifications below — not just a line in the log.
  agent.node.on('file-received', ({ fileName }) => {
    if (Notification.isSupported()) {
      new Notification({ title: 'NEXUS — file received', body: fileName }).show();
    }
  });

  // Destructive remote-control commands (see COMMANDS_REQUIRING_CONFIRMATION
  // in packages/protocol) pause here for an actual native OS dialog before
  // NexusNode will execute anything — the permission grant on its own is
  // never enough for these.
  agent.node.on('command-confirmation-required', async ({ commandId, command, from }) => {
    try {
      const device = agent.node.store.getDevice(from);
      const friendly = FRIENDLY_COMMAND_NAMES[command] || command;
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Deny', 'Allow'],
        defaultId: 0,
        cancelId: 0,
        title: 'NEXUS — confirm action',
        message: `${device ? device.name : from} wants to ${friendly}`,
        detail: 'This requires confirmation every time, even though the device has REMOTE_CONTROL permission.',
      });
      agent.node.confirmCommand(commandId, response === 1);
    } catch (e) {
      console.error('[nexus] command-confirmation dialog failed:', e);
      agent.node.confirmCommand(commandId, false);
    }
  });

  // Incoming file offer: THIS WAS MISSING ENTIRELY, which is why file
  // sends from the phone always timed out — agent.js logged the offer,
  // but nothing ever called acceptFileOffer()/rejectFileOffer() to
  // actually respond to it. Shows the modal, opens a save dialog on
  // "Save as…", and accepts or rejects accordingly.
  agent.node.on('file-offer-pending', async (payload) => {
    console.log(`[nexus:file] file-offer-pending handler fired for ${payload.fileName}`);
    const { fileId, from, fromName, fileName, fileSize, totalChunks } = payload;

    try {
      const mb = (fileSize / 1024 / 1024).toFixed(2);
      console.log(`[nexus:file] showing modal for ${fileName} (${mb} MB, ${totalChunks} chunks)`);

      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Save as…', 'Reject'],
        defaultId: 0,
        cancelId: 1,
        title: 'NEXUS — incoming file',
        message: `${fromName || from} wants to send you:`,
        detail: `${fileName}  (${mb} MB, ${totalChunks} chunk${totalChunks === 1 ? '' : 's'})`,
      });
      console.log(`[nexus:file] modal closed; response=${response}`);

      if (response !== 0) {
        console.log(`[nexus:file] user rejected ${fileName}`);
        agent.node.rejectFileOffer(fileId, { reason: 'rejected_by_user' });
        return;
      }

      const defaultPath = path.join(agent.receivedFolder, fileName);
      console.log(`[nexus:file] opening save dialog, defaultPath=${defaultPath}`);

      const saveResult = await dialog.showSaveDialog(mainWindow, {
        title: 'Save incoming file',
        defaultPath,
      });
      console.log(`[nexus:file] save dialog closed; canceled=${saveResult.canceled} filePath=${saveResult.filePath}`);

      if (saveResult.canceled || !saveResult.filePath) {
        console.log(`[nexus:file] user cancelled save dialog`);
        agent.node.rejectFileOffer(fileId, { reason: 'rejected_by_user' });
        return;
      }

      const ok = agent.node.acceptFileOffer(fileId, { finalPath: saveResult.filePath });
      console.log(`[nexus:file] acceptFileOffer returned ${ok} for ${fileId} -> ${saveResult.filePath}`);
    } catch (e) {
      console.error('[nexus:file] file-offer dialog failed:', e);
      try { agent.node.rejectFileOffer(fileId, { reason: 'dialog_error' }); } catch (_) {}
    }
  });

  // Forwarded phone notifications get a real native notification here,
  // not just a line in the activity log.
  agent.node.on('notification', ({ notification }) => {
    if (Notification.isSupported()) {
      new Notification({
        title: `${notification.app || 'Phone'}: ${notification.title || ''}`,
        body: notification.body || '',
      }).show();
    }
    forward('nexus:notification')(notification);
  });

  ipcMain.handle('nexus:get-identity', () => ({
    deviceId: agent.node.deviceId,
    deviceName: agent.node.deviceName,
  }));
  ipcMain.handle('nexus:generate-pairing-code', () => agent.generatePairingCode());
  ipcMain.handle('nexus:list-devices', () => agent.node.store.listDevices());
  ipcMain.handle('nexus:get-permissions', (_e, deviceId) => agent.node.getPermissions(deviceId));
  ipcMain.handle('nexus:set-permissions', (_e, { deviceId, perms }) => agent.node.setPermissions(deviceId, perms));
  ipcMain.handle('nexus:revoke-device', (_e, deviceId) => agent.node.revokeDevice(deviceId));
  ipcMain.handle('nexus:audit-log', () => agent.node.store.recentAuditLogs());
  ipcMain.handle('nexus:permissions-catalog', () => require('../../packages/protocol').PERMISSIONS);
  ipcMain.handle('nexus:received-folder', () => agent.receivedFolder);

  // THIS WAS MISSING — preload.js and index.html already call it, which
  // is exactly the "No handler registered for 'nexus:reject-file-offer'"
  // /'nexus:send-clipboard'" errors you were seeing.
  ipcMain.handle('nexus:reject-file-offer', (_e, fileId, reason) => agent.node.rejectFileOffer(fileId, { reason }));

  // Reads the laptop's real clipboard and pushes it to every currently
  // online trusted device (in practice, your one paired phone).
  ipcMain.handle('nexus:send-clipboard', () => {
    const text = clipboard.readText();
    if (!text) return { ok: false, message: 'Laptop clipboard is empty.' };
    const targets = agent.node.store.listDevices().filter((d) => d.trusted && d.status === 'online');
    if (targets.length === 0) return { ok: false, message: 'No connected device to send to.' };
    let sent = 0;
    for (const d of targets) {
      try {
        agent.node.sendClipboard(d.deviceId, text);
        sent++;
      } catch (e) {
        console.error(`[nexus] sendClipboard to ${d.deviceId} failed:`, e.message);
      }
    }
    if (sent === 0) return { ok: false, message: 'Failed to send to any connected device.' };
    return { ok: true, message: `Sent to ${sent} device${sent === 1 ? '' : 's'}.`, preview: text.slice(0, 60) };
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (agent) agent.stop();
  if (process.platform !== 'darwin') app.quit();
});