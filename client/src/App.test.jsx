import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from './api.js';
import App from './App.jsx';

// jsdom has no canvas, so render visible nodes as buttons instead.
vi.mock('./graph/GraphView.jsx', () => ({
  default: ({ graph, visible, onSelect, axisAngle, expandedIds }) => (
    <ul aria-label="Graph" data-axis-angle={axisAngle}>
      {[...graph.works.values()]
        .filter((work) => visible.has(work.id))
        .map((work) => (
          <li key={work.id}>
            <button
              type="button"
              onClick={() => onSelect(work.id)}
              data-expanded={expandedIds?.has(work.id) || undefined}
            >
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
  getArchiveItems: vi.fn(),
  getCitationMatch: vi.fn(),
  getCurrentUser: vi.fn(),
  signUp: vi.fn(),
  logIn: vi.fn(),
  logOut: vi.fn(),
  listGraphs: vi.fn(),
  getSavedGraph: vi.fn(),
  saveGraph: vi.fn(),
  updateGraph: vi.fn(),
  saveGraphSnapshot: vi.fn(),
  renameGraph: vi.fn(),
  deleteGraph: vi.fn(),
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
  vi.mocked(api.getCurrentUser).mockResolvedValue(null);
  vi.mocked(api.searchWorks).mockResolvedValue([anchor]);
  vi.mocked(api.getWork).mockResolvedValue(anchor);
  vi.mocked(api.getCiting).mockImplementation(async (id) => (id === 'anchor' ? [citer] : [more]));
  vi.mocked(api.getCited).mockImplementation(async (id) => (id === 'anchor' ? [ref] : []));
  vi.mocked(api.getArchiveItems).mockResolvedValue([]);
  vi.mocked(api.getCitationMatch).mockResolvedValue(null);
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

  it('shows a work not on OpenAlex without expand or anchor actions', async () => {
    const archive = work('archive', {
      type: 'reference-only',
      title: 'Deccani Painting',
      authors: [{ name: 'Zebrowski' }],
      year: 1983,
      venue: null,
      citedByCount: null,
      links: [],
      providers: ['crossref'],
      citation: 'Zebrowski, M. Deccani Painting. London, 1983.',
    });
    vi.mocked(api.getCited).mockImplementation(async (id) =>
      id === 'anchor' ? [ref, archive] : [],
    );
    await buildFromSearch(4);

    fireEvent.click(within(graph()).getByRole('button', { name: 'Deccani Painting' }));
    const details = screen.getByRole('complementary', { name: 'Deccani Painting' });
    expect(within(details).getByText(/Not on OpenAlex/)).toBeInTheDocument();
    expect(within(details).getByText(/Known only from a reference list/)).toBeInTheDocument();
    expect(
      within(details).getByText('Zebrowski, M. Deccani Painting. London, 1983.'),
    ).toBeVisible();
    expect(within(details).queryByRole('button', { name: /Expand/ })).toBeNull();
    expect(within(details).queryByRole('button', { name: 'Make this the anchor' })).toBeNull();
    // The source-type filter lists it under its own label.
    expect(screen.getByRole('checkbox', { name: /Not on OpenAlex/ })).toBeChecked();
  });

  it('links a work not on OpenAlex to the work Crossref matches it to', async () => {
    const dyarchy = work('dyarchy', {
      type: 'reference-only',
      title: 'The Manchu-Chinese Dyarchy',
      authors: [{ name: 'Fairbank' }],
      year: 1953,
      citedByCount: null,
      links: [],
      providers: ['crossref'],
    });
    vi.mocked(api.getCited).mockImplementation(async (id) =>
      id === 'anchor' ? [ref, dyarchy] : [],
    );
    vi.mocked(api.getCitationMatch).mockResolvedValue({
      doi: '10.2307/2942138',
      title: "The Manchu-Chinese Dyarchy in the 1840's and '50's",
      authors: [{ name: 'John K. Fairbank', family: 'Fairbank' }],
      year: 1953,
      venue: 'The Far Eastern Quarterly',
      type: 'journal-article',
      links: [
        { kind: 'doi', url: 'https://doi.org/10.2307/2942138' },
        { kind: 'jstor', url: 'https://www.jstor.org/stable/10.2307/2942138' },
      ],
    });
    await buildFromSearch(4);

    fireEvent.click(within(graph()).getByRole('button', { name: 'The Manchu-Chinese Dyarchy' }));
    const details = screen.getByRole('complementary', { name: 'The Manchu-Chinese Dyarchy' });
    expect(await within(details).findByRole('link', { name: 'JSTOR' })).toHaveAttribute(
      'href',
      'https://www.jstor.org/stable/10.2307/2942138',
    );
    expect(within(details).getByRole('link', { name: 'DOI' })).toBeInTheDocument();
    expect(
      within(details).getByText(/Crossref matches it to .The Manchu-Chinese Dyarchy in the 1840/),
    ).toHaveTextContent('(The Far Eastern Quarterly, 1953), linked below.');

    // Works on OpenAlex aren't looked up.
    fireEvent.click(within(graph()).getByRole('button', { name: 'Title ref' }));
    expect(api.getCitationMatch).toHaveBeenCalledTimes(1);
  });

  it('names the Internet Archive item found for a citation printed as text', async () => {
    const printed = 'B.H. Slicher van Bath, The Agrarian History of Western Europe (London, 1963).';
    const note = work('note', {
      type: 'reference-only',
      title: printed,
      authors: [],
      year: 1963,
      citedByCount: null,
      links: [],
      providers: ['crossref'],
      citation: printed,
    });
    vi.mocked(api.getCited).mockImplementation(async (id) => (id === 'anchor' ? [ref, note] : []));
    vi.mocked(api.getArchiveItems).mockImplementation(async (id) =>
      id === 'note'
        ? [
            {
              identifier: 'agrarianhistoryo0000slic',
              title: 'The agrarian history of Western Europe, A.D. 500-1850',
              creators: ['Slicher van Bath, B. H'],
              year: 1963,
              access: 'borrow',
              url: 'https://archive.org/details/agrarianhistoryo0000slic',
            },
          ]
        : [],
    );
    await buildFromSearch(4);

    fireEvent.click(within(graph()).getByRole('button', { name: printed }));
    const details = screen.getByRole('complementary', { name: printed });
    const link = await within(details).findByRole('link', { name: 'Internet Archive' });
    expect(link.parentElement).toHaveTextContent(
      'Internet Archive The agrarian history of Western Europe, A.D. 500-1850 1963 · borrow',
    );
  });

  it('explains a listed year that its citers predate', async () => {
    const reprint = work('anchor', { year: 2003, references: [] });
    vi.mocked(api.searchWorks).mockResolvedValue([reprint]);
    vi.mocked(api.getWork).mockResolvedValue(reprint);
    vi.mocked(api.getCiting).mockImplementation(async (id) =>
      id === 'anchor'
        ? [
            work('early', { year: 1953, references: ['anchor'] }),
            work('later', { year: 1988, references: ['anchor'] }),
          ]
        : [],
    );
    vi.mocked(api.getCited).mockResolvedValue([]);
    await buildFromSearch(3);

    fireEvent.click(within(graph()).getByRole('button', { name: 'Title anchor' }));
    const details = screen.getByRole('complementary', { name: 'Title anchor' });
    expect(within(details).getByText(/Before 1953/)).toBeInTheDocument();
    expect(within(details).getByText(/OpenAlex gives 2003/)).toBeInTheDocument();
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

  it('links to copies of a selected work on the Internet Archive', async () => {
    vi.mocked(api.getArchiveItems).mockImplementation(async (id) =>
      id === 'ref'
        ? [
            {
              identifier: 'refscan',
              title: 'Title ref',
              creators: ['Thompson, E. P.'],
              year: 1906,
              access: 'open',
              url: 'https://archive.org/details/refscan',
            },
          ]
        : [],
    );
    await buildFromSearch();
    fireEvent.click(within(graph()).getByRole('button', { name: 'Title ref' }));

    const details = screen.getByRole('complementary', { name: 'Title ref' });
    const link = await within(details).findByRole('link', { name: 'Internet Archive' });
    expect(link).toHaveAttribute('href', 'https://archive.org/details/refscan');
    expect(link.parentElement).toHaveTextContent('1906 · free to read');
    expect(api.getArchiveItems).toHaveBeenCalledWith('ref', expect.anything());

    // Another work's details don't keep the previous work's links.
    fireEvent.click(within(graph()).getByRole('button', { name: 'Title citer' }));
    const other = screen.getByRole('complementary', { name: 'Title citer' });
    expect(within(other).queryByRole('link', { name: 'Internet Archive' })).toBeNull();
  });

  it('expands a selected work', async () => {
    await buildFromSearch();
    fireEvent.click(within(graph()).getByRole('button', { name: 'Title ref' }));

    fireEvent.click(screen.getByRole('button', { name: 'Expand citing and cited works' }));

    expect(await within(graph()).findByRole('button', { name: 'Title more' })).toBeInTheDocument();
    expect(api.getCiting).toHaveBeenCalledWith('ref', { limit: 20 });
    expect(screen.getByRole('button', { name: 'Expanded' })).toBeDisabled();
  });

  it('marks works whose citing and cited works have both been fetched', async () => {
    await buildFromSearch();
    const expanded = () =>
      within(graph())
        .getAllByRole('button')
        .filter((button) => button.dataset.expanded)
        .map((button) => button.textContent);
    // Depth 1 each way: the build fetched both directions for the anchor only.
    expect(expanded()).toEqual(['Title anchor']);

    fireEvent.click(within(graph()).getByRole('button', { name: 'Title ref' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand citing and cited works' }));
    await screen.findByRole('button', { name: 'Expanded' });
    expect(expanded()).toEqual(['Title anchor', 'Title ref']);
    expect(screen.getByText('Expanded', { selector: '.legend span' })).toBeInTheDocument();
  });

  it('collapses a work the user expanded, dropping what only it brought in', async () => {
    await buildFromSearch();
    // Only works the user expanded can be collapsed.
    fireEvent.click(within(graph()).getByRole('button', { name: 'Title anchor' }));
    expect(screen.queryByRole('button', { name: 'Collapse' })).toBeNull();

    fireEvent.click(within(graph()).getByRole('button', { name: 'Title ref' }));
    expect(screen.queryByRole('button', { name: 'Collapse' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand citing and cited works' }));
    await within(graph()).findByRole('button', { name: 'Title more' });

    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));

    await waitFor(() =>
      expect(within(graph()).queryByRole('button', { name: 'Title more' })).toBeNull(),
    );
    // ref stays (the build reaches it), no longer expanded, and the anchor is unchanged.
    expect(within(graph()).getByRole('button', { name: 'Title ref' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand citing and cited works' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Collapse' })).toBeNull();
    expect(window.location.search).toContain('anchor=');
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
    // The cited request finished; the citing one is still running.
    const running = within(progress).getByRole('list', {
      name: 'Expanding “Title ref”: in progress',
    });
    expect(
      within(running)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Works citing “Title ref”']);

    releaseCiting();
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Loading progress' })).toBeNull(),
    );
  });

  it('filters by links in either direction, from a minimum of 1', async () => {
    // more cites ref; once ref is expanded it's linked to anchor, citer and more.
    await buildFromSearch();
    const slider = screen.getByRole('slider', { name: /Cited by or cites at least 1 on graph/ });
    expect(slider).toHaveAttribute('min', '1');
    expect(slider).toHaveAttribute('max', '2');

    fireEvent.click(within(graph()).getByRole('button', { name: 'Title ref' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand citing and cited works' }));
    await within(graph()).findByRole('button', { name: 'Title more' });
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    fireEvent.change(slider, { target: { value: '3' } });

    expect(screen.getByRole('slider', { name: /at least 3 on graph/ })).toBeInTheDocument();
    // Only ref has three links; the anchor always stays.
    expect(
      within(graph())
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Title anchor', 'Title ref']);
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

describe('accounts', () => {
  const user = { id: 'u1', email: 'historian@example.org' };
  const fill = (label, value) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });

  it('signs up from the header', async () => {
    vi.mocked(api.signUp).mockResolvedValue(user);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign up' }));

    const dialog = screen.getByRole('dialog', { name: 'Create an account' });
    expect(within(dialog).getByLabelText('Email')).toHaveFocus();
    fill('Email', 'historian@example.org');
    fill('Password', 'correct horse');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create an account' }));

    expect(await screen.findByText('historian@example.org')).toBeInTheDocument();
    expect(api.signUp).toHaveBeenCalledWith('historian@example.org', 'correct horse');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
  });

  it('shows a failed login in the dialog', async () => {
    vi.mocked(api.logIn).mockRejectedValue(new Error('Incorrect email or password'));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Log in' }));
    fill('Email', 'historian@example.org');
    fill('Password', 'wrong horse');
    fireEvent.submit(screen.getByLabelText('Password').closest('form'));

    const dialog = screen.getByRole('dialog', { name: 'Log in' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Incorrect email or password',
    );
  });

  it('switches between logging in and signing up, and closes on Escape', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Log in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    expect(screen.getByRole('dialog', { name: 'Create an account' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows who is signed in, and logs out', async () => {
    vi.mocked(api.getCurrentUser).mockResolvedValue(user);
    vi.mocked(api.logOut).mockResolvedValue();
    render(<App />);
    expect(await screen.findByText('historian@example.org')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));

    expect(await screen.findByRole('button', { name: 'Log in' })).toBeInTheDocument();
    expect(screen.queryByText('historian@example.org')).toBeNull();
  });
});

describe('saved graphs', () => {
  const user = { id: 'u1', email: 'historian@example.org' };
  const savedFrom = (state, overrides = {}) => ({
    id: 'g1',
    name: 'Riots',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    annotations: [],
    ...state,
    ...overrides,
  });

  beforeEach(() => {
    vi.mocked(api.getCurrentUser).mockResolvedValue(user);
  });

  it('asks you to log in to save', async () => {
    vi.mocked(api.getCurrentUser).mockResolvedValue(null);
    await buildFromSearch();
    expect(await screen.findByText('Log in to save this graph')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save graph' })).toBeNull();
  });

  it('saves the graph with a name: its anchor, options, filters, view and expansions', async () => {
    vi.mocked(api.saveGraph).mockImplementation(async (name, state) => savedFrom(state, { name }));
    await buildFromSearch();
    fireEvent.click(within(graph()).getByRole('button', { name: 'Title ref' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand citing and cited works' }));
    await within(graph()).findByRole('button', { name: 'Title more' });
    fireEvent.click(screen.getByRole('checkbox', { name: /Article/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Save graph' }));
    const dialog = screen.getByRole('dialog', { name: 'Save graph' });
    // Named after the anchor unless you change it.
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Title anchor');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Riots' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved as “Riots”')).toBeInTheDocument();
    const [name, state] = vi.mocked(api.saveGraph).mock.calls[0];
    expect(name).toBe('Riots');
    expect(state).toEqual({
      anchor: { id: 'anchor', ref: 'Wanchor', title: 'Title anchor' },
      options: { citingDepth: 1, citedDepth: 1, limit: 20, maxNodes: 300 },
      filters: { minYear: null, maxYear: null, minConnections: 1, excludedTypes: ['article'] },
      view: { axisAngle: 30 },
      expanded: ['ref'],
    });
    // With the graph as built, so reopening it needn't fetch anything.
    const snapshot = vi.mocked(api.saveGraph).mock.calls[0][2];
    expect(snapshot).toMatchObject({ anchorId: 'anchor', sticky: ['ref'], truncated: false });
    expect(snapshot.works.map((w) => w.id)).toContain('more');
    expect(snapshot.relations).toContainEqual(['anchor', 'anchor']);
    expect(snapshot.expanded).toContainEqual(['ref', ['citing', 'cited']]);
    expect(window.location.search).toContain('graph=g1');
  });

  it('updates the saved graph it came from, or saves a new one', async () => {
    vi.mocked(api.saveGraph).mockImplementation(async (name, state) => savedFrom(state, { name }));
    vi.mocked(api.updateGraph).mockImplementation(async (id, name, state) =>
      savedFrom(state, { id, name }),
    );
    await buildFromSearch();
    fireEvent.click(screen.getByRole('button', { name: 'Save graph' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved as/);

    fireEvent.click(screen.getByRole('button', { name: 'Save graph' }));
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() =>
      expect(api.updateGraph).toHaveBeenCalledWith(
        'g1',
        'Title anchor',
        expect.any(Object),
        expect.any(Object),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save graph' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save as new' }));
    await waitFor(() => expect(api.saveGraph).toHaveBeenCalledTimes(2));
  });

  it('opens a saved graph from its link, with its expansions, filters and view', async () => {
    vi.mocked(api.getSavedGraph).mockResolvedValue(
      savedFrom({
        anchor: { id: 'anchor', ref: 'Wanchor', title: 'Title anchor' },
        options: { citingDepth: 1, citedDepth: 1, limit: 20, maxNodes: 300 },
        filters: { minYear: 1900, maxYear: null, minConnections: 1, excludedTypes: [] },
        view: { axisAngle: 60 },
        expanded: ['ref'],
      }),
    );
    window.history.replaceState(null, '', '/?graph=g1');
    render(<App />);

    // more only arrives with the saved expansion of ref.
    await waitFor(() =>
      expect(within(graph()).getByRole('button', { name: 'Title more' })).toBeInTheDocument(),
    );
    expect(api.getSavedGraph).toHaveBeenCalledWith('g1');
    // Opening is a cancellable run, so its requests carry an abort signal.
    expect(api.getCiting).toHaveBeenCalledWith('ref', expect.objectContaining({ limit: 20 }));
    expect(screen.getByLabelText('From year')).toHaveValue(1900);
    expect(graph()).toHaveAttribute('data-axis-angle', '60');
    expect(window.location.search).toBe('?graph=g1');
  });

  const savedState = {
    anchor: { id: 'anchor', ref: 'Wanchor', title: 'Title anchor' },
    options: { citingDepth: 1, citedDepth: 1, limit: 20, maxNodes: 300 },
    filters: { minYear: null, maxYear: null, minConnections: 1, excludedTypes: [] },
    view: { axisAngle: 30 },
    expanded: ['ref'],
  };

  it('opens a saved graph from its snapshot without fetching any works', async () => {
    vi.mocked(api.getSavedGraph).mockResolvedValue(
      savedFrom(savedState, {
        stateKey: 'k1',
        snapshot: {
          anchorId: 'anchor',
          works: [work('anchor', { references: ['ref'] }), work('ref', { year: 1950 })],
          relations: [
            ['anchor', 'anchor'],
            ['ref', 'cited'],
          ],
          expanded: [['ref', ['citing', 'cited']]],
          sticky: ['ref'],
          truncated: true,
        },
      }),
    );
    window.history.replaceState(null, '', '/?graph=g1');
    render(<App />);

    await waitFor(() =>
      expect(within(graph()).getByRole('button', { name: 'Title ref' })).toBeInTheDocument(),
    );
    // Truncated, as when it was built.
    expect(screen.getByText(/Stopped at 2 works/)).toBeInTheDocument();
    for (const fetcher of [api.getWork, api.getCiting, api.getCited, api.saveGraphSnapshot]) {
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it('stores a snapshot after rebuilding a saved graph that had none', async () => {
    vi.mocked(api.getSavedGraph).mockResolvedValue(
      savedFrom(savedState, { stateKey: 'k1', snapshot: null }),
    );
    vi.mocked(api.saveGraphSnapshot).mockResolvedValue();
    window.history.replaceState(null, '', '/?graph=g1');
    render(<App />);

    await waitFor(() => expect(api.saveGraphSnapshot).toHaveBeenCalled());
    const [id, key, snapshot] = vi.mocked(api.saveGraphSnapshot).mock.calls[0];
    expect([id, key]).toEqual(['g1', 'k1']);
    expect(snapshot.works.map((w) => w.id)).toEqual(expect.arrayContaining(['anchor', 'more']));
    expect(api.getCiting).toHaveBeenCalled();
  });

  it('says so when a saved graph can’t be opened', async () => {
    vi.mocked(api.getSavedGraph).mockRejectedValue(new Error('Log in first'));
    window.history.replaceState(null, '', '/?graph=g1');
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t open the saved graph: Log in first',
    );
  });
});

describe('profile page', () => {
  const user = { id: 'u1', email: 'historian@example.org' };
  const summary = (id, name) => ({
    id,
    name,
    anchor: { title: 'The Moral Economy', ref: '10.1093/past/50.1.76' },
    expandedCount: 2,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  });

  beforeEach(() => {
    window.history.replaceState(null, '', '/profile');
    vi.mocked(api.getCurrentUser).mockResolvedValue(user);
    vi.mocked(api.listGraphs).mockResolvedValue([summary('g1', 'Riots'), summary('g2', 'Famine')]);
  });

  const list = () => screen.findByRole('list', { name: 'Saved graphs' });

  it('lists your saved graphs, each linking to open it', async () => {
    render(<App />);
    const items = within(await list()).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByRole('link', { name: 'Riots' })).toHaveAttribute(
      'href',
      '/?graph=g1',
    );
    expect(items[0]).toHaveTextContent('Anchor: The Moral Economy');
    expect(items[0]).toHaveTextContent('2 expanded');
  });

  it('renames a saved graph', async () => {
    vi.mocked(api.renameGraph).mockResolvedValue(summary('g1', 'Food riots'));
    render(<App />);
    const item = within(await list()).getAllByRole('listitem')[0];
    fireEvent.click(within(item).getByRole('button', { name: 'Rename' }));
    fireEvent.change(within(item).getByLabelText('Name'), { target: { value: 'Food riots' } });
    fireEvent.click(within(item).getByRole('button', { name: 'Save name' }));

    expect(await within(item).findByRole('link', { name: 'Food riots' })).toBeInTheDocument();
    expect(api.renameGraph).toHaveBeenCalledWith('g1', 'Food riots');
  });

  it('deletes a saved graph after confirming', async () => {
    vi.mocked(api.deleteGraph).mockResolvedValue();
    render(<App />);
    const item = within(await list()).getAllByRole('listitem')[1];
    fireEvent.click(within(item).getByRole('button', { name: 'Delete' }));
    expect(within(item).getByText('Delete “Famine”?')).toBeInTheDocument();
    fireEvent.click(within(item).getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Saved graphs' })).getAllByRole('listitem'),
      ).toHaveLength(1),
    );
    expect(api.deleteGraph).toHaveBeenCalledWith('g2');
  });

  it('asks you to log in, and links to it from the header', async () => {
    vi.mocked(api.getCurrentUser).mockResolvedValue(null);
    render(<App />);
    expect(await screen.findByText('Log in to see your saved graphs.')).toBeInTheDocument();
  });

  it('is linked from the header when signed in', async () => {
    window.history.replaceState(null, '', '/');
    render(<App />);
    expect(await screen.findByRole('link', { name: 'My graphs' })).toHaveAttribute(
      'href',
      '/profile',
    );
  });
});
