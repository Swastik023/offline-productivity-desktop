import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltip } from '@angular/material/tooltip';
import { FocusModeService } from '../focus-mode.service';
import { FocusModeLayoutComponent } from '../focus-mode-layout/focus-mode-layout.component';
import { FocusModeMode, getBreakCycle } from '../focus-mode.model';
import { Store } from '@ngrx/store';
import {
  cancelFocusSession,
  completeBreak,
  pauseFocusSession,
  resetCycles,
  skipBreak,
  unPauseFocusSession,
} from '../store/focus-mode.actions';
import { selectPausedTaskId } from '../store/focus-mode.selectors';
import { MatIcon } from '@angular/material/icon';
import { T } from '../../../t.const';
import { TranslatePipe } from '@ngx-translate/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TaskService } from '../../tasks/task.service';
import { GlobalConfigService } from '../../config/global-config.service';
import { MusicWidgetComponent } from '../music-widget/music-widget.component';

export const RANDOM_BG_IMAGE = `assets/pictures/${
  [
    '265C1B67-A368-42D8-B6C8-ABA938CD0D3D.png',
    '8BE67E6A-E794-4D68-8042-3137B42897E3.png',
    'il_1588xN.6523148784_315k.png',
    'il_1588xN.6565940272_hzs4.png',
    'il_1588xN.6699762555_t3bk.png',
  ][Math.floor(Math.random() * 5)]
}`;

@Component({
  selector: 'focus-mode-break',
  standalone: true,
  imports: [
    FocusModeLayoutComponent,
    MatButtonModule,
    MatTooltip,
    MatIcon,
    TranslatePipe,
    MusicWidgetComponent,
  ],
  templateUrl: './focus-mode-break.component.html',
  styleUrl: './focus-mode-break.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FocusModeBreakComponent {
  readonly focusModeService = inject(FocusModeService);
  private readonly _store = inject(Store);
  private readonly _taskService = inject(TaskService);
  private readonly _globalConfigService = inject(GlobalConfigService);
  T: typeof T = T;

  readonly relaxMessageKey = this.focusModeService.breakMessageKey;

  private readonly _pausedTaskId = toSignal(this._store.select(selectPausedTaskId));

  readonly remainingTime = computed(() => {
    return this.focusModeService.timeRemaining() || 0;
  });

  readonly progressPercentage = computed(() => {
    return this.focusModeService.progress() || 0;
  });

  readonly countdownText = computed(() => {
    const timeMs = this.remainingTime();
    if (timeMs <= 0) {
      return '';
    }
    const minutes = Math.floor(timeMs / 60000);
    const seconds = Math.floor((timeMs % 60000) / 1000);

    // Exact Stretchly wording
    if (minutes > 0) {
      return `${minutes} minute${minutes > 1 ? 's' : ''} remaining`;
    } else {
      return `in about ${seconds} second${seconds !== 1 ? 's' : ''}`;
    }
  });

  readonly isBreakPaused = computed(() => this.focusModeService.isSessionPaused());
  readonly isPomodoro = computed(
    () => this.focusModeService.mode() === FocusModeMode.Pomodoro,
  );

  readonly isStrictModeActive = computed(() => {
    if (!this.isPomodoro()) {
      return false;
    }
    const cfg = this._globalConfigService.pomodoroConfig();
    if (!cfg) {
      return false;
    }
    if (this.focusModeService.isBreakLong()) {
      return !!cfg.isStrictLongBreak;
    } else {
      return !!cfg.isStrictShortBreak;
    }
  });

  // currentCycle increments at the end of a focus session, so during the
  // break the store has already moved on. getBreakCycle subtracts 1 (clamped)
  // so the counter shows the cycle the break belongs to — "break of cycle N",
  // matching the user's mental model of "Focus + Break = one cycle".
  readonly displayedCycle = computed(() =>
    getBreakCycle(this.focusModeService.currentCycle() ?? 1),
  );

  readonly breakLabelKey = computed(() => {
    if (this.focusModeService.mode() === FocusModeMode.Flowtime) {
      return T.F.FOCUS_MODE.BREAK_TITLE;
    }
    return this.focusModeService.isBreakLong()
      ? T.F.FOCUS_MODE.LONG_BREAK_TITLE
      : T.F.FOCUS_MODE.SHORT_BREAK_TITLE;
  });

  isLongBreakMessage(key: string): boolean {
    return key?.includes('LONG_BREAK_IDEAS') ?? false;
  }

  skipBreak(): void {
    this._store.dispatch(skipBreak({ pausedTaskId: this._pausedTaskId() }));
  }

  completeBreak(): void {
    this._store.dispatch(completeBreak({ pausedTaskId: this._pausedTaskId() }));
  }

  pauseBreak(): void {
    // Bug #5995 Fix: Prefer currentTaskId (actively tracked task) over stored pausedTaskId
    // - If tracking is active during break: use currentTaskId (ensures effect fires)
    // - If tracking was auto-paused: fall back to stored pausedTaskId
    // This matches the banner's approach for consistent behavior
    const currentTaskId = this._taskService.currentTaskId();
    const storePausedTaskId = this._pausedTaskId();
    const pausedTaskId = currentTaskId || storePausedTaskId;

    this._store.dispatch(pauseFocusSession({ pausedTaskId }));
  }

  resumeBreak(): void {
    this._store.dispatch(unPauseFocusSession());
  }

  resetCycles(): void {
    this._store.dispatch(resetCycles());
  }

  exitToPlanning(): void {
    this._store.dispatch(cancelFocusSession());
  }
}
