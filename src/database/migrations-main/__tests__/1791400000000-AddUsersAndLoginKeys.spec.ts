import { DataSource } from 'typeorm';
import { CreateAuthAuditTables1779900000000 } from '../1779900000000-CreateAuthAuditTables';
import { AddApiKeyAllowedChats1786600000000 } from '../1786600000000-AddApiKeyAllowedChats';
import { AddUsersAndLoginKeys1791400000000 } from '../1791400000000-AddUsersAndLoginKeys';

/**
 * The main-connection migration must create `users` and add `api_keys.userId`, so a deploy with
 * `MAIN_DATABASE_SYNCHRONIZE=false` (the default) can sign a dashboard user in.
 */
describe('AddUsersAndLoginKeys migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const columns = async (table: string): Promise<string[]> => {
    const qr = ds.createQueryRunner();
    const rows = (await qr.query(`PRAGMA table_info("${table}")`)) as Array<{ name: string }>;
    await qr.release();
    return rows.map(r => r.name);
  };

  const indexes = async (table: string): Promise<string[]> => {
    const qr = ds.createQueryRunner();
    const rows = (await qr.query(`PRAGMA index_list("${table}")`)) as Array<{ name: string; unique: number }>;
    await qr.release();
    return rows.filter(r => r.unique === 1).map(r => r.name);
  };

  const priorChain = async (): Promise<void> => {
    const qr = ds.createQueryRunner();
    await new CreateAuthAuditTables1779900000000().up(qr);
    await new AddApiKeyAllowedChats1786600000000().up(qr);
    await qr.release();
  };

  it('creates users with a unique email index and adds the nullable api_keys.userId column', async () => {
    await priorChain();
    expect(await columns('users')).toEqual([]);
    expect(await columns('api_keys')).not.toContain('userId');

    const qr = ds.createQueryRunner();
    await new AddUsersAndLoginKeys1791400000000().up(qr);
    expect(await columns('users')).toEqual(
      expect.arrayContaining([
        'id',
        'email',
        'passwordHash',
        'role',
        'isActive',
        'lastLoginAt',
        'createdAt',
        'updatedAt',
      ]),
    );
    expect(await indexes('users')).toContain('IDX_users_email');
    expect(await columns('api_keys')).toContain('userId');

    await qr.query("INSERT INTO api_keys (id, name, keyHash, keyPrefix) VALUES ('1', 'k', 'hash', 'pref')");
    const rows = (await qr.query("SELECT userId FROM api_keys WHERE id = '1'")) as Array<{ userId: string | null }>;
    expect(rows[0].userId).toBeNull();

    await qr.query("INSERT INTO users (id, email, passwordHash) VALUES ('u1', 'a@example.com', 'h')");
    await expect(
      qr.query("INSERT INTO users (id, email, passwordHash) VALUES ('u2', 'a@example.com', 'h')"),
    ).rejects.toThrow();
    await qr.release();
  });

  it('is idempotent', async () => {
    await priorChain();
    const qr = ds.createQueryRunner();
    const migration = new AddUsersAndLoginKeys1791400000000();
    await migration.up(qr);
    await expect(migration.up(qr)).resolves.not.toThrow();
    expect((await columns('api_keys')).filter(c => c === 'userId')).toHaveLength(1);
    await qr.release();
  });

  it('down() drops the users table and the column, deleting the login keys the column owned', async () => {
    await priorChain();
    const qr = ds.createQueryRunner();
    const migration = new AddUsersAndLoginKeys1791400000000();
    await migration.up(qr);
    await qr.query(
      "INSERT INTO api_keys (id, name, keyHash, keyPrefix, userId) VALUES ('login', 'k', 'h1', 'p', 'u1')",
    );
    await qr.query("INSERT INTO api_keys (id, name, keyHash, keyPrefix) VALUES ('plain', 'k', 'h2', 'p')");
    await migration.down(qr);
    expect(await columns('users')).toEqual([]);
    expect(await columns('api_keys')).not.toContain('userId');
    const ids = (await qr.query('SELECT id FROM api_keys')) as Array<{ id: string }>;
    expect(ids.map(r => r.id)).toEqual(['plain']);
    await qr.release();
  });
});
