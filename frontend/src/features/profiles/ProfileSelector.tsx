import type { ChangeEvent } from "react";
import type { GcodeParseOptions } from "../gcode/gcode-types";
import type { MachineProfile, MaterialProfile, ProfileSelectionActions, ProfileSelectionValue } from "./profile-types";

export interface ProfileSelectorProps {
  readonly value: ProfileSelectionValue;
  readonly actions: ProfileSelectionActions;
  readonly disabled?: boolean;
  readonly idPrefix?: string;
}

function groupedOptions<T extends MachineProfile | MaterialProfile>(profiles: readonly T[]) {
  const builtIn = profiles.filter((profile) => !profile.community);
  const community = profiles.filter((profile) => profile.community);
  return (
    <>
      <optgroup label="内置 Profile">
        {builtIn.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </optgroup>
      {community.length ? (
        <optgroup label="社区 Profile">
          {community.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </optgroup>
      ) : null}
    </>
  );
}

export function ProfileSelector({
  value,
  actions,
  disabled = false,
  idPrefix = "gcode-profile",
}: ProfileSelectorProps) {
  const machineId = `${idPrefix}-machine`;
  const materialId = `${idPrefix}-material`;
  const bedSizeId = `${idPrefix}-bed-size`;
  const densityId = `${idPrefix}-density`;
  const originId = `${idPrefix}-origin`;
  const importId = `${idPrefix}-import`;

  const onImport = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) void actions.importFile(file);
  };

  return (
    <section className="profile-selector" aria-label="机器与材料 Profile">
      <div className="gcode-options profile-catalog-options">
        <label htmlFor={machineId}>
          机器 Profile
          <select
            id={machineId}
            value={value.selection.machineId}
            disabled={disabled}
            onChange={(event) => actions.selectMachine(event.currentTarget.value)}
          >
            {groupedOptions(value.catalog.machines)}
          </select>
        </label>
        <label htmlFor={materialId}>
          材料 Profile
          <select
            id={materialId}
            value={value.selection.materialId}
            disabled={disabled}
            onChange={(event) => actions.selectMaterial(event.currentTarget.value)}
          >
            {groupedOptions(value.catalog.materials)}
          </select>
        </label>
      </div>

      <div className="profile-evidence">
        <p>
          <strong>{value.machine.name}</strong> · {value.machine.kinematics} · {value.machine.buildVolume.x} ×{" "}
          {value.machine.buildVolume.y} × {value.machine.buildVolume.z} mm
          <small>机器来源：{value.machine.source}</small>
        </p>
        <p>
          <strong>{value.material.name}</strong> · 密度 {value.material.densityG} g/cm³
          <small>材料来源：{value.material.source}</small>
        </p>
        <p className="muted">本次 G-code 解析只使用平台包络、坐标原点和材料密度；温度与流量留待仿真阶段。</p>
      </div>

      <fieldset className="profile-parameter-fieldset" disabled={disabled}>
        <legend>解析参数</legend>
        <div className="gcode-options">
          <label htmlFor={bedSizeId}>
            平台尺寸（mm）
            <input
              id={bedSizeId}
              type="number"
              min="50"
              max="2000"
              value={value.draft.bedSize}
              aria-invalid={Boolean(value.errors.bedSize)}
              aria-describedby={value.errors.bedSize ? `${bedSizeId}-error` : undefined}
              onChange={(event) => actions.setBedSize(event.currentTarget.value)}
            />
            {value.errors.bedSize ? (
              <small id={`${bedSizeId}-error`} className="error-copy">
                {value.errors.bedSize}
              </small>
            ) : null}
          </label>
          <label htmlFor={densityId}>
            材料密度（g/cm³）
            <input
              id={densityId}
              type="number"
              min="0.2"
              max="5"
              step="0.01"
              value={value.draft.densityG}
              aria-invalid={Boolean(value.errors.densityG)}
              aria-describedby={value.errors.densityG ? `${densityId}-error` : undefined}
              onChange={(event) => actions.setDensityG(event.currentTarget.value)}
            />
            {value.errors.densityG ? (
              <small id={`${densityId}-error`} className="error-copy">
                {value.errors.densityG}
              </small>
            ) : null}
          </label>
          <label htmlFor={originId}>
            坐标原点
            <select
              id={originId}
              value={value.draft.origin}
              onChange={(event) => actions.setOrigin(event.currentTarget.value as GcodeParseOptions["origin"])}
            >
              <option value="corner">床角</option>
              <option value="center">床心（Delta）</option>
            </select>
          </label>
        </div>
        <button type="button" className="reset-button" disabled={!value.dirty} onClick={actions.restoreProfileOptions}>
          恢复 Profile 参数
        </button>
        <p className="muted" role="status">
          {value.options
            ? value.dirty
              ? "已手动覆盖 Profile；重新解析后生效。"
              : "当前参数与所选 Profile 一致。"
            : "参数校验未通过，暂不能提交解析。"}
        </p>
      </fieldset>

      <div className="profile-import">
        <label htmlFor={importId}>
          导入社区 Profile JSON（最大 2 MB）
          <input
            id={importId}
            type="file"
            accept=".json,application/json"
            disabled={disabled || value.importStatus === "reading"}
            onChange={onImport}
          />
        </label>
        <p className="muted">{value.storage.message}</p>
        {value.importMessage ? (
          <p
            role={value.importStatus === "error" ? "alert" : "status"}
            className={value.importStatus === "error" ? "error-copy" : "muted"}
          >
            {value.importMessage}
          </p>
        ) : null}
      </div>
    </section>
  );
}
