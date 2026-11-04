import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds dashboard users (email + password sign-in) on the **main** connection:
 *
 * - a `users` table, with a unique index on `email`, named as the entity names it so the drift gate
 *   sees no difference between the chain and `synchronize`;
 * - `api_keys.userId`, the owner of a key minted by a password sign-in. NULL on every key created
 *   through `POST /api/auth/api-keys` or seeded at boot, so existing rows need no backfill. A key
 *   with a userId is a login session: it is hidden from the key list, never counts as a usable admin
 *   for the last-admin guard, and is deleted on logout or when its user is removed.
 *
 * Idempotent, like the rest of the chain: the table uses IF NOT EXISTS and the column is probed
 * before the ALTER, so a run interrupted after the DDL still completes.
 */
export class AddUsersAndLoginKeys1791400000000 implements MigrationInterface {
  name = 'AddUsersAndLoginKeys1791400000000';

  private async hasColumn(queryRunner: QueryRunner, table: string, name: string): Promise<boolean> {
    const rows = (await queryRunner.query(`PRAGMA table_info("${table}")`)) as Array<{ name: string }>;
    return rows.some(r => r.name === name);
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "users" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"email" varchar(254) NOT NULL, ` +
        `"passwordHash" varchar(255) NOT NULL, ` +
        `"role" varchar(20) NOT NULL DEFAULT ('operator'), ` +
        `"isActive" boolean NOT NULL DEFAULT (1), ` +
        `"lastLoginAt" datetime, ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_users_email" ON "users" ("email")`);
    if (!(await this.hasColumn(queryRunner, 'api_keys', 'userId'))) {
      await queryRunner.query(`ALTER TABLE "api_keys" ADD COLUMN "userId" varchar(36)`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.hasColumn(queryRunner, 'api_keys', 'userId')) {
      // The keys the column owned are login sessions; without their owner they must not outlive it.
      await queryRunner.query(`DELETE FROM "api_keys" WHERE "userId" IS NOT NULL`);
      await queryRunner.query(`ALTER TABLE "api_keys" DROP COLUMN "userId"`);
    }
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_email"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
  }
}
