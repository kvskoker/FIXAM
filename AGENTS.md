## graphify

This project uses a **generated** knowledge graph, built with `graphify` and written
to `graphify-out/` (god nodes, community structure, cross-file relationships).
It is a local build aid, regenerated on demand, and **gitignored** — do not commit it.

Build or refresh it with:

```
graphify update .
```

Rules:
- IF `graphify-out/GRAPH_REPORT.md` EXISTS, read it before reading any source files, running grep/glob searches, or answering codebase questions. The graph is your primary map of the codebase.
- IF `graphify-out/wiki/index.md` EXISTS, navigate it instead of reading raw files.
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
