// Tracer's features by plan, for the "Plans and pricing" page (PricingPage.jsx): those built
// and those planned (ROADMAP.md, which gives each one's tier). When a feature ships, move it
// to `available: true` and gate it through entitlements (server/src/entitlements/plans.js)
// if it isn't free.
//
// `free` and `scholar` say what each plan gets: true (included), false (not included), or a
// short phrase for a limit ("2 anchors"). `note` adds detail shown under the feature's name.

import { ANONYMOUS } from '../auth/entitlements.js';

/**
 * @typedef {object} Feature
 * @property {string} name
 * @property {string} [note]
 * @property {boolean | string} free
 * @property {boolean | string} scholar
 * @property {boolean} available  Built and usable now.
 */

/** @type {{ heading: string, features: Feature[] }[]} */
export const FEATURE_GROUPS = [
  {
    heading: 'Building graphs',
    features: [
      {
        name: 'Citation graphs from any work',
        note: 'Citing and cited works, with separate depths, up to 2,000 works.',
        free: true,
        scholar: true,
        available: true,
      },
      {
        name: 'Multiple anchors',
        note: 'Build around several works at once, each anchor’s neighborhood in its own color.',
        free: `Up to ${ANONYMOUS.limits.anchors}`,
        scholar: 'Up to 6',
        available: true,
      },
      {
        name: 'Expand, re-anchor and collapse works',
        free: true,
        scholar: true,
        available: true,
      },
      {
        name: 'Advanced search',
        note: 'Title, author, abstract, full text, journal, publisher, year, type, language and more.',
        free: true,
        scholar: true,
        available: true,
      },
      {
        name: 'Start from an ISBN or a pasted citation',
        free: true,
        scholar: true,
        available: false,
      },
      {
        name: 'Bibliography import',
        note: 'From Zotero, BibTeX, RIS or pasted footnotes.',
        free: 'Up to about 20 items',
        scholar: true,
        available: false,
      },
    ],
  },
  {
    heading: 'Sources and data',
    features: [
      {
        name: 'OpenAlex, Crossref and OpenCitations combined',
        note: 'Including references OpenAlex doesn’t have, shown as works “Not on OpenAlex”.',
        free: true,
        scholar: true,
        available: true,
      },
      {
        name: 'Book chapters folded into their book',
        free: true,
        scholar: true,
        available: true,
      },
      {
        name: 'Citation matching and Internet Archive copies',
        note: 'Links to the work Crossref matches a printed citation to, and scanned copies to read.',
        free: true,
        scholar: true,
        available: true,
      },
      {
        name: 'Duplicate merging',
        note: 'One node for a work OpenAlex lists twice, or a printed reference matched to its record.',
        free: true,
        scholar: true,
        available: true,
      },
      {
        name: 'Data provenance and missing-data warnings',
        note: 'Which database each citation came from, and a flag on works whose references are missing.',
        free: true,
        scholar: true,
        available: true,
      },
      {
        name: 'Language metadata and filter',
        note: 'Each work’s language, a language filter, and original-script titles where Crossref has them.',
        free: true,
        scholar: true,
        available: true,
      },
      {
        name: 'Semantic Scholar as a source',
        free: true,
        scholar: true,
        available: false,
      },
      {
        name: 'Citation context',
        note: 'The sentence each citation appears in, where Semantic Scholar has it.',
        free: false,
        scholar: true,
        available: false,
      },
      {
        name: 'Grouping archival sources',
        free: true,
        scholar: true,
        available: false,
      },
      {
        name: 'Non-English sources',
        note: 'CiNii, Persée, Cairn, HathiTrust and others, as access is arranged.',
        free: true,
        scholar: true,
        available: false,
      },
    ],
  },
  {
    heading: 'Exploring and analysis',
    features: [
      {
        name: 'Filters, pins and a rotatable time axis',
        free: true,
        scholar: true,
        available: true,
      },
      {
        name: 'Co-citations',
        note: 'Works often cited alongside an anchor.',
        free: true,
        scholar: true,
        available: true,
      },
      {
        name: 'Shortest path to an anchor',
        note: 'From a work, or another anchor, with no link on the graph.',
        free: true,
        scholar: true,
        available: true,
      },
      {
        name: 'Shortest path between any two works',
        free: false,
        scholar: true,
        available: false,
      },
      {
        name: 'Citations per year',
        free: true,
        scholar: true,
        available: false,
      },
      {
        name: 'Color by discipline or topic',
        free: true,
        scholar: true,
        available: false,
      },
      {
        name: '“What am I missing?” suggestions',
        free: false,
        scholar: true,
        available: false,
      },
      {
        name: 'Cluster detection',
        free: false,
        scholar: true,
        available: false,
      },
      {
        name: 'Find and highlight works on the graph',
        free: true,
        scholar: true,
        available: false,
      },
    ],
  },
  {
    heading: 'Your work',
    features: [
      {
        name: 'Saved graphs, with auto-save',
        note: 'Needs a free account.',
        free: 'Up to 500',
        scholar: 'Up to 500',
        available: true,
      },
      {
        name: 'Notes on works',
        note: 'Planned: notes on one graph for free, on every graph with Scholar.',
        free: true,
        scholar: true,
        available: true,
      },
      {
        name: 'Reading status and a personal library',
        free: false,
        scholar: true,
        available: false,
      },
      {
        name: 'Manual works and citation links',
        note: 'Add what the databases missed, visible only to you.',
        free: false,
        scholar: true,
        available: false,
      },
      {
        name: 'Library links',
        note: 'Your library’s link resolver, set by you (preset with an institutional plan).',
        free: true,
        scholar: true,
        available: false,
      },
    ],
  },
  {
    heading: 'Sharing and output',
    features: [
      {
        name: 'Shareable links',
        note: 'Anyone with the link sees the graph built fresh.',
        free: true,
        scholar: true,
        available: true,
      },
      {
        name: 'Shared editing',
        note: 'Share a saved graph with others as viewers or editors (a group plan).',
        free: false,
        scholar: false,
        available: false,
      },
      {
        name: 'Bibliography export',
        note: 'BibTeX, RIS, CSL-JSON and Chicago style.',
        free: true,
        scholar: true,
        available: false,
      },
      {
        name: 'Image export',
        free: 'PNG with a credit',
        scholar: 'SVG, print resolution, no credit',
        available: false,
      },
      {
        name: 'Dated, citable snapshots',
        note: 'A permanent public link to the graph as of the day its data was retrieved.',
        free: false,
        scholar: true,
        available: false,
      },
    ],
  },
];
