import { Global, Module } from '@nestjs/common';
import { RolesGuard } from '@/common/guards/roles.guard';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { AuditController } from '@/audit/audit.controller';
import { AuditService } from '@/audit/audit.service';

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, JwtAuthGuard, RolesGuard],
  exports: [AuditService],
})
export class AuditModule {}
