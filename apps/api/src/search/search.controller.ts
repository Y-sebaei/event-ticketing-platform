import { Controller, Get } from '@nestjs/common';
import { SearchService } from './search.service';

@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  /** Powers the city filter on the browse page. */
  @Get('cities')
  cities() {
    return this.search.cities();
  }
}
