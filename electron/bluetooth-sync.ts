import { app, ipcMain, BrowserWindow } from 'electron';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'fs/promises';
import { join, resolve, sep } from 'path';
import { IPC } from './shared-with-frontend/ipc-events.const';
import { log } from 'electron-log/main';

interface HelperCommand {
  id: number;
  cmd: string;
  [key: string]: unknown;
}

interface HelperResponse {
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: string;
  event?: string;
  linkId?: string;
  dataBase64?: string;
  reason?: string;
  peerDeviceId?: string;
}

const HELPER_RELATIVE_PATHS = [
  join('..', 'sp-bluetooth-helper'),
  join('electron', 'assets', 'sp-bluetooth-helper'),
];

const SHARED_STORE_DIR_NAME = 'bluetooth-sync';

class BluetoothHelperProcess {
  private helper: ChildProcessWithoutNullStreams | null = null;
  private pendingByCommandId = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private nextCommandId = 0;
  private stdoutBuffer = '';

  constructor(
    private readonly emitToRenderer: (channel: string, payload: unknown) => void,
  ) {}

  isSupported(): boolean {
    return process.platform === 'darwin' && this.resolveHelperPath() !== null;
  }

  async send(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const helper = this.ensureStarted();
    this.nextCommandId += 1;
    const id = this.nextCommandId;
    const command: HelperCommand = { id, cmd, ...args };

    return await new Promise((resolveCommand, rejectCommand) => {
      this.pendingByCommandId.set(id, {
        resolve: resolveCommand,
        reject: rejectCommand,
      });
      helper.stdin.write(`${JSON.stringify(command)}\n`);
    });
  }

  stop(): void {
    this.helper?.kill();
    this.helper = null;
  }

  private resolveHelperPath(): string | null {
    for (const relativePath of HELPER_RELATIVE_PATHS) {
      const candidate = join(app.getAppPath(), relativePath);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.helper) {
      return this.helper;
    }
    const helperPath = this.resolveHelperPath();
    if (!helperPath) {
      throw new Error('Bluetooth sync helper binary is not bundled with this build');
    }

    const helper = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    helper.stdout.setEncoding('utf8');
    helper.stdout.on('data', (chunk: string) => this.acceptStdout(chunk));
    helper.stderr.setEncoding('utf8');
    helper.stderr.on('data', (chunk: string) =>
      log('[bluetooth-helper] ' + chunk.trim()),
    );
    helper.on('exit', (code) => this.handleHelperExit(code));

    this.helper = helper;
    return helper;
  }

  private acceptStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.acceptMessage(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private acceptMessage(line: string): void {
    let message: HelperResponse;
    try {
      message = JSON.parse(line) as HelperResponse;
    } catch {
      log('[bluetooth-helper] unparsable line');
      return;
    }

    if (message.event) {
      this.emitEvent(message);
      return;
    }
    if (message.id === undefined) {
      return;
    }
    const pending = this.pendingByCommandId.get(message.id);
    if (!pending) {
      return;
    }
    this.pendingByCommandId.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result ?? null);
    } else {
      pending.reject(new Error(message.error ?? 'Bluetooth helper command failed'));
    }
  }

  private emitEvent(message: HelperResponse): void {
    if (message.event === 'data') {
      this.emitToRenderer(IPC.BLUETOOTH_SYNC_LINK_DATA, {
        linkId: message.linkId,
        dataBase64: message.dataBase64,
      });
    } else if (message.event === 'linkClosed') {
      this.emitToRenderer(IPC.BLUETOOTH_SYNC_LINK_CLOSED, {
        linkId: message.linkId,
        reason: message.reason ?? null,
      });
    } else if (message.event === 'incomingLink') {
      this.emitToRenderer(IPC.BLUETOOTH_SYNC_INCOMING_LINK, {
        linkId: message.linkId,
        peerDeviceId: message.peerDeviceId ?? '',
      });
    }
  }

  private handleHelperExit(code: number | null): void {
    log(`[bluetooth-helper] exited with code ${code}`);
    this.helper = null;
    const exitError = new Error('Bluetooth helper exited');
    for (const pending of this.pendingByCommandId.values()) {
      pending.reject(exitError);
    }
    this.pendingByCommandId.clear();
  }
}

const sharedStoreDir = (): string => join(app.getPath('userData'), SHARED_STORE_DIR_NAME);

const resolveInsideSharedStore = (relativePath: string): string => {
  const root = sharedStoreDir();
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('Bluetooth shared file path escapes the shared store');
  }
  return target;
};

export const initBluetoothSync = (getMainWindow: () => BrowserWindow | null): void => {
  const helper = new BluetoothHelperProcess((channel, payload) => {
    getMainWindow()?.webContents.send(channel, payload);
  });

  ipcMain.handle(IPC.BLUETOOTH_SYNC_IS_AVAILABLE, async () => {
    if (!helper.isSupported()) {
      return false;
    }
    const result = (await helper.send('isAvailable')) as { isAvailable: boolean } | null;
    return result?.isAvailable === true;
  });

  ipcMain.handle(IPC.BLUETOOTH_SYNC_GET_LOCAL_DEVICE_NAME, async () => {
    const result = (await helper.send('localDeviceName')) as {
      deviceName: string;
    } | null;
    return result?.deviceName ?? 'Mac';
  });

  ipcMain.handle(IPC.BLUETOOTH_SYNC_LIST_PAIRED_DEVICES, async () =>
    helper.send('listPaired'),
  );

  ipcMain.handle(
    IPC.BLUETOOTH_SYNC_CONNECT,
    async (_event, args: { platformAddress: string }) =>
      helper.send('connect', { platformAddress: args.platformAddress }),
  );

  ipcMain.handle(
    IPC.BLUETOOTH_SYNC_WRITE,
    async (_event, args: { linkId: string; dataBase64: string }) =>
      helper.send('write', args),
  );

  ipcMain.handle(
    IPC.BLUETOOTH_SYNC_CLOSE_LINK,
    async (_event, args: { linkId: string }) => helper.send('close', args),
  );

  ipcMain.handle(IPC.BLUETOOTH_SYNC_START_LISTENING, async () =>
    helper.send('startListening'),
  );

  ipcMain.handle(IPC.BLUETOOTH_SYNC_STOP_LISTENING, async () => {
    helper.stop();
    return null;
  });

  ipcMain.handle(
    IPC.BLUETOOTH_SYNC_READ_SHARED_FILE,
    async (_event, args: { filePath: string }) =>
      readFile(resolveInsideSharedStore(args.filePath), 'utf8'),
  );

  ipcMain.handle(
    IPC.BLUETOOTH_SYNC_WRITE_SHARED_FILE,
    async (_event, args: { filePath: string; dataStr: string }) => {
      const target = resolveInsideSharedStore(args.filePath);
      await mkdir(sharedStoreDir(), { recursive: true });
      const temporaryTarget = `${target}.${process.pid}.tmp`;
      await writeFile(temporaryTarget, args.dataStr, 'utf8');
      await rename(temporaryTarget, target);
      return null;
    },
  );

  ipcMain.handle(
    IPC.BLUETOOTH_SYNC_DELETE_SHARED_FILE,
    async (_event, args: { filePath: string }) => {
      await unlink(resolveInsideSharedStore(args.filePath)).catch(() => undefined);
      return null;
    },
  );

  ipcMain.handle(
    IPC.BLUETOOTH_SYNC_LIST_SHARED_FILES,
    async (_event, args: { dirPath: string }) => {
      const target = resolveInsideSharedStore(args.dirPath || '.');
      try {
        return await readdir(target);
      } catch {
        return [];
      }
    },
  );

  app.on('before-quit', () => helper.stop());
};
