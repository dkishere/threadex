import { useEffect, type RefObject } from "react";

const SCROLL_KEYS = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "];

/**
 * Keeps a scroll container pinned to its bottom each time it becomes visible and ready.
 * A hidden panel (display: none) has no scroll height, so scrolling while it is hidden is a no-op;
 * this re-runs when `isOpen` flips true and follows later growth (late markdown, images) until the user interacts.
 */
export function useScrollToBottomWhenOpened(containerRef: RefObject<HTMLElement | null>, isOpen: boolean, isContentReady: boolean, resetKey: string) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isOpen || !isContentReady) return;
    let cancelled = false;
    let frame = 0;
    const scrollToBottom = () => { if (!cancelled) container.scrollTop = container.scrollHeight - container.clientHeight; };
    const scheduleScroll = () => {
      if (cancelled || frame) return;
      frame = window.requestAnimationFrame(() => { frame = 0; scrollToBottom(); });
    };
    const resizeObserver = new ResizeObserver(scheduleScroll);
    const observeContent = () => {
      resizeObserver.disconnect();
      resizeObserver.observe(container);
      for (const child of container.children) resizeObserver.observe(child);
      scheduleScroll();
    };
    const mutationObserver = new MutationObserver(observeContent);
    const stopFollowing = () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
    const stopOnScrollKey = (event: KeyboardEvent) => {
      if (!SCROLL_KEYS.includes(event.key)) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      stopFollowing();
    };
    mutationObserver.observe(container, { childList: true });
    container.addEventListener("wheel", stopFollowing, { passive: true });
    container.addEventListener("touchstart", stopFollowing, { passive: true });
    container.addEventListener("pointerdown", stopFollowing, { passive: true });
    window.addEventListener("keydown", stopOnScrollKey);
    scrollToBottom();
    observeContent();
    return () => {
      stopFollowing();
      container.removeEventListener("wheel", stopFollowing);
      container.removeEventListener("touchstart", stopFollowing);
      container.removeEventListener("pointerdown", stopFollowing);
      window.removeEventListener("keydown", stopOnScrollKey);
    };
  }, [containerRef, isOpen, isContentReady, resetKey]);
}
