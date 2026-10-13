import { useEffect, useId, useRef, useState } from 'react';
import Modal from './Modal.jsx';

const MIN_PASSWORD_LENGTH = 8;

/**
 * The header's account controls: "Log in" and "Sign up" when signed out; a link to the user's
 * saved graphs, the account's email and "Log out" when signed in. Logging in and signing up happen in a small dialog.
 */
export default function AccountMenu({ user, onSignUp, onLogIn, onLogOut }) {
  const [mode, setMode] = useState(null); // 'login' | 'signup' | null
  const [error, setError] = useState(null);

  // Still checking who's signed in: show nothing rather than flash "Log in".
  if (user === undefined) return null;

  if (user) {
    return (
      <div className="account">
        <a href="/profile">My graphs</a>
        <span className="muted" title="Signed in">
          {user.email}
        </span>
        <button type="button" onClick={() => onLogOut().catch((err) => setError(err.message))}>
          Log out
        </button>
        {error && (
          <span role="alert" className="error">
            {error}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="account">
      <button type="button" onClick={() => setMode('login')}>
        Log in
      </button>
      <button type="button" className="primary" onClick={() => setMode('signup')}>
        Sign up
      </button>
      {mode && (
        <AuthDialog
          mode={mode}
          onModeChange={setMode}
          onSubmit={mode === 'login' ? onLogIn : onSignUp}
          onClose={() => setMode(null)}
        />
      )}
    </div>
  );
}

/** A modal form for logging in or signing up. Escape or "Cancel" closes it. */
function AuthDialog({ mode, onModeChange, onSubmit, onClose }) {
  const titleId = useId();
  const emailRef = useRef(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const signingUp = mode === 'signup';
  const title = signingUp ? 'Create an account' : 'Log in';

  useEffect(() => {
    emailRef.current?.focus();
  }, [mode]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(email, password);
      onClose();
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  return (
    <Modal titleId={titleId} onClose={onClose}>
      <h2 id={titleId}>{title}</h2>
      <form onSubmit={handleSubmit}>
        <label>
          Email
          <input
            ref={emailRef}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={signingUp ? 'new-password' : 'current-password'}
            required
            minLength={signingUp ? MIN_PASSWORD_LENGTH : undefined}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {signingUp && <p className="muted small">At least {MIN_PASSWORD_LENGTH} characters.</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={submitting}>
            {submitting ? 'Please wait…' : title}
          </button>
        </div>
      </form>
      <p className="muted small">
        {signingUp ? 'Already have an account? ' : 'New to Tracer? '}
        <button
          type="button"
          className="link-button"
          onClick={() => onModeChange(signingUp ? 'login' : 'signup')}
        >
          {signingUp ? 'Log in' : 'Create an account'}
        </button>
      </p>
    </Modal>
  );
}
