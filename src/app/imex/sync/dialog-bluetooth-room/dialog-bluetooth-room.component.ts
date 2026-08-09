import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import {
  MatDialogActions,
  MatDialogContent,
  MatDialogRef,
  MatDialogTitle,
} from '@angular/material/dialog';
import { MatButton } from '@angular/material/button';
import { MatCheckbox } from '@angular/material/checkbox';
import { MatIcon } from '@angular/material/icon';
import { MatIconButton } from '@angular/material/button';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { TranslatePipe } from '@ngx-translate/core';
import type { BluetoothRoomMember } from '@sp/sync-providers/bluetooth';
import { T } from '../../../t.const';
import { loadSyncProviders } from '../../../op-log/sync-providers/sync-providers.factory';
import { SyncProviderId } from '../../../op-log/sync-providers/provider.const';
import type { BluetoothRoomEditor } from '../../../op-log/sync-providers/bluetooth/bluetooth-sync';
import type { BluetoothPairedDevice } from '../../../op-log/sync-providers/bluetooth/bluetooth-platform.port';

@Component({
  selector: 'dialog-bluetooth-room',
  templateUrl: './dialog-bluetooth-room.component.html',
  styleUrl: './dialog-bluetooth-room.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatDialogTitle,
    MatDialogContent,
    MatDialogActions,
    MatButton,
    MatIconButton,
    MatCheckbox,
    MatIcon,
    MatProgressSpinner,
    TranslatePipe,
  ],
})
export class DialogBluetoothRoomComponent {
  private readonly _matDialogRef =
    inject<MatDialogRef<DialogBluetoothRoomComponent>>(MatDialogRef);

  readonly T = T;
  readonly isLoading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly members = signal<BluetoothRoomMember[]>([]);
  readonly addableDevices = signal<BluetoothPairedDevice[]>([]);

  private editor: BluetoothRoomEditor | null = null;

  constructor() {
    void this._load();
  }

  readonly invitingAddress = signal<string | null>(null);

  async inviteDevice(device: BluetoothPairedDevice): Promise<void> {
    this.loadError.set(null);
    this.invitingAddress.set(device.platformAddress);
    try {
      const result = await this.editor?.invitePairedDevice(
        device.platformAddress,
        device.deviceName,
      );
      if (result?.decision !== 'accepted') {
        this.loadError.set('The other device declined the request.');
        return;
      }
      const room = await this.editor?.loadRoom();
      this.members.set(room?.members ?? []);
      await this._refreshAddableDevices();
    } catch (error) {
      this.loadError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.invitingAddress.set(null);
    }
  }

  removeMember(deviceId: string): void {
    this.members.update((current) =>
      current.filter((member) => member.deviceId !== deviceId),
    );
    this._refreshAddableDevices();
  }

  setTrustedToInvite(deviceId: string, isTrustedToInvite: boolean): void {
    this.members.update((current) =>
      current.map((member) =>
        member.deviceId === deviceId ? { ...member, isTrustedToInvite } : member,
      ),
    );
  }

  async save(): Promise<void> {
    try {
      await this.editor?.saveRoomMembers(this.members());
      this._matDialogRef.close(true);
    } catch (error) {
      this.loadError.set(error instanceof Error ? error.message : String(error));
    }
  }

  close(): void {
    this._matDialogRef.close(false);
  }

  private async _load(): Promise<void> {
    try {
      const providers = await loadSyncProviders();
      const provider = providers.find((entry) => entry.id === SyncProviderId.Bluetooth);
      this.editor = provider as unknown as BluetoothRoomEditor | null;
      if (!this.editor) {
        this.loadError.set('Bluetooth sync is not available on this device');
        return;
      }
      const room = await this.editor.loadRoom();
      this.members.set(room.members);
      await this._refreshAddableDevices();
    } catch (error) {
      this.loadError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.isLoading.set(false);
    }
  }

  private async _refreshAddableDevices(): Promise<void> {
    const paired = (await this.editor?.listPairedDevices()) ?? [];
    const memberAddresses = new Set(
      this.members().map((member) => member.platformAddress),
    );
    this.addableDevices.set(
      paired.filter((device) => !memberAddresses.has(device.platformAddress)),
    );
  }
}
