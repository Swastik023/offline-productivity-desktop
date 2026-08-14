import { inject, Injectable } from '@angular/core';
import { createEffect, ofType } from '@ngrx/effects';
import { LOCAL_ACTIONS } from '../../../util/local-actions.token';
import { Action, Store } from '@ngrx/store';
import { TranslateService } from '@ngx-translate/core';
import { combineLatest, defer, EMPTY, of, Observable } from 'rxjs';
import { skipWhileApplyingRemoteOps } from '../../../util/skip-during-sync.operator';
import {
  distinctUntilChanged,
  filter,
  map,
  pairwise,
  switchMap,
  take,
  tap,
  throttleTime,
  withLatestFrom,
} from 'rxjs/operators';
import * as actions from './focus-mode.actions';
import * as selectors from './focus-mode.selectors';
import { FocusModeStrategyFactory } from '../focus-mode-strategies';
import { GlobalConfigService } from '../../config/global-config.service';
import { TaskService } from '../../tasks/task.service';
import { WorkContextService } from '../../work-context/work-context.service';
import { playSound } from '../../../util/play-sound';
import { startWhiteNoise, stopWhiteNoise } from '../../../util/white-noise';
import { startBreakEndAlarm, stopBreakEndAlarm } from '../../../util/break-end-alarm';
import { FocusModeLocalSettingsService } from '../../config/focus-mode-local-settings.service';
import { IS_ELECTRON } from '../../../app.constants';
import { setCurrentTask, unsetCurrentTask } from '../../tasks/store/task.actions';
import { selectLastCurrentTask, selectTaskById } from '../../tasks/store/task.selectors';
import { setActiveWorkContext } from '../../work-context/store/work-context.actions';
import { openIdleDialog } from '../../idle/store/idle.actions';
import { LS } from '../../../core/persistence/storage-keys.const';
import {
  selectFocusModeConfig,
  selectIsFocusModeEnabled,
  selectPomodoroConfig,
  selectIdleConfig,
} from '../../config/store/global-config.reducer';
import { updateGlobalConfigSection } from '../../config/store/global-config.actions';
import {
  FocusModeMode,
  FocusScreen,
  getBreakCycle,
  TimerState,
} from '../focus-mode.model';
import { FocusModeStorageService } from '../focus-mode-storage.service';
import { TakeABreakService } from '../../take-a-break/take-a-break.service';
import { NotifyService } from '../../../core/notify/notify.service';
import { getNextIdeaKey } from '../focus-mode-break-idea.util';
import { msToString } from '../../../ui/duration/ms-to-string.pipe';
import { T } from '../../../t.const';
import { IS_ANDROID_WEB_VIEW_TOKEN } from '../../../util/is-android-web-view';
import { BannerService } from '../../../core/banner/banner.service';
import { BannerId } from '../../../core/banner/banner.model';
import { ipcIdleTime$ } from '../../../core/ipc-events';

import { MetricService } from '../../metric/metric.service';
const SESSION_DONE_SOUND = 'positive.mp3';
const TICK_SOUND = 'tick.mp3';
/** Focus-mode ambient sounds play at 40% of the user's main volume to avoid being intrusive. */
const FOCUS_SOUND_VOLUME_FACTOR = 0.4;

@Injectable()
export class FocusModeEffects {
  ipcIdleTime$ = ipcIdleTime$;

  private actions$ = inject(LOCAL_ACTIONS);
  private store = inject(Store);
  private strategyFactory = inject(FocusModeStrategyFactory);
  private globalConfigService = inject(GlobalConfigService);
  private taskService = inject(TaskService);
  private workContextService = inject(WorkContextService);
  private metricService = inject(MetricService);
  private storageService = inject(FocusModeStorageService);
  private takeABreakService = inject(TakeABreakService);
  private notifyService = inject(NotifyService);
  private bannerService = inject(BannerService);
  private isAndroidWebView = inject(IS_ANDROID_WEB_VIEW_TOKEN);
  private focusModeLocalSettingsService = inject(FocusModeLocalSettingsService);
  private translateService = inject(TranslateService);

  // Sync: When tracking starts → resume/skip-break or auto-spawn a new session.
  //
  // Sync (always): if a session/break is in progress, keep it in lockstep with
  // tracking — resume paused work, skip a stale break, etc.
  //
  // Auto-spawn (opt-in via `autoStartFocusOnPlay`): if no session is active and
  // the user has opted in, start a new session quietly. The overlay is NOT
  // dispatched — surface comes from the existing banner / future indicator.
  // Inside the overlay we still respect `isShowPreparation` so #7384's
  // rocket-prep flow keeps working for users who opted into the prep screen.
  syncTrackingStartToSession$ = createEffect(() =>
    this.taskService.currentTaskId$.pipe(
      skipWhileApplyingRemoteOps(),
      // currentTaskId$ is local UI state (not synced), so distinctUntilChanged is sufficient
      distinctUntilChanged(),
      filter((taskId) => !!taskId),
      withLatestFrom(
        this.store.select(selectFocusModeConfig),
        this.store.select(selectIsFocusModeEnabled),
      ),
      filter(([_taskId, _cfg, isFocusModeEnabled]) => isFocusModeEnabled),
      withLatestFrom(
        this.store.select(selectors.selectTimer),
        this.store.select(selectors.selectMode),
        this.store.select(selectors.selectCurrentScreen),
        this.store.select(selectors.selectIsOverlayShown),
        // Bug #5995 Fix: Get the LATEST value of isResumingBreak here
        // to avoid using stale value from outer closure
        this.store.select(selectors.selectIsResumingBreak),
      ),
      switchMap(
        ([
          [_taskId, cfg],
          timer,
          mode,
          currentScreen,
          isOverlayShown,
          isResumingBreak,
        ]) => {
          // If session is paused (purpose is 'work' but not running), resume it
          if (timer.purpose === 'work' && !timer.isRunning) {
            return of(actions.unPauseFocusSession());
          }
          // If break is active, handle based on state and cause
          // Bug #5995 Fix: Don't skip breaks that were just resumed
          if (timer.purpose === 'break') {
            // Check store flag to distinguish between break resume and manual tracking start
            if (isResumingBreak) {
              // Clear flag after processing to prevent false positives
              // Don't skip the break - just clear the flag
              return of(actions.clearResumingBreakFlag());
            }
            // User manually started tracking during break
            // Skip the break to sync with tracking (bug #5875 fix)
            // Bug #6726 fix: Don't pass pausedTaskId — the user already chose a new task
            return of(actions.skipBreak({ pausedTaskId: undefined }));
          }
          // No session active: auto-spawn only when the user opted in.
          if (timer.purpose === null && currentScreen === FocusScreen.Main) {
            if (!cfg?.autoStartFocusOnPlay) {
              return EMPTY;
            }
            // Bug #7384: respect isShowPreparation only inside the overlay
            // (preparation screen is overlay-bound). When the user opted into the
            // prep screen, let the manual Start click drive it; the quiet
            // auto-spawn path (no overlay) has no rocket and bypasses the gate.
            if (isOverlayShown && cfg?.isShowPreparation) {
              return EMPTY;
            }
            const strategy = this.strategyFactory.getStrategy(mode);
            const duration = strategy.initialSessionDuration;
            return of(
              actions.startFocusSession({
                duration,
              }),
            );
          }
          return EMPTY;
        },
      ),
    ),
  );

  // Sync: When tracking stops → pause focus session (both work and break)
  // Uses pairwise to capture the previous task ID before it's lost
  // Only triggers when focus mode feature is enabled
  // Bug #5954 fix: Also pause breaks when tracking stops
  syncTrackingStopToSession$ = createEffect(() =>
    this.taskService.currentTaskId$.pipe(
      // CRITICAL: Prevent cascading dispatches during sync that cause app freeze.
      // Without this, rapid currentTaskId changes from remote ops trigger pairwise()
      // which dispatches pauseFocusSession repeatedly, overwhelming the store.
      skipWhileApplyingRemoteOps(),
      pairwise(),
      withLatestFrom(
        this.store.select(selectors.selectTimer),
        this.store.select(selectIsFocusModeEnabled),
      ),
      filter(
        ([[prevTaskId, currTaskId], timer, isFocusModeEnabled]) =>
          isFocusModeEnabled &&
          (timer.purpose === 'work' || timer.purpose === 'break') &&
          timer.isRunning &&
          !!prevTaskId &&
          !currTaskId, // Was tracking (prevTaskId exists) and now stopped (currTaskId is null)
      ),
      map(([[prevTaskId]]) => actions.pauseFocusSession({ pausedTaskId: prevTaskId })),
    ),
  );

  // Sync: When focus session pauses → stop tracking
  // Skip when currentTaskId is already null (pause originated from tracking stop,
  // which already cleared it); redundant dispatch would clobber lastCurrentTaskId.
  syncSessionPauseToTracking$ = createEffect(() =>
    this.actions$.pipe(
      ofType(actions.pauseFocusSession),
      withLatestFrom(
        this.store.select(selectors.selectTimer),
        this.taskService.currentTaskId$,
      ),
      filter(
        ([action, timer, currentTaskId]) =>
          (timer.purpose === 'work' || timer.purpose === 'break') &&
          !!action.pausedTaskId &&
          !!currentTaskId,
      ),
      map(() => unsetCurrentTask()),
    ),
  );

  // Sync: When focus session resumes → start tracking
  // Checks that the paused task still exists before resuming tracking
  syncSessionResumeToTracking$ = createEffect(() =>
    this.actions$.pipe(
      ofType(actions.unPauseFocusSession),
      withLatestFrom(
        this.store.select(selectFocusModeConfig),
        this.store.select(selectors.selectTimer),
        this.store.select(selectors.selectPausedTaskId),
        this.taskService.currentTaskId$,
      ),
      switchMap(([_action, cfg, timer, pausedTaskId, currentTaskId]) => {
        if (timer.purpose !== 'work' && timer.purpose !== 'break') {
          return EMPTY;
        }
        // Bug #6534 Fix: Clear _isResumingBreak flag when not resuming tracking during break.
        // Without this, the flag stays stale and causes syncTrackingStartToSession$
        // to treat the next manual tracking start as a break resume.
        if (timer.purpose === 'break' && cfg?.isPauseTrackingDuringBreak) {
          return of(actions.clearResumingBreakFlag());
        }
        if (currentTaskId || !pausedTaskId) {
          return EMPTY;
        }
        return this.store.select(selectTaskById, { id: pausedTaskId }).pipe(
          take(1),
          filter((task) => !!task),
          map(() => setCurrentTask({ id: pausedTaskId })),
        );
      }),
    ),
  );

  // Sync: When focus session starts → start or switch tracking
  // An explicitly selected task takes precedence over existing and resumable tasks.
  // Checks that the paused task still exists before starting tracking
  // Bug #5954 fix: Falls back to lastCurrentTask if no pausedTaskId (e.g., after app restart)
  // Bug #5954 fix: Shows focus overlay if no valid (undone) task is available
  syncSessionStartToTracking$ = createEffect(() =>
    this.actions$.pipe(
      ofType(actions.startFocusSession),
      withLatestFrom(
        this.store.select(selectors.selectPausedTaskId),
        this.taskService.currentTaskId$,
        this.store.select(selectLastCurrentTask),
      ),
      filter(([action, pausedTaskId, currentTaskId, lastCurrentTask]) =>
        action.taskId
          ? action.taskId !== currentTaskId
          : !currentTaskId && (!!pausedTaskId || !!lastCurrentTask),
      ),
      switchMap(([action, pausedTaskId, _currentTaskId, lastCurrentTask]) => {
        // Prefer an explicit selection, then pausedTaskId, then lastCurrentTask.
        const taskIdToResume = action.taskId || pausedTaskId || lastCurrentTask?.id;
        if (!taskIdToResume) return EMPTY;

        return this.store.select(selectTaskById, { id: taskIdToResume }).pipe(
          take(1),
          switchMap((task) =>
            task && !task.isDone
              ? of(setCurrentTask({ id: taskIdToResume }))
              : action.taskId
                ? of(actions.selectFocusTask())
                : of(actions.showFocusOverlay()),
          ),
        );
      }),
    ),
  );

  // Detect when work session timer completes and dispatch completeFocusSession
  // Only triggers when timer STOPS (isRunning becomes false) with elapsed >= duration
  // Guard: skip auto-completion when overtime is enabled (user pausing during overtime
  // should not trigger session completion)
  detectSessionCompletion$ = createEffect(() =>
    this.store.select(selectors.selectTimer).pipe(
      skipWhileApplyingRemoteOps(),
      withLatestFrom(
        this.store.select(selectors.selectMode),
        this.store.select(selectors.selectIsOvertimeEnabled),
      ),
      // Only consider emissions where timer just stopped running
      distinctUntilChanged(
        ([prevTimer], [currTimer]) => prevTimer.isRunning === currTimer.isRunning,
      ),
      filter(
        ([timer, mode, _isOvertimeEnabled]) =>
          timer.purpose === 'work' &&
          !timer.isRunning &&
          timer.elapsed >= timer.duration &&
          mode !== FocusModeMode.Flowtime &&
          !_isOvertimeEnabled,
      ),

      map(() => actions.completeFocusSession({ isManual: false })),
    ),
  );

  // Detect when break timer completes and show notification (no auto-complete)
  detectBreakTimeUp$ = createEffect(
    () =>
      this.store.select(selectors.selectTimer).pipe(
        skipWhileApplyingRemoteOps(),
        filter((timer) => this._isBreakTimeUp(timer)),
        distinctUntilChanged(
          (prev, curr) =>
            prev.elapsed === curr.elapsed && prev.startedAt === curr.startedAt,
        ),
        tap(() => {
          // When the looping break-end alarm is enabled it owns the break-end
          // sound (breakEndAlarmSound$); skip the one-shot here so they don't
          // double up. The window focus/flash still fires.
          this._notifyUser(false, this._isLoopBreakEndAlarmOn());
        }),
      ),
    { dispatch: false },
  );

  // Loop the break-end sound until the break is dismissed, when the user has
  // opted in (per-device setting — see FocusModeLocalSettingsService / #8593).
  // Mirrors whiteNoiseSound$: a single selector-based effect owns the loop
  // lifecycle, so any leave-break transition (completeBreak / skipBreak /
  // starting the next session — all of which flip timer.purpose away from
  // 'break' or set it running again) naturally stops the loop via
  // distinctUntilChanged. A hard safety ceiling inside startBreakEndAlarm()
  // stops it regardless if the user truly walked away.
  breakEndAlarmSound$ = createEffect(
    () =>
      this.store.select(selectors.selectTimer).pipe(
        skipWhileApplyingRemoteOps(),
        map((timer) => this._isBreakTimeUp(timer) && this._isLoopBreakEndAlarmOn()),
        distinctUntilChanged(),
        tap((shouldAlarm) => {
          if (shouldAlarm) {
            const soundVolume = this.globalConfigService.sound()?.volume || 0;
            startBreakEndAlarm(SESSION_DONE_SOUND, soundVolume);
          } else {
            stopBreakEndAlarm();
          }
        }),
      ),
    { dispatch: false },
  );

  // Session completion effects - split into separate concerns for better maintainability

  // Effect 1: Increment cycle for Pomodoro mode
  incrementCycleOnSessionComplete$ = createEffect(() =>
    this.actions$.pipe(
      ofType(actions.completeFocusSession),
      withLatestFrom(this.store.select(selectors.selectMode)),
      filter(([_, mode]) => mode === FocusModeMode.Pomodoro),
      map(() => actions.incrementCycle()),
    ),
  );

  // Effect 2: Stop tracking on session end when no break auto-starts
  // Bug #5875 fix: Stop tracking on manual session end
  // Bug #5954 fix: Only stop tracking if isPauseTrackingDuringBreak is enabled
  // Bug #5996 fix: Also stop tracking on automatic completion for modes without auto-break
  // Bug #5737 fix: Store pausedTaskId before unsetting to avoid race condition
  stopTrackingOnSessionEnd$ = createEffect(() =>
    this.actions$.pipe(
      ofType(actions.completeFocusSession),
      withLatestFrom(
        this.store.select(selectFocusModeConfig),
        this.store.select(selectors.selectMode),
        this.taskService.currentTaskId$,
      ),
      filter(([action, config, mode, taskId]) => {
        if (!config?.isPauseTrackingDuringBreak) {
          return false;
        }
        if (!taskId) {
          return false;
        }
        // For manual completion, always stop tracking
        if (action.isManual) {
          return true;
        }
        // Bug #6510 fix: For automatic completion, only stop tracking if no break will start.
        // When a break will start, tracking pause is deferred to break-start (autoStartBreakOnSessionComplete$).
        const strategy = this.strategyFactory.getStrategy(mode);
        const breakWillStart = strategy.shouldStartBreakAfterSession;
        return !breakWillStart;
      }),
      // Bug #5737 fix: Store pausedTaskId before unsetting current task
      // This ensures the task can be resumed after break even with manual "End Session"
      switchMap(([_action, _config, _mode, taskId]) =>
        of(actions.setPausedTaskId({ pausedTaskId: taskId }), unsetCurrentTask()),
      ),
    ),
  );

  // Effect 3: Auto-start break after session completion
  // Bug #6044 fix: Listen to incrementCycle instead of completeFocusSession to eliminate race condition
  // This ensures the cycle value is already incremented when we calculate break type
  autoStartBreakOnSessionComplete$ = createEffect(() =>
    this.actions$.pipe(
      ofType(actions.incrementCycle),
      withLatestFrom(
        this.store.select(selectors.selectMode),
        this.store.select(selectors.selectCurrentCycle),
        this.store.select(selectFocusModeConfig),
        this.taskService.currentTaskId$,
        this.workContextService.activeWorkContext$,
        this.workContextService.getTimeWorkedForDay$(),
        this.taskService.currentTask$,
      ),
      filter(([_, mode, __, config]) => {
        // Only for Pomodoro mode (since only Pomodoro increments cycles)
        if (mode !== FocusModeMode.Pomodoro) return false;
        const strategy = this.strategyFactory.getStrategy(mode);
        return strategy.shouldStartBreakAfterSession;
      }),
      switchMap(
        ([
          _,
          mode,
          cycle,
          config,
          currentTaskId,
          workContext,
          dailyTimeWorked,
          currentTask,
        ]) => {
          const strategy = this.strategyFactory.getStrategy(mode);
          // Cycle Adjustment needed, Cycle is 1 too high after incrementCycle
          // we want to get the last session's cycle
          const breakInfo = strategy.getBreakDuration(getBreakCycle(cycle));
          const shouldPauseTracking = config?.isPauseTrackingDuringBreak && currentTaskId;
          const actionsArr: Action[] = [];

          // Pause tracking during break if configured
          if (shouldPauseTracking) {
            actionsArr.push(unsetCurrentTask());
          }

          // Capture work context for preservation during break
          const workContextSnapshot =
            workContext && currentTask
              ? {
                  activeId: workContext.id,
                  activeType: workContext.type,
                  title: workContext.title,
                  taskTitle: currentTask.title,
                  dailyTimeWorked: dailyTimeWorked || 0,
                }
              : null;

          // Start break with appropriate duration and work context
          if (breakInfo) {
            actionsArr.push(
              actions.startBreak({
                duration: breakInfo.duration,
                isLongBreak: breakInfo.isLong,
                pausedTaskId: shouldPauseTracking ? currentTaskId : undefined,
                workContext: workContextSnapshot,
              }),
            );
          } else {
            // Fallback if no break info
            actionsArr.push(
              actions.startBreak({
                pausedTaskId: shouldPauseTracking ? currentTaskId : undefined,
                workContext: workContextSnapshot,
              }),
            );
          }

          return of(...actionsArr);
        },
      ),
    ),
  );

  // Effect 3b: Auto-start the Flowtime break when the user explicitly ends their
  // session. Triggers on endFlowtimeSession — NOT pauseFocusSession (which is
  // fired by sync-stop, idle, and the regular pause button).
  //
  // Mirrors autoStartBreakOnSessionComplete$ (Pomodoro). The action ORDER matters:
  // completeFocusSession (isManual:FALSE) → [unsetCurrentTask] → startBreak.
  //  - isManual:false keeps stopTrackingOnSessionEnd$ out of it (it defers the
  //    tracking-pause to break-start). If we used isManual:true, that effect would
  //    enqueue its own unsetCurrentTask AFTER startBreak, and syncTrackingStopToSession$
  //    would then pause the just-started break.
  //  - We unset the task HERE, explicitly before startBreak, so the tracking-stop is
  //    seen while the timer is still idle (syncTrackingStopToSession$ only pauses a
  //    RUNNING timer), not after the break is running.
  // completeFocusSession also logs the session (logFocusSession$). When no break is
  // due we complete with isManual:true (stops tracking) and show the SessionDone screen.
  autoStartFlowtimeBreakOnSessionEnd$ = createEffect(() =>
    this.actions$.pipe(
      ofType(actions.endFlowtimeSession),
      withLatestFrom(
        this.store.select(selectors.selectMode),
        this.store.select(selectors.selectTimer),
        this.store.select(selectFocusModeConfig),
        this.taskService.currentTaskId$,
        this.workContextService.activeWorkContext$,
        this.workContextService.getTimeWorkedForDay$(),
        this.taskService.currentTask$,
      ),
      filter(([_action, mode, timer]) => {
        if (mode !== FocusModeMode.Flowtime) return false;
        if (timer.purpose !== 'work') return false;
        return true;
      }),
      switchMap(
        ([
          action,
          mode,
          timer,
          config,
          currentTaskId,
          workContext,
          dailyTimeWorked,
          currentTask,
        ]) => {
          const strategy = this.strategyFactory.getStrategy(mode);
          const breakInfo = strategy.getBreakDuration(timer.elapsed);

          if (!strategy.shouldStartBreakAfterSession || !breakInfo) {
            return [actions.completeFocusSession({ isManual: true })];
          }

          const pausedTaskId = action.pausedTaskId ?? currentTaskId;
          const shouldPauseTracking =
            !!config?.isPauseTrackingDuringBreak && !!pausedTaskId;

          // Capture work context for preservation during break
          const workContextSnapshot =
            workContext && currentTask
              ? {
                  activeId: workContext.id,
                  activeType: workContext.type,
                  title: workContext.title,
                  taskTitle: currentTask.title,
                  dailyTimeWorked: dailyTimeWorked || 0,
                }
              : null;

          const actionsArr: Action[] = [
            actions.completeFocusSession({ isManual: false }),
          ];
          if (shouldPauseTracking) {
            actionsArr.push(unsetCurrentTask());
          }
          actionsArr.push(
            actions.startBreak({
              duration: breakInfo.duration,
              isLongBreak: breakInfo.isLong,
              pausedTaskId: shouldPauseTracking ? pausedTaskId : undefined,
              workContext: workContextSnapshot,
            }),
          );
          return actionsArr;
        },
      ),
    ),
  );

  // Effect 4: Notification side effect (non-dispatching)
  notifyOnSessionComplete$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(actions.completeFocusSession),
        tap(() => this._notifyUser()),
      ),
    { dispatch: false },
  );

  // Effect 4b: Don't let a Countdown session end silently. Countdown is the only
  // mode that auto-stops with no follow-up: Pomodoro transitions straight into a
  // break (its own surfaced screen) and Flowtime only ever stops on an explicit
  // user action — neither is a silent stop. Manual end (isManual) is excluded.
  //
  // The reducer already routes completeFocusSession to the SessionDone screen, so
  // if the overlay is open the user sees it. We only intervene when the overlay
  // is hidden (user working elsewhere): rather than seize the whole screen, we
  // surface a non-modal banner that points back to the SessionDone screen and
  // self-dismisses once the overlay opens. We also raise an OS notification, but
  // only when it adds something — skipped while the app is focused (the surfaced
  // banner/overlay + desktop window flash are alert enough, and it would fire
  // spuriously on idle-resume) and on Android, where the native foreground
  // service already posts its own completion notification (see
  // FocusModeForegroundService.onTimerComplete), so this would duplicate.
  surfaceSessionDoneOnCompletion$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(actions.completeFocusSession),
        withLatestFrom(
          this.store.select(selectors.selectMode),
          this.store.select(selectors.selectLastSessionDuration),
          this.store.select(selectors.selectIsOverlayShown),
        ),
        filter(([action, mode]) => mode === FocusModeMode.Countdown && !action.isManual),
        tap(([_action, _mode, duration, isOverlayShown]) => {
          if (!document.hasFocus() && !this.isAndroidWebView) {
            this.notifyService.notify({
              title: T.F.FOCUS_MODE.SESSION_COMPLETED,
              body: T.F.FOCUS_MODE.SESSION_COMPLETED_NOTIFICATION_BODY,
              translateParams: { duration: msToString(duration, true) },
            });
          }
          if (!isOverlayShown) {
            this.bannerService.open({
              id: BannerId.FocusModeSessionDone,
              ico: 'celebration',
              msg: T.F.FOCUS_MODE.SESSION_COMPLETED_BANNER,
              translateParams: { duration: msToString(duration, true) },
              action: {
                // Opens the overlay onto the SessionDone screen (where the user
                // picks start-next vs back-to-planning) — it does not itself
                // start a session, so the label must not promise that.
                label: T.F.FOCUS_MODE.SESSION_COMPLETED_BANNER_ACTION,
                fn: () => this.store.dispatch(actions.showFocusOverlay()),
              },
              // Self-dismiss once the overlay opens (via the action above, the
              // idle-resume flow, or the user opening focus mode manually).
              hideWhen$: this.store
                .select(selectors.selectIsOverlayShown)
                .pipe(filter((isShown) => isShown)),
            });
          }
        }),
      ),
    { dispatch: false },
  );

  // Restore work context when breaks are completed or skipped
  restoreWorkContextOnBreakEnd$ = createEffect(() =>
    this.actions$.pipe(
      ofType(actions.skipBreak, actions.completeBreak),
      withLatestFrom(
        this.store.select(selectors.selectPausedWorkContext),
        this.store.select(selectors.selectPausedTaskId),
      ),
      filter(([action, pausedWorkContext, pausedTaskId]) => {
        // Only restore if we have a paused work context and potentially a task to restore
        return !!pausedWorkContext && (!!action.pausedTaskId || !!pausedTaskId);
      }),
      switchMap(([action, pausedWorkContext, pausedTaskId]) => {
        const actionsToDispatch: Action[] = [];
        const taskIdToResume = action.pausedTaskId || pausedTaskId;

        if (taskIdToResume && pausedWorkContext) {
          // Set the work context back to the paused context
          actionsToDispatch.push(
            setActiveWorkContext({
              activeId: pausedWorkContext.activeId,
              activeType: pausedWorkContext.activeType,
            }),
          );

          // Resume tracking the task
          actionsToDispatch.push(setCurrentTask({ id: taskIdToResume }));
        }

        return actionsToDispatch.length > 0 ? of(...actionsToDispatch) : EMPTY;
      }),
    ),
  );

  // Overtime: set _isOvertimeEnabled when a Pomodoro session starts with isManualBreakStart
  setOvertimeOnSessionStart$ = createEffect(() =>
    this.actions$.pipe(
      ofType(actions.startFocusSession),
      withLatestFrom(
        this.store.select(selectors.selectMode),
        this.store.select(selectFocusModeConfig),
      ),
      map(([_, mode, config]) =>
        actions.setOvertimeEnabled({
          enabled: mode === FocusModeMode.Pomodoro && !!config?.isManualBreakStart,
        }),
      ),
    ),
  );

  // Overtime: one-shot notification when timer first crosses the duration mark
  notifyOnOvertimeStart$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(actions.startFocusSession),
        switchMap(() =>
          this.store.select(selectors.selectTimer).pipe(
            filter(
              (timer) =>
                timer.isRunning &&
                timer.purpose === 'work' &&
                timer.duration > 0 &&
                timer.elapsed >= timer.duration,
            ),
            take(1),
            tap(() => this._notifyUser()),
          ),
        ),
      ),
    { dispatch: false },
  );

  // Break completion effects - split into separate concerns for better maintainability
  // Note: pausedTaskId is passed in action payload to avoid race condition
  // (reducer clears pausedTaskId before effect reads state)

  // Effect 1: Resume tracking after break
  // Bug #6726 fix: Don't override if user is already tracking a different task
  resumeTrackingOnBreakComplete$ = createEffect(() =>
    this.actions$.pipe(
      ofType(actions.completeBreak),
      filter((action) => !!action.pausedTaskId),
      withLatestFrom(this.taskService.currentTaskId$),
      filter(([_, currentTaskId]) => !currentTaskId),
      map(([action]) => setCurrentTask({ id: action.pausedTaskId! })),
    ),
  );

  // Effect 2: Auto-start next session after break
  autoStartSessionOnBreakComplete$ = createEffect(() =>
    this.actions$.pipe(
      ofType(actions.completeBreak),
      withLatestFrom(
        this.store.select(selectors.selectMode),
        this.store.select(selectFocusModeConfig),
      ),
      filter(([_, mode]) => {
        const strategy = this.strategyFactory.getStrategy(mode);
        return strategy.shouldAutoStartNextSession;
      }),
      map(([_, mode, config]) => {
        const strategy = this.strategyFactory.getStrategy(mode);
        return actions.startFocusSession({
          duration: strategy.initialSessionDuration,
        });
      }),
    ),
  );

  // Handle skip break
  // Note: pausedTaskId is passed in action payload to avoid race condition
  skipBreak$ = createEffect(() =>
    this.actions$.pipe(
      ofType(actions.skipBreak),
      withLatestFrom(
        this.store.select(selectors.selectMode),
        this.store.select(selectFocusModeConfig),
        this.taskService.currentTaskId$,
      ),
      switchMap(([action, mode, config, currentTaskId]) => {
        const strategy = this.strategyFactory.getStrategy(mode);
        const actionsToDispatch: any[] = [];

        // Resume task tracking if we paused it during break
        // Bug #6726 fix: Don't override if user is already tracking a different task
        if (action.pausedTaskId && !currentTaskId) {
          actionsToDispatch.push(setCurrentTask({ id: action.pausedTaskId }));
        }

        // Auto-start next session if configured
        if (strategy.shouldAutoStartNextSession) {
          const duration = strategy.initialSessionDuration;
          actionsToDispatch.push(
            actions.startFocusSession({
              duration,
            }),
          );
        }

        return actionsToDispatch.length > 0 ? of(...actionsToDispatch) : EMPTY;
      }),
    ),
  );

  // Bug #6064 fix: Reset "without break" timer when focus mode break starts
  // This ensures Pomodoro breaks are correctly recognized as rest periods regardless of
  // whether task tracking is paused during breaks (isPauseTrackingDuringBreak setting)
  resetBreakTimerOnBreakStart$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(actions.startBreak),
        tap(() => {
          // Signal TakeABreakService to reset its timer. Must be resetTimer()
          // rather than otherNoBreakTIme$.next(0): the latter only zeroes the
          // counter and skips the reminder teardown, leaving a stale banner up.
          this.takeABreakService.resetTimer();
        }),
      ),
    { dispatch: false },
  );

  // Handle session cancellation
  cancelSession$ = createEffect(() =>
    this.actions$.pipe(
      ofType(actions.cancelFocusSession),
      map(() => unsetCurrentTask()),
    ),
  );

  // Pause on idle
  pauseOnIdle$ = createEffect(() =>
    this.actions$.pipe(
      ofType(openIdleDialog),
      withLatestFrom(this.taskService.currentTaskId$),
      map(([_, currentTaskId]) =>
        actions.pauseFocusSession({ pausedTaskId: currentTaskId }),
      ),
    ),
  );

  logFocusSession$ = createEffect(
    () =>
      this.actions$.pipe(
        // Every completed session (including Flowtime, which dispatches
        // completeFocusSession before auto-starting its break) is logged here.
        ofType(actions.completeFocusSession),
        withLatestFrom(this.store.select(selectors.selectLastSessionDuration)),
        tap(([, duration]) => {
          if (duration > 0) {
            this.metricService.logFocusSession(duration);
          }
        }),
      ),
    { dispatch: false },
  );

  // Persist mode to localStorage
  persistMode$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(actions.setFocusModeMode),
        tap(({ mode }) => {
          localStorage.setItem(LS.FOCUS_MODE_MODE, mode);
        }),
      ),
    { dispatch: false },
  );

  persistCountdownDuration$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(actions.setFocusSessionDuration),
        withLatestFrom(this.store.select(selectors.selectMode)),
        tap(([{ focusSessionDuration }, mode]) => {
          if (mode === FocusModeMode.Countdown && focusSessionDuration > 0) {
            this.storageService.setLastCountdownDuration(focusSessionDuration);
          }
        }),
      ),
    { dispatch: false },
  );

  syncDurationWithMode$ = createEffect(() =>
    this.actions$.pipe(
      ofType(actions.setFocusModeMode, actions.focusModeLoaded),
      withLatestFrom(
        this.store.select(selectors.selectTimer),
        this.store.select(selectors.selectMode),
      ),
      switchMap(([action, timer, storeMode]) => {
        const mode =
          action.type === actions.setFocusModeMode.type
            ? (action as ReturnType<typeof actions.setFocusModeMode>).mode
            : storeMode;

        if (timer.purpose !== null) {
          return EMPTY;
        }

        // Only sync on load if duration is not set (0) to avoid overwriting manual changes
        if (action.type === actions.focusModeLoaded.type && timer.duration > 0) {
          return EMPTY;
        }

        if (mode === FocusModeMode.Flowtime) {
          return EMPTY;
        }

        const strategy = this.strategyFactory.getStrategy(mode);
        const duration = strategy.initialSessionDuration;

        if (
          typeof duration !== 'number' ||
          duration <= 0 ||
          duration === timer.duration
        ) {
          return EMPTY;
        }

        return of(actions.setFocusSessionDuration({ focusSessionDuration: duration }));
      }),
    ),
  );

  // Sync duration when Pomodoro settings change (only for unstarted sessions)
  syncDurationWithPomodoroConfig$ = createEffect(() =>
    this.actions$.pipe(
      ofType(updateGlobalConfigSection),
      filter(({ sectionKey }) => sectionKey === 'pomodoro'),
      withLatestFrom(
        this.store.select(selectors.selectTimer),
        this.store.select(selectors.selectMode),
        this.store.select(selectPomodoroConfig),
      ),
      switchMap(([_action, timer, mode, pomodoroConfig]) => {
        // Only sync if session hasn't started yet
        if (timer.purpose !== null) {
          return EMPTY;
        }

        // Only sync for Pomodoro mode
        if (mode !== FocusModeMode.Pomodoro) {
          return EMPTY;
        }

        const newDuration = pomodoroConfig?.duration;

        // Only sync if duration is valid and divisible by 1000 (whole seconds)
        if (
          typeof newDuration !== 'number' ||
          newDuration <= 0 ||
          newDuration % 1000 !== 0 ||
          newDuration === timer.duration
        ) {
          return EMPTY;
        }

        return of(actions.setFocusSessionDuration({ focusSessionDuration: newDuration }));
      }),
    ),
  );

  // Electron-specific effects
  // Action-based effect to update Windows taskbar progress (fixes #6061)
  // Throttled to prevent excessive IPC calls (timer ticks every 1s)
  // Follows action-based pattern (CLAUDE.md Section 8) instead of selector-based
  setTaskBarProgress$ =
    IS_ELECTRON &&
    createEffect(
      () =>
        this.actions$.pipe(
          ofType(
            actions.tick,
            actions.startFocusSession,
            actions.pauseFocusSession,
            actions.unPauseFocusSession,
            actions.startBreak,
            actions.skipBreak,
            actions.completeBreak,
            actions.completeFocusSession,
            actions.cancelFocusSession,
            actions.selectFocusTask,
          ),
          // Throttle to prevent excessive IPC calls (timer ticks every 1s)
          // Use leading + trailing to ensure immediate feedback and final state
          throttleTime(500, undefined, { leading: true, trailing: true }),
          withLatestFrom(
            this.store.select(selectors.selectProgress),
            this.store.select(selectors.selectIsRunning),
            this.store.select(selectors.selectTimeRemaining),
            this.store.select(selectors.selectBreakMessageKey),
            this.store.select(selectors.selectMode),
            this.store.select(selectors.selectIsSessionPaused),
            this.store.select(selectors.selectIsLongBreak),
            this.store.select(selectors.selectIsBreakActive),
            this.store.select(selectPomodoroConfig),
          ),
          tap(
            ([
              _action,
              progress,
              isRunning,
              remainingTime,
              breakMessageKey,
              mode,
              isPaused,
              isLongBreak,
              isBreakActive,
              pomodoroConfig,
            ]) => {
              try {
                window.ea.setProgressBar({
                  progress: progress / 100,
                  progressBarMode: isRunning ? 'normal' : 'pause',
                });

                if (isBreakActive) {
                  // Unused desktop notification variables have been removed to fix lint errors
                }
              } catch (e) {
                // Ignore errors
              }
            },
          ),
        ),
      { dispatch: false },
    );

  focusWindowOnBreakStart$ = createEffect(() =>
    this.actions$.pipe(
      ofType(actions.startBreak),
      withLatestFrom(this.store.select(selectors.selectMode)),
      switchMap(([action, mode]) => {
        if (IS_ELECTRON) {
          this._notifyUser(true);
        }

        let key = T.F.FOCUS_MODE.BREAK_RELAX_MSG;
        if (mode === FocusModeMode.Pomodoro) {
          const isLong = !!action.isLongBreak;
          const randomKey = getNextIdeaKey(isLong);
          key = isLong
            ? `F.FOCUS_MODE.LONG_BREAK_IDEAS.${randomKey}`
            : `F.FOCUS_MODE.MINI_BREAK_IDEAS.${randomKey}`;
        } else if (mode === FocusModeMode.Flowtime) {
          const randomKey = getNextIdeaKey(true);
          key = `F.FOCUS_MODE.LONG_BREAK_IDEAS.${randomKey}`;
        }

        return of(actions.setBreakMessageKey({ breakMessageKey: key }));
      }),
    ),
  );

  // Play ticking sound during focus sessions if enabled
  playTickSound$ = createEffect(
    () =>
      this.store.select(selectors.selectTimer).pipe(
        skipWhileApplyingRemoteOps(),
        filter(
          (timer) => timer.isRunning && timer.purpose === 'work' && timer.elapsed > 0,
        ),
        // Only emit when we cross a second boundary
        distinctUntilChanged(
          (prev, curr) =>
            Math.floor(prev.elapsed / 1000) === Math.floor(curr.elapsed / 1000),
        ),
        withLatestFrom(this.store.select(selectFocusModeConfig)),
        tap(([, focusModeConfig]) => {
          const soundVolume = this.globalConfigService.sound()?.volume || 0;
          if (focusModeConfig?.focusModeSound === 'tick' && soundVolume > 0) {
            playSound(TICK_SOUND, Math.round(soundVolume * FOCUS_SOUND_VOLUME_FACTOR));
          }
        }),
      ),
    { dispatch: false },
  );

  // Manage white noise loop during focus sessions
  whiteNoiseSound$ = createEffect(
    () =>
      combineLatest([
        this.store.select(selectors.selectTimer),
        this.store.select(selectFocusModeConfig),
      ]).pipe(
        skipWhileApplyingRemoteOps(),
        map(([timer, focusModeConfig]) => {
          const soundVolume = this.globalConfigService.sound()?.volume || 0;
          return (
            focusModeConfig?.focusModeSound === 'whiteNoise' &&
            timer.isRunning &&
            timer.purpose === 'work' &&
            timer.elapsed > 0 &&
            soundVolume > 0
          );
        }),
        distinctUntilChanged(),
        tap((shouldPlay) => {
          if (shouldPlay) {
            const soundVolume = this.globalConfigService.sound()?.volume || 0;
            startWhiteNoise(Math.round(soundVolume * FOCUS_SOUND_VOLUME_FACTOR));
          } else {
            stopWhiteNoise();
          }
        }),
      ),
    { dispatch: false },
  );

  private _isBreakTimeUp(timer: TimerState): boolean {
    return (
      timer.purpose === 'break' &&
      !timer.isRunning &&
      timer.startedAt !== null &&
      timer.elapsed >= timer.duration
    );
  }

  private _isLoopBreakEndAlarmOn(): boolean {
    return (
      this.focusModeLocalSettingsService.settings().isLoopBreakEndAlarm &&
      (this.globalConfigService.sound()?.volume || 0) > 0
    );
  }

  private _notifyUser(isHideBar = false, isSkipSound = false): void {
    const soundVolume = this.globalConfigService.sound()?.volume || 0;

    // Play sound if enabled (skipped when the looping break-end alarm owns it)
    if (!isSkipSound && soundVolume > 0) {
      playSound(SESSION_DONE_SOUND, soundVolume);
    }

    // Focus window if in Electron
    if (IS_ELECTRON) {
      window.ea.showOrFocus();
      window.ea.flashFrame();
      window.ea.setProgressBar({
        progress: 1,
        progressBarMode: isHideBar ? 'none' : 'normal',
      });
    }
  }

  // Handle Skip Break from overlay (Phase 5H)
  skipBreakFromIpc$ = createEffect(() =>
    defer(() => {
      if (IS_ELECTRON && window.ea && window.ea.onFocusModeSkipBreak) {
        return new Observable<void>((subscriber) => {
          window.ea.onFocusModeSkipBreak(() => {
            subscriber.next();
          });
        });
      }
      return EMPTY;
    }).pipe(map(() => actions.skipBreak({ pausedTaskId: null }))),
  );

  // Phase 4D: Natural Breaks
  naturalBreak$ = createEffect(() =>
    defer(() => this.ipcIdleTime$).pipe(
      withLatestFrom(
        this.store.select(selectors.selectMode),
        this.store.select(selectors.selectIsSessionRunning),
        this.store.select(selectors.selectIsBreakActive),
        this.store.select(selectPomodoroConfig),
        this.store.select(selectIdleConfig),
      ),
      switchMap(
        ([idleTime, mode, isSessionRunning, isBreakActive, pomodoroCfg, idleCfg]) => {
          const isEligible =
            mode === FocusModeMode.Pomodoro &&
            isSessionRunning &&
            !isBreakActive &&
            pomodoroCfg?.isEnableNaturalBreaks === true &&
            idleCfg?.isSuppressIdleDuringFocusMode === true &&
            idleTime >= (pomodoroCfg?.naturalBreaksInactivityResetTime || 5 * 60 * 1000);

          if (isEligible) {
            return of(actions.cancelFocusSession(), actions.resetCycles());
          }
          return EMPTY;
        },
      ),
    ),
  );
}
