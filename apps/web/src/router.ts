import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'browse', component: () => import('./views/BrowseView.vue') },
    { path: '/events/:slug', name: 'event', component: () => import('./views/EventView.vue') },
    // The built-in checkout page, used when no Stripe key is configured. With
    // Stripe configured, the API redirects to Stripe Checkout instead and this
    // route is never reached.
    { path: '/pay', name: 'pay', component: () => import('./views/PayView.vue') },
    { path: '/orders/:id', name: 'order', component: () => import('./views/OrderView.vue') },
  ],
  scrollBehavior: () => ({ top: 0 }),
});
