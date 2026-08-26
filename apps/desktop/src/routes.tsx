import { createMemoryRouter } from 'react-router';

import { HomePage } from '@/pages/home';

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
        {
          path: 'workflows',
          lazy: () => import('@/pages/workflows'),
        },
        {
          path: 'workflows/new',
          lazy: () => import('@/pages/workflows/new'),
        },
        {
          path: 'workflows/:id',
          lazy: () => import('@/pages/workflow'),
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
    initialEntries: ['/workflows'],
  },
);
