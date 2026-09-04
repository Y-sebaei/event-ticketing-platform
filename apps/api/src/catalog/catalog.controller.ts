import { Body, Controller, Get, Param, Post, Query, UsePipes } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod.pipe';
import { SearchService, searchQuerySchema, type SearchQuery } from '../search/search.service';
import { CatalogService } from './catalog.service';
import { createEventSchema, type CreateEventInput } from './catalog.dto';

@Controller('events')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly search: SearchService,
  ) {}

  /**
   * Browse and search are one endpoint. The frontend does not need to know
   * whether a request was answered by Elasticsearch or by Postgres, and making
   * it two endpoints would mean the browse page silently keeps working while
   * search is broken — the exact bug you want to notice.
   */
  @Get()
  @UsePipes(new ZodValidationPipe(searchQuerySchema))
  async list(@Query() query: SearchQuery) {
    return this.search.search(query);
  }

  @Get(':slug')
  async detail(@Param('slug') slug: string) {
    return this.catalog.getEventBySlug(slug);
  }

  /**
   * Event creation. Used by the seed script and by the end-to-end tests; there
   * is no admin portal, which was a deliberate scope decision.
   */
  @Post()
  @UsePipes(new ZodValidationPipe(createEventSchema))
  async create(@Body() body: CreateEventInput) {
    return this.catalog.createEvent(body);
  }
}
