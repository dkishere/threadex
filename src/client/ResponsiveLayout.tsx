import { useEffect, useRef, useState, type ReactNode } from "react";
import { Menu, PanelLeft, PanelLeftClose, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import "./styles/responsive.css";

export function ResponsiveLayout({ children }: { children: ReactNode }) {
  const [compact, setCompact] = useState(() => window.matchMedia("(width < 1080px)").matches);
  const [leftOpen, setLeftOpen] = useState(() => window.innerWidth >= 1080);
  const [middleOpen, setMiddleOpen] = useState(() => window.innerWidth >= 768);
  const [menuOpen, setMenuOpen] = useState(false);
  const controls = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tablet = window.matchMedia("(width < 1080px)");
    const phone = window.matchMedia("(width < 768px)");
    const height = window.matchMedia("(height < 1080px)");
    const updateHeight = () => setMenuOpen(false);
    const updateTablet = () => { setCompact(tablet.matches); setLeftOpen(!tablet.matches); setMenuOpen(false); };
    const updatePhone = () => setMiddleOpen(!phone.matches);
    tablet.addEventListener("change", updateTablet);
    phone.addEventListener("change", updatePhone);
    height.addEventListener("change", updateHeight);
    return () => { tablet.removeEventListener("change", updateTablet); phone.removeEventListener("change", updatePhone); height.removeEventListener("change", updateHeight); };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || (!menuOpen && !(compact && leftOpen))) return;
      setMenuOpen(false);
      if (compact) setLeftOpen(false);
      controls.current?.querySelector<HTMLButtonElement>(menuOpen ? ".layout-menu-toggle" : ".layout-left-toggle")?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [compact, leftOpen, menuOpen]);

  return <div className="responsive-layout" data-left-open={leftOpen} data-middle-open={middleOpen} data-menu-open={menuOpen}>
    <div className="layout-controls" ref={controls} aria-label="Layout controls">
      <button className="layout-menu-toggle" aria-label="Toggle workspace menu" aria-expanded={menuOpen} onClick={() => { setMenuOpen(!menuOpen); if (compact) setLeftOpen(false); }} title="Workspace menu">{menuOpen ? <X /> : <Menu />}</button>
      <button className="layout-left-toggle" aria-label="Toggle sessions panel" aria-expanded={leftOpen} onClick={() => { setLeftOpen(!leftOpen); setMenuOpen(false); }} title="Sessions">{leftOpen ? <PanelLeftClose /> : <PanelLeft />}</button>
      <button aria-label="Toggle middle panel" aria-expanded={middleOpen} onClick={() => setMiddleOpen(!middleOpen)} title="Turns / Plan / Side chat">{middleOpen ? <PanelRightClose /> : <PanelRightOpen />}</button>
    </div>
    {((compact && leftOpen) || menuOpen) && <button className="layout-backdrop" aria-label="Close navigation" onClick={() => { if (compact) setLeftOpen(false); setMenuOpen(false); controls.current?.querySelector<HTMLButtonElement>(menuOpen ? ".layout-menu-toggle" : ".layout-left-toggle")?.focus(); }} />}
    {children}
  </div>;
}
