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
 *   Global citation count reported by the provider. Drives node size on the client.
 * @property {string[]} referencedIds
 *   Provider IDs of the works this one cites. Used to draw edges between any two works on
 *   the graph, not only edges to the root.
 * @property {ProviderLink[]} links
 */

/**
 * One entry of a work's reference list as a publisher deposited it (see crossref.js). It may
 * name a work no citation database has, such as an archival source or an older book.
 *
 * @typedef {object} ProviderReference
 * @property {string | null} doi   Normalized with normalizeDoi().
 * @property {string | null} title
 * @property {ProviderAuthor[]} authors  Usually just the first author's surname.
 * @property {number | null} year
 * @property {string | null} venue  Journal, or the book a chapter appeared in.
 * @property {string | null} unstructured  The citation as printed, when deposited.
 */

/**
 * The IDs of the work at one end of a citation link (see opencitations.js). Either may be
 * missing.
 *
 * @typedef {object} LinkedIds
 * @property {string | null} doi       Normalized with normalizeDoi().
 * @property {string | null} openalex  Short OpenAlex ID, e.g. "W123".
 */

/**
 * @typedef {object} ListOptions
 * @property {number} [limit]  Maximum number of works to return.
 */

/**
 * What an advanced search looks for. Every given field must match; text fields match words,
 * not exact strings. Venue and publisher IDs come from the same provider's `suggest`.
 *
 * @typedef {object} SearchCriteria
 * @property {string} [any]       Any field: title, abstract, full text and so on.
 * @property {string} [title]
 * @property {string} [author]    Author names as printed.
 * @property {string} [abstract]
 * @property {string} [fulltext]
 * @property {string[]} [venueIds]      Any of these journals or book series.
 * @property {string[]} [publisherIds]  Any of these publishers (or their imprints).
 * @property {number} [fromYear]
 * @property {number} [toYear]
 * @property {string[]} [types]   Any of these work types, e.g. "book".
 * @property {string} [language]  ISO 639-1 code, e.g. "fr".
 * @property {number} [minCitations]  Times cited, at least.
 * @property {boolean} [openAccess]
 * @property {'relevance' | 'cited' | 'newest' | 'oldest'} [sort]
 *   Relevance needs a text field; without one, the most-cited works come first.
 */

/**
 * A venue or publisher to search within, as `suggest` returns it.
 *
 * @typedef {object} Suggestion
 * @property {string} id    The provider's ID for it, opaque outside the adapter.
 * @property {string} name
 * @property {string | null} hint  E.g. a journal's publisher.
 * @property {number | null} worksCount
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
 * @property {(dois: string[]) => Promise<ProviderWork[]>} [getWorksByDoi]
 *   Batch lookup by DOI. Unknown DOIs are omitted; order is not guaranteed.
 * @property {(id: string, options?: ListOptions) => Promise<ProviderWork[]>} getCitingWorks
 *   Works that cite the given work.
 * @property {(id: string, options?: ListOptions) => Promise<ProviderWork[]>} getCitedWorks
 *   Works the given work cites.
 * @property {(query: string, options?: ListOptions) => Promise<ProviderWork[]>} searchWorks
 * @property {(criteria: SearchCriteria, options?: { limit?: number, page?: number }) =>
 *   Promise<{ works: ProviderWork[], total: number }>} [searchWorksAdvanced]
 *   One page of works matching every field of `criteria`, and how many match in all.
 * @property {(kind: 'venue' | 'publisher', query: string) => Promise<Suggestion[]>} [suggest]
 *   Venues or publishers whose names match `query`.
 */

export {};
