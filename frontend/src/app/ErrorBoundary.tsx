import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly error: Error | null;
  readonly errorId: string;
}

export class ErrorBoundary extends Component<Props, State> {
  public override state: State = { error: null, errorId: "" };

  public static getDerivedStateFromError(error: Error): State {
    const errorId = globalThis.crypto?.randomUUID?.() ?? `ui-${Date.now().toString(36)}`;
    return { error, errorId };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[react-shell]", error, info.componentStack);
  }

  public override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal" role="alert">
        <p className="eyebrow">FORGE·X / UI ERROR</p>
        <h1>工作台界面发生错误</h1>
        <p>
          错误编号：<code>{this.state.errorId}</code>
        </p>
        {import.meta.env.DEV ? <pre>{this.state.error.message}</pre> : null}
        <button type="button" onClick={() => window.location.reload()}>
          重新载入
        </button>
      </main>
    );
  }
}
