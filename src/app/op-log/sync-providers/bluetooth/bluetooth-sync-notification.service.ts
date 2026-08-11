import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { registerPlugin } from '@capacitor/core';
import { firstValueFrom } from 'rxjs';
import { distinctUntilChanged, pairwise, startWith } from 'rxjs/operators';
import { IS_ANDROID_WEB_VIEW } from '../../../util/is-android-web-view';
import { SyncWrapperService } from '../../../imex/sync/sync-wrapper.service';
import { SyncProviderId } from '../provider.const';

interface BluetoothSyncNotifications {
  showSyncProgress(): Promise<void>;
  hideSyncProgress(): Promise<void>;
  showSyncFailure(options: { reason: string }): Promise<void>;
}

const BluetoothSyncBridge =
  registerPlugin<BluetoothSyncNotifications>('BluetoothSyncBridge');

@Injectable({ providedIn: 'root' })
export class BluetoothSyncNotificationService {
  private readonly _syncWrapper = inject(SyncWrapperService);
  private readonly _destroyRef = inject(DestroyRef);

  constructor() {
    if (!IS_ANDROID_WEB_VIEW) {
      return;
    }
    this._syncWrapper.isSyncInProgress$
      .pipe(
        distinctUntilChanged(),
        startWith(false),
        pairwise(),
        takeUntilDestroyed(this._destroyRef),
      )
      .subscribe(([wasRunning, isRunning]) => {
        if (isRunning) {
          void this._showProgressForBluetooth();
        } else if (wasRunning) {
          void BluetoothSyncBridge.hideSyncProgress().catch(() => undefined);
        }
      });
  }

  async reportFailure(reason: string): Promise<void> {
    if (!IS_ANDROID_WEB_VIEW) {
      return;
    }
    await BluetoothSyncBridge.showSyncFailure({ reason }).catch(() => undefined);
  }

  private async _showProgressForBluetooth(): Promise<void> {
    const providerId = await firstValueFrom(this._syncWrapper.syncProviderId$);
    if (providerId !== SyncProviderId.Bluetooth) {
      return;
    }
    await BluetoothSyncBridge.showSyncProgress().catch(() => undefined);
  }
}
