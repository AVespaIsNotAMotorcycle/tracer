import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App.jsx';

describe('App', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the API health status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ json: () => Promise.resolve({ status: 'ok', db: 'connected' }) }),
    );

    render(<App />);

    expect(await screen.findByText('API status: ok (db: connected)')).toBeInTheDocument();
  });

  it('shows unreachable when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));

    render(<App />);

    expect(await screen.findByText('API status: unreachable (db: n/a)')).toBeInTheDocument();
  });
});
