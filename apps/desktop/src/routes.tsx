import { createMemoryRouter } from 'react-router';

import { HomePage } from '@/pages/home';

export const router = createMemoryRouter(
  [
    {
      path: '/',
      Component: HomePage,
      children: [
        {
          path: 'workflow',
          lazy: () => import('@/pages/workflow'),
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
    initialEntries: ['/workflow'],
  },
);
