import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { TICKETING_INVENTORY_V1_PACKAGE_NAME } from './generated/inventory';

export const INVENTORY_PACKAGE = TICKETING_INVENTORY_V1_PACKAGE_NAME;

/**
 * Resolves the .proto next to the compiled output first (Docker) and falls back
 * to the source tree (local `tsx` runs), so both paths work without a
 * conditional in every service's bootstrap.
 */
export function inventoryProtoPath(): string {
  const candidates = [
    join(__dirname, 'proto', 'inventory.proto'),
    join(__dirname, '..', 'proto', 'inventory.proto'),
    join(__dirname, '..', '..', 'proto', 'inventory.proto'),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(`inventory.proto not found. Looked in:\n  ${candidates.join('\n  ')}`);
  }
  return found;
}

export const GRPC_LOADER_OPTIONS = {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
} as const;
