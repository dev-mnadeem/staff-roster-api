import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  NotImplementedException,
  Post,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Public } from '@/common/decorators/public.decorator';
import { IDENTITY_PROVIDER } from '@/identity/identity.types';
import type { IdentityProvider } from '@/identity/identity.types';
import { LoginDto, LoginResponseDto } from '@/auth/dto/login.dto';

/**
 * Direct sign-in, available only under the self-hosted identity provider.
 *
 * With a hosted provider the browser authenticates against the vendor and this
 * API never sees a password, so the endpoint reports 501 rather than pretending
 * to be a login it cannot perform.
 */
@ApiTags('Auth')
@Controller('auth')
export class LoginController {
  constructor(
    @Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange email and password for a token (local identity only)',
  })
  @ApiOkResponse({ type: LoginResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid email or password' })
  async login(@Body() dto: LoginDto): Promise<LoginResponseDto> {
    if (!this.identity.signIn) {
      throw new NotImplementedException(
        `The "${this.identity.name}" identity provider does not accept ` +
          'passwords. Authenticate with the provider directly and send its ' +
          'token as a bearer token.',
      );
    }
    const result = await this.identity.signIn(dto.email, dto.password);
    if (!result) {
      throw new NotImplementedException('Sign-in is unavailable.');
    }
    return { accessToken: result.accessToken };
  }
}
