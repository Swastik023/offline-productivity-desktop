// Timer state - single source of truth
export interface TimerState {
  isRunning: boolean;
  startedAt: number | null;
  elapsed: number;
  duration: number;
  purpose: 'work' | 'break' | null;
  isLongBreak?: boolean;
}

// Work context snapshot for preserving project/context during breaks
export interface PausedWorkContextSnapshot {
  activeId: string;
  activeType: import('../work-context/work-context.model').WorkContextType;
  title: string;
  taskTitle?: string;
  dailyTimeWorked?: number;
}

export enum FocusMainUIState {
  Preparation = 'Preparation',
  Countdown = 'Countdown',
  InProgress = 'InProgress',
}

// UI screens enum
export enum FocusScreen {
  TaskSelection = 'TaskSelection',
  DurationSelection = 'DurationSelection',
  Preparation = 'Preparation',
  Main = 'Main',
  SessionDone = 'SessionDone',
  Break = 'Break',
  // Entered when a Pomodoro break expires naturally. The timer is stopped and
  // no new session starts. The user must explicitly click "Start Focus" to
  // continue. This state persists across overlay close/reopen until the user acts.
  WaitingForNextFocus = 'WaitingForNextFocus',
}

export enum FocusModeMode {
  'Flowtime' = 'Flowtime',
  'Pomodoro' = 'Pomodoro',
  'Countdown' = 'Countdown',
}

// Simplified state structure
export interface FocusModeState {
  // The timer - single source of truth
  timer: TimerState;

  // The UI - what screen to show
  currentScreen: FocusScreen;
  mainState: FocusMainUIState;
  isOverlayShown: boolean;

  // Session metadata
  mode: FocusModeMode;
  currentCycle: number;
  lastCompletedDuration: number;

  // Task tracking during breaks
  pausedTaskId: string | null;

  // Work context preservation during breaks
  pausedWorkContext: PausedWorkContextSnapshot | null;

  // Internal flag: tracks if break resume is in progress
  _isResumingBreak: boolean;

  // Internal flag: when true, tick reducer won't auto-stop work timer at duration
  _isOvertimeEnabled: boolean;

  // Selected message key for the current break
  breakMessageKey: string | null;
}

// Mode strategy interface
export interface FocusModeStrategy {
  readonly initialSessionDuration: number;
  readonly shouldStartBreakAfterSession: boolean;
  readonly shouldAutoStartNextSession: boolean;
  getBreakDuration(cycle: number): { duration: number; isLong: boolean } | null;
  getNextScreenAfterTaskSelection(skipPreparation: boolean): {
    screen: FocusScreen;
    duration?: number;
  };
}

// Helper functions and type guards for timer
export const isTimerRunning = (timer: TimerState): boolean => {
  return timer.isRunning && timer.purpose !== null;
};

export const isWorkSession = (timer: TimerState): boolean => {
  return timer.purpose === 'work';
};

export const isBreakSession = (timer: TimerState): boolean => {
  return timer.purpose === 'break';
};

/**
 * After incrementCycle, the current cycle is 1 too high for break calculation.
 * This returns the last completed session's cycle, clamped to a minimum of 1.
 */
export const getBreakCycle = (currentCycle: number): number =>
  Math.max(currentCycle - 1, 1);

// Constants for better maintainability
export const FOCUS_MODE_DEFAULTS = {
  SESSION_DURATION: 25 * 60 * 1000, // 25 minutes
  SHORT_BREAK_DURATION: 5 * 60 * 1000, // 5 minutes
  LONG_BREAK_DURATION: 15 * 60 * 1000, // 15 minutes
  CYCLES_BEFORE_LONG_BREAK: 4,
} as const;
