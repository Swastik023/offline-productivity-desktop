/**
 * Tests for the WaitingForNextFocus state introduced to fix the Pomodoro
 * break-expiry flow. After a break ends naturally, the system must enter an
 * explicit waiting state rather than staying on the ambiguous Break screen.
 * The user must manually click "Start Focus" to begin the next session.
 */
import { focusModeReducer, initialState } from './focus-mode.reducer';
import { tick, startBreak, completeBreak, skipBreak } from './focus-mode.actions';
import { FocusScreen, FocusModeMode } from '../focus-mode.model';

const BREAK_DURATION_MS = 5 * 60 * 1000; // 5 minutes

/** Produce a state with a running break timer that has just expired. */
const stateWithExpiredBreak = (): ReturnType<typeof focusModeReducer> => {
  // Start with a running break
  let state = focusModeReducer(
    { ...initialState, mode: FocusModeMode.Pomodoro },
    startBreak({ duration: BREAK_DURATION_MS, isLongBreak: false, pausedTaskId: null }),
  );

  // Fast-forward: set startedAt in the past so the next tick will see elapsed >= duration.
  // We manipulate startedAt directly to simulate time passing without real delays.
  state = {
    ...state,
    timer: {
      ...state.timer,
      startedAt: Date.now() - (BREAK_DURATION_MS + 1000), // 1 second past the end
    },
  };

  return state;
};

describe('FocusModeReducer — WaitingForNextFocus', () => {
  describe('when a Pomodoro break expires naturally via tick', () => {
    it('should transition currentScreen to WaitingForNextFocus', () => {
      const state = stateWithExpiredBreak();
      const result = focusModeReducer(state, tick());

      expect(result.currentScreen).toBe(FocusScreen.WaitingForNextFocus);
    });

    it('should stop the break timer (isRunning = false)', () => {
      const state = stateWithExpiredBreak();
      const result = focusModeReducer(state, tick());

      expect(result.timer.isRunning).toBe(false);
    });

    it('should preserve the break timer purpose (purpose = break)', () => {
      const state = stateWithExpiredBreak();
      const result = focusModeReducer(state, tick());

      // Timer purpose stays 'break' so isBreakActive stays true in selectors,
      // which keeps the header circle visible.
      expect(result.timer.purpose).toBe('break');
    });

    it('should NOT auto-transition away — state stays WaitingForNextFocus on further ticks', () => {
      const state = stateWithExpiredBreak();
      let result = focusModeReducer(state, tick());
      expect(result.currentScreen).toBe(FocusScreen.WaitingForNextFocus);

      // Subsequent ticks should be no-ops (timer.isRunning = false)
      result = focusModeReducer(result, tick());
      expect(result.currentScreen).toBe(FocusScreen.WaitingForNextFocus);
      result = focusModeReducer(result, tick());
      expect(result.currentScreen).toBe(FocusScreen.WaitingForNextFocus);
    });
  });

  describe('when completeBreak is dispatched from WaitingForNextFocus', () => {
    it('should transition to Main + Preparation', () => {
      const state = stateWithExpiredBreak();
      const waiting = focusModeReducer(state, tick());
      expect(waiting.currentScreen).toBe(FocusScreen.WaitingForNextFocus);

      const result = focusModeReducer(waiting, completeBreak({ pausedTaskId: null }));

      expect(result.currentScreen).toBe(FocusScreen.Main);
    });

    it('should reset the timer to idle', () => {
      const state = stateWithExpiredBreak();
      const waiting = focusModeReducer(state, tick());

      const result = focusModeReducer(waiting, completeBreak({ pausedTaskId: null }));

      expect(result.timer.purpose).toBeNull();
      expect(result.timer.isRunning).toBe(false);
      expect(result.timer.elapsed).toBe(0);
    });

    it('should clear pausedTaskId', () => {
      const state = {
        ...stateWithExpiredBreak(),
        pausedTaskId: 'task-123',
      };
      const waiting = focusModeReducer(state, tick());

      const result = focusModeReducer(waiting, completeBreak({ pausedTaskId: null }));

      expect(result.pausedTaskId).toBeNull();
    });
  });

  describe('when skipBreak is dispatched from WaitingForNextFocus', () => {
    it('should also transition to Main + Preparation and clear timer', () => {
      const state = stateWithExpiredBreak();
      const waiting = focusModeReducer(state, tick());

      const result = focusModeReducer(waiting, skipBreak({ pausedTaskId: null }));

      expect(result.currentScreen).toBe(FocusScreen.Main);
      expect(result.timer.purpose).toBeNull();
    });
  });

  describe('break screen remains Break while timer is still running', () => {
    it('should NOT enter WaitingForNextFocus before break expires', () => {
      let state = focusModeReducer(
        { ...initialState, mode: FocusModeMode.Pomodoro },
        startBreak({
          duration: BREAK_DURATION_MS,
          isLongBreak: false,
          pausedTaskId: null,
        }),
      );
      expect(state.currentScreen).toBe(FocusScreen.Break);

      // Tick once — still early in the break (startedAt is ~now, elapsed ~1s, duration 5m)
      state = focusModeReducer(state, tick());

      // Should still be on Break screen, not WaitingForNextFocus
      expect(state.currentScreen).toBe(FocusScreen.Break);
    });
  });
});
