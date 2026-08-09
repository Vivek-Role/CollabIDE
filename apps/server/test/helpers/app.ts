import type { Express } from 'express';

import { buildApp } from '../../src/app.js';

/**
 * The app under test. Modules 1.2 onward build their fixtures (a registered
 * user, an authenticated agent, a project) on top of this.
 */
export function createTestApp(): Express {
  return buildApp();
}
