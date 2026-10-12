# CLAUDE.md

Use `AGENTS.md` as the primary instruction file for this repository.

- Main repo instructions: `AGENTS.md`
- Where things are: `APP_SCHEMA.md` (index) → `docs/schema/*.md` (detail, on demand)
- Why they are that way: `DECISIONS.md` (index) → `docs/decisions/*.md`; read the matching section before changing behaviour

When routes, shared components, data modules, or feature relationships change, update the matching `docs/schema/` file in the same change (the `APP_SCHEMA.md` index only for a new area). When a *rule* changes, update the matching `docs/decisions/` file instead — keep rationale out of the map.
