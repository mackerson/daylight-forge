# ADR 0014: One command catalog, three doors (CLI, MCP, Tauri)

Status: Accepted (KitKraft precedent). Date: 2026-10-19.

## Decision
`olc_engine::catalog()` is the only place user-visible actions are defined. `olc <cmd>`
(with `--json`), the MCP `execute` tool, and the Tauri shell call the same `execute`. Front
ends never contain logic another front end lacks. Launchers (`olc ui`, `olc mcp`) and setup
(`olc install`) are plain subcommands off the catalog so a connected agent cannot rewrite the
PATH or its own registration. MCP is first-class from M0 because it is how the factory drives
`gen.*`, `validate` and `pack.*`.
