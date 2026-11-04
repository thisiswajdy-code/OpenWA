import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { ApiKey } from './entities/api-key.entity';
import { User } from './entities/user.entity';
import { AuthService } from './auth.service';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import { ChatScopeService } from './chat-scope.service';
import { ActiveKeyIndex } from './active-key-index';
import { AuthController } from './auth.controller';
import { AuthValidateController } from './auth-validate.controller';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { UserLoginController } from './user-login.controller';
import { SignupController } from './signup.controller';
import { ArvyNotifyController } from './arvy-notify.controller';
import { SignupService } from './signup.service';
import { ArvyClient } from './arvy-client';
import { ApiKeyGuard } from './guards/api-key.guard';
import { ProxyAwareThrottlerGuard } from '../../common/security/proxy-aware-throttler.guard';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ApiKey, User], 'main')],
  controllers: [
    AuthController,
    AuthValidateController,
    UserController,
    UserLoginController,
    SignupController,
    ArvyNotifyController,
  ],
  providers: [
    AuthService,
    UserService,
    SignupService,
    ArvyClient,
    ApiKeyUsageTracker,
    ChatScopeService,
    ActiveKeyIndex,
    {
      provide: APP_GUARD,
      useClass: ProxyAwareThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
  ],
  exports: [AuthService, UserService, ChatScopeService, ActiveKeyIndex],
})
export class AuthModule {}
