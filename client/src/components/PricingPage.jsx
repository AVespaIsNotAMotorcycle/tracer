import { Check, CircleCheck, Clock, Minus } from 'lucide-react';
import { FEATURE_GROUPS } from '../pricing/features.js';
import Header from './Header.jsx';

/** What a plan gets of a feature: included, not included, or a limit. */
function PlanCell({ value }) {
  if (value === true) {
    return (
      <td className="plan-cell">
        <Check className="icon included" aria-hidden="true" />
        <span className="visually-hidden">Included</span>
      </td>
    );
  }
  if (value === false) {
    return (
      <td className="plan-cell">
        <Minus className="icon not-included" aria-hidden="true" />
        <span className="visually-hidden">Not included</span>
      </td>
    );
  }
  return <td className="plan-cell">{value}</td>;
}

function Status({ available }) {
  return available ? (
    <span className="status available">
      <CircleCheck className="icon" aria-hidden="true" />
      Available
    </span>
  ) : (
    <span className="status planned">
      <Clock className="icon" aria-hidden="true" />
      Planned
    </span>
  );
}

/**
 * The plans compared feature by feature (FEATURE_GROUPS), built or planned, at /pricing.
 */
export default function PricingPage({ auth }) {
  const all = FEATURE_GROUPS.flatMap((group) => group.features);
  const available = all.filter((feature) => feature.available).length;
  return (
    <div className="page">
      <Header auth={auth} />
      <main className="pricing">
        <h2>Plans and pricing</h2>
        <p>
          Tracer is free to use. A paid plan, <strong>Scholar</strong>, will add tools for research
          projects: more anchors, a personal library, importing your bibliography and analysis of
          the graph. Scholar isn’t on sale yet, and its price will be set when it launches. Until
          then, everything marked available is free, apart from graphs with more than two anchors.
        </p>
        <p className="muted small">
          {available} of the {all.length} features below are available now; the rest are planned.
        </p>

        <div className="pricing-table-wrap">
          <table className="pricing-table">
            <caption className="visually-hidden">
              Features of the Free and Scholar plans, and whether each is available yet
            </caption>
            <thead>
              <tr>
                <th scope="col">Feature</th>
                <th scope="col">Free</th>
                <th scope="col">Scholar</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            {FEATURE_GROUPS.map((group) => (
              <tbody key={group.heading}>
                <tr className="group-row">
                  <th scope="colgroup" colSpan={4}>
                    {group.heading}
                  </th>
                </tr>
                {group.features.map((feature) => (
                  <tr key={feature.name} className={feature.available ? undefined : 'planned'}>
                    <th scope="row">
                      <span className="feature-name">{feature.name}</span>
                      {feature.note && <span className="feature-note">{feature.note}</span>}
                    </th>
                    <PlanCell value={feature.free} />
                    <PlanCell value={feature.scholar} />
                    <td>
                      <Status available={feature.available} />
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
        <p className="muted small">
          Shared editing is planned for a group plan for seminars and labs, and preset library links
          for an institutional plan.
        </p>
      </main>
    </div>
  );
}
