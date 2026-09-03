/**
 * Hand-written mirrors of the server's REST payloads.
 *
 * These deliberately do NOT live in @collab/shared. That package exists for the
 * contracts both apps compile against — the WS protocol (module 3.1) and the
 * language registry (6.1). Promoting these there today would mean editing
 * apps/server for no functional gain, and Phase 2 changes no server line.
 *
 * The trade-off is real: these can drift from the server. Every interface below
 * names the file it mirrors so a grep finds both sides, and module 3.1 is the
 * designated place to converge them.
 *
 * One rule that is easy to get wrong: dates arrive as ISO **strings** over JSON,
 * not Date objects. Typing them as Date compiles and then fails at runtime the
 * first time anything calls a Date method on them.
 */

export type Role = 'OWNER' | 'EDITOR' | 'VIEWER';

/** mirrors apps/server/src/modules/auth/routes.ts — PublicUser */
export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

/** mirrors apps/server/src/modules/projects/service.ts — ProjectSummary */
export interface Project {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

/** mirrors apps/server/src/modules/projects/service.ts — MemberSummary */
export interface Member {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
}

/** mirrors apps/server/src/modules/files/service.ts — FileRecord */
export interface FileRecord {
  id: string;
  path: string;
  isDir: boolean;
  createdAt: string;
  updatedAt: string;
}

/** mirrors apps/server/src/modules/files/service.ts — TreeNode.
 *  The server returns this already nested and already sorted (directories
 *  first, then alphabetical), so the client renders it as-is. */
export interface TreeNode extends FileRecord {
  name: string;
  children: TreeNode[];
}

export interface FileWithContent extends FileRecord {
  content: string;
}

/**
 * Response envelopes.
 *
 * Every route wraps its payload, and the wrappers are not uniform — {user},
 * {projects}, {tree}, {file}, {deleted}. Rather than hide that behind a generic
 * unwrapper that would need a key argument at every call site anyway, the
 * envelopes are typed here and destructured by the caller. The *error* envelope
 * is the one that is genuinely uniform, and api.ts unwraps that in one place.
 */
export interface UserResponse {
  user: User;
}

export interface ProjectListResponse {
  projects: Array<Project & { role: Role }>;
}

export interface ProjectResponse {
  project: Project & { role?: Role };
}

export interface ProjectDetailResponse {
  project: Project;
  members: Member[];
  role: Role;
}

export interface MemberResponse {
  member: Member;
}

export interface TreeResponse {
  tree: TreeNode[];
}

export interface FileResponse {
  file: FileRecord;
}

export interface FileContentResponse {
  file: FileWithContent;
}

export interface DeleteResponse {
  deleted: number;
}
