import { useCallback, useEffect, useState } from 'react';

import { api } from '../../lib/api';
import type { Member, Project, ProjectDetailResponse, Role } from '../../lib/types';
import { toProjectMessage } from './errors';

/**
 * One project and everything about it.
 *
 * Named for members because that is what it mostly does, but it loads the whole
 * detail response: GET /api/projects/:id returns { project, members, role } in a
 * single request, so splitting it into two hooks would mean two requests for
 * data the server already sends together.
 *
 * `role` is the caller's own role on this project, and it is what the UI uses to
 * decide which controls to render. That is presentation only — every one of
 * these routes is guarded by requireProjectRole on the server, so hiding a
 * button is a courtesy, not the boundary.
 */
export function useProjectDetail(projectId: string) {
  const [project, setProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [role, setRole] = useState<Role | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await api.get<ProjectDetailResponse>(`/projects/${projectId}`);
      setProject(response.project);
      setMembers(response.members);
      setRole(response.role);
    } catch (caught) {
      setError(toProjectMessage(caught));
      setProject(null);
      setMembers([]);
      setRole(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const invite = useCallback(
    async (email: string, memberRole: Role) => {
      await api.post(`/projects/${projectId}/members`, { email, role: memberRole });
      await refresh();
    },
    [projectId, refresh],
  );

  const changeRole = useCallback(
    async (userId: string, memberRole: Role) => {
      await api.patch(`/projects/${projectId}/members/${userId}`, { role: memberRole });
      await refresh();
    },
    [projectId, refresh],
  );

  const removeMember = useCallback(
    async (userId: string) => {
      await api.delete<void>(`/projects/${projectId}/members/${userId}`);
      await refresh();
    },
    [projectId, refresh],
  );

  /**
   * PATCH /projects/:id returns { project } with **no role field**, unlike every
   * other project response. Rather than reconstruct a partial object from it,
   * this refetches the detail endpoint — one request to stay honest about a
   * response shape that is the odd one out.
   */
  const rename = useCallback(
    async (name: string) => {
      await api.patch(`/projects/${projectId}`, { name });
      await refresh();
    },
    [projectId, refresh],
  );

  return { project, members, role, loading, error, refresh, invite, changeRole, removeMember, rename };
}
