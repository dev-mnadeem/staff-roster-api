import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Location, Skill, UserRole } from '@prisma/client';
import {
  type MemberWithJoins,
  TeamRepository,
} from '@/database/repositories/team.repository';

import { LocationDto } from '@/locations/dto/location.dto';
import { SkillDto } from '@/skills/dto/skill.dto';
import { TeamMemberDto } from '@/team/dto/team-member.dto';
import { IDENTITY_PROVIDER } from '@/identity/identity.types';
import type { IdentityProvider } from '@/identity/identity.types';

@Injectable()
export class TeamService {
  private readonly logger = new Logger(TeamService.name);

  constructor(
    @Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider,
    private readonly teamRepository: TeamRepository,
  ) {}

  async list(): Promise<TeamMemberDto[]> {
    const [members, emailById] = await Promise.all([
      this.teamRepository.listMembers(),
      this.fetchEmailMap(),
    ]);
    return members.map((m) => this.toDto(m, emailById.get(m.id)));
  }

  async findById(id: string): Promise<TeamMemberDto> {
    const member = await this.teamRepository.findMemberById(id);
    if (!member) throw new NotFoundException(`Team member ${id} not found`);
    const email = await this.fetchEmail(id);
    return this.toDto(member, email);
  }

  async setCertifications(
    staffId: string,
    locationIds: string[],
  ): Promise<TeamMemberDto> {
    const member = await this.teamRepository.findMemberById(staffId);
    if (!member)
      throw new NotFoundException(`Team member ${staffId} not found`);
    this.requireRole(member.role, 'staff', 'certifications');

    const allExist = await this.teamRepository.locationsExist(locationIds);
    if (!allExist) {
      throw new BadRequestException('One or more locationIds do not exist');
    }

    await this.teamRepository.setCertifications(staffId, locationIds);
    return this.findById(staffId);
  }

  async setSkills(staffId: string, skillIds: string[]): Promise<TeamMemberDto> {
    const member = await this.teamRepository.findMemberById(staffId);
    if (!member)
      throw new NotFoundException(`Team member ${staffId} not found`);
    this.requireRole(member.role, 'staff', 'skills');

    const allExist = await this.teamRepository.skillsExist(skillIds);
    if (!allExist) {
      throw new BadRequestException('One or more skillIds do not exist');
    }

    await this.teamRepository.setSkills(staffId, skillIds);
    return this.findById(staffId);
  }

  async setManagedLocations(
    managerId: string,
    locationIds: string[],
  ): Promise<TeamMemberDto> {
    const member = await this.teamRepository.findMemberById(managerId);
    if (!member) {
      throw new NotFoundException(`Team member ${managerId} not found`);
    }
    this.requireRole(member.role, 'manager', 'managed locations');

    const allExist = await this.teamRepository.locationsExist(locationIds);
    if (!allExist) {
      throw new BadRequestException('One or more locationIds do not exist');
    }

    await this.teamRepository.setManagedLocations(managerId, locationIds);
    return this.findById(managerId);
  }

  private requireRole(
    actual: UserRole,
    expected: UserRole,
    field: string,
  ): void {
    if (actual !== expected) {
      throw new BadRequestException(
        `Cannot set ${field} on a ${actual}; user must be ${expected}`,
      );
    }
  }

  private fetchEmailMap(): Promise<Map<string, string>> {
    return this.identity.getEmailMap();
  }

  private async fetchEmail(userId: string): Promise<string | undefined> {
    const account = await this.identity.getAccount(userId);
    return account?.email;
  }

  private toDto(member: MemberWithJoins, email?: string): TeamMemberDto {
    return {
      id: member.id,
      email,
      role: member.role,
      displayName: member.displayName ?? undefined,
      desiredHoursPerWeek: member.desiredHoursPerWeek ?? undefined,
      certifications: member.certifications.map((c) =>
        this.locationToDto(c.location),
      ),
      skills: member.skills.map((s) => this.skillToDto(s.skill)),
      managedLocations: member.managedLocations.map((m) =>
        this.locationToDto(m.location),
      ),
    };
  }

  private locationToDto(location: Location): LocationDto {
    return {
      id: location.id,
      name: location.name,
      timezone: location.timezone,
      address: location.address,
      createdAt: location.createdAt.toISOString(),
      updatedAt: location.updatedAt.toISOString(),
    };
  }

  private skillToDto(skill: Skill): SkillDto {
    return {
      id: skill.id,
      name: skill.name,
      createdAt: skill.createdAt.toISOString(),
      updatedAt: skill.updatedAt.toISOString(),
    };
  }
}
