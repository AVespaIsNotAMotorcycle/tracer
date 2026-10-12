// Shared shapes for citation-data providers. Every adapter converts its API's responses into
// these types so nothing outside the adapter depends on a provider's response format.
//
// Adapters work in provider IDs. Mapping provider IDs to Tracer IDs, and merging records from
// several providers, happens in a layer above the adapters.

/**
 * @typedef {object} ProviderAuthor
 * @property {string} name
 * @property {string | null} orcid  Bare ORCID iD, e.g. "0000-0003-1613-5981".
 */

/**
 * @typedef {object} ProviderLink
 * @property {'doi' | 'landing_page' | 'pdf' | 'provider'} kind
 * @property {string} url
 */

/**
 * A single work as reported by one provider.
 *
 * @typedef {object} ProviderWork
 * @property {string} provider        Provider name, e.g. "openalex".
 * @property {string} providerId      The work's ID in that provider, e.g. "W2741809807".
 * @property {Record<string, string>} externalIds
 *   Identifiers usable to match this work across providers, e.g. { doi, openalex, pmid }.
 *   DOIs are normalized with normalizeDoi().
 * @property {string | null} title
 * @property {ProviderAuthor[]} authors
 * @property {number | null} year
 * @property {string | null} type     Provider's work type, e.g. "article", "book-chapter".
 * @property {string | null} venue    Journal, book series, or other container.
 * @property {string | null} abstract
 * @property {number | null} citedByCount
 *   Global citation count reported by the provider. Not used for node sizing, which counts
 *   in-graph citations only.
 * @property {string[]} referencedIds
 *   Provider IDs of the works this one cites. Used to draw edges between any two works on
 *   the graph, not only edges to the root.
 * @property {ProviderLink[]} links
 */

/**
 * @typedef {object} ListOptions
 * @property {number} [limit]  Maximum number of works to return.
 */

/**
 * The interface every provider adapter implements.
 *
 * @typedef {object} Provider
 * @property {string} name
 * @property {(id: string) => Promise<ProviderWork | null>} getWork
 *   Look up one work by provider ID or DOI. Resolves to null if the provider doesn't have it.
 * @property {(ids: string[]) => Promise<ProviderWork[]>} getWorks
 *   Batch lookup by provider ID. Results follow the input order; unknown IDs are omitted.
 * @property {(id: string, options?: ListOptions) => Promise<ProviderWork[]>} getCitingWorks
 *   Works that cite the given work.
 * @property {(id: string, options?: ListOptions) => Promise<ProviderWork[]>} getCitedWorks
 *   Works the given work cites.
 * @property {(query: string, options?: ListOptions) => Promise<ProviderWork[]>} searchWorks
 */

export {};
