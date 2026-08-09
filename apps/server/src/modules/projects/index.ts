/**
 * The projects module's public surface. Module 1.5 mounts the file routes
 * underneath these, and module 6.6 will add /:id/run.
 */

export { projectsRouter } from './routes.js';
export type { MemberSummary, ProjectSummary } from './service.js';
