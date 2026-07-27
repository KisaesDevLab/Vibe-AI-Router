/**
 * Migration runner. Migrations are ordered directories under db/migrations/, each containing
 * `up.sql` and `down.sql`. Reversibility is a phase-gate requirement (Phase 1.16: up → down → up
 * in CI), which drizzle-kit's forward-only output cannot satisfy — hence this runner (Q-001).
 *
 * Usage: tsx db/migrate.ts up | down [steps=1] | status
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface MigrationInfo {
  name: string;
  applied: boolean;
}

async function listMigrationDirs(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export async function migrate(
  databaseUrl: string,
  direction: 'up' | 'down',
  steps: number = direction === 'up' ? Infinity : 1,
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const ran: string[] = [];
  try {
    await sql`CREATE TABLE IF NOT EXISTS _migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    const appliedRows = await sql<{ name: string }[]>`SELECT name FROM _migrations ORDER BY name`;
    const applied = new Set(appliedRows.map((r) => r.name));
    const all = await listMigrationDirs();

    const targets =
      direction === 'up'
        ? all.filter((n) => !applied.has(n)).slice(0, steps === Infinity ? undefined : steps)
        : all
            .filter((n) => applied.has(n))
            .reverse()
            .slice(0, steps === Infinity ? undefined : steps);

    for (const name of targets) {
      const file = join(MIGRATIONS_DIR, name, direction === 'up' ? 'up.sql' : 'down.sql');
      const body = await readFile(file, 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        if (direction === 'up') {
          await tx`INSERT INTO _migrations (name) VALUES (${name})`;
        } else {
          await tx`DELETE FROM _migrations WHERE name = ${name}`;
        }
      });
      log(`${direction}: ${name}`);
      ran.push(name);
    }
    return ran;
  } finally {
    await sql.end();
  }
}

export async function status(databaseUrl: string): Promise<MigrationInfo[]> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await sql`CREATE TABLE IF NOT EXISTS _migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    const appliedRows = await sql<{ name: string }[]>`SELECT name FROM _migrations`;
    const applied = new Set(appliedRows.map((r) => r.name));
    return (await listMigrationDirs()).map((name) => ({ name, applied: applied.has(name) }));
  } finally {
    await sql.end();
  }
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('migrate.ts') || entry.endsWith('migrate.js')) {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    process.stderr.write('DATABASE_URL is required\n');
    process.exit(1);
  }
  const cmd = process.argv[2] ?? 'up';
  const write = (m: string): void => void process.stdout.write(m + '\n');
  if (cmd === 'status') {
    const rows = await status(url);
    for (const r of rows) write(`${r.applied ? '[x]' : '[ ]'} ${r.name}`);
  } else if (cmd === 'up' || cmd === 'down') {
    const steps = process.argv[3] ? Number(process.argv[3]) : undefined;
    const ran = await migrate(url, cmd, cmd === 'up' ? (steps ?? Infinity) : (steps ?? 1), write);
    write(ran.length ? `${ran.length} migration(s) ${cmd}` : 'nothing to do');
  } else {
    process.stderr.write(`unknown command: ${cmd}\n`);
    process.exit(1);
  }
}
