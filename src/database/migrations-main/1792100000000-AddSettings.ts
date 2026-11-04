import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `settings` table on the **main** connection: named values an admin changes at runtime,
 * stored as JSON text (the first is the sign-up plan, `signup.plan`). Idempotent like the rest of
 * the chain.
 */
export class AddSettings1792100000000 implements MigrationInterface {
  name = 'AddSettings1792100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "settings" (` +
        `"key" varchar(100) PRIMARY KEY NOT NULL, ` +
        `"value" text NOT NULL, ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "settings"`);
  }
}
