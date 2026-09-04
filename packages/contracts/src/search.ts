/**
 * The Elasticsearch index contract, shared by its only writer (the worker) and
 * its only reader (the API). Keeping the mapping here rather than in either
 * service is what stops the two from disagreeing about a field type — the
 * classic way a search feature starts returning nothing after a deploy.
 */
export const EVENTS_INDEX = 'events-v1';

export interface EventDocument {
  eventId: string;
  slug: string;
  title: string;
  description: string;
  startsAt: string;
  status: 'draft' | 'published' | 'cancelled';
  currency: string;
  venueId: string;
  venueName: string;
  city: string;
  country: string;
  minPriceCents: number;
  maxPriceCents: number;
  indexedAt: string;
}

export const EVENTS_INDEX_MAPPING = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
    analysis: {
      analyzer: {
        // Berlin listings mix German and English titles in the same index, so
        // folding diacritics is not optional: a search for "buhne" has to match
        // "Bühne", and "Cafe" has to match "Café".
        event_text: {
          type: 'custom',
          tokenizer: 'standard',
          filter: ['lowercase', 'asciifolding'],
        },
      },
    },
  },
  mappings: {
    properties: {
      eventId: { type: 'keyword' },
      slug: { type: 'keyword' },
      title: {
        type: 'text',
        analyzer: 'event_text',
        // The keyword sub-field exists for exact-match and sorting; the text
        // field is what full-text search scores against.
        fields: { keyword: { type: 'keyword', ignore_above: 256 } },
      },
      description: { type: 'text', analyzer: 'event_text' },
      startsAt: { type: 'date' },
      status: { type: 'keyword' },
      currency: { type: 'keyword' },
      venueId: { type: 'keyword' },
      venueName: { type: 'text', analyzer: 'event_text', fields: { keyword: { type: 'keyword' } } },
      city: { type: 'keyword' },
      country: { type: 'keyword' },
      minPriceCents: { type: 'integer' },
      maxPriceCents: { type: 'integer' },
      indexedAt: { type: 'date' },
    },
  },
} as const;
