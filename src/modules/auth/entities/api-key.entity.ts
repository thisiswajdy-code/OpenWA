import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export enum ApiKeyRole {
  ADMIN = 'admin',
  OPERATOR = 'operator',
  VIEWER = 'viewer',
}

@Entity('api_keys')
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  keyHash!: string;

  // 12 to fit the 12-char prefix that auth.service writes (was varchar(8); harmless on the
  // hardcoded-SQLite `main` connection, but kept consistent with the code).
  @Column({ type: 'varchar', length: 12 })
  keyPrefix!: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: ApiKeyRole.OPERATOR,
  })
  role!: ApiKeyRole;

  @Column({ type: 'simple-array', nullable: true })
  allowedIps!: string[] | null;

  @Column({ type: 'simple-array', nullable: true })
  allowedSessions!: string[] | null;

  // Chat-level allowlist, independent of allowedSessions and the same fail-open semantic: NULL or
  // empty means "every chat". Entries are WhatsApp chat ids (a group `<id>@g.us`, a contact
  // `<phone>@c.us` / `<lid>@lid`, or a bare phone number). Enforced on the read surface and on
  // sends; see src/common/security/chat-scope.ts.
  @Column({ type: 'simple-array', nullable: true })
  allowedChats!: string[] | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'datetime', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'datetime', nullable: true })
  lastUsedAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  usageCount!: number;

  // The dashboard user a password sign-in minted this key for (see user.entity.ts), or NULL for a key
  // created through the API or seeded at boot. A key with an owner is a login session: hidden from
  // the key list, never a usable admin for the last-admin guard, deleted on logout or with its user.
  @Column({ type: 'varchar', length: 36, nullable: true })
  userId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  /**
   * Not a column. Set by AuthService.applyOwnerScope on the login key of a non-admin dashboard user:
   * `allowedSessions` was replaced, for this request, by the sessions that user owns. The guard lets
   * such a key through the @RequireUnscopedKey fence only where the handler is marked
   * @AllowOwnerScoped (creating a session, logout, me), so a tenant can add a session without being
   * able to reach the credential-minting surfaces a session-scoped API key is fenced off.
   */
  ownerScoped?: boolean;
}
