import { inject, Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import {
  DialogChangeEncryptionPasswordComponent,
  ChangeEncryptionPasswordResult,
  ChangeEncryptionPasswordDialogData,
} from './dialog-change-encryption-password/dialog-change-encryption-password.component';
import {
  DialogEnableEncryptionComponent,
  EnableEncryptionDialogData,
  EnableEncryptionResult,
} from './dialog-enable-encryption/dialog-enable-encryption.component';
import { firstValueFrom } from 'rxjs';
import { NotifyService } from '../../core/notify/notify.service';
import { T } from '../../t.const';
import type { IncomingInvitation, InvitationOutcome } from '@sp/sync-providers/bluetooth';

// Module-level reference, set by the service constructor
let dialogOpenerInstance: EncryptionPasswordDialogOpenerService | null = null;

const setInstance = (instance: EncryptionPasswordDialogOpenerService): void => {
  dialogOpenerInstance = instance;
};

const callOpener = <T>(fn: (opener: EncryptionPasswordDialogOpenerService) => T): T => {
  if (!dialogOpenerInstance) {
    throw new Error(
      'EncryptionPasswordDialogOpenerService not initialized. ' +
        'Ensure the service is injected before calling dialog functions.',
    );
  }
  return fn(dialogOpenerInstance);
};

/**
 * Singleton service to open the encryption password change dialog.
 * Used by the sync form config which doesn't have direct access to injector.
 *
 * The constructor self-registers the module-level reference so that
 * exported functions work from static form config handlers.
 */
@Injectable({
  providedIn: 'root',
})
export class EncryptionPasswordDialogOpenerService {
  private _matDialog = inject(MatDialog);
  private _notifyService = inject(NotifyService);

  constructor() {
    // Self-register so module-level functions can delegate to this instance
    setInstance(this);
  }

  closeAllDialogs(): void {
    this._matDialog.closeAll();
  }

  async openBluetoothInvitationDialog(
    invitation: IncomingInvitation,
  ): Promise<InvitationOutcome> {
    // The dialog is only visible once the app is in front, so a backgrounded
    // device gets a notification to bring it there; the request stays pending
    // until the user answers.
    void this._notifyService.notify({
      title: T.F.SYNC.FORM.BLUETOOTH.INVITATION_TITLE,
      body: T.F.SYNC.FORM.BLUETOOTH.INVITATION_TEXT,
      translateParams: { deviceName: invitation.inviterDeviceName },
    });

    const { DialogBluetoothInvitationComponent } =
      await import('./dialog-bluetooth-invitation/dialog-bluetooth-invitation.component');
    const dialogRef = this._matDialog.open(DialogBluetoothInvitationComponent, {
      data: invitation,
      disableClose: true,
    });
    const outcome = await firstValueFrom(dialogRef.afterClosed());
    return outcome ?? { decision: 'rejected', isTrustedToInvite: false };
  }

  async openBluetoothRoomDialog(): Promise<void> {
    const { DialogBluetoothRoomComponent } =
      await import('./dialog-bluetooth-room/dialog-bluetooth-room.component');
    this._matDialog.open(DialogBluetoothRoomComponent, { restoreFocus: true });
  }

  openChangePasswordDialog(
    mode: 'full' | 'disable-only' = 'full',
    providerType: 'supersync' | 'file-based' = 'supersync',
  ): Promise<ChangeEncryptionPasswordResult | undefined> {
    const dialogRef = this._matDialog.open(DialogChangeEncryptionPasswordComponent, {
      width: mode === 'disable-only' ? '450px' : '400px',
      disableClose: true,
      data: { mode, providerType } as ChangeEncryptionPasswordDialogData,
    });

    return firstValueFrom(dialogRef.afterClosed());
  }

  openEnableEncryptionDialog(
    providerType: 'supersync' | 'file-based' = 'supersync',
  ): Promise<EnableEncryptionResult | undefined> {
    const dialogRef = this._matDialog.open(DialogEnableEncryptionComponent, {
      width: '450px',
      disableClose: true,
      data: { providerType } as EnableEncryptionDialogData,
    });

    return firstValueFrom(dialogRef.afterClosed());
  }
}

export const openEncryptionPasswordChangeDialog = (): Promise<
  ChangeEncryptionPasswordResult | undefined
> => callOpener((o) => o.openChangePasswordDialog());

export const openEncryptionPasswordChangeDialogForFileBased = (): Promise<
  ChangeEncryptionPasswordResult | undefined
> => callOpener((o) => o.openChangePasswordDialog('full', 'file-based'));

export const openEnableEncryptionDialog = (): Promise<
  EnableEncryptionResult | undefined
> => callOpener((o) => o.openEnableEncryptionDialog());

export const openEnableEncryptionDialogForFileBased = (): Promise<
  EnableEncryptionResult | undefined
> => callOpener((o) => o.openEnableEncryptionDialog('file-based'));

export const openDisableEncryptionDialogForFileBased = (): Promise<
  ChangeEncryptionPasswordResult | undefined
> => callOpener((o) => o.openChangePasswordDialog('disable-only', 'file-based'));

export const closeAllDialogs = (): void => {
  callOpener((o) => o.closeAllDialogs());
};

export const openBluetoothRoomDialog = (): Promise<void> =>
  callOpener((opener) => opener.openBluetoothRoomDialog());

export const openBluetoothInvitationDialog = (
  invitation: IncomingInvitation,
): Promise<InvitationOutcome> =>
  callOpener((opener) => opener.openBluetoothInvitationDialog(invitation));
