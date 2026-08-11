import type {
  MachineProfile,
  MachineProfileDefinition,
  MaterialProfile,
  MaterialProfileDefinition,
  ProfileBundle,
  ProfileValidationResult,
} from "../features/profiles/profile-types";

export interface LegacyProfileRegistry {
  validateMachine(value: unknown, path?: string): string[];
  validateMaterial(value: unknown, path?: string): string[];
  validateBundle(value: unknown): ProfileValidationResult;
  importBundle(
    bundle: ProfileBundle,
    options?: { readonly persist?: boolean }
  ): { readonly machines: MachineProfile[]; readonly materials: MaterialProfile[] };
  registerMachine(profile: MachineProfileDefinition, isCommunity?: boolean): MachineProfile;
  registerMaterial(profile: MaterialProfileDefinition, isCommunity?: boolean): MaterialProfile;
  machine(id: string): MachineProfile | null;
  material(id: string): MaterialProfile | null;
  listMachines(): MachineProfile[];
  listMaterials(): MaterialProfile[];
  persist(): boolean;
  loadStored(): { readonly machines: MachineProfile[]; readonly materials: MaterialProfile[] } | null;
  clearStored(): void;
  readonly kinematics: readonly string[];
  builtinBundle(): ProfileBundle;
}

export const legacyProfileRegistry: LegacyProfileRegistry;
