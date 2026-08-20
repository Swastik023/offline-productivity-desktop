import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { Store } from '@ngrx/store';
import {
  firstValueFrom,
  combineLatest,
  from,
  throttleTime,
  asyncScheduler,
  switchMap,
} from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs/operators';
import typia from 'typia';
import { TaskService } from '../../features/tasks/task.service';
import { Task, TaskWithSubTasks } from '../../features/tasks/task.model';
import { TaskArchiveService } from '../../features/archive/task-archive.service';
import { ProjectService } from '../../features/project/project.service';
import { TagService } from '../../features/tag/tag.service';
import { TODAY_TAG } from '../../features/tag/tag.const';
import { DateService } from '../date/date.service';
import { isTodayWithOffset } from '../../util/is-today.util';
import { GlobalConfigService } from '../../features/config/global-config.service';
import {
  FOCUS_MODE_DEFAULTS,
  FocusModeMode,
  getBreakCycle,
  TimerState,
} from '../../features/focus-mode/focus-mode.model';
import * as focusModeSelectors from '../../features/focus-mode/store/focus-mode.selectors';
import {
  LocalRestApiRequestPayload,
  LocalRestApiResponsePayload,
} from '../../../../electron/shared-with-frontend/local-rest-api.model';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Only these fields may be set via the REST API to prevent state corruption. */
const ALLOWED_TASK_FIELDS = new Set<string>([
  'title',
  'notes',
  'isDone',
  'timeEstimate',
  'timeSpent',
  'projectId',
  'tagIds',
  'dueDay',
  'dueWithTime',
  'plannedAt',
]);

/**
 * Relational fields that callers often try to set but must be rejected:
 * mutating them as plain values corrupts invariants (parent<->child links,
 * projectId inheritance, tag-ordering lists). Subtask creation is available
 * via `POST /tasks` with `parentId` — see `_handleCreateTask`.
 */
const REJECTED_TASK_FIELDS = ['parentId', 'subTaskIds'] as const;

/**
 * Fields a subtask inherits from its parent at the reducer (`addSubTask`
 * forces `tagIds: []` and `projectId = parent.projectId`). Reject them on
 * subtask create so callers don't get a 201 with values different from what
 * they sent.
 */
const SUBTASK_INHERITED_FIELDS = ['projectId', 'tagIds'] as const;

const pickAllowedFields = (body: Record<string, unknown>): Partial<Task> => {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(body)) {
    if (ALLOWED_TASK_FIELDS.has(key)) {
      result[key] = body[key];
    }
  }
  return result as Partial<Task>;
};

/**
 * Value-level types for the fields writable via the REST API. Keys mirror
 * ALLOWED_TASK_FIELDS; `pickAllowedFields` filters by key only, so this is
 * where the *values* get checked. Without it a caller could push a wrong-typed
 * value (e.g. `tagIds: 123`, `timeEstimate: 'abc'`) straight into the store and
 * the synced op-log, where it corrupts state locally and trips typia-as-corrupt
 * on other devices when the op replays.
 */
interface WritableTaskFields {
  title?: string;
  notes?: string;
  isDone?: boolean;
  timeEstimate?: number;
  timeSpent?: number;
  projectId?: string;
  tagIds?: string[];
  dueDay?: string | null;
  dueWithTime?: number | null;
  plannedAt?: number;
}

type FieldTypeError = { path: string; expected: string };

/**
 * Validates the value types of already-key-filtered task fields. The create
 * path is separately guarded by `typia.assert<Task>` in the task service (a
 * bad value throws → generic 500); validating here lets both create and PATCH
 * reject bad input with a clean 400 before anything is dispatched.
 */
const validateWritableFields = (
  fields: Partial<Task>,
): { ok: true } | { ok: false; errors: FieldTypeError[] } => {
  const result = typia.validate<WritableTaskFields>(fields);
  if (result.success) {
    return { ok: true };
  }
  return {
    ok: false,
    errors: result.errors.map((e) => ({ path: e.path, expected: e.expected })),
  };
};

const firstRejectedField = (body: Record<string, unknown>): string | undefined =>
  REJECTED_TASK_FIELDS.find((field) => field in body);

const getQueryParam = (
  query: Record<string, string | string[]>,
  key: string,
): string | undefined => {
  const value = query[key];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
};

const getQueryParamAsBoolean = (
  query: Record<string, string | string[]>,
  key: string,
  defaultValue: boolean,
): boolean => {
  const value = getQueryParam(query, key);
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true';
};

const createErrorResponse = (
  requestId: string,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): LocalRestApiResponsePayload => ({
  requestId,
  status,
  body: {
    ok: false,
    error: {
      code,
      message,
      details,
    },
  },
});

const createSuccessResponse = (
  requestId: string,
  status: number,
  data: unknown,
): LocalRestApiResponsePayload => ({
  requestId,
  status,
  body: {
    ok: true,
    data,
  },
});

type TaskSource = 'active' | 'archived' | 'all';
type ProductivityStateAppStatus = 'running' | 'idle' | 'break' | 'paused' | 'unknown';
type ProductivityStateTimerMode = 'pomodoro' | 'flowtime' | 'countdown' | 'none';
type ProductivityStateTimerState = 'running' | 'paused' | 'break' | 'stopped';

const PRODUCTIVITY_STATE_SCHEMA_VERSION = 1;

const isValidTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && new Date(value).getTime() > 0;

const isTaskInToday = (
  task: Task,
  todayStr: string,
  startOfNextDayDiffMs: number,
): boolean => {
  if (isValidTimestamp(task.dueWithTime)) {
    return isTodayWithOffset(task.dueWithTime, todayStr, startOfNextDayDiffMs);
  }
  return task.dueDay === todayStr;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const mapFocusModeMode = (
  mode: FocusModeMode | null | undefined,
): ProductivityStateTimerMode => {
  switch (mode) {
    case FocusModeMode.Pomodoro:
      return 'pomodoro';
    case FocusModeMode.Flowtime:
      return 'flowtime';
    case FocusModeMode.Countdown:
      return 'countdown';
    default:
      return 'none';
  }
};

const getTimerState = (timer: TimerState): ProductivityStateTimerState => {
  if (timer.purpose === 'break') {
    return timer.isRunning ? 'running' : 'paused';
  }
  if (timer.purpose === 'work') {
    return timer.isRunning ? 'running' : 'paused';
  }
  return 'stopped';
};

const getAppStatus = (
  timer: TimerState,
  currentTask: Task | null | undefined,
): ProductivityStateAppStatus => {
  if (timer.purpose === 'break') {
    return 'break';
  }
  if (timer.purpose === 'work' && !timer.isRunning) {
    return 'paused';
  }
  if ((timer.purpose === 'work' && timer.isRunning) || currentTask) {
    return 'running';
  }
  return 'idle';
};

const getRemainingMs = (timer: TimerState): number | null =>
  timer.purpose && timer.duration > 0
    ? Math.max(0, timer.duration - timer.elapsed)
    : null;

const getStartedAtIso = (timer: TimerState): string | null =>
  isValidTimestamp(timer.startedAt) ? new Date(timer.startedAt).toISOString() : null;

const sumTimeSpentForDay = (tasks: Task[], day: string): number =>
  tasks
    .filter((task) => !task.parentId)
    .reduce((sum, task) => {
      const timeSpent = task.timeSpentOnDay?.[day];
      return sum + (isFiniteNumber(timeSpent) ? timeSpent : 0);
    }, 0);

@Injectable({
  providedIn: 'root',
})
export class LocalRestApiHandlerService {
  private readonly _taskService = inject(TaskService);
  private readonly _taskArchiveService = inject(TaskArchiveService);
  private readonly _projectService = inject(ProjectService);
  private readonly _tagService = inject(TagService);
  private readonly _dateService = inject(DateService);
  private readonly _store = inject(Store);
  private readonly _globalConfigService = inject(GlobalConfigService);
  private readonly _destroyRef = inject(DestroyRef);
  private _isInitialized = false;
  private _archiveCache: any = null;
  private _lastArchiveCacheTime = 0;
  private _cachedArchivedTodayStats: { completed: number; focusTimeMs: number } | null =
    null;
  private _isBroadcasting = false;
  private _activeSocketCount = signal<number>(0);

  init(): void {
    if (this._isInitialized || !window.ea?.onLocalRestApiRequest) {
      return;
    }
    this._isInitialized = true;

    window.ea.onLocalRestApiRequest((payload) => {
      void this._handleRequest(payload);
    });

    this._startReactiveBroadcast();
  }

  private _startReactiveBroadcast(): void {
    // Register for live socket-count updates from Electron so we can skip
    // all computation when zero OBS/extension clients are connected.
    if (window.ea.onSocketCount) {
      window.ea.onSocketCount((count) => this._activeSocketCount.set(count));
    }

    combineLatest([
      this._store.select(focusModeSelectors.selectTimer),
      this._store.select(focusModeSelectors.selectMode),
      this._taskService.currentTask$,
      this._store.select(focusModeSelectors.selectCurrentCycle),
      this._store.select(focusModeSelectors.selectIsWaitingForNextFocus),
    ])
      .pipe(
        takeUntilDestroyed(this._destroyRef),
        filter(() => this._activeSocketCount() > 0), // zero clients → skip everything
        throttleTime(1000, asyncScheduler, { leading: false, trailing: true }),
        switchMap(() => from(this._buildAndBroadcast())),
      )
      .subscribe();
  }

  private async _buildAndBroadcast(): Promise<void> {
    if (this._isBroadcasting) return;
    this._isBroadcasting = true;
    try {
      const statePayload = await this._handleGetProductivityState('broadcast');
      if (statePayload.body.ok) {
        window.ea.broadcastLocalRestApiState(statePayload.body.data);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Failed to broadcast REST API state', e);
    } finally {
      this._isBroadcasting = false;
    }
  }

  private async _handleRequest(payload: LocalRestApiRequestPayload): Promise<void> {
    let response: LocalRestApiResponsePayload;

    try {
      response = await this._routeRequest(payload);
    } catch (error) {
      response = createErrorResponse(
        payload.requestId,
        500,
        'INTERNAL_ERROR',
        error instanceof Error ? error.message : 'Unknown internal error',
      );
    }

    window.ea.sendLocalRestApiResponse(response);
  }

  private async _routeRequest(
    payload: LocalRestApiRequestPayload,
  ): Promise<LocalRestApiResponsePayload> {
    const { method, path, requestId, body, query } = payload;
    const segments = path.split('/').filter(Boolean);

    if (method === 'GET' && path === '/status') {
      return this._handleGetStatus(requestId);
    }

    if (method === 'GET' && path === '/api/productivity-state') {
      return this._handleGetProductivityState(requestId);
    }

    if (method === 'GET' && path === '/task-control/current') {
      return this._handleGetCurrentTask(requestId);
    }

    if (method === 'POST' && path === '/task-control/stop') {
      return this._handleStopTask(requestId);
    }

    if (method === 'POST' && path === '/task-control/current') {
      return this._handleSetCurrentTask(requestId, body);
    }

    if (method === 'GET' && path === '/tasks') {
      return this._handleListTasks(requestId, query);
    }

    if (method === 'POST' && path === '/tasks') {
      return this._handleCreateTask(requestId, body);
    }

    if (segments[0] === 'tasks' && segments[1] && segments.length >= 2) {
      return this._handleTaskRoutes(method, segments, requestId, body);
    }

    if (method === 'GET' && path === '/projects') {
      return this._handleListProjects(requestId, query);
    }

    if (method === 'GET' && path === '/tags') {
      return this._handleListTags(requestId, query);
    }

    return createErrorResponse(requestId, 404, 'NOT_FOUND', 'Route not found');
  }

  private async _handleGetStatus(
    requestId: string,
  ): Promise<LocalRestApiResponsePayload> {
    const [currentTask, allTasks] = await Promise.all([
      firstValueFrom(this._taskService.currentTask$),
      firstValueFrom(this._taskService.allTasks$),
    ]);

    return createSuccessResponse(requestId, 200, {
      currentTask,
      currentTaskId: currentTask?.id ?? null,
      taskCount: allTasks.length,
    });
  }

  private async _handleGetProductivityState(
    requestId: string,
  ): Promise<LocalRestApiResponsePayload> {
    const [
      currentTask,
      allTasks,
      projects,
      currentProjectContext,
      timer,
      mode,
      currentCycle,
      pausedTaskId,
      isWaitingForNextFocus,
    ] = await Promise.all([
      firstValueFrom(this._taskService.currentTask$),
      firstValueFrom(this._taskService.allTasks$),
      firstValueFrom(this._projectService.list$),
      firstValueFrom(this._projectService.currentProject$),
      firstValueFrom(this._store.select(focusModeSelectors.selectTimer)),
      firstValueFrom(this._store.select(focusModeSelectors.selectMode)),
      firstValueFrom(this._store.select(focusModeSelectors.selectCurrentCycle)),
      firstValueFrom(this._store.select(focusModeSelectors.selectPausedTaskId)),
      firstValueFrom(this._store.select(focusModeSelectors.selectIsWaitingForNextFocus)),
    ]);
    const todayStr = this._dateService.todayStr();
    const now = Date.now();
    if (!this._archiveCache || now - this._lastArchiveCacheTime > 60000) {
      this._archiveCache = await this._taskArchiveService.loadYoung();
      this._lastArchiveCacheTime = now;

      const archivedTasks = this._archiveCache.ids
        .map((id: string) => this._archiveCache.entities[id])
        .filter((task: Task | undefined): task is Task => !!task);

      this._cachedArchivedTodayStats = {
        completed: archivedTasks.filter(
          (task: Task) =>
            !task.parentId &&
            task.isDone &&
            isFiniteNumber(task.doneOn) &&
            this._dateService.isToday(task.doneOn),
        ).length,
        focusTimeMs: sumTimeSpentForDay(archivedTasks, todayStr),
      };
    }

    const activeCompleted = allTasks.filter(
      (task) =>
        !task.parentId &&
        task.isDone &&
        isFiniteNumber(task.doneOn) &&
        this._dateService.isToday(task.doneOn),
    ).length;

    const activeFocusTimeMs = sumTimeSpentForDay(allTasks, todayStr);

    const totalCompletedTasks =
      activeCompleted + (this._cachedArchivedTodayStats?.completed || 0);
    const totalFocusTimeMs =
      activeFocusTimeMs + (this._cachedArchivedTodayStats?.focusTimeMs || 0);
    const resolvedProject =
      projects.find((project) => project.id === currentTask?.projectId) ??
      currentProjectContext ??
      null;
    const isPomodoro = mode === FocusModeMode.Pomodoro;
    const remainingMs = getRemainingMs(timer);
    const isBreakActive = timer.purpose === 'break';
    const cfg = this._globalConfigService.pomodoroConfig();
    const isStrict = isBreakActive
      ? !!(timer.isLongBreak ? cfg?.isStrictLongBreak : cfg?.isStrictShortBreak)
      : false;
    const currentTaskEstimateMs =
      currentTask && isFiniteNumber(currentTask.timeEstimate)
        ? currentTask.timeEstimate
        : null;
    const currentTaskTimeSpentMs =
      currentTask && isFiniteNumber(currentTask.timeSpent) ? currentTask.timeSpent : null;
    const currentTaskTimeSpentTodayMs =
      currentTask &&
      currentTask.timeSpentOnDay &&
      isFiniteNumber(currentTask.timeSpentOnDay[this._dateService.todayStr()])
        ? currentTask.timeSpentOnDay[this._dateService.todayStr()]
        : 0;

    const lastActiveTaskRaw = pausedTaskId
      ? (allTasks.find((t) => t.id === pausedTaskId) ?? null)
      : null;
    const lastActiveProjectRaw = lastActiveTaskRaw
      ? (projects.find((p) => p.id === lastActiveTaskRaw.projectId) ?? null)
      : null;

    const todayTasks = allTasks
      .filter(
        (t) =>
          !t.parentId &&
          (!t.isDone ||
            (isFiniteNumber(t.doneOn) && this._dateService.isToday(t.doneOn))),
      )
      .map((t) => ({
        id: t.id,
        title: t.title,
        isDone: t.isDone,
        timeSpentMs: t.timeSpent,
        timeSpentTodayMs:
          t.timeSpentOnDay &&
          isFiniteNumber(t.timeSpentOnDay[this._dateService.todayStr()])
            ? t.timeSpentOnDay[this._dateService.todayStr()]
            : 0,
        estimateMs: t.timeEstimate,
      }));

    const totalEstimate = todayTasks.reduce((acc, t) => acc + (t.estimateMs || 0), 0);
    const completedEstimate = todayTasks
      .filter((t) => t.isDone)
      .reduce((acc, t) => acc + (t.estimateMs || 0), 0);
    const dailyProgress = totalEstimate > 0 ? completedEstimate / totalEstimate : null;

    return createSuccessResponse(requestId, 200, {
      appStatus: getAppStatus(timer, currentTask),
      timestamp: new Date().toISOString(),
      schemaVersion: PRODUCTIVITY_STATE_SCHEMA_VERSION,
      todayTasks,
      currentTask: {
        id: currentTask?.id ?? null,
        title: currentTask?.title ?? null,
        estimateMs: currentTaskEstimateMs,
        timeSpentMs: currentTaskTimeSpentMs,
        timeSpentTodayMs: currentTaskTimeSpentTodayMs,
      },
      currentProject: {
        id: resolvedProject?.id ?? null,
        title: resolvedProject?.title ?? null,
      },
      timer: {
        mode: timer.purpose === null ? 'none' : mapFocusModeMode(mode),
        state: getTimerState(timer),
        isRunning: timer.isRunning,
        purpose: timer.purpose,
        elapsedMs: timer.purpose ? timer.elapsed : null,
        remainingMs,
        remaining:
          timer.purpose && remainingMs !== null ? Math.floor(remainingMs / 1000) : null,
        duration: timer.purpose ? Math.floor(timer.duration / 1000) : null,
        isStrict,
        startedAt: getStartedAtIso(timer),
        isWaitingForNextFocus,
      },
      lastActiveTask: {
        id: lastActiveTaskRaw?.id ?? null,
        title: lastActiveTaskRaw?.title ?? null,
      },
      lastActiveProject: {
        id: lastActiveProjectRaw?.id ?? null,
        title: lastActiveProjectRaw?.title ?? null,
      },
      session: {
        round:
          isPomodoro && timer.purpose
            ? isBreakActive
              ? getBreakCycle(currentCycle)
              : currentCycle
            : null,
        roundsPerCycle: isPomodoro
          ? (this._globalConfigService.pomodoroConfig()?.cyclesBeforeLongerBreak ??
            FOCUS_MODE_DEFAULTS.CYCLES_BEFORE_LONG_BREAK)
          : null,
        completedPomodoros: null,
      },
      break: {
        state: isBreakActive ? 'active' : 'none',
        type: isBreakActive ? (timer.isLongBreak ? 'long' : 'micro') : null,
        nextBreakInMs: isPomodoro && !isBreakActive ? remainingMs : null,
        breakRemainingMs: isBreakActive ? remainingMs : null,
      },
      today: {
        completedTasks: totalCompletedTasks,
        focusTimeMs: totalFocusTimeMs,
        dailyProgress: dailyProgress,
      },
    });
  }

  private async _handleGetCurrentTask(
    requestId: string,
  ): Promise<LocalRestApiResponsePayload> {
    const currentTask = await firstValueFrom(this._taskService.currentTask$);
    return createSuccessResponse(requestId, 200, currentTask);
  }

  private async _handleStopTask(requestId: string): Promise<LocalRestApiResponsePayload> {
    this._taskService.setCurrentId(null);
    return createSuccessResponse(requestId, 200, { currentTaskId: null });
  }

  private async _handleSetCurrentTask(
    requestId: string,
    body: unknown,
  ): Promise<LocalRestApiResponsePayload> {
    if (!isRecord(body)) {
      return createErrorResponse(
        requestId,
        400,
        'INVALID_INPUT',
        'Request body must be a JSON object with taskId',
      );
    }

    const taskId = body.taskId;

    if (taskId === null) {
      this._taskService.setCurrentId(null);
      return createSuccessResponse(requestId, 200, { currentTaskId: null });
    }

    if (typeof taskId !== 'string') {
      return createErrorResponse(
        requestId,
        400,
        'INVALID_INPUT',
        'taskId must be a string or null',
      );
    }

    const task = await this._getTaskById(taskId);
    if (!task) {
      return createErrorResponse(requestId, 404, 'TASK_NOT_FOUND', 'Task not found');
    }

    this._taskService.setCurrentId(taskId);
    return createSuccessResponse(requestId, 200, { currentTaskId: taskId });
  }

  private async _handleListTasks(
    requestId: string,
    query: Record<string, string | string[]>,
  ): Promise<LocalRestApiResponsePayload> {
    const queryText = getQueryParam(query, 'query');
    const projectId = getQueryParam(query, 'projectId');
    const tagId = getQueryParam(query, 'tagId');
    const includeDone = getQueryParamAsBoolean(query, 'includeDone', false);
    const VALID_SOURCES: TaskSource[] = ['active', 'archived', 'all'];
    const rawSource = getQueryParam(query, 'source') || 'active';
    const source: TaskSource = VALID_SOURCES.includes(rawSource as TaskSource)
      ? (rawSource as TaskSource)
      : 'active';

    let tasks: Task[];

    if (source === 'archived') {
      const archive = await this._taskArchiveService.load();
      tasks = archive.ids.map((id) => archive.entities[id]).filter((t): t is Task => !!t);
    } else if (source === 'all') {
      tasks = await this._taskService.getAllTasksEverywhere();
    } else {
      tasks = await firstValueFrom(this._taskService.allTasks$);
    }

    let filtered = tasks;

    if (queryText) {
      const lowerQuery = queryText.toLowerCase();
      filtered = filtered.filter((t) => t.title.toLowerCase().includes(lowerQuery));
    }

    if (projectId) {
      filtered = filtered.filter((t) => t.projectId === projectId);
    }

    if (tagId === TODAY_TAG.id) {
      const todayStr = this._dateService.todayStr();
      const startOfNextDayDiffMs = this._dateService.getStartOfNextDayDiffMs();
      filtered = filtered.filter((t) => isTaskInToday(t, todayStr, startOfNextDayDiffMs));
    } else if (tagId) {
      filtered = filtered.filter((t) => t.tagIds.includes(tagId));
    }

    if (!includeDone) {
      filtered = filtered.filter((t) => !t.isDone);
    }

    return createSuccessResponse(requestId, 200, filtered);
  }

  private async _handleCreateTask(
    requestId: string,
    body: unknown,
  ): Promise<LocalRestApiResponsePayload> {
    if (!isRecord(body) || typeof body.title !== 'string' || !body.title.trim()) {
      return createErrorResponse(
        requestId,
        400,
        'INVALID_INPUT',
        'Task title must be a non-empty string',
      );
    }

    if ('subTaskIds' in body) {
      return createErrorResponse(
        requestId,
        400,
        'UNSUPPORTED_FIELD',
        'subTaskIds cannot be set on task creation — create the parent first, then create each child with POST /tasks using parentId',
      );
    }

    const title = body.title.trim();
    const additionalFields = pickAllowedFields(body);

    const validation = validateWritableFields(additionalFields);
    if (!validation.ok) {
      return createErrorResponse(
        requestId,
        400,
        'INVALID_INPUT',
        'One or more task fields have an invalid type',
        validation.errors,
      );
    }

    if ('parentId' in body) {
      if (typeof body.parentId !== 'string' || !body.parentId) {
        return createErrorResponse(
          requestId,
          400,
          'INVALID_INPUT',
          'parentId must be a non-empty string',
        );
      }

      const inherited = SUBTASK_INHERITED_FIELDS.find((field) => field in body);
      if (inherited) {
        return createErrorResponse(
          requestId,
          400,
          'UNSUPPORTED_FIELD',
          `${inherited} cannot be set when creating a subtask — it's inherited from the parent`,
        );
      }

      const parent = await this._getTaskById(body.parentId);
      if (!parent) {
        return createErrorResponse(
          requestId,
          404,
          'PARENT_NOT_FOUND',
          `Parent task ${body.parentId} not found`,
        );
      }

      if (parent.parentId) {
        return createErrorResponse(
          requestId,
          400,
          'INVALID_PARENT',
          'Cannot nest subtasks: parent task is itself a subtask',
        );
      }

      const subTaskId = this._taskService.addSubTaskTo(body.parentId, {
        title,
        ...additionalFields,
      });
      const createdSubTask = await this._getTaskById(subTaskId);
      return createSuccessResponse(requestId, 201, createdSubTask);
    }

    const taskId = this._taskService.add(title, false, additionalFields);
    const createdTask = await this._getTaskById(taskId);

    return createSuccessResponse(requestId, 201, createdTask);
  }

  private async _handleTaskRoutes(
    method: string,
    segments: string[],
    requestId: string,
    body: unknown,
  ): Promise<LocalRestApiResponsePayload> {
    const taskId = segments[1];

    if (segments.length === 2) {
      if (method === 'GET') {
        const task = await this._getTaskById(taskId);
        if (!task) {
          return createErrorResponse(requestId, 404, 'TASK_NOT_FOUND', 'Task not found');
        }
        return createSuccessResponse(requestId, 200, task);
      }

      if (method === 'PATCH') {
        if (!isRecord(body)) {
          return createErrorResponse(
            requestId,
            400,
            'INVALID_INPUT',
            'PATCH body must be a JSON object',
          );
        }

        const rejected = firstRejectedField(body);
        if (rejected) {
          return createErrorResponse(
            requestId,
            400,
            'UNSUPPORTED_FIELD',
            `${rejected} cannot be set via PATCH — re-parenting is not supported by this API`,
          );
        }

        const changes = pickAllowedFields(body);
        const validation = validateWritableFields(changes);
        if (!validation.ok) {
          return createErrorResponse(
            requestId,
            400,
            'INVALID_INPUT',
            'One or more task fields have an invalid type',
            validation.errors,
          );
        }

        const task = await this._getTaskById(taskId);
        if (!task) {
          return createErrorResponse(requestId, 404, 'TASK_NOT_FOUND', 'Task not found');
        }

        if (Object.prototype.hasOwnProperty.call(changes, 'projectId')) {
          const targetProjectId = changes.projectId;
          if (typeof targetProjectId !== 'string' || !targetProjectId.trim()) {
            return createErrorResponse(
              requestId,
              400,
              'INVALID_INPUT',
              'projectId must be a non-empty string',
            );
          }
          const isProjectChange = targetProjectId !== task.projectId;
          // Echoing back the unchanged projectId is allowed on subtasks so
          // GET→PATCH round-trips don't fail; only actual changes are rejected.
          if (task.parentId && isProjectChange) {
            return createErrorResponse(
              requestId,
              400,
              'UNSUPPORTED_FIELD',
              'projectId cannot be changed directly on a subtask — move its parent task instead',
            );
          }

          if (isProjectChange) {
            // list() only contains unarchived projects, and matching by iteration
            // (not entity-map lookup) keeps prototype-property names like
            // 'constructor' from resolving to a truthy non-project.
            const targetProject = this._projectService
              .list()
              .find((project) => project.id === targetProjectId && !project.isArchived);
            if (!targetProject) {
              return createErrorResponse(
                requestId,
                404,
                'PROJECT_NOT_FOUND',
                'Destination project not found or archived',
              );
            }
          }
        }

        this._taskService.update(taskId, changes);
        return createSuccessResponse(requestId, 200, await this._getTaskById(taskId));
      }

      if (method === 'DELETE') {
        const task = await this._getTaskWithSubTasksById(taskId);
        if (!task) {
          return createErrorResponse(requestId, 404, 'TASK_NOT_FOUND', 'Task not found');
        }

        this._taskService.remove(task);
        return createSuccessResponse(requestId, 200, { deleted: true, id: taskId });
      }
    }

    if (segments.length === 3 && segments[2] === 'start' && method === 'POST') {
      const task = await this._getTaskById(taskId);
      if (!task) {
        return createErrorResponse(requestId, 404, 'TASK_NOT_FOUND', 'Task not found');
      }

      this._taskService.setCurrentId(taskId);
      return createSuccessResponse(requestId, 200, { currentTaskId: taskId });
    }

    if (segments.length === 3 && segments[2] === 'archive' && method === 'POST') {
      return this._handleArchiveTask(requestId, taskId);
    }

    if (segments.length === 3 && segments[2] === 'restore' && method === 'POST') {
      return this._handleRestoreTask(requestId, taskId);
    }

    return createErrorResponse(requestId, 404, 'NOT_FOUND', 'Route not found');
  }

  private async _handleArchiveTask(
    requestId: string,
    taskId: string,
  ): Promise<LocalRestApiResponsePayload> {
    const task = await this._getTaskWithSubTasksById(taskId);
    if (!task) {
      return createErrorResponse(requestId, 404, 'TASK_NOT_FOUND', 'Task not found');
    }

    await this._taskService.moveToArchive(task);
    return createSuccessResponse(requestId, 200, { id: taskId, archived: true });
  }

  private async _handleRestoreTask(
    requestId: string,
    taskId: string,
  ): Promise<LocalRestApiResponsePayload> {
    const existsInArchive = await this._taskArchiveService.hasTask(taskId);
    if (!existsInArchive) {
      return createErrorResponse(
        requestId,
        404,
        'TASK_NOT_FOUND',
        'Task not found in archive',
      );
    }

    const archivedTask = await this._taskArchiveService.getById(taskId);
    const subTasks: Task[] = [];

    if (archivedTask.subTaskIds?.length) {
      const archive = await this._taskArchiveService.load();
      for (const subTaskId of archivedTask.subTaskIds) {
        if (archive.entities[subTaskId]) {
          subTasks.push(archive.entities[subTaskId]);
        }
      }
    }

    this._taskService.restoreTask(archivedTask, subTasks);
    const restoredTask = await this._getTaskById(taskId);
    return createSuccessResponse(requestId, 200, restoredTask);
  }

  private async _handleListProjects(
    requestId: string,
    query: Record<string, string | string[]>,
  ): Promise<LocalRestApiResponsePayload> {
    const queryText = getQueryParam(query, 'query');

    let projects = await firstValueFrom(this._projectService.list$);

    if (queryText) {
      const lowerQuery = queryText.toLowerCase();
      projects = projects.filter((p) => p.title.toLowerCase().includes(lowerQuery));
    }

    return createSuccessResponse(requestId, 200, projects);
  }

  private async _handleListTags(
    requestId: string,
    query: Record<string, string | string[]>,
  ): Promise<LocalRestApiResponsePayload> {
    const queryText = getQueryParam(query, 'query');

    let tags = await firstValueFrom(this._tagService.tags$);

    if (queryText) {
      const lowerQuery = queryText.toLowerCase();
      tags = tags.filter((t) => t.title.toLowerCase().includes(lowerQuery));
    }

    return createSuccessResponse(requestId, 200, tags);
  }

  // The id equality checks reject prototype-property names ('constructor',
  // 'toString', …) that entity-map lookups resolve to truthy non-tasks.
  private async _getTaskById(taskId: string): Promise<Task | undefined> {
    const task = await firstValueFrom(this._taskService.getByIdOnce$(taskId));
    return task?.id === taskId ? task : undefined;
  }

  private async _getTaskWithSubTasksById(
    taskId: string,
  ): Promise<TaskWithSubTasks | undefined> {
    const task = await firstValueFrom(this._taskService.getByIdWithSubTaskData$(taskId));
    return task?.id === taskId ? task : undefined;
  }
}
