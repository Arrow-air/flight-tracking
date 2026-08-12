import { createRouter, createWebHistory } from 'vue-router';
// Design-system styles are loaded here so every route gets them.
import './styles/index.css';
import { auth, initAuth, isAdmin } from './lib/auth';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./pages/FleetList.vue') },
    {
      path: '/login',
      component: () => import('./pages/Login.vue'),
      meta: { public: true },
    },
    { path: '/aircraft/new', component: () => import('./pages/AircraftNew.vue') },
    { path: '/aircraft/:id', component: () => import('./pages/AircraftDetail.vue') },
    { path: '/sites', component: () => import('./pages/Sites.vue') },
    { path: '/flights', component: () => import('./pages/Flights.vue') },
    { path: '/flights/new', component: () => import('./pages/QuickLog.vue') },
    { path: '/flights/:id', component: () => import('./pages/FlightCard.vue') },
    { path: '/flights/:id/params', component: () => import('./pages/FlightParams.vue') },
    { path: '/upload', component: () => import('./pages/BulkUpload.vue') },
    { path: '/logs', component: () => import('./pages/LogStatus.vue') },
    { path: '/profile', component: () => import('./pages/Profile.vue') },
    {
      path: '/admin',
      component: () => import('./pages/Admin.vue'),
      meta: { adminOnly: true },
    },
    {
      path: '/styleguide',
      component: () => import('./pages/Styleguide.vue'),
      meta: { public: true },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach(async (to) => {
  await initAuth();
  if (!to.meta.public && !auth.session) {
    return { path: '/login', query: { redirect: to.fullPath } };
  }
  if (to.path === '/login' && auth.session) {
    return { path: '/' };
  }
  // Client-side gate for admin routes (RLS is the server-side gate; this only
  // keeps non-admins from landing on a page whose every query would 403).
  if (to.meta.adminOnly && !isAdmin.value) {
    return { path: '/' };
  }
  return true;
});
