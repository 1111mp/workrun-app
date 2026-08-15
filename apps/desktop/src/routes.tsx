import { createMemoryRouter, Navigate } from 'react-router';

import { HomePage } from '@/pages/home';

export const router = createMemoryRouter(
  [
    {
      path: '/',
      Component: HomePage,
      children: [
        {
          path: 'workflow',
          Component: () => <Navigate to='/workflows' replace />,
        },
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
