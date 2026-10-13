import { useSyncExternalStore } from "react";

const subscribeNoop = () => () => {};

/**
 * `false` on the server and during hydration, `true` once the client has mounted.
 * Uses `useSyncExternalStore` instead of `useEffect(() => setMounted(true))`, so the first
 * client render already knows it is mounted and no extra render pass is needed.
 */
export function useIsMounted(): boolean {
    return useSyncExternalStore(
        subscribeNoop,
        () => true,
        () => false,
    );
}
