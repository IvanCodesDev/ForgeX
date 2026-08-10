const boundaries = [
  ["React + TypeScript", "表单、路由、状态、可访问性、任务进度与报告展示"],
  ["Three.js / Worker", "3D 场景、路径抽样、即时预览与重计算隔离"],
  ["C# 权威核心", "G-code、仿真、统计、校准、任务、租户与审计"],
];

export function ArchitecturePage() {
  return (
    <section className="panel architecture-page">
      <p className="eyebrow">RESPONSIBILITY BOUNDARY</p>
      <h1>一套产品，三条清晰计算边界。</h1>
      <div className="boundary-list">
        {boundaries.map(([title, detail], index) => (
          <article key={title}>
            <span>0{index + 1}</span>
            <div>
              <h2>{title}</h2>
              <p>{detail}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
