import { useCallback, useMemo, useReducer } from "react";
import type { GcodeParseOptions } from "../gcode/gcode-types";
import {
  deriveProfileOptions,
  getProfileStorageStatus,
  importProfileFile,
  listProfileCatalog,
  ProfileImportError,
  validateProfileOptionDraft,
} from "./profile-adapter";
import type {
  MachineProfile,
  MaterialProfile,
  ProfileCatalog,
  ProfileImportStatus,
  ProfileOptionDraft,
  ProfileSelectionActions,
  ProfileSelectionController,
  ProfileStorageStatus,
} from "./profile-types";

interface InternalState {
  readonly catalog: ProfileCatalog;
  readonly machineId: string;
  readonly materialId: string;
  readonly draft: ProfileOptionDraft;
  readonly importStatus: ProfileImportStatus;
  readonly importMessage: string;
  readonly storage: ProfileStorageStatus;
}

type Action =
  | { readonly type: "select-machine"; readonly id: string }
  | { readonly type: "select-material"; readonly id: string }
  | { readonly type: "bed-size"; readonly value: string }
  | { readonly type: "density"; readonly value: string }
  | { readonly type: "origin"; readonly value: GcodeParseOptions["origin"] }
  | { readonly type: "restore" }
  | { readonly type: "import-start" }
  | {
      readonly type: "import-finish";
      readonly catalog: ProfileCatalog;
      readonly status: "success" | "error";
      readonly message: string;
      readonly storage: ProfileStorageStatus;
    };

function requiredMachine(catalog: ProfileCatalog, id: string): MachineProfile {
  const machine = catalog.machines.find((profile) => profile.id === id) ?? catalog.machines[0];
  if (!machine) throw new Error("Profile catalog does not contain a machine");
  return machine;
}

function requiredMaterial(catalog: ProfileCatalog, id: string): MaterialProfile {
  const material = catalog.materials.find((profile) => profile.id === id) ?? catalog.materials[0];
  if (!material) throw new Error("Profile catalog does not contain a material");
  return material;
}

function draftFrom(machine: MachineProfile, material: MaterialProfile): ProfileOptionDraft {
  const options = deriveProfileOptions(machine, material);
  return { bedSize: String(options.bedSize), densityG: String(options.densityG), origin: options.origin };
}

function initialState(): InternalState {
  const catalog = listProfileCatalog();
  const machine = requiredMachine(catalog, "corexy");
  const material = requiredMaterial(catalog, "PLA");
  return {
    catalog,
    machineId: machine.id,
    materialId: material.id,
    draft: draftFrom(machine, material),
    importStatus: "idle",
    importMessage: "",
    storage: getProfileStorageStatus(),
  };
}

function reducer(state: InternalState, action: Action): InternalState {
  switch (action.type) {
    case "select-machine": {
      const machine = state.catalog.machines.find((profile) => profile.id === action.id);
      if (!machine) return state;
      const baseline = deriveProfileOptions(machine, requiredMaterial(state.catalog, state.materialId));
      return {
        ...state,
        machineId: machine.id,
        draft: { ...state.draft, bedSize: String(baseline.bedSize), origin: baseline.origin },
      };
    }
    case "select-material": {
      const material = state.catalog.materials.find((profile) => profile.id === action.id);
      if (!material) return state;
      return { ...state, materialId: material.id, draft: { ...state.draft, densityG: String(material.densityG) } };
    }
    case "bed-size":
      return { ...state, draft: { ...state.draft, bedSize: action.value } };
    case "density":
      return { ...state, draft: { ...state.draft, densityG: action.value } };
    case "origin":
      return { ...state, draft: { ...state.draft, origin: action.value } };
    case "restore":
      return {
        ...state,
        draft: draftFrom(
          requiredMachine(state.catalog, state.machineId),
          requiredMaterial(state.catalog, state.materialId)
        ),
      };
    case "import-start":
      return { ...state, importStatus: "reading", importMessage: "正在读取并校验 Profile…" };
    case "import-finish":
      return {
        ...state,
        catalog: action.catalog,
        importStatus: action.status,
        importMessage: action.message,
        storage: action.storage,
      };
  }
}

export function useProfileSelection(): ProfileSelectionController {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const machine = requiredMachine(state.catalog, state.machineId);
  const material = requiredMaterial(state.catalog, state.materialId);
  const baselineOptions = useMemo(() => deriveProfileOptions(machine, material), [machine, material]);
  const validation = useMemo(() => validateProfileOptionDraft(state.draft), [state.draft]);
  const selectedOptions = useMemo(
    () =>
      validation.options
        ? Object.freeze({
            ...baselineOptions,
            ...validation.options,
            machineProfileId: machine.id,
            materialProfileId: material.id,
          })
        : null,
    [baselineOptions, machine.id, material.id, validation.options]
  );
  const dirty =
    !validation.options ||
    validation.options.bedSize !== baselineOptions.bedSize ||
    validation.options.densityG !== baselineOptions.densityG ||
    validation.options.origin !== baselineOptions.origin;

  const selectMachine = useCallback((id: string) => dispatch({ type: "select-machine", id }), []);
  const selectMaterial = useCallback((id: string) => dispatch({ type: "select-material", id }), []);
  const setBedSize = useCallback((value: string) => dispatch({ type: "bed-size", value }), []);
  const setDensityG = useCallback((value: string) => dispatch({ type: "density", value }), []);
  const setOrigin = useCallback((value: GcodeParseOptions["origin"]) => dispatch({ type: "origin", value }), []);
  const restoreProfileOptions = useCallback(() => dispatch({ type: "restore" }), []);
  const importFile = useCallback(async (file: File) => {
    dispatch({ type: "import-start" });
    try {
      const result = await importProfileFile(file);
      const catalog = listProfileCatalog();
      const persistence = result.persisted ? "已保存到当前浏览器" : "仅在本次会话保留";
      dispatch({
        type: "import-finish",
        catalog,
        status: "success",
        message: `Profile 已导入：${result.machines.length} 个机型 · ${result.materials.length} 种材料；${persistence}。`,
        storage: getProfileStorageStatus(),
      });
    } catch (error) {
      const message =
        error instanceof ProfileImportError ? `${error.code} · ${error.message}` : "IMPORT_FAILED · Profile 导入失败";
      dispatch({
        type: "import-finish",
        catalog: listProfileCatalog(),
        status: "error",
        message,
        storage: getProfileStorageStatus(),
      });
    }
  }, []);

  const actions = useMemo<ProfileSelectionActions>(
    () => ({
      selectMachine,
      selectMaterial,
      setBedSize,
      setDensityG,
      setOrigin,
      restoreProfileOptions,
      importFile,
    }),
    [importFile, restoreProfileOptions, selectMachine, selectMaterial, setBedSize, setDensityG, setOrigin]
  );

  const value = useMemo(
    () => ({
      catalog: state.catalog,
      selection: { machineId: machine.id, materialId: material.id },
      machine,
      material,
      draft: state.draft,
      baselineOptions,
      options: selectedOptions,
      errors: validation.errors,
      dirty,
      importStatus: state.importStatus,
      importMessage: state.importMessage,
      storage: state.storage,
    }),
    [baselineOptions, dirty, machine, material, selectedOptions, state, validation]
  );

  return { value, actions };
}
