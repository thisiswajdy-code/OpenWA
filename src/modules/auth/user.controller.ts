import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { UserService } from './user.service';
import { CreateUserDto, UpdateUserDto, UserResponseDto } from './dto';
import { CurrentApiKey, RequireRole, RequireUnscopedKey } from './decorators/auth.decorators';
import { type ApiKey, ApiKeyRole } from './entities/api-key.entity';
import type { User } from './entities/user.entity';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';

/**
 * Dashboard user management. Fenced exactly like API-key management: a user signs in to a login key
 * with the user's role, so creating a user is minting a credential, which only an unscoped ADMIN
 * key may do.
 */
@ApiTags('auth')
@Controller('auth/users')
@RequireUnscopedKey()
@RequireRole(ApiKeyRole.ADMIN)
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly auditService: AuditService,
  ) {}

  private auditContext(req: Request, actor?: ApiKey) {
    return {
      apiKey: actor,
      ipAddress: (req as Request & { clientIp?: string }).clientIp ?? undefined,
      method: req.method,
      path: req.path,
    };
  }

  private toResponse(user: User): UserResponseDto {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      lastLoginAt: user.lastLoginAt ?? undefined,
      pendingApproval: user.approvedAt === null,
      approvedAt: user.approvedAt ?? undefined,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  @Post()
  @ApiOperation({ summary: 'Create a dashboard user (admin only)' })
  @ApiResponse({ status: 201, description: 'User created. The password is never returned.', type: UserResponseDto })
  @ApiResponse({ status: 400, description: 'Validation failed, or the body carries a field the DTO does not declare.' })
  @ApiResponse({ status: 409, description: 'A user with this email already exists.' })
  async create(
    @Body() dto: CreateUserDto,
    @Req() req: Request,
    @CurrentApiKey() actor?: ApiKey,
  ): Promise<UserResponseDto> {
    const user = await this.userService.create(dto);
    await this.auditService.logInfo(AuditAction.USER_CREATED, {
      ...this.auditContext(req, actor),
      metadata: { targetUserId: user.id, email: user.email, role: user.role },
    });
    return this.toResponse(user);
  }

  @Get()
  @ApiOperation({ summary: 'List dashboard users (admin only)' })
  @ApiResponse({ status: 200, description: 'All users, newest first.', type: [UserResponseDto] })
  async findAll(): Promise<UserResponseDto[]> {
    return (await this.userService.findAll()).map(user => this.toResponse(user));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a dashboard user (admin only)' })
  @ApiResponse({ status: 200, description: 'The user.', type: UserResponseDto })
  @ApiResponse({ status: 404, description: 'No user with this id.' })
  async findOne(@Param('id') id: string): Promise<UserResponseDto> {
    return this.toResponse(await this.userService.findOne(id));
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a dashboard user (admin only)' })
  @ApiResponse({ status: 200, description: 'The updated user.', type: UserResponseDto })
  @ApiResponse({ status: 400, description: 'Validation failed, or the body carries a field the DTO does not declare.' })
  @ApiResponse({ status: 404, description: 'No user with this id.' })
  @ApiResponse({ status: 409, description: 'Another user already has this email.' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @Req() req: Request,
    @CurrentApiKey() actor?: ApiKey,
  ): Promise<UserResponseDto> {
    const before = await this.userService.findOne(id);
    const user = await this.userService.update(id, dto);
    await this.auditService.logInfo(AuditAction.USER_UPDATED, {
      ...this.auditContext(req, actor),
      metadata: {
        targetUserId: user.id,
        before: { email: before.email, role: before.role, isActive: before.isActive },
        after: { email: user.email, role: user.role, isActive: user.isActive },
        passwordChanged: dto.password !== undefined,
      },
    });
    return this.toResponse(user);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a self-service sign-up, unlocking the dashboard for it (admin only)' })
  @ApiResponse({
    status: 200,
    description: 'The user, approved. Approving an approved user changes nothing.',
    type: UserResponseDto,
  })
  @ApiResponse({ status: 404, description: 'No user with this id.' })
  async approve(
    @Param('id') id: string,
    @Req() req: Request,
    @CurrentApiKey() actor?: ApiKey,
  ): Promise<UserResponseDto> {
    const { user, approved } = await this.userService.approve(id);
    if (approved) {
      await this.auditService.logInfo(AuditAction.USER_APPROVED, {
        ...this.auditContext(req, actor),
        metadata: { targetUserId: user.id, email: user.email, paymentLinkId: user.paymentLinkId },
      });
    }
    return this.toResponse(user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a dashboard user and every login key it holds (admin only)' })
  @ApiResponse({ status: 204, description: 'User deleted' })
  @ApiResponse({ status: 404, description: 'No user with this id.' })
  async delete(@Param('id') id: string, @Req() req: Request, @CurrentApiKey() actor?: ApiKey): Promise<void> {
    const user = await this.userService.delete(id);
    await this.auditService.logInfo(AuditAction.USER_DELETED, {
      ...this.auditContext(req, actor),
      metadata: { targetUserId: id, email: user.email },
    });
  }
}
