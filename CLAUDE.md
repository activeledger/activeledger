## Token Efficiency Rules
- Never read or print whole files if editing a specific function; use line-range edits.
- Run targeted unit tests instead of full monorepo test suites during development loops.
- Pipe long shell commands through tail (e.g., `pnpm build | tail -n 20`).
- Summarize task completion in under 3 sentences before exiting a loop.