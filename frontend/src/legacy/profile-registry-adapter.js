// 渐进迁移边界：React 只通过 typed facade 使用 legacy Profile 注册表。
// 这里是新前端唯一允许读取 FXProfiles 全局对象的位置。
import "../../../js/profile-registry.js";

const registry = globalThis.FXProfiles;
if (!registry) throw new Error("FORGE·X Profile registry failed to initialize");

export const legacyProfileRegistry = registry;
