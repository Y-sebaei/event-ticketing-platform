import { Module } from '@nestjs/common';
import { InventoryClient } from '../common/inventory.client';
import { SearchModule } from '../search/search.module';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

@Module({
  imports: [SearchModule],
  controllers: [CatalogController],
  providers: [CatalogService, InventoryClient],
  exports: [CatalogService, InventoryClient],
})
export class CatalogModule {}
