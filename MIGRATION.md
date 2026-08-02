# Backend Extraction Plan

This repository is the future source of truth for Duelcade's authoritative
multiplayer runtime.

## Current phase

- The Colyseus server, shared game engine, protocol types, and server tests have
  been copied from the mobile repository.
- The mobile repository keeps its existing server copy temporarily so the app
  remains buildable while deployment and client configuration are migrated.
- Changes to authoritative multiplayer behavior should be made here first and
  mirrored to the mobile repository only while this transition is active.

## Exit criteria for removing the mobile copy

1. Deploy this backend to a TLS-enabled staging environment.
2. Point development and preview mobile builds at the staging WebSocket URL.
3. Publish the shared wire protocol as a versioned package, or generate the
   client types from a versioned schema.
4. Run both repositories' typechecks and integration tests against the same
   protocol version.
5. Add compatibility handling for clients that are one supported app version
   behind.
6. Remove the mobile repository's `server/` directory and duplicated
   authoritative engine code only after the staged Android build passes
   multiplayer smoke tests.

## Deployment gates

- HTTPS/WSS only outside local development.
- Secrets supplied by the deployment platform, never committed.
- Health checks enabled on `/health`.
- Structured logs, crash reporting, rate limiting, and connection metrics
  configured before production traffic.
- Dependency audit run in CI, where sending the dependency manifest to the
  selected vulnerability service is explicitly authorized.
