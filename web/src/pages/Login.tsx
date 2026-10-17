import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { EyeMark } from "../components/EyeMark";

export function Login({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/auth/login", { method: "POST", body: { email, password } });
      await onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <section className="login-art">
        <div className="brand">
          <EyeMark size={36} />
          <span className="brand-name" style={{ fontSize: 24 }}>Appeal Eye<em>Q</em></span>
        </div>
        <div>
          <h1>Keep an eye on every appeal.</h1>
          <p>Properties, filing windows, decisions, savings and fees for property tax appeal practices, in one place.</p>
        </div>
        <small style={{ color: "rgba(255,255,255,0.45)" }}>Cook County and the collar counties</small>
      </section>
      <section className="login-form">
        <form onSubmit={submit} aria-label="Sign in">
          <div>
            <div className="eyebrow">Welcome back</div>
            <h2>Sign in</h2>
          </div>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <button className="btn" type="submit" disabled={busy}>{busy ? "Signing in" : "Sign in"}</button>
          {error && <div className="error" role="alert">{error}</div>}
        </form>
      </section>
    </div>
  );
}
