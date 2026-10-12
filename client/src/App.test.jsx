import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from './api.js';
import App from './App.jsx';

// jsdom has no canvas, so render visible nodes as buttons instead.
vi.mock('./graph/GraphView.jsx', () => ({
  default: ({ graph, visible, onSelect, axisAngle }) => (
    <ul aria-label="Graph" data-axis-angle={axisAngle}>
      {[...graph.works.values()]
        .filter((work) => visible.has(work.id))
        .map((work) => (
          <li key={work.id}>
            <button type="button" onClick={() => onSelect(work.id)}>
              {work.title}
            </button>
          </li>
        ))}
    </ul>
  ),
}));

vi.mock('./api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  searchWorks: vi.fn(),
  getWork: vi.fn(),
  getCiting: vi.fn(),
  getCited: vi.fn(),
}));

const work = (id, { references = [], year = 1971, ...rest } = {}) => ({
  id,
  externalIds: { openalex: `W${id}` },
  title: `Title ${id}`,
  authors: [{ name: 'E. P. Thompson', orcid: null }],
  year,
  type: 'article',
  venue: 'Past & Present',
  abstract: null,
  citedByCount: 4693,
  references,
  links: [
    { kind: 'provider', url: `https://openalex.org/W${id}` },
    { kind: 'doi', url: `https://doi.org/10.1234/${id}` },
  ],
  providers: ['openalex'],
  ...rest,
});

// anchor cites ref; citer cites anchor and ref.
const anchor = work('anchor', { references: ['ref'] });
const ref = work('ref', { year: 1930 });
const citer = work('citer', { references: ['anchor', 'ref'], year: 1995 });
const more = work('more', { references: ['ref'], year: 2010 });

const graph = () => screen.getByRole('list', { name: 'Graph' });

beforeEach(() => {
  vi.mocked(api.searchWorks).mockResolvedValue([anchor]);
  vi.mocked(api.getWork).mockResolvedValue(anchor);
  vi.mocked(api.getCiting).mockImplementation(async (id) => (id === 'anchor' ? [citer] : [more]));
  vi.mocked(api.getCited).mockImplementation(async (id) => (id === 'anchor' ? [ref] : []));
});

async function buildFromSearch() {
  render(<App />);
  fireEvent.change(screen.getByLabelText('Title, DOI, or OpenAlex ID'), {
    target: { value: 'moral economy' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Go' }));
  const results = await screen.findByRole('list', { name: 'Search results' });
  fireEvent.click(within(results).getByRole('button', { name: /Title anchor/ }));
  await waitFor(() => expect(within(graph()).getAllByRole('button')).toHaveLength(3));
}

describe('App', () => {
  it('shows an empty state before a search', () => {
    render(<App />);
    expect(screen.getByText(/paste a DOI/)).toBeInTheDocument();
  });

  it('searches, then builds a graph from the chosen result', async () => {
    await buildFromSearch();

    expect(api.searchWorks).toHaveBeenCalledWith('moral economy');
    expect(api.getWork).toHaveBeenCalledWith('anchor', expect.anything());
    for (const title of ['Title anchor', 'Title ref', 'Title citer']) {
      expect(within(graph()).getByRole('button', { name: title })).toBeInTheDocument();
    }
  });

  it('builds directly from a DOI without searching', async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText('Title, DOI, or OpenAlex ID'), {
      target: { value: 'https://doi.org/10.1093/past/50.1.76' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));

    await waitFor(() =>
      expect(api.getWork).toHaveBeenCalledWith(
        'https://doi.org/10.1093/past/50.1.76',
        expect.anything(),
      ),
    );
    expect(api.searchWorks).not.toHaveBeenCalled();
  });

  it('passes depth and limit options to the build', async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText('Cited depth'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Works per node'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Title, DOI, or OpenAlex ID'), {
      target: { value: 'W2043699734' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));

    await waitFor(() =>
      expect(api.getCiting).toHaveBeenCalledWith('anchor', expect.objectContaining({ limit: 5 })),
    );
    expect(api.getCited).not.toHaveBeenCalled();
  });

  it('shows details and external links for a selected work', async () => {
    await buildFromSearch();

    fireEvent.click(within(graph()).getByRole('button', { name: 'Title ref' }));

    const details = screen.getByRole('complementary', { name: 'Title ref' });
    expect(within(details).getByText('Found as a cited work')).toBeInTheDocument();
    // Cited by anchor and citer on the graph.
    expect(within(details).getByText('Cited by on graph').nextSibling).toHaveTextContent('2');
    expect(within(details).getByRole('link', { name: 'DOI' })).toHaveAttribute(
      'href',
      'https://doi.org/10.1234/ref',
    );
    expect(within(details).getByRole('link', { name: 'OpenAlex' })).toHaveAttribute(
      'target',
      '_blank',
    );
  });

  it('expands a selected work', async () => {
    await buildFromSearch();
    fireEvent.click(within(graph()).getByRole('button', { name: 'Title ref' }));

    fireEvent.click(screen.getByRole('button', { name: 'Expand citing and cited works' }));

    expect(await within(graph()).findByRole('button', { name: 'Title more' })).toBeInTheDocument();
    expect(api.getCiting).toHaveBeenCalledWith('ref', { limit: 20 });
    expect(screen.getByRole('button', { name: 'Expanded' })).toBeDisabled();
  });

  it('marks the anchor as already expanded', async () => {
    await buildFromSearch();

    fireEvent.click(within(graph()).getByRole('button', { name: 'Title anchor' }));

    expect(screen.getByRole('button', { name: 'Expanded' })).toBeDisabled();
  });

  it('hides works outside the year filter but keeps the anchor', async () => {
    await buildFromSearch();

    fireEvent.change(screen.getByLabelText('From year'), { target: { value: '1990' } });

    const titles = within(graph())
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(titles.sort()).toEqual(['Title anchor', 'Title citer']);
    expect(screen.getByText('Showing 2 of 3')).toBeInTheDocument();
  });

  it('draws the time axis at 30 degrees by default and lets the user rotate it', async () => {
    await buildFromSearch();
    expect(graph()).toHaveAttribute('data-axis-angle', '30');

    fireEvent.change(screen.getByLabelText(/Time axis angle/), { target: { value: '60' } });
    expect(graph()).toHaveAttribute('data-axis-angle', '60');
    expect(screen.getByText('Time axis angle: 60°')).toBeInTheDocument();

    fireEvent.click(
      within(screen.getByRole('region', { name: 'View' })).getByRole('button', { name: 'Reset' }),
    );
    expect(graph()).toHaveAttribute('data-axis-angle', '30');
  });

  it('shows API errors', async () => {
    vi.mocked(api.getWork).mockRejectedValue(new Error('Work not found: W1'));
    render(<App />);
    fireEvent.change(screen.getByLabelText('Title, DOI, or OpenAlex ID'), {
      target: { value: 'W1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Work not found: W1');
  });
});
