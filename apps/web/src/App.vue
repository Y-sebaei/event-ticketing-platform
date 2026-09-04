<script setup lang="ts"></script>

<template>
  <header class="site">
    <div class="inner">
      <RouterLink to="/" class="brand">Berlin Tickets</RouterLink>
      <span class="tag">events, venues and a great deal of telemetry</span>
    </div>
  </header>
  <main class="container">
    <RouterView />
  </main>
</template>
