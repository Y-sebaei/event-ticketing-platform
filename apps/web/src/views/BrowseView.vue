<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { api, type SearchResponse } from '../lib/api';
import { formatDate, formatMoney } from '../lib/format';

const query = ref('');
const city = ref('');
const maxPrice = ref('');
const sort = ref<'relevance' | 'date' | 'price'>('relevance');
const page = ref(1);

const cities = ref<string[]>([]);
const results = ref<SearchResponse | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

let debounce: ReturnType<typeof setTimeout> | undefined;

async function load() {
  loading.value = true;
  error.value = null;
  try {
    results.value = await api.search({
      q: query.value || undefined,
      city: city.value || undefined,
      maxPriceCents: maxPrice.value ? Number(maxPrice.value) * 100 : undefined,
      sort: sort.value,
      page: page.value,
      pageSize: 12,
    });
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

// Debounced so typing does not fire a request per keystroke; filters apply at
// once because a dropdown change is a deliberate act, not a work in progress.
watch(query, () => {
  page.value = 1;
  clearTimeout(debounce);
  debounce = setTimeout(load, 250);
});
watch([city, maxPrice, sort], () => {
  page.value = 1;
  void load();
});
watch(page, load);

onMounted(async () => {
  await load();
  cities.value = await api.cities().catch(() => []);
});
</script>

<template>
  <div class="filters">
    <input v-model="query" type="search" placeholder="Search events, artists, venues…" aria-label="Search" />
    <select v-model="city" aria-label="City">
      <option value="">All cities</option>
      <option v-for="c in cities" :key="c" :value="c">{{ c }}</option>
    </select>
    <input v-model="maxPrice" type="number" min="0" placeholder="Max price (€)" aria-label="Maximum price" />
    <select v-model="sort" aria-label="Sort by">
      <option value="relevance">Most relevant</option>
      <option value="date">Soonest first</option>
      <option value="price">Cheapest first</option>
    </select>
  </div>

  <p v-if="error" class="error">{{ error }}</p>

  <p v-if="results" class="muted small" data-testid="result-summary">
    {{ results.total }} event<span v-if="results.total !== 1">s</span>
    <span v-if="results.source === 'database'" class="badge warn" style="margin-left: 8px">
      search degraded — showing database results
    </span>
  </p>

  <div v-if="loading && !results" class="muted">Loading…</div>

  <div class="grid" data-testid="event-grid">
    <RouterLink
      v-for="event in results?.items ?? []"
      :key="event.eventId"
      class="card"
      :to="`/events/${event.slug}`"
      data-testid="event-card"
    >
      <div class="badge">{{ event.city }}</div>
      <h3 style="margin: 10px 0 4px">{{ event.title }}</h3>
      <p class="muted small" style="margin: 0">{{ event.venueName }} · {{ formatDate(event.startsAt) }}</p>
      <p style="margin: 12px 0 0">
        from <strong>{{ formatMoney(event.minPriceCents, event.currency) }}</strong>
      </p>
    </RouterLink>
  </div>

  <p v-if="results && results.items.length === 0" class="muted" data-testid="no-results">
    Nothing matches that. Try a broader search.
  </p>

  <div v-if="results && results.totalPages > 1" class="row" style="margin-top: 28px">
    <button class="ghost" :disabled="page <= 1" @click="page--">Previous</button>
    <span class="muted small">Page {{ results.page }} of {{ results.totalPages }}</span>
    <button class="ghost" :disabled="page >= results.totalPages" @click="page++">Next</button>
  </div>
</template>
