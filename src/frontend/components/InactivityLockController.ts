/**
 * InactivityLockController
 *
 * Framework-agnostic controller managing client-side inactivity monitoring,
 * full-screen lock enforcement, biometric/passkey verification, Stellar wallet
 * re-verification, and persistent user timeout preferences.
 *
 * Implemented as a plain TypeScript class with dependency injection so the
 * entire state machine, countdown timers, event throttling, and authentication
 * flows can be unit-tested without a real browser DOM.
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface InactivityLockState {
  /** Whether the session is currently locked behind the blur overlay. */
  isLocked: boolean;
  /** Inactivity timeout duration in milliseconds (default 15 minutes). */
  timeoutMs: number;
  /** Timestamp (ms) of the most recent recorded user activity. */
  lastActivityAt: number;
  /** Milliseconds remaining before the session will lock (0 when locked). */
  remainingMs: number;
  /** Currently selected unlock method: 'passkey' | 'wallet'. */
  unlockMethod: 'passkey' | 'wallet';
  /** True while biometric or wallet signature verification is in flight. */
  isVerifying: boolean;
  /** Error message if unlock verification fails. */
  error: string | null;
  /** Masked wallet address or user identifier displayed in the lock modal. */
  walletAddress: string | null;
  /** Total number of lock events during this session. */
  lockCount: number;
}

export interface InactivityLockDeps {
  /** Initial connected Stellar wallet public key, or null. */
  walletAddress?: string | null;
  /** Custom initial timeout in milliseconds (defaults to 15 minutes = 900,000 ms). */
  defaultTimeoutMs?: number;
  /** Key used for saving timeout preference in storage. */
  storageKey?: string;
  /** Pluggable storage adapter (defaults to window.localStorage if available, or in-memory fallback). */
  storage?: StorageLike;
  /** Current time provider (for deterministic testing). */
  now?: () => number;
  /** Timer scheduler (defaults to setInterval). */
  setIntervalFn?: (cb: () => void, ms: number) => any;
  /** Timer clearer (defaults to clearInterval). */
  clearIntervalFn?: (timerId: any) => void;
  /**
   * Wallet re-verification routine.
   * Can perform signature challenge or connection confirmation.
   */
  verifyWallet?: (walletAddress: string) => Promise<boolean>;
  /**
   * Biometric / Passkey WebAuthn authentication routine.
   */
  verifyPasskey?: () => Promise<boolean>;
  /**
   * Optional callback fired when session locks.
   */
  onLock?: () => void;
  /**
   * Optional callback fired when session unlocks.
   */
  onUnlock?: () => void;
}

export const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
export const DEFAULT_STORAGE_KEY = 'stellarflow_inactivity_timeout_ms';
export const LAST_ACTIVITY_STORAGE_KEY = 'stellarflow_last_activity_timestamp';
export const LOCK_STATE_STORAGE_KEY = 'stellarflow_session_locked';

/** Preset timeout options in milliseconds for user selection */
export const TIMEOUT_PRESETS: { label: string; valueMs: number }[] = [
  { label: '5 Minutes', valueMs: 5 * 60 * 1000 },
  { label: '10 Minutes', valueMs: 10 * 60 * 1000 },
  { label: '15 Minutes (Default)', valueMs: 15 * 60 * 1000 },
  { label: '30 Minutes', valueMs: 30 * 60 * 1000 },
  { label: '1 Hour', valueMs: 60 * 60 * 1000 },
];

export class InactivityLockController {
  private state: InactivityLockState;
  private deps: Required<Omit<InactivityLockDeps, 'walletAddress' | 'onLock' | 'onUnlock'>> & {
    walletAddress: string | null;
    onLock?: () => void;
    onUnlock?: () => void;
  };
  private timerId: any = null;
  private subscribers: Set<(state: Readonly<InactivityLockState>) => void> = new Set();
  private throttleIntervalMs = 1000; // Only record activity at most once per second

  constructor(deps: InactivityLockDeps = {}) {
    const memoryStorage: Record<string, string> = {};
    const fallbackStorage: StorageLike = {
      getItem: (k) => memoryStorage[k] ?? null,
      setItem: (k, v) => {
        memoryStorage[k] = v;
      },
      removeItem: (k) => {
        delete memoryStorage[k];
      },
    };

    const storage =
      deps.storage ??
      (typeof window !== 'undefined' && window.localStorage ? window.localStorage : fallbackStorage);

    const storageKey = deps.storageKey ?? DEFAULT_STORAGE_KEY;
    const now = deps.now ?? (() => Date.now());

    // Restore saved timeout preference if valid, otherwise fallback to default
    let timeoutMs = deps.defaultTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    try {
      const saved = storage.getItem(storageKey);
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed) && parsed > 0) {
          timeoutMs = parsed;
        }
      }
    } catch {
      // Ignore storage access errors (e.g. private browsing restrictions)
    }

    this.deps = {
      walletAddress: deps.walletAddress ?? null,
      defaultTimeoutMs: timeoutMs,
      storageKey,
      storage,
      now,
      setIntervalFn: deps.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms)),
      clearIntervalFn: deps.clearIntervalFn ?? ((id) => clearInterval(id)),
      verifyWallet: deps.verifyWallet ?? (async () => true),
      verifyPasskey: deps.verifyPasskey ?? (async () => true),
      onLock: deps.onLock,
      onUnlock: deps.onUnlock,
    };

    const currentTime = this.deps.now();

    this.state = {
      isLocked: false,
      timeoutMs,
      lastActivityAt: currentTime,
      remainingMs: timeoutMs,
      unlockMethod: 'passkey',
      isVerifying: false,
      error: null,
      walletAddress: this.deps.walletAddress,
      lockCount: 0,
    };
  }

  // ── Public Accessors & Subscriptions ─────────────────────────────────────────

  getState(): Readonly<InactivityLockState> {
    return { ...this.state };
  }

  subscribe(listener: (state: Readonly<InactivityLockState>) => void): () => void {
    this.subscribers.add(listener);
    listener(this.getState());
    return () => {
      this.subscribers.delete(listener);
    };
  }

  private notify(): void {
    const currentState = this.getState();
    this.subscribers.forEach((fn) => fn(currentState));
  }

  // ── Lifecycle & Timer Management ─────────────────────────────────────────────

  /**
   * Starts background inactivity heartbeat monitor.
   * Checks every interval if idle duration has exceeded timeout.
   */
  startMonitoring(): void {
    if (this.timerId !== null) return;

    this.timerId = this.deps.setIntervalFn(() => {
      this.checkInactivity();
    }, 1000);
  }

  /**
   * Stops background heartbeat monitor.
   */
  stopMonitoring(): void {
    if (this.timerId !== null) {
      this.deps.clearIntervalFn(this.timerId);
      this.timerId = null;
    }
  }

  // ── Activity Tracking ────────────────────────────────────────────────────────

  /**
   * Record user interaction (mouse move, keyboard click, touch, scroll).
   * Throttled to avoid event loop overhead.
   */
  recordActivity(): void {
    if (this.state.isLocked) return; // Do not record activity while locked

    const now = this.deps.now();
    if (now - this.state.lastActivityAt < this.throttleIntervalMs) {
      return; // Throttled
    }

    this.state = {
      ...this.state,
      lastActivityAt: now,
      remainingMs: this.state.timeoutMs,
      error: null,
    };

    try {
      this.deps.storage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(now));
    } catch {
      // Ignore storage errors
    }

    this.notify();
  }

  /**
   * Called on heartbeat tick or when page visibility changes.
   */
  checkInactivity(): void {
    if (this.state.isLocked) return;

    const now = this.deps.now();
    const elapsed = now - this.state.lastActivityAt;
    const remaining = Math.max(0, this.state.timeoutMs - elapsed);

    if (remaining <= 0) {
      this.lockSession();
    } else {
      if (this.state.remainingMs !== remaining) {
        this.state = { ...this.state, remainingMs: remaining };
        this.notify();
      }
    }
  }

  // ── Lock State ───────────────────────────────────────────────────────────────

  /**
   * Lock the session immediately, blurring the active route views.
   */
  lockSession(): void {
    if (this.state.isLocked) return;

    this.state = {
      ...this.state,
      isLocked: true,
      remainingMs: 0,
      error: null,
      lockCount: this.state.lockCount + 1,
    };

    try {
      this.deps.storage.setItem(LOCK_STATE_STORAGE_KEY, 'true');
    } catch {
      // Ignore storage errors
    }

    this.notify();
    if (this.deps.onLock) {
      this.deps.onLock();
    }
  }

  // ── Unlock Verification Flows ────────────────────────────────────────────────

  /**
   * Switch between 'passkey' and 'wallet' unlock tabs.
   */
  setUnlockMethod(method: 'passkey' | 'wallet'): void {
    this.state = { ...this.state, unlockMethod: method, error: null };
    this.notify();
  }

  /**
   * Unlock with biometric / WebAuthn passkey.
   */
  async unlockWithPasskey(): Promise<boolean> {
    if (this.state.isVerifying) return false;

    this.state = { ...this.state, isVerifying: true, error: null };
    this.notify();

    try {
      const verified = await this.deps.verifyPasskey();
      if (verified) {
        this.completeUnlock();
        return true;
      } else {
        this.state = {
          ...this.state,
          isVerifying: false,
          error: 'Biometric passkey authentication failed. Please try again.',
        };
        this.notify();
        return false;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Passkey verification failed';
      this.state = {
        ...this.state,
        isVerifying: false,
        error: msg,
      };
      this.notify();
      return false;
    }
  }

  /**
   * Unlock by re-verifying connected Stellar wallet.
   */
  async unlockWithWallet(): Promise<boolean> {
    if (this.state.isVerifying) return false;
    if (!this.state.walletAddress) {
      this.state = {
        ...this.state,
        error: 'No Stellar wallet connected. Please re-authenticate.',
      };
      this.notify();
      return false;
    }

    this.state = { ...this.state, isVerifying: true, error: null };
    this.notify();

    try {
      const verified = await this.deps.verifyWallet(this.state.walletAddress);
      if (verified) {
        this.completeUnlock();
        return true;
      } else {
        this.state = {
          ...this.state,
          isVerifying: false,
          error: 'Wallet signature verification failed. Please check your wallet.',
        };
        this.notify();
        return false;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Wallet verification failed';
      this.state = {
        ...this.state,
        isVerifying: false,
        error: msg,
      };
      this.notify();
      return false;
    }
  }

  /**
   * Completes unlock transition, removing blur overlay and preserving active route state.
   */
  private completeUnlock(): void {
    const now = this.deps.now();
    this.state = {
      ...this.state,
      isLocked: false,
      isVerifying: false,
      error: null,
      lastActivityAt: now,
      remainingMs: this.state.timeoutMs,
    };

    try {
      this.deps.storage.removeItem(LOCK_STATE_STORAGE_KEY);
      this.deps.storage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(now));
    } catch {
      // Ignore storage errors
    }

    this.notify();
    if (this.deps.onUnlock) {
      this.deps.onUnlock();
    }
  }

  // ── Custom Timeout Preference ────────────────────────────────────────────────

  /**
   * Save custom user inactivity duration preference (in milliseconds).
   * Updates state and persists to storage immediately.
   */
  setTimeoutPreference(durationMs: number): void {
    if (durationMs <= 0) return;

    this.state = {
      ...this.state,
      timeoutMs: durationMs,
      remainingMs: this.state.isLocked ? 0 : durationMs,
    };

    try {
      this.deps.storage.setItem(this.deps.storageKey, String(durationMs));
    } catch {
      // Ignore storage errors
    }

    this.notify();
  }

  /**
   * Updates connected wallet address.
   */
  setWalletAddress(address: string | null): void {
    this.state = { ...this.state, walletAddress: address };
    this.deps.walletAddress = address;
    this.notify();
  }

  // ── Cross-Tab Sync ───────────────────────────────────────────────────────────

  /**
   * Synchronize state when storage events fire from other tabs.
   */
  handleStorageEvent(key: string, newValue: string | null): void {
    if (key === this.deps.storageKey && newValue) {
      const parsed = parseInt(newValue, 10);
      if (!isNaN(parsed) && parsed > 0) {
        this.state = { ...this.state, timeoutMs: parsed };
        this.notify();
      }
    } else if (key === LOCK_STATE_STORAGE_KEY) {
      if (newValue === 'true' && !this.state.isLocked) {
        this.lockSession();
      } else if (newValue === null && this.state.isLocked) {
        this.completeUnlock();
      }
    } else if (key === LAST_ACTIVITY_STORAGE_KEY && newValue && !this.state.isLocked) {
      const parsed = parseInt(newValue, 10);
      if (!isNaN(parsed) && parsed > this.state.lastActivityAt) {
        this.state = {
          ...this.state,
          lastActivityAt: parsed,
          remainingMs: this.state.timeoutMs,
        };
        this.notify();
      }
    }
  }
}
