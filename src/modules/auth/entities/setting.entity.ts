import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * A named setting an admin changes at runtime, stored as JSON text on the **main** (always-SQLite)
 * connection. The first key is `signup.plan` (signup-plan.service.ts); a row is read through its
 * service, which supplies the default when the row is absent.
 */
@Entity('settings')
export class Setting {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  key!: string;

  @Column({ type: 'text' })
  value!: string;

  @UpdateDateColumn()
  updatedAt!: Date;
}
