import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `sessions.ownerUserId`: the dashboard user whose login key created the session, which a
 * non-admin user's login key is scoped to (see session.entity.ts and AuthService.applyOwnerScope).
 * NULL on every existing row: those stay visible to admins and API keys only.
 *
 * Hand-authored because `synchronize` is off for the data connection on PostgreSQL (and optional on
 * SQLite). The index name matches the entity's @Index so both schema paths converge. Idempotent:
 * the column is probed and the index uses IF NOT EXISTS (both dialects).
 */
export class AddSessionOwner1792400000000 implements MigrationInterface {
  name = 'AddSessionOwner1792400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('sessions', 'ownerUserId'))) {
      await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "ownerUserId" varchar(36)`);
    }
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sessions_ownerUserId" ON "sessions" ("ownerUserId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sessions_ownerUserId"`);
    if (await queryRunner.hasColumn('sessions', 'ownerUserId')) {
      await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "ownerUserId"`);
    }
  }
}
