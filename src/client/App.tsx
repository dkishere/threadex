import { useEffect, useState } from "react";
import { App as ThreadexApp } from "./ThreadexApp";
import { McpPlanHarness } from "./McpPlanHarness";
import { ResponsiveLayout } from "./ResponsiveLayout";

function isHarnessLocation() {
  const url = new URL(window.location.href);
  return url.pathname === "/harness" || url.searchParams.get("view") === "harness";
}

export function App() {
  const [showHarness, setShowHarness] = useState(isHarnessLocation);

  useEffect(() => {
    const handleNavigation = () => setShowHarness(isHarnessLocation());
    window.addEventListener("popstate", handleNavigation);
    return () => window.removeEventListener("popstate", handleNavigation);
  }, []);

  if (showHarness) {
    return (
      <McpPlanHarness
        onExit={() => {
          window.history.pushState({}, "", "/");
          setShowHarness(false);
        }}
      />
    );
  }

  return <ResponsiveLayout><ThreadexApp /></ResponsiveLayout>;
}
