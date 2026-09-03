import { useCallback, useEffect, useState } from 'react';

import { api } from '../../lib/api';
import type { Project, ProjectListResponse, ProjectResponse, Role } from '../../lib/types';
import { toProjectMessage } from './errors';

/**
 * The project list, and the two mutations that change it.
 *
 * Mutations refetch rather than patching local state. With no cache library
 * that is one extra request on an action a user takes a few times a minute, and
 * it makes a stale list impossible — which is the failure mode that actually
 * costs time to debug. Optimistic updates are not worth their bug surface here.
 *
 * Mutations let their errors throw. The caller is a dialog with somewhere to
 * show them; swallowing them here would leave a form that silently does nothing.
 */

export type ProjectListItem = Project & { role: Role };

export function useProjects() {
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await api.get<ProjectListResponse>('/projects');
      setProjects(response.projects);
    } catch (caught) {
      setError(toProjectMessage(caught));
      setProjects(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createProject = useCallback(
    async (name: string) => {
      await api.post<ProjectResponse>('/projects', { name });
      await refresh();
    },
    [refresh],
  );

  const deleteProject = useCallback(
    async (projectId: string) => {
      await api.delete<void>(`/projects/${projectId}`);
      await refresh();
    },
    [refresh],
  );

  return { projects, loading, error, refresh, createProject, deleteProject };
}
