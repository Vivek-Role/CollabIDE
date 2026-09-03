/**
 * The persistence module's public surface. Cross-module imports go through this
 * barrel only.
 *
 * Module 4.3 is the first caller, and it imports `docStore` — never
 * `postgresDocStore` — so the backing store is swappable at the one line below.
 * This module imports nothing from `modules/collab`: persistence takes a doc id
 * and bytes, never a Room, so the dependency runs one way, collab -> persistence.
 */

import type { DocStore } from './DocStore.js';
import { postgresDocStore } from './postgresDocStore.js';

export type { DocStore, LoadedDoc } from './DocStore.js';
export { attachPersistence, type AttachOptions, type DocPersistence } from './buffer.js';
export { materializeContent } from './materialize.js';
export { postgresDocStore } from './postgresDocStore.js';

/** The selection point: the one line that changes if the store is ever swapped. */
export const docStore: DocStore = postgresDocStore;
