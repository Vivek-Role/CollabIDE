/**
 * Shared contracts between apps/server, apps/runner and apps/web.
 *
 * Nothing here may import from any app — this package is the one-way
 * dependency that lets server and runner share types without importing
 * each other.
 *
 * Filled in by later modules:
 *   3.1  protocol.ts   — WS message kinds, doc id format
 *   6.1  languages.ts  — LANGUAGES registry
 */

export const SHARED_PACKAGE_VERSION = '0.1.0';
