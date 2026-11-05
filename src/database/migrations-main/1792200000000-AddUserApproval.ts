import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `users.approvedAt` on the **main** connection: when an admin approved the account (see
 * user.entity.ts). Existing users keep their access: every admin-created user (no payment link)
 * and every sign-up that had already paid is backfilled as approved at its creation; a sign-up
 * still waiting for its payment stays unapproved and goes through approval after it pays.
 *
 * Idempotent like the rest of the chain: the column is probed before the ALTER, and the backfill
 * only touches rows the column is still NULL on.
 */
export class AddUserApproval1792200000000 implements MigrationInterface {
  name = 'AddUserApproval1792200000000';

  private async hasColumn(queryRunner: QueryRunner, table: string, name: string): Promise<boolean> {
    const rows = (await queryRunner.query(`PRAGMA table_info("${table}")`)) as Array<{ name: string }>;
    return rows.some(r => r.name === name);
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(queryRunner, 'users', 'approvedAt'))) {
      await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "approvedAt" datetime`);
    }
    await queryRunner.query(
      `UPDATE "users" SET "approvedAt" = "createdAt" ` +
        `WHERE "approvedAt" IS NULL AND ("paymentLinkId" IS NULL OR "isActive" = 1)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.hasColumn(queryRunner, 'users', 'approvedAt')) {
      await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "approvedAt"`);
    }
  }
}
