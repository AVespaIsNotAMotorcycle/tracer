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
  // The URL carries the anchor, and jsdom shares one location across tests.
  window.history.replaceState(null, '', '/');
  vi.mocked(api.searchWorks).mockResolvedValue([anchor]);
  vi.mocked(api.getWork).mockResolvedValue(anchor);
  vi.mocked(api.getCiting).mockImplementation(async (id) => (id === 'anchor' ? [citer] : [more]));
  vi.mocked(api.getCited).mockImplementation(async (id) => (id === 'anchor' ? [ref] : []));
});

async function buildFromSearch(expectedNodes = 3) {
  render(<App />);
  fireEvent.change(screen.getByLabelText('Title, DOI, or OpenAlex ID'), {
    target: { value: 'moral economy' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Go' }));
  const results = await screen.findByRole('list', { name: 'Search results' });
  fireEvent.click(within(results).getByRole('button', { name: /Title anchor/ }));
  await waitFor(() => expect(within(graph()).getAllByRole('button')).toHaveLength(expectedNodes));
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

  it('labels each search result with its source type', async () => {
    vi.mocked(api.searchWorks).mockResolvedValue([anchor, work('b', { type: 'book' })]);
    render(<App />);
    fireEvent.change(screen.getByLabelText('Title, DOI, or OpenAlex ID'), {
      target: { value: 'moral economy' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    const results = await screen.findByRole('list', { name: 'Search results' });

    expect(within(results).getByRole('button', { name: /^Article:\s*Title anchor/ })).toBeVisible();
    expect(within(results).getByRole('button', { name: /^Book:\s*Title b/ })).toBeVisible();
  });

  it('closes the search results, keeping the graph', async () => {
    await buildFromSearch();
    fireEvent.click(screen.getByRole('button', { name: 'Close search results' }));

    expect(screen.queryByRole('list', { name: 'Search results' })).not.toBeInTheDocument();
    expect(within(graph()).getByRole('button', { name: 'Title anchor' })).toBeInTheDocument();
  });

  it('closes the no-results message', async () => {
    vi.mocked(api.searchWorks).mockResolvedValue([]);
    render(<App />);
    fireEvent.change(screen.getByLabelText('Title, DOI, or OpenAlex ID'), {
      target: { value: 'nothing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    await screen.findByText('No works found.');
    fireEvent.click(screen.getByRole('button', { name: 'Close search results' }));

    expect(screen.queryByText('No works found.')).not.toBeInTheDocument();
  });

  it('shows a book’s chapters in its details instead of as nodes', async () => {
    const book = work('book', {
      type: 'book',
      year: 2020,
      externalIds: { doi: '10.1017/9781108647403' },
    });
    const chapter = (id, suffix, title, authors) =>
      work(id, {
        type: 'book-chapter',
        year: 2020,
        title,
        authors,
        references: ['anchor'],
        externalIds: { doi: `10.1017/9781108647403.${suffix}` },
      });
    vi.mocked(api.getCiting).mockImplementation(async (id) =>
      id === 'anchor'
        ? [
            book,
            chapter('ch2', '010', 'The Atlantic World', [{ name: 'E. P. Thompson', orcid: null }]),
            chapter('ch1', '005', 'The Grumbling Hive', [{ name: 'A. Author' }]),
          ]
        : [],
    );
    await buildFromSearch(3);

    expect(within(graph()).queryByRole('button', { name: 'The Grumbling Hive' })).toBeNull();
    fireEvent.click(within(graph()).getByRole('button', { name: 'Title book' }));
    const chapters = screen.getByRole('list', { name: 'Chapters' });
    const items = within(chapters).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('The Grumbling Hive'),
      expect.stringContaining('The Atlantic World'),
    ]);
    expect(items[0]).toHaveTextContent('A. Author');
    // The same authors as the book's aren't repeated.
    expect(items[1]).not.toHaveTextContent('Thompson');
    expect(within(items[0]).getByRole('link', { name: 'The Grumbling Hive' })).toHaveAttribute(
      'href',
      'https://doi.org/10.1234/ch1',
    );
    // The book cites the anchor once, through its chapters.
    expect(screen.getByText('Cites on graph').nextSibling).toHaveTextContent('1');

    // Expanding the book expands its chapters too.
    fireEvent.click(screen.getByRole('button', { name: 'Expand citing and cited works' }));
    expect(await screen.findByRole('button', { name: 'Expanded' })).toBeDisabled();
    for (const id of ['book', 'ch1', 'ch2']) {
      expect(api.getCiting).toHaveBeenCalledWith(id, { limit: 20 });
      expect(api.getCited).toHaveBeenCalledWith(id, { limit: 20 });
    }
  });

  it('applies changed depth and size options to the current graph', async () => {
    await buildFromSearch();
    const apply = screen.getByRole('button', { name: 'Apply to current graph' });
    expect(apply).toBeDisabled(); // Nothing changed yet.

    // Expand ref by hand, so it should survive the rebuild.
    fireEvent.click(within(graph()).getByRole('button', { name: 'Title ref' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand citing and cited works' }));
    await within(graph()).findByRole('button', { name: 'Title more' });
    vi.mocked(api.getWork).mockClear();

    fireEvent.change(screen.getByLabelText('Citing depth'), { target: { value: '0' } });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);

    // citer is dropped (citing depth 0); more stays, found through the expanded ref.
    await waitFor(() =>
      expect(within(graph()).queryByRole('button', { name: 'Title citer' })).toBeNull(),
    );
    expect(within(graph()).getByRole('button', { name: 'Title more' })).toBeInTheDocument();
    expect(api.getWork).not.toHaveBeenCalled(); // Same anchor; its data is reused.
    await waitFor(() => expect(window.location.search).toContain('citing=0'));
    expect(apply).toBeDisabled();
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

  it('makes a selected work the new anchor, keeping the old anchor expanded', async () => {
    await buildFromSearch();
    vi.mocked(api.getWork).mockClear();
    fireEvent.click(within(graph()).getByRole('button', { name: 'Title ref' }));

    fireEvent.click(screen.getByRole('button', { name: 'Make this the anchor' }));

    // From ref: its citing work "more". Kept: the old anchor with its neighbors (citer, ref).
    expect(await within(graph()).findByRole('button', { name: 'Title more' })).toBeInTheDocument();
    const titles = within(graph())
      .getAllByRole('button')
      .map((button) => button.textContent)
      .sort();
    expect(titles).toEqual(['Title anchor', 'Title citer', 'Title more', 'Title ref']);
    const details = screen.getByRole('complementary', { name: 'Title ref' });
    expect(within(details).getByText('Anchor')).toBeInTheDocument();
    expect(within(details).queryByRole('button', { name: 'Make this the anchor' })).toBeNull();
    expect(api.getWork).not.toHaveBeenCalled();
  });

  it('does not offer to re-anchor on the anchor', async () => {
    await buildFromSearch();
    fireEvent.click(within(graph()).getByRole('button', { name: 'Title anchor' }));

    expect(screen.queryByRole('button', { name: 'Make this the anchor' })).toBeNull();
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

    fireEvent.click(screen.getByRole('button', { name: 'Reset angle' }));
    expect(graph()).toHaveAttribute('data-axis-angle', '30');
  });

  it('shows loading progress while a graph builds, then clears it', async () => {
    let releaseCited;
    vi.mocked(api.getCited).mockImplementation(
      () => new Promise((resolve) => (releaseCited = () => resolve([ref]))),
    );
    render(<App />);
    fireEvent.change(screen.getByLabelText('Title, DOI, or OpenAlex ID'), {
      target: { value: 'W1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));

    const progress = await screen.findByRole('list', { name: 'Loading progress' });
    expect(within(progress).getByText('Building graph')).toBeInTheDocument();
    // Anchor lookup and citing list done; cited list still pending.
    await waitFor(() => expect(within(progress).getByText(/2 of 3 requests/)).toBeInTheDocument());
    expect(within(progress).getByRole('progressbar')).toHaveAttribute('value', '2');
    expect(screen.getByRole('status')).toHaveTextContent('Building graph…');

    releaseCited();
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Loading progress' })).toBeNull(),
    );
  });

  it('shows progress while expanding a work', async () => {
    await buildFromSearch();
    let releaseCiting;
    vi.mocked(api.getCiting).mockImplementation(
      () => new Promise((resolve) => (releaseCiting = () => resolve([more]))),
    );
    fireEvent.click(within(graph()).getByRole('button', { name: 'Title ref' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand citing and cited works' }));

    const progress = await screen.findByRole('list', { name: 'Loading progress' });
    expect(within(progress).getByText('Expanding “Title ref”')).toBeInTheDocument();
    await waitFor(() => expect(within(progress).getByText(/1 of 2 requests/)).toBeInTheDocument());

    releaseCiting();
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Loading progress' })).toBeNull(),
    );
  });

  describe('source type filter', () => {
    const withBooks = () =>
      vi
        .mocked(api.getCited)
        .mockImplementation(async (id) =>
          id === 'anchor'
            ? [ref, work('book1', { type: 'book' }), work('book2', { type: 'book' })]
            : [],
        );
    const typeFilter = () => screen.getByRole('group', { name: 'Source types' });
    const titles = () =>
      within(graph())
        .getAllByRole('button')
        .map((button) => button.textContent)
        .sort();

    it('lists the source types on the graph with icons and counts', async () => {
      withBooks();
      await buildFromSearch(5);

      const rows = within(typeFilter())
        .getAllByRole('listitem')
        .map((li) => li.textContent);
      expect(rows).toEqual(['Article3', 'Book2']);
      expect(
        within(typeFilter())
          .getAllByRole('checkbox')
          .every((box) => box.checked),
      ).toBe(true);
    });

    it('hides works of an unchecked type but keeps the anchor', async () => {
      withBooks();
      await buildFromSearch(5);

      fireEvent.click(within(typeFilter()).getByRole('checkbox', { name: /Article/ }));

      expect(titles()).toEqual(['Title anchor', 'Title book1', 'Title book2']);
      expect(screen.getByText('Showing 3 of 5')).toBeInTheDocument();
    });

    it('keeps the selected work visible even if its type is hidden', async () => {
      withBooks();
      await buildFromSearch(5);
      fireEvent.click(within(graph()).getByRole('button', { name: 'Title ref' }));

      fireEvent.click(within(typeFilter()).getByRole('checkbox', { name: /Article/ }));

      expect(titles()).toContain('Title ref');
    });

    it('restores hidden types on Reset', async () => {
      withBooks();
      await buildFromSearch(5);
      fireEvent.click(within(typeFilter()).getByRole('checkbox', { name: /Book/ }));
      expect(titles()).toHaveLength(3);

      fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));

      expect(titles()).toHaveLength(5);
    });
  });

  it('shows the source type in the details panel', async () => {
    await buildFromSearch();
    fireEvent.click(within(graph()).getByRole('button', { name: 'Title ref' }));

    const details = screen.getByRole('complementary', { name: 'Title ref' });
    expect(within(details).getByText(/Article · 1930 · Past & Present/)).toBeInTheDocument();
  });

  describe('URL', () => {
    const anchorParam = () => new URLSearchParams(window.location.search).get('anchor');

    it('puts the anchor in the URL after a build', async () => {
      const lengthBefore = window.history.length;
      await buildFromSearch();

      await waitFor(() => expect(anchorParam()).toBe('Wanchor'));
      expect(window.history.length).toBe(lengthBefore + 1);
    });

    it('prefers the DOI and records non-default options', async () => {
      vi.mocked(api.getWork).mockResolvedValue({
        ...anchor,
        externalIds: { openalex: 'Wanchor', doi: '10.1093/past/50.1.76' },
      });
      render(<App />);
      fireEvent.change(screen.getByLabelText('Cited depth'), { target: { value: '0' } });
      fireEvent.change(screen.getByLabelText('Title, DOI, or OpenAlex ID'), {
        target: { value: 'W1' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Go' }));

      await waitFor(() =>
        expect(window.location.search).toBe('?anchor=10.1093%2Fpast%2F50.1.76&cited=0'),
      );
    });

    it('opens the graph a shared URL describes, with its options', async () => {
      window.history.replaceState(null, '', '/?anchor=Wanchor&cited=0&perNode=5');
      const lengthBefore = window.history.length;
      render(<App />);

      await waitFor(() => expect(within(graph()).getAllByRole('button')).toHaveLength(2));
      expect(api.getWork).toHaveBeenCalledWith('Wanchor', expect.anything());
      expect(api.getCiting).toHaveBeenCalledWith('anchor', expect.objectContaining({ limit: 5 }));
      expect(api.getCited).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Cited depth')).toHaveValue('0');
      expect(window.history.length).toBe(lengthBefore);
    });

    it('rewrites a shared OpenAlex ID to the DOI without adding history', async () => {
      vi.mocked(api.getWork).mockResolvedValue({
        ...anchor,
        externalIds: { openalex: 'Wanchor', doi: '10.1/x' },
      });
      window.history.replaceState(null, '', '/?anchor=Wanchor');
      const lengthBefore = window.history.length;
      render(<App />);

      await waitFor(() => expect(anchorParam()).toBe('10.1/x'));
      expect(window.history.length).toBe(lengthBefore);
    });

    it('pushes re-anchors to history, and Back restores the previous anchor', async () => {
      await buildFromSearch();
      await waitFor(() => expect(anchorParam()).toBe('Wanchor'));
      fireEvent.click(within(graph()).getByRole('button', { name: 'Title ref' }));
      fireEvent.click(screen.getByRole('button', { name: 'Make this the anchor' }));
      await waitFor(() => expect(anchorParam()).toBe('Wref'));
      vi.mocked(api.getWork).mockClear();

      window.history.back();

      await waitFor(() => expect(anchorParam()).toBe('Wanchor'));
      await waitFor(() => expect(api.getWork).toHaveBeenCalledWith('Wanchor', expect.anything()));
    });

    it('leaves the URL alone when a build fails', async () => {
      vi.mocked(api.getWork).mockRejectedValue(new Error('Work not found: W1'));
      render(<App />);
      fireEvent.change(screen.getByLabelText('Title, DOI, or OpenAlex ID'), {
        target: { value: 'W1' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Go' }));

      await screen.findByRole('alert');
      expect(window.location.search).toBe('');
    });
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
