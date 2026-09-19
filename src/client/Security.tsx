import { useCallback, useEffect, useRef, useState, type ReactNode, type FormEvent } from "react";
import "./styles/security.css";

const TOKEN_KEY = "threadex.rememberedToken";
function rememberedToken(value?: string | null): string | null {
  try {
    if (value === null) localStorage.removeItem(TOKEN_KEY);
    else if (value !== undefined) localStorage.setItem(TOKEN_KEY, value);
    return localStorage.getItem(TOKEN_KEY);
  } catch { return null; }
}

async function securityRequest(path: string, body?: object) {
  const response = await fetch(`/api/security/${path}`, { signal: AbortSignal.timeout(10_000), ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) {
    if (path === "restore" && response.status === 401) rememberedToken(null);
    throw new Error(data.error || "Security request failed.");
  }
  if (typeof data.token === "string") rememberedToken(data.token);
  if (path === "logout") rememberedToken(null);
  return data;
}

function PasswordForm({ setup = false, change = false, onSuccess }: { setup?: boolean; change?: boolean; onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if ((setup || change) && password !== confirm) { setError("Passwords do not match."); return; }
    setBusy(true); setError("");
    try {
      await securityRequest(setup || change ? "password" : "login", { password, currentPassword });
      setPassword(""); setCurrentPassword(""); setConfirm(""); onSuccess();
    } catch (error) { setError(error instanceof Error ? error.message : "Request failed."); }
    finally { setBusy(false); }
  }
  return <form className="security-form" onSubmit={submit}>
    {change && <label>Current password<input type="password" autoComplete="current-password" required value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} /></label>}
    <label>{setup || change ? "New password" : "Password"}<input type="password" autoComplete={setup || change ? "new-password" : "current-password"} minLength={setup || change ? 12 : undefined} maxLength={1024} required value={password} onChange={e => setPassword(e.target.value)} /></label>
    {(setup || change) && <><p>Use at least 12 characters.</p><label>Confirm password<input type="password" autoComplete="new-password" required value={confirm} onChange={e => setConfirm(e.target.value)} /></label></>}
    {error && <p role="alert">{error}</p>}
    <button className="secondary primary" disabled={busy}>{busy ? "Please wait…" : change ? "Change password" : setup ? "Set password" : "Sign in"}</button>
  </form>;
}

function SecurityError({ error, retry }: { error: string; retry: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => dialog.current?.showModal(), 60_000);
    return () => window.clearTimeout(timer);
  }, []);
  return <>
    <div className="security-error-bar" role="status">
      <span>Connection error. Retrying automatically… {error}</span>
      <button className="secondary" onClick={retry}>Retry now</button>
    </div>
    <dialog ref={dialog} className="security-error-dialog" aria-labelledby="security-error-title" aria-describedby="security-error-description">
      <h2 id="security-error-title">Unable to reconnect</h2>
      <p id="security-error-description">Threadex has been unable to check your connection for one minute. Retrying automatically…</p>
      <p>{error}</p>
      <div><button className="secondary" onClick={retry}>Retry now</button><button className="secondary" onClick={() => dialog.current?.close()}>Dismiss</button></div>
    </dialog>
  </>;
}

export function SecurityGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<{ configured: boolean; authenticated: boolean; canSetup: boolean } | null>(null);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      let value = await securityRequest("status");
      const saved = rememberedToken();
      if (!value.authenticated && saved) {
        try { await securityRequest("restore", { token: saved }); value = await securityRequest("status"); }
        catch (error) { if (rememberedToken()) throw error; }
      }
      setStatus(value); setError("");
    } catch (error) { setError(error instanceof Error ? error.message : "Request failed."); }
    finally { pending.current = false; }
  }, []);
  useEffect(() => {
    void refresh();
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [refresh]);
  const hasError = Boolean(error);
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), hasError ? 5_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [refresh, hasError]);
  return <>{!status ? <main className="security-login" aria-busy="true"><p role="status">{error ? "Waiting for connection…" : "Loading…"}</p></main> : status.authenticated ? children : <main className="security-login"><section className="settings-card">
    <h1>Threadex</h1>
    <h2>{status?.canSetup ? "Set your password" : "Sign in"}</h2>
    {status.configured || status.canSetup ? <PasswordForm setup={status.canSetup} onSuccess={() => void refresh()} /> : <p>Open Threadex on localhost to set the initial password before remote access.</p>}
  </section></main>}
    {error && <SecurityError error={error} retry={() => void refresh()} />}
  </>;
}

export function SecuritySettingsPanel() {
  const [notice, setNotice] = useState("");
  return <div className="settings-content" role="tabpanel" aria-label="Security">
    <div className="settings-section-heading"><div><h2>Security</h2><p>This browser remembers your sign-in for 30 days, including server restarts.</p></div></div>
    <section className="settings-card"><h3>Change password</h3><p>Changing your password signs out all other devices.</p><PasswordForm change onSuccess={() => setNotice("Password changed. Other devices have been signed out.")} /></section>
    {notice && <p role="status">{notice}</p>}
    <button className="secondary" onClick={() => { void securityRequest("logout", {}).then(() => window.location.reload()).catch(error => setNotice(error.message)); }}>Sign out all devices</button>
  </div>;
}
