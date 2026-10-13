import AccountMenu from './AccountMenu.jsx';

/** The page header: the app's name (linking home) and the account controls. */
export default function Header({ auth }) {
  return (
    <header className="app-header">
      <h1>
        <a href="/" className="home-link">
          Tracer
        </a>
      </h1>
      <p className="muted">Citation graphs for the humanities</p>
      <AccountMenu
        user={auth.user}
        onSignUp={auth.signUp}
        onLogIn={auth.logIn}
        onLogOut={auth.logOut}
      />
    </header>
  );
}
