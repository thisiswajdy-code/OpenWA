import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { ApiKeyRole } from './api-key.entity';

/**
 * A dashboard user: an email and password that sign in to the dashboard without pasting an API key.
 *
 * A user is not a credential the API accepts. Signing in exchanges the password for a short-lived
 * API key owned by the user (`api_keys.userId`), with the user's role and no session or chat scope,
 * so every surface that authenticates a key (the HTTP guard, the WebSocket handshake, the audit
 * trail) works unchanged. Lives on the **main** (always-SQLite) connection, next to `api_keys`.
 */
@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Named explicitly so the migrations-main chain creates the index TypeORM expects, instead of the
  // hashed name synchronize would generate (which the drift gate would then report).
  @Index('IDX_users_email', { unique: true })
  @Column({ type: 'varchar', length: 254 })
  email!: string;

  // Self-describing scrypt string; see password-hash.ts.
  @Column({ type: 'varchar', length: 255 })
  passwordHash!: string;

  @Column({ type: 'varchar', length: 20, default: ApiKeyRole.OPERATOR })
  role!: ApiKeyRole;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'datetime', nullable: true })
  lastLoginAt!: Date | null;

  // The recurring payment link a self-service sign-up created for the user; NULL for admin-created users.
  @Column({ type: 'varchar', length: 64, nullable: true })
  paymentLinkId!: string | null;

  // When an admin approved the account. A user an admin creates (or the boot seeds) is approved at
  // once; a self-service sign-up is not, and its login key is refused everywhere but the routes
  // marked @AllowPendingApproval until an admin approves it (POST /api/auth/users/:id/approve).
  @Column({ type: 'datetime', nullable: true })
  approvedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
