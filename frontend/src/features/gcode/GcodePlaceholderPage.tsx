export function GcodePlaceholderPage() {
  return (
    <section className="panel placeholder-page">
      <p className="eyebrow">NEXT VERTICAL SLICE</p>
      <h1>G-code 导入 → 分块解析 → 摘要 → 3D 路径</h1>
      <p>此路由已作为下一阶段的稳定挂载点。启用前继续使用现有导入页面，启用后由 feature flag 切换。</p>
      <ol>
        <li>Worker 分块读取，主线程只接收进度与抽样路径。</li>
        <li>原始字节 SHA-256 与服务端权威摘要并列展示。</li>
        <li>Three.js 生命周期封装为 ViewerEngine，不进入 React state。</li>
      </ol>
    </section>
  );
}
