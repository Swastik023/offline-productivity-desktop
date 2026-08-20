import {
  ChangeDetectionStrategy,
  Component,
  computed,
  HostBinding,
  inject,
  signal,
} from '@angular/core';
import { Store } from '@ngrx/store';
import { MatButtonModule, MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatTooltip } from '@angular/material/tooltip';
import { TranslatePipe } from '@ngx-translate/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { T } from '../../../t.const';
import {
  completeBreak,
  cancelFocusSession,
  completeTask,
} from '../store/focus-mode.actions';
import { selectPausedTaskId } from '../store/focus-mode.selectors';
import { FocusModeService } from '../focus-mode.service';
import { FocusModeMode, getBreakCycle } from '../focus-mode.model';
import { TaskService } from '../../tasks/task.service';
import { TaskSharedActions } from '../../../root-store/meta/task-shared.actions';
import { FocusModeLayoutComponent } from '../focus-mode-layout/focus-mode-layout.component';
import { FocusModeTaskRowComponent } from '../focus-mode-task-row/focus-mode-task-row.component';
import { FocusModeTaskSelectorComponent } from '../focus-mode-task-selector/focus-mode-task-selector.component';
import { MusicWidgetComponent } from '../music-widget/music-widget.component';
import { RANDOM_BG_IMAGE } from '../focus-mode-break/focus-mode-break.component';

@Component({
  selector: 'focus-mode-waiting',
  templateUrl: './focus-mode-waiting.component.html',
  styleUrls: ['./focus-mode-waiting.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [
    FocusModeLayoutComponent,
    MatButtonModule,
    MatIconButton,
    MatIcon,
    MatTooltip,
    TranslatePipe,
    FocusModeTaskRowComponent,
    FocusModeTaskSelectorComponent,
    MusicWidgetComponent,
  ],
})
export class FocusModeWaitingComponent {
  private readonly _store = inject(Store);
  readonly focusModeService = inject(FocusModeService);
  private readonly _taskService = inject(TaskService);

  T: typeof T = T;

  private readonly _pausedTaskId = toSignal(this._store.select(selectPausedTaskId));
  readonly currentTask = toSignal(this._taskService.currentTask$);
  readonly isTaskSelectorOpen = signal(false);

  readonly isPomodoro = computed(
    () => this.focusModeService.mode() === FocusModeMode.Pomodoro,
  );

  // The cycle that just completed — mirrors the break component's displayedCycle.
  readonly displayedCycle = computed(() =>
    getBreakCycle(this.focusModeService.currentCycle() ?? 1),
  );

  /** Confirm the break is over and move to Preparation so the user manually starts Focus. */
  startNextFocus(): void {
    this._store.dispatch(completeBreak({ pausedTaskId: this._pausedTaskId() }));
  }

  /** Exit focus mode entirely. */
  exitToPlanning(): void {
    this._store.dispatch(cancelFocusSession());
  }

  // --- Shared task-row controls (only reachable when tracking continues through
  // the break; otherwise the row shows the relax message and these aren't shown).

  openTaskSelector(): void {
    this.isTaskSelectorOpen.set(true);
  }

  closeTaskSelector(): void {
    this.isTaskSelectorOpen.set(false);
  }

  switchTask(taskId: string): void {
    this.closeTaskSelector();
    this._taskService.setCurrentId(taskId);
  }

  finishCurrentTask(): void {
    this._store.dispatch(completeTask());
  }

  updateTaskTitle(wasChanged: boolean, newVal: string): void {
    const task = this.currentTask();
    if (wasChanged && newVal && task) {
      this._store.dispatch(
        TaskSharedActions.updateTask({
          task: {
            id: task.id,
            changes: { title: newVal },
          },
        }),
      );
    }
  }
}
