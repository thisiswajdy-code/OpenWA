import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the password-reset columns on `users` (**main** connection): the hash of the code emailed
 * to the user, its expiry and the wrong-code count (see password-reset.service.ts). NULL / 0 on
 * every existing row, so no backfill. Idempotent like the rest of the chain.
 */
export class AddUserPasswordReset1792300000000 implements MigrationInterface {
  name = 'AddUserPasswordReset1792300000000';

  private async hasColumn(queryRunner: QueryRunner, table: string, name: string): Promise<boolean> {
    const rows = (await queryRunner.query(`PRAGMA table_info("${table}")`)) as Array<{ name: string }>;
    return rows.some(r => r.name === name);
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(queryRunner, 'users', 'resetCodeHash'))) {
      await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "resetCodeHash" varchar(255)`);
    }
    if (!(await this.hasColumn(queryRunner, 'users', 'resetCodeExpiresAt'))) {
      await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "resetCodeExpiresAt" datetime`);
    }
    if (!(await this.hasColumn(queryRunner, 'users', 'resetAttempts'))) {
      await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "resetAttempts" integer NOT NULL DEFAULT (0)`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const column of ['resetAttempts', 'resetCodeExpiresAt', 'resetCodeHash']) {
      if (await this.hasColumn(queryRunner, 'users', column)) {
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "${column}"`);
      }
    }
  }
}
