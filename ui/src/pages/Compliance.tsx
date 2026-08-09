import { useEffect, useState } from 'react';
import { api, type TaskClass } from '../api';
import { Tier } from '../components';

/**
 * Compliance (14.7): export the AI Data-Handling Appendix for the firm's WISP, and preview the
 * live data-tier assignments the appendix documents. Download is a cookie-authed anchor to the
 * server endpoint (same pattern as the Audit CSV export).
 */
export function Compliance(): JSX.Element {
  const [classes, setClasses] = useState<TaskClass[]>([]);

  useEffect(() => {
    void api.get<TaskClass[]>('/admin-api/task-classes').then(setClasses);
  }, []);

  const sorted = [...classes].sort((a, b) => a.app.localeCompare(b.app) || a.key.localeCompare(b.key));

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>Compliance</h1>
          <p className="sub">
            WISP documentation for the AI controls this appliance enforces — generated from your live
            configuration.
          </p>
        </div>
        <a className="btn" href="/admin-api/wisp.docx" download>
          Export WISP appendix (.docx)
        </a>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>AI Data-Handling Appendix</h2>
        <p className="sub">
          A Microsoft Word exhibit for your firm's Written Information Security Plan (FTC Safeguards
          Rule, 16 CFR Part 314; IRS Publication 4557). It documents — as configured right now — your
          data tiers per task, configured AI providers, the automated screening of cloud-bound data,
          credential encryption, retention, and access controls. Re-export after any provider or tier
          change to keep it current.
        </p>
        <p className="sub" style={{ fontStyle: 'italic' }}>
          Not legal advice. This covers only the AI-handling controls the router enforces; physical
          security, personnel, incident response, and your designated Qualified Individual belong to
          your primary WISP. Have your attorney review.
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Data tiers (live)</h2>
        <p className="sub">
          What the appendix's tier table will contain. Change a tier on the Policies page and re-export.
        </p>
        <table>
          <thead>
            <tr>
              <th>Task class</th>
              <th>App</th>
              <th>Tier</th>
              <th>Leaves the appliance?</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((tc) => (
              <tr key={tc.key}>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{tc.key}</td>
                <td>{tc.app}</td>
                <td><Tier tier={tc.sensitivity} /></td>
                <td style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
                  {tc.sensitivity === 'local_only'
                    ? 'No — on-appliance only'
                    : tc.sensitivity === 'cloud_deidentified'
                      ? 'Only after automated screening'
                      : 'Yes — no client data by construction'}
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={4}>
                  <div className="empty">
                    <div className="big">No task classes registered yet</div>
                    They appear here once an app registers with the router.
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
