import { DataSource } from 'typeorm';
import { AddSessionOwner1792400000000 } from '../1792400000000-AddSessionOwner';

const INDEX = 'IDX_sessions_ownerUserId';

describe('AddSessionOwner migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
    // The sessions table as a deployment from before ownership has it, with a row in it.
    await ds.query(
      `CREATE TABLE "sessions" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar(100) NOT NULL, "status" varchar(50) NOT NULL DEFAULT ('created'))`,
    );
    await ds.query(`INSERT INTO "sessions" ("id", "name") VALUES ('s1', 'main')`);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const columns = async (): Promise<string[]> =>
    (await ds.query<{ name: string }[]>(`PRAGMA table_info("sessions")`)).map(r => r.name);
  const indexNames = async (): Promise<string[]> =>
    (await ds.query<{ name: string }[]>(`PRAGMA index_list("sessions")`)).map(r => r.name);

  it('adds a nullable ownerUserId with its index, leaving existing sessions unowned', async () => {
    await new AddSessionOwner1792400000000().up(ds.createQueryRunner());
    expect(await columns()).toContain('ownerUserId');
    expect(await indexNames()).toContain(INDEX);
    expect(await ds.query(`SELECT "ownerUserId" FROM "sessions" WHERE "id" = 's1'`)).toEqual([{ ownerUserId: null }]);
  });

  it('is idempotent, and down() removes the index and the column', async () => {
    const migration = new AddSessionOwner1792400000000();
    const runner = ds.createQueryRunner();
    await migration.up(runner);
    await expect(migration.up(runner)).resolves.toBeUndefined();
    expect((await columns()).filter(c => c === 'ownerUserId')).toHaveLength(1);

    await migration.down(runner);
    expect(await columns()).not.toContain('ownerUserId');
    expect(await indexNames()).not.toContain(INDEX);
  });
});
