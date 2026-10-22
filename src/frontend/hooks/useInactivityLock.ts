import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  InactivityLockController,
  InactivityLockState,
  InactivityLockDeps,
  DEFAULT_INACTIVITY_TIMEOUT_MS,
  DEFAULT_STORAGE_KEY,
} from '../components/InactivityLockController';

export interface UseInactivityLockOptions extends InactivityLockDeps {
  /** Automatically start monitoring upon mount (default: true) */
  autoStart?: boolean;
}

/**
 * useInactivityLock
 *
 * Hook for managing client-side inactivity monitoring, wallet re-verification,
 * and session lock state in React functional components.
 */
export function useInactivityLock(options: UseInactivityLockOptions = {}) {
  const {
    walletAddress = null,
    defaultTimeoutMs = DEFAULT_INACTIVITY_TIMEOUT_MS,
    storageKey = DEFAULT_STORAGE_KEY,
    autoStart = true,
    verifyWallet,
    verifyPasskey,
    onLock,
    onUnlock,
  } = options;

  const controller = useMemo(
    () =>
      new InactivityLockController({
        walletAddress,
        defaultTimeoutMs,
        storageKey,
        verifyWallet,
        verifyPasskey,
        onLock,
        onUnlock,
      }),
    [],
  );

  const [state, setState] = useState<InactivityLockState>(() => controller.getState());

  useEffect(() => {
    controller.setWalletAddress(walletAddress);
  }, [controller, walletAddress]);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    return unsubscribe;
  }, [controller]);

  useEffect(() => {
    if (!autoStart) return;

    controller.startMonitoring();

    const handleActivity = () => controller.recordActivity();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        controller.checkInactivity();
      }
    };
    const handleStorage = (e: StorageEvent) => {
      if (e.key) controller.handleStorageEvent(e.key, e.newValue);
    };

    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'touchmove', 'wheel', 'scroll'];
    events.forEach((evt) => window.addEventListener(evt, handleActivity, { passive: true }));
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('storage', handleStorage);

    return () => {
      controller.stopMonitoring();
      events.forEach((evt) => window.removeEventListener(evt, handleActivity));
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('storage', handleStorage);
    };
  }, [controller, autoStart]);

  const recordActivity = useCallback(() => controller.recordActivity(), [controller]);
  const lock = useCallback(() => controller.lockSession(), [controller]);
  const unlockWithPasskey = useCallback(() => controller.unlockWithPasskey(), [controller]);
  const unlockWithWallet = useCallback(() => controller.unlockWithWallet(), [controller]);
  const setTimeoutPreference = useCallback(
    (ms: number) => controller.setTimeoutPreference(ms),
    [controller],
  );

  return {
    ...state,
    recordActivity,
    lock,
    unlockWithPasskey,
    unlockWithWallet,
    setTimeoutPreference,
    controller,
  };
}
