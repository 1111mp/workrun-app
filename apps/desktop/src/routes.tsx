import { createMemoryRouter } from 'react-router';

import { HomePage } from '@/pages/home';
import {
  NewWorkflowRoute,
  WorkflowRoute,
} from '@/pages/workflow/workflow-route';

export const router = createMemoryRouter(
  [
    {
      path: '/login',
      lazy: () => import('@/pages/login'),
    },
    {
      path: '/',
      Component: HomePage,
      children: [
        { path: 'start', lazy: () => import('@/pages/start') },
        {
          path: 'workflows',
          lazy: () => import('@/pages/workflows'),
        },
        {
          path: 'workflows/new',
          Component: NewWorkflowRoute,
        },
        {
          path: 'workflows/:id',
          Component: WorkflowRoute,
        },
        {
          path: 'apps',
          lazy: () => import('@/pages/apps'),
        },
        {
          path: 'apps/new',
          lazy: () => import('@/pages/apps/new'),
        },
        {
          path: 'apps/:id',
          lazy: () => import('@/pages/apps/detail'),
        },
        {
          path: 'runs',
          lazy: () => import('@/pages/runs'),
        },
        {
          path: 'skills',
          lazy: () => import('@/pages/skills'),
        },
        {
          path: 'settings',
          lazy: () => import('@/pages/settings'),
        },
        {
          path: 'profile',
          lazy: () => import('@/pages/profile'),
        },
        {
          path: 'mcp-servers',
          lazy: () => import('@/pages/mcp-servers'),
        },
      ],
    },
    // fallback
    {
      path: '*',
      lazy: () => import('@/pages/not-found'),
    },
  ],
  {
    initialEntries: ['/start'],
  },
);
