// The .proto ships with the compiled package because @grpc/proto-loader reads
// it at runtime. Forgetting this is the classic "works locally, empty service
// definition in Docker" failure.
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
await mkdir(join(here, 'dist', 'proto'), { recursive: true });
await cp(join(here, 'proto'), join(here, 'dist', 'proto'), { recursive: true });
console.log('[contracts] copied proto -> dist/proto');
