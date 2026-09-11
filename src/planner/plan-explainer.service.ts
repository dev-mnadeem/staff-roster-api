import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlanExplanation, RosterPlan } from '@/planner/planner.types';

type PlanCore = Omit<RosterPlan, 'explanation'>;

/**
 * Turns a plan into a paragraph a manager can read.
 *
 * The numbers alone do not answer the question a manager actually has, which
 * is "can I send this out?". That needs the shape of the plan stated plainly:
 * how much is covered, what is still open and why, and whether the roster is
 * more even than it was.
 *
 * The rules-based writer is the default and is always correct, because it only
 * restates figures the planner computed. A model is used when one is
 * configured, for a more fluent summary — but it is given the figures and asked
 * to narrate them, never to decide anything. `source` on the result tells the
 * reader which they got.
 */
@Injectable()
export class PlanExplainerService {
  private readonly logger = new Logger(PlanExplainerService.name);

  constructor(private readonly config: ConfigService) {}

  async explain(plan: PlanCore): Promise<PlanExplanation> {
    const facts = this.summarise(plan);

    if (this.hasModel()) {
      try {
        return { summary: await this.narrate(facts), source: 'model' };
      } catch (error) {
        // A summary is a convenience; never fail a plan because prose failed.
        this.logger.warn(
          `Model narration failed, falling back to rules: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return { summary: facts, source: 'rules' };
  }

  /** Deterministic prose. Every clause restates a computed number. */
  private summarise(plan: PlanCore): string {
    const { metrics, assignments, unfilled } = plan;
    const parts: string[] = [];

    if (metrics.slotsTotal === 0) {
      return 'There are no shifts in this range, so there was nothing to plan.';
    }

    const pct = Math.round(metrics.coverage * 100);
    parts.push(
      assignments.length === 0
        ? `No new assignments were possible. Coverage stays at ${pct}% ` +
            `(${metrics.slotsFilled} of ${metrics.slotsTotal} slots).`
        : `Filled ${assignments.length} slot${assignments.length === 1 ? '' : 's'}, ` +
            `bringing coverage to ${pct}% (${metrics.slotsFilled} of ` +
            `${metrics.slotsTotal}).`,
    );

    // Spread is a standard deviation of hours: lower means more even.
    const delta = metrics.hoursSpreadBefore - metrics.hoursSpreadAfter;
    if (Math.abs(delta) < 0.05) {
      parts.push(
        `The spread of hours is unchanged at ${metrics.hoursSpreadAfter.toFixed(1)}h.`,
      );
    } else if (delta > 0) {
      parts.push(
        `Hours are more evenly shared than before — spread narrowed from ` +
          `${metrics.hoursSpreadBefore.toFixed(1)}h to ` +
          `${metrics.hoursSpreadAfter.toFixed(1)}h.`,
      );
    } else {
      parts.push(
        `Hours are less even than before (spread ` +
          `${metrics.hoursSpreadBefore.toFixed(1)}h → ` +
          `${metrics.hoursSpreadAfter.toFixed(1)}h), because the only eligible ` +
          `people were already among the busiest.`,
      );
    }

    if (unfilled.length > 0) {
      const slots = unfilled.reduce((sum, u) => sum + u.remaining, 0);
      const topBlocker = unfilled
        .flatMap((u) => u.blockers)
        .sort((a, b) => b.staffCount - a.staffCount)[0];
      parts.push(
        `${slots} slot${slots === 1 ? '' : 's'} across ${unfilled.length} ` +
          `shift${unfilled.length === 1 ? '' : 's'} could not be filled` +
          (topBlocker
            ? `; most commonly because staff were ${topBlocker.reason}.`
            : '.'),
      );
    }

    return parts.join(' ');
  }

  private hasModel(): boolean {
    return Boolean(this.config.get<string>('PLANNER_LLM_API_KEY'));
  }

  /**
   * Placeholder for a hosted model call.
   *
   * Left unimplemented on purpose rather than stubbed with a fake response:
   * `hasModel()` is false without a key, so this is unreachable in the default
   * configuration, and a reader should not have to wonder whether the summary
   * they are looking at came from a model. Wiring a provider here is the only
   * change needed.
   */
  private narrate(facts: string): Promise<string> {
    return Promise.reject(
      new Error(
        'No model provider is wired up. Remove PLANNER_LLM_API_KEY to use the ' +
          `rules-based summary. Facts were: ${facts}`,
      ),
    );
  }
}
