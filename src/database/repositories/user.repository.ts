import { Inject, Injectable } from '@nestjs/common';
import type { User as UserProfile } from '@prisma/client';
import { PrismaService } from '@/database/prisma.service';
import { IDENTITY_PROVIDER } from '@/identity/identity.types';
import type { AuthAccount, IdentityProvider } from '@/identity/identity.types';

@Injectable()
export class UserRepository {
  constructor(
    @Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider,
    private readonly prisma: PrismaService,
  ) {}

  /** The account record from whichever identity provider is active. */
  findAuthUserById(userId: string): Promise<AuthAccount | null> {
    return this.identity.getAccount(userId);
  }

  findProfileById(userId: string): Promise<UserProfile | null> {
    return this.prisma.user.findUnique({ where: { id: userId } });
  }
}
