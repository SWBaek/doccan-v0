# CanDoc MVP 1

Read `README.md`, `docs/SCHEMA.md`, and `docs/AGENT.md` before editing document data.

- Never modify the input ZIP or `data/source`. Preserve the complete document.
- Use the running local API through `python -m candoc.cli` for document inspection and proposals.
- Document content changes require user approval of the exact proposal. Do not approve on the user's behalf or directly edit the work JSON/SQLite database. Explicitly authorized tests use a separate test Asset.
- Do not infer original text from conversion artifacts, summarize, polish, or rearrange source content.
- Unsupported structural mutations must fail closed. Review state and lineage stay outside DoclingDocument.
- Use pinned docling-core 2.93.0 and schema 1.10.0. Never serialize model normalization into the working source.
- Run `python -m unittest discover -s tests -v` for changes to the document workflow. Browser tests mutate only `verification/browser-data` on port 52742.
