import { useEffect, useState } from 'react';

export default function App() {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then(setHealth)
      .catch(() => setHealth({ status: 'unreachable' }));
  }, []);

  return (
    <main>
      <h1>Tracer</h1>
      <p>API status: {health ? `${health.status} (db: ${health.db ?? 'n/a'})` : 'checking…'}</p>
    </main>
  );
}
