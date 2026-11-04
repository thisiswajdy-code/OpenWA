import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `users.paymentLinkId` on the **main** connection: the recurring payment link a self-service
 * sign-up created for the user (see signup.service.ts). NULL on every user an admin created or the
 * boot seeded, so existing rows need no backfill.
 *
 * Idempotent like the rest of the chain: the column is probed before the ALTER.
 */
export class AddUserPaymentLink1792000000000 implements MigrationInterface {
  name = 'AddUserPaymentLink1792000000000';

  private async hasColumn(queryRunner: QueryRunner, table: string, name: string): Promise<boolean> {
    const rows = (await queryRunner.query(`PRAGMA table_info("${table}")`)) as Array<{ name: string }>;
    return rows.some(r => r.name === name);
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(queryRunner, 'users', 'paymentLinkId'))) {
      await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "paymentLinkId" varchar(64)`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.hasColumn(queryRunner, 'users', 'paymentLinkId')) {
      await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "paymentLinkId"`);
    }
  }
}
