import { inject, Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { Store } from '@ngrx/store';
import { BannerService } from '../../core/banner/banner.service';
import { BannerId } from '../../core/banner/banner.model';
import { LS } from '../../core/persistence/storage-keys.const';
import { GlobalConfigService } from '../../features/config/global-config.service';
import { OnboardingHintService } from '../../features/onboarding/onboarding-hint.service';
import { selectTaskFeatureState } from '../../features/tasks/store/task.selectors';
import { devError } from '../../util/dev-error';
import { T } from '../../t.const';
import { OperationLogStoreService } from '../../op-log/persistence/operation-log-store.service';
import { interval } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DestroyRef } from '@angular/core';

const DAY_MS = 24 * 60 * 60 * 1000;

// "Used for a while": wall-clock days since the app was first opened on this
// device. Wall-clock (not app-start count) so it is robust both to users who
// restart many times a day and to those who leave the app running for weeks.
const MIN_DAYS_SINCE_FIRST_USE = 7;

// ...and there must be a non-trivial amount of data actually worth protecting:
// a fresh install seeds only 4 example tasks, so this keeps us from nudging an
// empty/dormant app even after the time threshold passes.
const MIN_TASKS = 20;

/**
 * Offline-first means a user who never configures sync has no backup at all.
 * Once they have clearly used the app for a while AND accumulated real data,
 * gently (and exactly once) encourage setting up sync so their data stays safe.
 * Mirrors the calm, gated-once pattern of NoteStartupBannerService.
 */
@Injectable({ providedIn: 'root' })
export class SyncSafetyBannerService {
  private readonly _bannerService = inject(BannerService);
  private readonly _globalConfigService = inject(GlobalConfigService);
  private readonly _matDialog = inject(MatDialog);
  private readonly _store = inject(Store);
  private readonly _opLogStore = inject(OperationLogStoreService);
  private readonly _destroyRef = inject(DestroyRef);

  private readonly _taskState = this._store.selectSignal(selectTaskFeatureState);
  private _isOpLogBackpressureCheckStarted = false;

  showReminderIfNeeded(): void {
    // Once-ever guard: already acted on / dismissed.
    if (localStorage.getItem(LS.SYNC_SAFETY_NUDGE_DISMISSED)) {
      return;
    }
    // Start (or read) the first-use clock. Seeding here means it begins ticking
    // the first time the app boots on this device; an install that already
    // exists when this feature ships starts its clock now (a deliberate grace
    // period rather than nudging every existing user at once).
    const firstUseMs = this._getOrSeedFirstUse();

    // Don't interrupt the first-run onboarding flow.
    if (OnboardingHintService.isOnboardingInProgress()) {
      return;
    }
    // Already using sync → nothing to nudge. Treat "config not loaded yet"
    // (undefined) as a skip too, so a synced user is never nudged in a race.
    const sync = this._globalConfigService.sync();
    if (!sync || (sync.isEnabled && sync.syncProvider)) {
      return;
    }
    // Used for a while?
    if (Date.now() - firstUseMs < MIN_DAYS_SINCE_FIRST_USE * DAY_MS) {
      return;
    }
    // Enough data to be worth protecting?
    if ((this._taskState().ids?.length ?? 0) < MIN_TASKS) {
      return;
    }

    this._bannerService.open({
      id: BannerId.SyncSafetyReminder,
      msg: T.APP.B_SYNC_SAFETY.MSG,
      ico: 'cloud_off',
      action: {
        label: T.APP.B_SYNC_SAFETY.SETUP,
        fn: () => {
          this._dismissForever();
          void this._openSyncCfgDialog().catch(devError);
        },
      },
      action2: {
        label: T.APP.B_SYNC_SAFETY.DISMISS,
        fn: () => this._dismissForever(),
      },
      isHideDismissBtn: true,
    });
  }

  private _getOrSeedFirstUse(): number {
    const stored = +(localStorage.getItem(LS.SYNC_SAFETY_FIRST_SEEN) || 0);
    if (stored) {
      return stored;
    }
    const now = Date.now();
    localStorage.setItem(LS.SYNC_SAFETY_FIRST_SEEN, now.toString());
    return now;
  }

  private _dismissForever(): void {
    localStorage.setItem(LS.SYNC_SAFETY_NUDGE_DISMISSED, 'true');
  }

  private async _openSyncCfgDialog(): Promise<void> {
    const { DialogSyncCfgComponent } =
      await import('./dialog-sync-cfg/dialog-sync-cfg.component');
    this._matDialog.open(DialogSyncCfgComponent);
  }

  startOpLogBackpressureCheck(): void {
    if (this._isOpLogBackpressureCheckStarted) {
      return;
    }
    this._isOpLogBackpressureCheckStarted = true;

    // Check every 10 minutes for extreme backpressure in the local OpLog queue
    interval(10 * 60 * 1000)
      .pipe(takeUntilDestroyed(this._destroyRef))
      .subscribe(async () => {
        const sync = this._globalConfigService.sync();
        if (!sync?.isEnabled || !sync.syncProvider) {
          return;
        }

        try {
          const unsynced = await this._opLogStore.getUnsynced();
          if (unsynced.length > 2000) {
            this._bannerService.open({
              id: BannerId.OpLogBackpressureWarning,
              msg: T.APP.B_OP_LOG_BACKPRESSURE.MSG,
              translateParams: { count: unsynced.length },
              ico: 'warning',
              action: {
                label: T.APP.B_OP_LOG_BACKPRESSURE.SETTINGS,
                fn: () => {
                  this._bannerService.dismiss(BannerId.OpLogBackpressureWarning);
                  void this._openSyncCfgDialog().catch(devError);
                },
              },
              action2: {
                label: T.APP.B_OP_LOG_BACKPRESSURE.DISMISS,
                fn: () => this._bannerService.dismiss(BannerId.OpLogBackpressureWarning),
              },
              isHideDismissBtn: true,
            });
          } else {
            // Dismiss automatically if queue recovers
            this._bannerService.dismiss(BannerId.OpLogBackpressureWarning);
          }
        } catch (e) {
          devError(e);
        }
      });
  }
}
