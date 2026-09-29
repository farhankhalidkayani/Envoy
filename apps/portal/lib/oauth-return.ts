"use client";

import { useEffect } from "react";

/**
 * OAuth callbacks land back here with ?connected=… or ?oauth_error=…; surface
 * the outcome once, then strip it so a refresh doesn't repeat it.
 */
export function useOAuthReturn(onConnected: (provider: string) => void, onError: (message: string) => void) {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const error = params.get("oauth_error");
    if (!connected && !error) return;
    if (connected) onConnected(connected);
    if (error) onError(error);
    window.history.replaceState(null, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
