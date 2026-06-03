import { Module } from '@nestjs/common';
import { DatabaseModule } from '@/database/database.module';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { AuthController } from '@/auth/auth.controller';
import { AuthService } from '@/auth/auth.service';
import { LoginController } from '@/auth/login.controller';

@Module({
  imports: [DatabaseModule],
  providers: [AuthService, JwtAuthGuard],
  controllers: [AuthController, LoginController],
  exports: [AuthService, JwtAuthGuard],
})
export class AuthModule {}
