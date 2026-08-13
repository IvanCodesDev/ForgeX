import { Workbench } from "../workbench/Workbench";

/* 工作台是单页应用：与旧入口一致，导航由顶部流程胶囊在同一视口内切换面板，
   不引入路由，避免把沉浸式 3D 工作区拆成多页。 */
export function App() {
  return <Workbench />;
}
