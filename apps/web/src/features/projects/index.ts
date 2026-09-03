/**
 * The projects feature's public surface. Nothing outside this folder imports
 * its files directly — same barrel rule the server modules follow.
 */
export { ProjectsPage } from './ProjectsPage';
export { MembersPanel } from './MembersPanel';
export { useProjects } from './useProjects';
export type { ProjectListItem } from './useProjects';
export { useProjectDetail } from './useMembers';
export { toProjectFormErrors, toProjectMessage } from './errors';
