/**
 * Shared contracts between apps/server, apps/runner and apps/web.
 *
 * Nothing here may import from any app — this package is the one-way
 * dependency that lets server and runner share types without importing
 * each other.
 */

export * from './protocol.js';
export * from './languages.js';

export const SHARED_PACKAGE_VERSION = '0.1.0';
