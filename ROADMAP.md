# Tracer roadmap

The features planned for Tracer, in the order they should be built.

**How the order was chosen:** features that set or change a core assumption (the data model, IDs, who owns what, what a saved graph stores) come first. These are cheap now and get more expensive with every feature built on top of them. Features that are self-contained (pure computation on the graph, UI-only additions, exports) come later, because they cost about the same whenever they're built.

Each entry lists:

- **Tier:** Free or Paid (Scholar), following the pricing plan.
- **Size:** rough focused hours at the current pace (S ≤ 2 h, M 3–6 h, L 6–16 h, XL longer or depends on others).
- **Why here:** the engineering reason for its place in the order.

---

## Already shipped

- **Fielded search** (advanced search across title, author, venue, publisher, year, type, language, citation count, open access). Done.
- **Notes on works**, saved with the graph as `annotations`. Done. Reading status is still to do (see 7).
- **Shortest path to the anchor.** Done. Generalizing it is still to do (see 17).
- **Multiple anchors** (1): a graph built around several works, colored by anchor with shared works split between their colors; 2 anchors free, 6 on Scholar. Saved graphs are version 2 (`anchors`).
- **Duplicate merging and stable IDs** (2): OpenAlex records sharing a DOI, and grey reference-only nodes Crossref matched to an OpenAlex work, merge into one work when their records agree (`sameWork`), combining their citations. A merged Source redirects (`mergedInto`) wherever its ID is looked up, and saved graphs are rewritten to follow it when opened. Done.
- **Entitlements layer** (groundwork): `can(user, feature)` / `limitFor(user, limit)` in `server/src/entitlements/`, checked by the gated routes and controls, with every tier including everything for now. Billing (Stripe) waits for launch.

---

## Before phase 1: groundwork

These aren't features, but each one gets harder to add later.

- **Request outside access now.** Apply for a Semantic Scholar API key (needed for 12), ask OpenAlex about a higher credit limit, and contact data providers for non-English sources (22). These take days to months to come back and don't depend on any code.

---

## Phase 1: Core model

### 3. Data provenance and missing-data warnings
**Tier:** Free · **Size:** M

Show which provider supplied each work and each citation link (OpenAlex, Crossref, OpenCitations, later Semantic Scholar and others). Flag works whose reference list is empty or suspiciously short compared with their citation count, such as Thompson's 1971 article with thousands of citers and no references, so an apparent origin point isn't mistaken for one.

**Why here:** edges are currently merged into a single `references` list, which loses where each link came from. Recording the source per link means changing how Sources store links, and cached Sources and snapshots made before the change won't have it until they refresh. Every provider added later (12, 22) should be built with provenance from the start, not have it retrofitted.

### 4. Language metadata
**Tier:** Free · **Size:** S

Add each work's language to the normalized work record. Show it in the details panel, add a language filter to the Filters panel, and show original-script titles next to romanized ones where a provider has both.

**Why here:** advanced search already filters by language, but works on the graph don't carry it. Adding fields to `ProviderWork` is cheap, but Sources cache records for 30 days and snapshots store works as they were built, so the sooner the field exists, the sooner stored data has it. Non-English sources (22) depend on it.

### 5. Citations per year
**Tier:** Free · **Size:** S

A small chart in the details panel showing how often a work has been cited each year (OpenAlex's `counts_by_year`), to show a work's reception over time.

**Why here:** the same schema reason as 4. Do 4, 5 and 6 together as one change to the work record, so cached data and snapshots only have to catch up once.

### 6. Color by discipline or topic
**Tier:** Free · **Size:** S

Optionally color nodes by OpenAlex field or topic instead of by relation to the anchor, to show an idea moving between history, anthropology, political science and so on.

**Why here:** the same schema change as 4 and 5. The coloring itself is UI-only and could come later; the data should be stored now.

### 7. Reading status and a personal library
**Tier:** Paid (free: notes on 1 graph) · **Size:** M

Tag works as to-read, reading, read or cited, and show the status on the graph. Keep a library page listing every work the user has tagged or noted, across all their graphs.

**Why here:** notes currently live on each saved graph. Reading status shouldn't: "I've read this" is true in every graph. Deciding now that some user data lives on a per-user library (a `LibraryEntry` keyed by user and Tracer ID) and some on the graph sets the pattern for manual edits (8), sharing (9) and bibliography import (11). Making that decision after notes have spread across hundreds of saved graphs means a data migration.

### 8. Manual nodes and edges
**Tier:** Paid · **Size:** L

Let users add a citation link the databases missed ("I read this footnote"), or a work no database has, marked as manual and visible only to them (and later to their collaborators).

**Why here:** this is user-owned data mixed into provider data, so it depends on the ownership pattern from 7 and the provenance model from 3 (a manual link is just another source, `manual`). Every graph computation (edges, counts, co-citation, path search, lanes) has to include the overlay. The more of those computations exist, the more places need changing.

### 9. Sharing and permissions
**Tier:** Free read-only links (already exist); Seminar/Lab tier for shared editing · **Size:** L

Share a saved graph with other users as viewer or editor. Editors can expand works and add notes; viewers can explore and copy the graph. Real-time co-editing (live cursors, Google Docs style) is out of scope.

**Why here:** every graph route currently assumes the owner is the only user (`userId` on SavedGraph, a 404 for anyone else). Auto-save, just added, saves the latest state over whatever is on the server, which is fine for one person and loses work with two. Adding a version check on save (reject a `PUT` whose base version is stale) is a small change now and should come before collaborators exist. A permissions check written once in the routes is far easier than adding it after more graph routes exist.

---

## Phase 2: Getting sources in

### 10. Start from an ISBN or a pasted citation
**Tier:** Free · **Size:** M

Start a graph from an ISBN (looked up through Open Library or WorldCat), a library catalog record, or a citation pasted as text ("Hummel, Arthur W., ed. *Eminent Chinese of the Ch'ing Period*. Washington, 1943–44"), reusing the Crossref citation matching already built for grey nodes.

**Why here:** it's the matching engine that bibliography import (11) runs in bulk. Build and tune it on one citation at a time first.

### 11. Bibliography import
**Tier:** Paid (free up to about 20 items) · **Size:** L

Import a Zotero collection, a BibTeX or RIS file, or pasted footnotes, and build one graph from all of them. Show which items matched, which didn't, and which are islands with no links to the rest.

**Why here:** depends on multiple anchors (1), duplicate merging (2), the personal library (7, so imported items can be marked "cited") and citation matching (10). Its OpenAlex cost (about 10 credits per search) is why it's limited by tier, through the entitlements layer.

### 12. Semantic Scholar adapter and citation context
**Tier:** Free (the adapter); Paid (citation context) · **Size:** L

Add Semantic Scholar as a provider for records and links. Then show the sentence each citation appears in, where Semantic Scholar has it, so users can tell "building on X" from "arguing against X."

**Why here:** a new provider should arrive after provenance (3) and duplicate merging (2), so it's built with both rather than adding duplicates and unlabelled links. Its API key request should already be in (see groundwork).

### 13. Grouping archival sources
**Tier:** Free · **Size:** L

Recognize references to archival collections in printed citations ("First Historical Archives, Beijing," "TNA HO 42/119") and group them under one node per archive or collection, as their own source type, to show which archives a body of scholarship rests on and which are underused.

**Why here:** archives don't fit the year axis (they're undated or span centuries) and they're a new node type that filters, the legend and layout must handle. It touches layout code, so it's easier before more layout features exist. Extracting archive names from footnotes is heuristic work that needs tuning against many real reference lists, so start it once matching (10) has settled.

---

## Phase 3: Output, and launching the paid tier

When 14–16 are done, together with 7 and 11, the Scholar tier has enough to launch. Add Stripe billing, password reset by email, terms of service and a privacy policy at this point.

### 14. Bibliography export
**Tier:** Free · **Size:** M

Export the visible, pinned or tagged works as BibTeX, RIS, CSL-JSON (for Zotero) and formatted Chicago notes-bibliography style, using a CSL library rather than formatting citations by hand.

**Why here:** self-contained, and it costs the same whenever it's built. It's here because it's needed for launch, and it's better with reading status (7) so users can export "everything I marked cited."

### 15. Image export
**Tier:** Free PNG with a "made with Tracer" credit; Paid SVG, print resolution, grayscale and no credit · **Size:** M (PNG S, SVG L)

Export the graph as an image for a book figure, article or slides, and embed a live graph in a website.

**Why here:** PNG is a canvas export and easy any time. SVG gets harder with every decoration added to the canvas (rings, badges, trunks, ramps, routing), because each one has to be drawn a second way. Using a library that implements the Canvas 2D API to produce SVG (such as `svgcanvas`) avoids most of that, but check that it handles the `Path2D` icons before relying on it.

### 16. Dated, citable snapshots
**Tier:** Paid · **Size:** M

Freeze a graph as a permanent public link, labeled with the date its data was retrieved, so it can be cited in a footnote ("citation network generated with Tracer, data as of October 2026") and a reader sees the same graph.

**Why here:** after the data model has settled (1–6), because a public permalink is a promise that the snapshot keeps opening forever. Every later change to the snapshot format then needs code to read old ones. Snapshots already exist as a cache (`GraphSnapshot`, one week); this makes some of them immutable and permanent, with a format `version` from day one.

---

## Phase 4: Analysis and convenience

These are computations on a graph already loaded, or UI-only additions. They cost about the same whenever they're built, so they come last apart from 22.

### 17. Path between any two works
**Tier:** Paid · **Size:** S

Generalize the shortest-path search so it runs between any two selected works, not only from a disconnected work to the anchor. The server route already takes `to`.

**Why here:** nearly done. After multiple anchors (1), so "the anchor" isn't hardcoded into it again.

### 18. "What am I missing?"
**Tier:** Paid · **Size:** M

Suggest works the graph points to but doesn't include: those heavily cited across the graph's works, and those with similar reference lists to the anchor (bibliographic coupling, the counterpart of co-citation). Useful as a check before submitting a manuscript.

**Why here:** reuses the co-citation code, and no other feature depends on it.

### 19. Cluster detection
**Tier:** Paid · **Size:** M

Detect densely connected groups of works (for example with Louvain community detection from `graphology`), color them, and let users name them, which often maps onto the schools of a historiography.

**Why here:** pure computation on the loaded graph. Cluster names can be saved as a new `annotations` kind, which the model already allows for.

### 20. Find and highlight in the graph
**Tier:** Free · **Size:** S

Search the works on screen by title or author, and highlight every work by one author.

**Why here:** UI only, and costs the same whenever it's built.

### 21. Library links
**Tier:** Free (user setting); Institution tier (preconfigured) · **Size:** S

Let users enter their library's OpenURL link resolver, and show "find it at my library" and WorldCat links in each work's details.

**Why here:** one user setting and one link builder; costs the same whenever it's built.

---

## Ongoing

### 22. Non-English sources
**Tier:** Free · **Size:** XL, depends on outside parties

Add providers for scholarship English-language indexes cover poorly: CiNii (Japanese, open API), Persée and Cairn (French), HathiTrust (full-text public-domain books), Wikidata, and Chinese databases such as CNKI or Taiwan's NCL where access can be arranged. Match the same work across scripts and romanizations (Hepburn, Wade-Giles, pinyin).

**Why last:** it depends on language metadata (4), provenance (3) and duplicate merging (2), and each source is its own project on its own timeline. Some, CNKI especially, may need a licensing agreement that takes months or never happens. Start the access requests during the groundwork phase and add each provider when its access comes through, in parallel with everything else.
