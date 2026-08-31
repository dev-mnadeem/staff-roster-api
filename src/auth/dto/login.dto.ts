import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'manager@coastaleats.test' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'password123' })
  @IsString()
  @MinLength(8)
  password!: string;
}

export class LoginResponseDto {
  @ApiProperty({ description: 'Bearer token for the Authorization header.' })
  accessToken!: string;
}
