import { inject, Injectable } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { createEffect, ofType } from '@ngrx/effects';
import { setCurrentTask, unsetCurrentTask } from './task.actions';
import { select, Store } from '@ngrx/store';
import {
  filter,
  startWith,
  take,
  tap,
  throttleTime,
  withLatestFrom,
} from 'rxjs/operators';
import { selectCurrentTask, selectTaskEntities } from './task.selectors';
import { selectTodayTaskIds } from '../../work-context/store/work-context.selectors';
import { GlobalConfigService } from '../../config/global-config.service';
import {
  selectIsOverlayShown,
  selectPausedTaskId,
  selectPausedWorkContext,
} from '../../focus-mode/store/focus-mode.selectors';
import { TimeTrackingActions } from '../../time-tracking/store/time-tracking.actions';
import { FocusModeService } from '../../focus-mode/focus-mode.service';
import {
  cancelFocusSession,
  completeFocusSession,
  hideFocusOverlay,
  pauseFocusSession,
  showFocusOverlay,
  startFocusSession,
  tick,
  unPauseFocusSession,
} from '../../focus-mode/store/focus-mode.actions';
import { IPC } from '../../../../../electron/shared-with-frontend/ipc-events.const';
import { TaskService } from '../task.service';
import { TaskSharedActions } from '../../../root-store/meta/task-shared.actions';
import { LOCAL_ACTIONS } from '../../../util/local-actions.token';
import { DateService } from '../../../core/date/date.service';

// TODO send message to electron when current task changes here

@Injectable()
export class TaskElectronEffects {
  private _actions$ = inject(LOCAL_ACTIONS);
  private _store$ = inject<Store<any>>(Store);
  private _configService = inject(GlobalConfigService);
  private _focusModeService = inject(FocusModeService);
  private _taskService = inject(TaskService);
  private _dateService = inject(DateService);
  private _isBreakActive$ = toObservable(this._focusModeService.isBreakActive);

  // -----------------------------------------------------------------------------------
  // NOTE: IS_ELECTRON checks not necessary, since we check before importing this module
  // -----------------------------------------------------------------------------------

  constructor() {
    /**
     * SYNC-SAFE: This IPC listener is safe during sync/hydration because:
     * - Read-only operation - only reads current state and sends to Electron
     * - No store mutations or action dispatches
     * - Responds to explicit IPC request, not store-change driven
     * - take(1) ensures single response per request
     */
    window.ea.on(IPC.REQUEST_CURRENT_TASK_FOR_TASK_WIDGET, () => {
      this._store$
        .pipe(
          select(selectCurrentTask),
          withLatestFrom(
            this._store$.pipe(select(selectIsOverlayShown)),
            this._focusModeService.currentSessionTime$,
            this._isBreakActive$,
            this._store$.pipe(select(selectPausedTaskId)),
            this._store$.pipe(select(selectPausedWorkContext)),
            this._store$.pipe(select(selectTaskEntities)),
          ),
          // Only take the first value and complete
          take(1),
        )
        .subscribe(
          ([
            current,
            isFocusModeEnabled,
            currentFocusSessionTime,
            isBreakActive,
            pausedTaskId,
            pausedWorkContext,
            taskEntities,
          ]) => {
            const pausedTask = (pausedTaskId ? taskEntities[pausedTaskId] : null) ?? null;
            const pausedWorkContextTitle = pausedWorkContext?.title || null;

            window.ea.updateCurrentTask(
              current,
              false, // isPomodoroEnabled - legacy, always false
              0, // currentPomodoroSessionTime - legacy, always 0
              isFocusModeEnabled,
              currentFocusSessionTime,
              this._focusModeService.mode(),
              {
                isInBreak: isBreakActive,
                pausedTask,
                pausedWorkContextTitle,
              },
            );
          },
        );
    });

    window.ea.onSwitchTask((taskId) => {
      this._taskService.setCurrentId(taskId);
    });
  }

  syncTodayTasksToElectron$ = createEffect(
    () =>
      this._store$.pipe(
        select(selectTodayTaskIds),
        withLatestFrom(this._store$.pipe(select(selectTaskEntities))),
        tap(([todayTaskIds, taskEntities]) => {
          const tasks = todayTaskIds
            .map((id) => taskEntities[id])
            .filter((t) => !!t && !t.isDone)
            .map((t) => ({
              id: t!.id,
              title: t!.title,
              timeEstimate: t!.timeEstimate,
              timeSpent: t!.timeSpent,
              timeSpentToday: t!.timeSpentOnDay[this._dateService.todayStr()] || 0,
            }));
          window.ea.updateTodayTasks(tasks);
        }),
      ),
    { dispatch: false },
  );

  taskChangeElectron$ = createEffect(
    () =>
      this._actions$.pipe(
        ofType(
          setCurrentTask,
          unsetCurrentTask,
          TimeTrackingActions.addTimeSpent,
          showFocusOverlay,
          hideFocusOverlay,
          startFocusSession,
          cancelFocusSession,
          pauseFocusSession,
          unPauseFocusSession,
          completeFocusSession,
          // Keep tray time in sync during focus-mode breaks and focus sessions
          // without an active task (addTimeSpent is gated on currentTask.id).
          tick,
        ),
        // addTimeSpent and tick both fire every 1s during an active-task focus
        // session (same shared globalInterval source), so collapse them into a
        // single IPC/sec. Leading+trailing preserves immediate feedback for the
        // non-tick actions (setCurrentTask, startFocusSession, ...).
        throttleTime(500, undefined, { leading: true, trailing: true }),
        withLatestFrom(
          this._store$.pipe(select(selectCurrentTask)),
          this._store$.pipe(select(selectIsOverlayShown)),
          this._focusModeService.currentSessionTime$.pipe(startWith(0)),
          this._focusModeService.timeToGo$.pipe(startWith(0)),
          this._isBreakActive$,
          this._store$.pipe(select(selectPausedTaskId)),
          this._store$.pipe(select(selectPausedWorkContext)),
          this._store$.pipe(select(selectTaskEntities)),
        ),
        tap(
          ([
            action,
            current,
            isFocusModeEnabled,
            currentFocusSessionTime,
            timeToGo,
            isBreakActive,
            pausedTaskId,
            pausedWorkContext,
            taskEntities,
          ]) => {
            // Get paused task information during breaks
            const pausedTask = (pausedTaskId ? taskEntities[pausedTaskId] : null) ?? null;
            const pausedWorkContextTitle = pausedWorkContext?.title || null;

            const isFlowtime = this._focusModeService.mode() === 'Flowtime';
            const timeToPass = isFlowtime ? currentFocusSessionTime : timeToGo;

            window.ea.updateCurrentTask(
              current,
              false, // isPomodoroEnabled - legacy, always false
              0, // currentPomodoroSessionTime - legacy, always 0
              isFocusModeEnabled,
              timeToPass,
              this._focusModeService.mode(),
              // Add break mode data
              {
                isInBreak: isBreakActive,
                pausedTask,
                pausedWorkContextTitle,
              },
            );
          },
        ),
      ),
    { dispatch: false },
  );

  setTaskBarNoProgress$ = createEffect(
    () =>
      this._actions$.pipe(
        ofType(setCurrentTask),
        tap(({ id }) => {
          if (!id) {
            window.ea.setProgressBar({
              progress: -1,
              progressBarMode: 'none',
            });
          }
        }),
      ),
    { dispatch: false },
  );

  clearTaskBarOnTaskDone$ = createEffect(
    () =>
      this._actions$.pipe(
        ofType(TaskSharedActions.updateTask),
        tap(({ task }) => {
          if (task.changes.isDone) {
            window.ea.setProgressBar({
              progress: -1,
              progressBarMode: 'none',
            });
          }
        }),
      ),
    { dispatch: false },
  );

  setTaskBarProgress$ = createEffect(
    () =>
      this._actions$.pipe(
        ofType(TimeTrackingActions.addTimeSpent),
        // The OS taskbar progress bar moves imperceptibly per second; throttling
        // collapses 1 IPC/sec into ~1 IPC/3s. Leading+trailing keeps the first
        // tick after start instant and the final value at the end of a window.
        throttleTime(3000, undefined, { leading: true, trailing: true }),
        withLatestFrom(this._store$.select(selectIsOverlayShown)),
        // Don't show progress bar when focus session is running
        filter(([a, isFocusSessionRunning]) => !isFocusSessionRunning),
        tap(([{ task }]) => {
          const progress = task.timeSpent / task.timeEstimate;
          window.ea.setProgressBar({
            progress,
            progressBarMode: 'normal',
          });
        }),
      ),
    { dispatch: false },
  );
}
