import AccountMenu from './AccountMenu.jsx';
import TracerMark from './TracerMark.jsx';

/** The page header: the app's name (linking home), a link to the plans and the account controls. */
export default function Header({ auth }) {
  return (
    <header className="app-header">
      <h1>
        <a href="/" className="home-link">
          <TracerMark size={32} style={{ marginBottom: '-8px' }} />
          Tracer
        </a>
      </h1>
      <p className="muted">Citation graphs for the humanities</p>
      <nav className="header-nav" aria-label="Site">
        <a href="/pricing">Plans and pricing</a>
      </nav>
      <AccountMenu
        user={auth.user}
        onSignUp={auth.signUp}
        onLogIn={auth.logIn}
        onLogOut={auth.logOut}
      />
    </header>
  );
}
