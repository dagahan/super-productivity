import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import {
  MatDialogActions,
  MatDialogContent,
  MatDialogRef,
  MatDialogTitle,
  MAT_DIALOG_DATA,
} from '@angular/material/dialog';
import { MatButton } from '@angular/material/button';
import { MatCheckbox } from '@angular/material/checkbox';
import { TranslatePipe } from '@ngx-translate/core';
import type { IncomingInvitation, InvitationOutcome } from '@sp/sync-providers/bluetooth';
import { T } from '../../../t.const';

@Component({
  selector: 'dialog-bluetooth-invitation',
  templateUrl: './dialog-bluetooth-invitation.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatDialogTitle,
    MatDialogContent,
    MatDialogActions,
    MatButton,
    MatCheckbox,
    TranslatePipe,
  ],
})
export class DialogBluetoothInvitationComponent {
  private readonly _matDialogRef =
    inject<MatDialogRef<DialogBluetoothInvitationComponent, InvitationOutcome>>(
      MatDialogRef,
    );

  readonly invitation = inject<IncomingInvitation>(MAT_DIALOG_DATA);
  readonly T = T;
  readonly isTrustedToInvite = signal(false);

  constructor() {
    this._matDialogRef.disableClose = true;
  }

  accept(): void {
    this._matDialogRef.close({
      decision: 'accepted',
      isTrustedToInvite: this.isTrustedToInvite(),
    });
  }

  reject(): void {
    this._matDialogRef.close({ decision: 'rejected', isTrustedToInvite: false });
  }
}
