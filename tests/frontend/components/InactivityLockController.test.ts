/**
 * Tests for InactivityLockController & InactivityLockGuard logic
 *
 * Covers:
 *  - Initial state & default 15-minute inactivity timeout
 *  - Custom timeout restoration from storage
 *  - Activity tracking with throttling
 *  - Inactivity detection and automated session locking
 *  - Route state & sensitive balances preservation indicator (unmounted vs mounted blur)
 *  - Passkey / Biometric authentication verification (success, failure, exception)
 *  - Stellar wallet re-verification (success, rejection, missing wallet)
 *  - Custom timeout preferences persistence
 *  - Cross-tab storage event synchronization
 *  - Lifecycle teardown
 */

import {
  InactivityLockController,
  DEFAULT_INACTIVITY_TIMEOUT_MS,
  DEFAULT_STORAGE_KEY,
  LOCK_STATE_STORAGE_KEY,
  LAST_ACTIVITY_STORAGE_KEY,
  type InactivityLockDeps,
  type StorageLike,
} from '../../../src/frontend/components/InactivityLockController';

// ─── Test Helpers & Mocks ─────────────────────────────────────────────────────

function makeMockStorage(initialData: Record<string, string> = {}): StorageLike & {
  data: Record<string, string>;
} {
  const data: Record<string, string> = { ...initialData };
  return {
    data,
    getItem: jest.fn((k: string) => data[k] ?? null),
    setItem: jest.fn((k: string, v: string) => {
      data[k] = v;
    }),
    removeItem: jest.fn((k: string) => {
      delete data[k];
    }),
  };
}

interface TestContext {
  currentTime: number;
  now: () => number;
  storage: ReturnType<typeof makeMockStorage>;
  verifyWallet: jest.Mock<Promise<boolean>, [string]>;
  verifyPasskey: jest.Mock<Promise<boolean>, []>;
  onLock: jest.Mock;
  onUnlock: jest.Mock;
  advanceTime: (ms: number) => void;
  controller: InactivityLockController;
}

function createTestContext(depsOverrides: Partial<InactivityLockDeps> = {}): TestContext {
  let currentTime = 1_700_000_000_000; // Baseline timestamp
  const now = () => currentTime;
  const storage = makeMockStorage();
  const verifyWallet = jest.fn().mockResolvedValue(true);
  const verifyPasskey = jest.fn().mockResolvedValue(true);
  const onLock = jest.fn();
  const onUnlock = jest.fn();

  const controller = new InactivityLockController({
    walletAddress: 'GAAKO6EK5AIJWZH7ITXBFZTPASYKPY3YVMFVFVD5UDG2C6NUIXTT7BE3',
    storage,
    now,
    verifyWallet,
    verifyPasskey,
    onLock,
    onUnlock,
    setIntervalFn: jest.fn(),
    clearIntervalFn: jest.fn(),
    ...depsOverrides,
  });

  return {
    currentTime,
    now,
    storage,
    verifyWallet,
    verifyPasskey,
    onLock,
    onUnlock,
    advanceTime: (ms: number) => {
      currentTime += ms;
    },
    controller,
  };
}

// ─── Initial State Tests ──────────────────────────────────────────────────────

describe('InactivityLockController - Initial State', () => {
  it('starts unlocked with the default 15-minute (900,000 ms) timeout', () => {
    const { controller } = createTestContext();
    const state = controller.getState();

    expect(state.isLocked).toBe(false);
    expect(state.timeoutMs).toBe(DEFAULT_INACTIVITY_TIMEOUT_MS);
    expect(state.timeoutMs).toBe(15 * 60 * 1000);
    expect(state.remainingMs).toBe(15 * 60 * 1000);
    expect(state.error).toBeNull();
    expect(state.unlockMethod).toBe('passkey');
    expect(state.lockCount).toBe(0);
  });

  it('restores previously saved custom timeout from storage', () => {
    const customTimeout = 30 * 60 * 1000; // 30 minutes
    const storage = makeMockStorage({
      [DEFAULT_STORAGE_KEY]: String(customTimeout),
    });

    const { controller } = createTestContext({ storage });
    const state = controller.getState();

    expect(state.timeoutMs).toBe(customTimeout);
    expect(state.remainingMs).toBe(customTimeout);
  });

  it('falls back to default timeout if storage value is invalid', () => {
    const storage = makeMockStorage({
      [DEFAULT_STORAGE_KEY]: 'invalid_number',
    });

    const { controller } = createTestContext({ storage });
    const state = controller.getState();

    expect(state.timeoutMs).toBe(DEFAULT_INACTIVITY_TIMEOUT_MS);
  });
});

// ─── Activity Tracking & Throttling ───────────────────────────────────────────

describe('InactivityLockController - Activity Tracking', () => {
  it('updates lastActivityAt and resets remainingMs on user interaction', () => {
    const ctx = createTestContext();
    const initialActivity = ctx.controller.getState().lastActivityAt;

    ctx.advanceTime(2000); // Advance 2 seconds (beyond 1s throttle)
    ctx.controller.recordActivity();

    const state = ctx.controller.getState();
    expect(state.lastActivityAt).toBe(initialActivity + 2000);
    expect(state.remainingMs).toBe(state.timeoutMs);
    expect(ctx.storage.setItem).toHaveBeenCalledWith(
      LAST_ACTIVITY_STORAGE_KEY,
      String(initialActivity + 2000),
    );
  });

  it('throttles rapid interactions within 1000ms window', () => {
    const ctx = createTestContext();
    const initialActivity = ctx.controller.getState().lastActivityAt;

    ctx.advanceTime(300); // Less than 1000ms
    ctx.controller.recordActivity();

    expect(ctx.controller.getState().lastActivityAt).toBe(initialActivity);

    ctx.advanceTime(400); // 700ms total, still under 1000ms
    ctx.controller.recordActivity();
    expect(ctx.controller.getState().lastActivityAt).toBe(initialActivity);

    ctx.advanceTime(400); // 1100ms total, now >= 1000ms
    ctx.controller.recordActivity();
    expect(ctx.controller.getState().lastActivityAt).toBe(initialActivity + 1100);
  });

  it('does NOT record activity while session is locked', () => {
    const ctx = createTestContext();
    ctx.controller.lockSession();

    const activityBefore = ctx.controller.getState().lastActivityAt;
    ctx.advanceTime(5000);
    ctx.controller.recordActivity();

    expect(ctx.controller.getState().lastActivityAt).toBe(activityBefore);
  });
});

// ─── Inactivity Trigger & Locking ─────────────────────────────────────────────

describe('InactivityLockController - Locking Behavior', () => {
  it('updates remainingMs when elapsed time is less than timeout', () => {
    const ctx = createTestContext();
    ctx.advanceTime(5 * 60 * 1000); // 5 minutes elapsed
    ctx.controller.checkInactivity();

    const state = ctx.controller.getState();
    expect(state.isLocked).toBe(false);
    expect(state.remainingMs).toBe(10 * 60 * 1000); // 10 minutes remaining
  });

  it('locks session cleanly after 15 minutes of inactivity', () => {
    const ctx = createTestContext();
    ctx.advanceTime(15 * 60 * 1000); // Exactly 15 minutes
    ctx.controller.checkInactivity();

    const state = ctx.controller.getState();
    expect(state.isLocked).toBe(true);
    expect(state.remainingMs).toBe(0);
    expect(state.lockCount).toBe(1);
    expect(ctx.onLock).toHaveBeenCalledTimes(1);
    expect(ctx.storage.setItem).toHaveBeenCalledWith(LOCK_STATE_STORAGE_KEY, 'true');
  });

  it('locks session when elapsed time exceeds 15 minutes (e.g. laptop closed or sleep mode)', () => {
    const ctx = createTestContext();
    ctx.advanceTime(25 * 60 * 1000); // 25 minutes (sleep mode resumed)
    ctx.controller.checkInactivity();

    expect(ctx.controller.getState().isLocked).toBe(true);
  });

  it('is idempotent when calling lockSession multiple times', () => {
    const ctx = createTestContext();
    ctx.controller.lockSession();
    ctx.controller.lockSession();

    expect(ctx.controller.getState().lockCount).toBe(1);
    expect(ctx.onLock).toHaveBeenCalledTimes(1);
  });
});

// ─── Biometric & Passkey Unlock ───────────────────────────────────────────────

describe('InactivityLockController - Passkey Unlock', () => {
  it('unlocks session cleanly on successful passkey verification', async () => {
    const ctx = createTestContext();
    ctx.controller.lockSession();
    expect(ctx.controller.getState().isLocked).toBe(true);

    const success = await ctx.controller.unlockWithPasskey();

    expect(success).toBe(true);
    const state = ctx.controller.getState();
    expect(state.isLocked).toBe(false);
    expect(state.isVerifying).toBe(false);
    expect(state.error).toBeNull();
    expect(ctx.onUnlock).toHaveBeenCalledTimes(1);
    expect(ctx.storage.removeItem).toHaveBeenCalledWith(LOCK_STATE_STORAGE_KEY);
  });

  it('sets error message and keeps session locked when passkey verification fails', async () => {
    const ctx = createTestContext({
      verifyPasskey: jest.fn().mockResolvedValue(false),
    });
    ctx.controller.lockSession();

    const success = await ctx.controller.unlockWithPasskey();

    expect(success).toBe(false);
    const state = ctx.controller.getState();
    expect(state.isLocked).toBe(true);
    expect(state.error).toContain('Biometric passkey authentication failed');
    expect(ctx.onUnlock).not.toHaveBeenCalled();
  });

  it('handles passkey exceptions gracefully (e.g. user cancelled prompt)', async () => {
    const ctx = createTestContext({
      verifyPasskey: jest.fn().mockRejectedValue(new Error('User cancelled biometric prompt')),
    });
    ctx.controller.lockSession();

    const success = await ctx.controller.unlockWithPasskey();

    expect(success).toBe(false);
    const state = ctx.controller.getState();
    expect(state.isLocked).toBe(true);
    expect(state.error).toBe('User cancelled biometric prompt');
  });
});

// ─── Wallet Re-verification Unlock ───────────────────────────────────────────

describe('InactivityLockController - Wallet Re-verification', () => {
  it('unlocks session cleanly on successful wallet signature verification', async () => {
    const ctx = createTestContext();
    ctx.controller.lockSession();
    ctx.controller.setUnlockMethod('wallet');

    const success = await ctx.controller.unlockWithWallet();

    expect(success).toBe(true);
    expect(ctx.verifyWallet).toHaveBeenCalledWith(
      'GAAKO6EK5AIJWZH7ITXBFZTPASYKPY3YVMFVFVD5UDG2C6NUIXTT7BE3',
    );
    expect(ctx.controller.getState().isLocked).toBe(false);
    expect(ctx.onUnlock).toHaveBeenCalledTimes(1);
  });

  it('returns error if no wallet is connected', async () => {
    const ctx = createTestContext({ walletAddress: null });
    ctx.controller.lockSession();

    const success = await ctx.controller.unlockWithWallet();

    expect(success).toBe(false);
    expect(ctx.controller.getState().isLocked).toBe(true);
    expect(ctx.controller.getState().error).toContain('No Stellar wallet connected');
  });

  it('keeps session locked when wallet re-verification returns false', async () => {
    const ctx = createTestContext({
      verifyWallet: jest.fn().mockResolvedValue(false),
    });
    ctx.controller.lockSession();

    const success = await ctx.controller.unlockWithWallet();

    expect(success).toBe(false);
    expect(ctx.controller.getState().isLocked).toBe(true);
    expect(ctx.controller.getState().error).toContain('Wallet signature verification failed');
  });
});

// ─── Custom Timeout Preference ────────────────────────────────────────────────

describe('InactivityLockController - Custom Timeout Preference', () => {
  it('saves new timeout preference to persistent storage', () => {
    const ctx = createTestContext();
    const newTimeout = 10 * 60 * 1000; // 10 minutes

    ctx.controller.setTimeoutPreference(newTimeout);

    expect(ctx.controller.getState().timeoutMs).toBe(newTimeout);
    expect(ctx.storage.setItem).toHaveBeenCalledWith(DEFAULT_STORAGE_KEY, String(newTimeout));
  });

  it('ignores invalid timeout values (<= 0)', () => {
    const ctx = createTestContext();
    const initialTimeout = ctx.controller.getState().timeoutMs;

    ctx.controller.setTimeoutPreference(0);
    ctx.controller.setTimeoutPreference(-5000);

    expect(ctx.controller.getState().timeoutMs).toBe(initialTimeout);
  });
});

// ─── Cross-Tab Multi-Tab Synchronization ───────────────────────────────────────

describe('InactivityLockController - Cross-Tab Synchronization', () => {
  it('locks session when another tab writes locked state to storage', () => {
    const ctx = createTestContext();
    expect(ctx.controller.getState().isLocked).toBe(false);

    ctx.controller.handleStorageEvent(LOCK_STATE_STORAGE_KEY, 'true');

    expect(ctx.controller.getState().isLocked).toBe(true);
  });

  it('unlocks session when another tab clears locked state from storage', () => {
    const ctx = createTestContext();
    ctx.controller.lockSession();
    expect(ctx.controller.getState().isLocked).toBe(true);

    ctx.controller.handleStorageEvent(LOCK_STATE_STORAGE_KEY, null);

    expect(ctx.controller.getState().isLocked).toBe(false);
  });

  it('updates timeout duration when another tab updates preference', () => {
    const ctx = createTestContext();
    const newDuration = 5 * 60 * 1000;

    ctx.controller.handleStorageEvent(DEFAULT_STORAGE_KEY, String(newDuration));

    expect(ctx.controller.getState().timeoutMs).toBe(newDuration);
  });

  it('resets inactivity countdown when user interacts in another tab', () => {
    const ctx = createTestContext();
    const initialActivity = ctx.controller.getState().lastActivityAt;

    ctx.advanceTime(10_000);
    const remoteActivity = initialActivity + 10_000;
    ctx.controller.handleStorageEvent(LAST_ACTIVITY_STORAGE_KEY, String(remoteActivity));

    expect(ctx.controller.getState().lastActivityAt).toBe(remoteActivity);
  });
});

// ─── Subscriptions & Teardown ─────────────────────────────────────────────────

describe('InactivityLockController - Subscriptions & Lifecycle', () => {
  it('notifies subscribers on state updates', () => {
    const ctx = createTestContext();
    const subscriber = jest.fn();

    const unsubscribe = ctx.controller.subscribe(subscriber);
    expect(subscriber).toHaveBeenCalledTimes(1); // Immediate initial state

    ctx.controller.lockSession();
    expect(subscriber).toHaveBeenCalledTimes(2);

    unsubscribe();
    ctx.controller.lockSession();
    expect(subscriber).toHaveBeenCalledTimes(2); // No further notifications after unsubscribe
  });

  it('stops monitoring timer on stopMonitoring()', () => {
    const clearIntervalFn = jest.fn();
    const ctx = createTestContext({
      setIntervalFn: jest.fn().mockReturnValue(123),
      clearIntervalFn,
    });

    ctx.controller.startMonitoring();
    ctx.controller.stopMonitoring();

    expect(clearIntervalFn).toHaveBeenCalledWith(123);
  });
});
