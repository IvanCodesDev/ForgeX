import { NAV_ITEMS, type WorkflowNavId } from "./nav-items";
import type { WorkflowNav } from "./useWorkflowNav";

interface FlowPillsProps {
  readonly nav: WorkflowNav;
  readonly insightOpen: boolean;
}

export function FlowPills({ nav, insightOpen }: FlowPillsProps) {
  return (
    <nav id="flow-pills" className="pill-card boot-item" aria-label="工作流程">
      {NAV_ITEMS.map((item, index) => {
        const indexLabel = `0${index + 1}`;
        if (item.id === "insight") {
          return (
            <button
              key={item.id}
              type="button"
              id="pill-insight"
              className={insightOpen ? "flow-pill fp-accent on" : "flow-pill fp-accent"}
              onClick={(event) => nav.toggleInsight(event.currentTarget)}
            >
              <span className="fp-idx">{indexLabel}</span>
              <span>{item.label}</span>
            </button>
          );
        }
        const active = nav.open && nav.lastNav === item.id;
        return (
          <button
            key={item.id}
            type="button"
            className={active ? "flow-pill on" : "flow-pill"}
            onClick={() => nav.openNav(item.id as WorkflowNavId)}
          >
            <span className="fp-idx">{indexLabel}</span>
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
