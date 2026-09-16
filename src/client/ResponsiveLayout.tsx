import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Menu, PanelLeft, PanelLeftClose, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import "./styles/responsive.css";

const noopRunningSessionCount = () => undefined;
const RunningSessionCountContext = createContext<(count: number) => void>(noopRunningSessionCount);
const CompactLayoutContext = createContext(false);
const CloseMiddlePanelContext = createContext<() => void>(() => undefined);

export function useCompactLayout() {
  return useContext(CompactLayoutContext);
}

export function useSetRunningSessionCount() {
  return useContext(RunningSessionCountContext);
}

export function useCloseMiddlePanel() {
  return useContext(CloseMiddlePanelContext);
}

export function ResponsiveLayout({ children }: { children: ReactNode }) {
  const [compact, setCompact] = useState(() => window.matchMedia("(width < 1080px)").matches);
  const [leftOpen, setLeftOpen] = useState(() => window.innerWidth >= 1080);
  const [middleOpen, setMiddleOpen] = useState(() => window.innerWidth >= 768);
  const [menuOpen, setMenuOpen] = useState(false);
  const [runningSessionCount, setRunningSessionCount] = useState(0);
  const controls = useRef<HTMLDivElement>(null);
  const layout = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = layout.current;
    if (!compact || !element) return;
    const viewport = window.visualViewport;
    const updateViewport = () => {
      // Preserve native pinch zoom; only follow the keyboard/browser chrome at normal scale.
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
      element.style.setProperty("--app-height", `${viewport?.height ?? window.innerHeight}px`);
      element.style.setProperty("--app-top", `${viewport?.offsetTop ?? 0}px`);
    };
    updateViewport();
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    window.addEventListener("resize", updateViewport);
    return () => {
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
      element.style.removeProperty("--app-height");
      element.style.removeProperty("--app-top");
    };
  }, [compact]);

  useEffect(() => {
    const tablet = window.matchMedia("(width < 1080px)");
    const height = window.matchMedia("(height < 1080px)");
    const updateHeight = () => setMenuOpen(false);
    const updateTablet = () => { setCompact(tablet.matches); setLeftOpen(!tablet.matches); setMenuOpen(false); };
    tablet.addEventListener("change", updateTablet);
    height.addEventListener("change", updateHeight);
    return () => { tablet.removeEventListener("change", updateTablet); height.removeEventListener("change", updateHeight); };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !menuOpen) return;
      setMenuOpen(false);
      controls.current?.querySelector<HTMLButtonElement>(menuOpen ? ".layout-menu-toggle" : ".layout-left-toggle")?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const menuLabel = runningSessionCount > 0
    ? `Toggle workspace menu (${runningSessionCount} running session${runningSessionCount === 1 ? "" : "s"})`
    : "Toggle workspace menu";
  const menuCount = runningSessionCount > 99 ? "99+" : runningSessionCount;
  const closeMiddlePanel = () => {
    if (window.matchMedia("(width < 768px)").matches) setMiddleOpen(false);
  };

  return <RunningSessionCountContext.Provider value={setRunningSessionCount}>
    <div ref={layout} className="responsive-layout" data-left-open={leftOpen} data-middle-open={middleOpen} data-menu-open={menuOpen}>
      <div className="layout-controls" ref={controls} aria-label="Layout controls">
        <button className="layout-menu-toggle" aria-label={menuLabel} aria-expanded={menuOpen} onClick={() => { setMenuOpen(!menuOpen); if (compact) setLeftOpen(false); }} title="Workspace menu">
          {menuOpen ? <X /> : <Menu />}
          {runningSessionCount > 0 && <span className="layout-menu-count" aria-hidden="true">{menuCount}</span>}
        </button>
        {!compact && <button className="layout-left-toggle" aria-label="Toggle sessions panel" aria-expanded={leftOpen} onClick={() => { setLeftOpen(!leftOpen); setMenuOpen(false); }} title="Sessions">{leftOpen ? <PanelLeftClose /> : <PanelLeft />}</button>}
        <button aria-label="Toggle middle panel" aria-expanded={middleOpen} onClick={() => setMiddleOpen(!middleOpen)} title="Sessions / Turns / Plan / Side chat">{middleOpen ? <PanelRightClose /> : <PanelRightOpen />}</button>
      </div>
      {menuOpen && <button className="layout-backdrop" aria-label="Close navigation" onClick={() => { setMenuOpen(false); controls.current?.querySelector<HTMLButtonElement>(".layout-menu-toggle")?.focus(); }} />}
      <CompactLayoutContext.Provider value={compact}>
        <CloseMiddlePanelContext.Provider value={closeMiddlePanel}>{children}</CloseMiddlePanelContext.Provider>
      </CompactLayoutContext.Provider>
    </div>
  </RunningSessionCountContext.Provider>;
}
