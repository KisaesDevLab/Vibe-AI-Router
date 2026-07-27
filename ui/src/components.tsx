/** Shared bits: the tier chip (signature element), status text, capability chips. */

export function Tier({ tier }: { tier: string }): JSX.Element {
  const label = tier === 'local_only' ? 'LOCAL' : tier === 'cloud_deidentified' ? 'SCRUBBED' : 'CLOUD';
  const title =
    tier === 'local_only'
      ? 'Never leaves the appliance'
      : tier === 'cloud_deidentified'
        ? 'Cloud permitted only after the scrubber passes'
        : 'Cloud permitted — prompts carry no client data by construction';
  return (
    <span className={`tier ${tier}`} title={title}>
      {label}
    </span>
  );
}

export function Status({ value }: { value: string }): JSX.Element {
  return <span className={`status ${value}`}>{value.toUpperCase()}</span>;
}

export function Caps({ caps }: { caps: Record<string, boolean> }): JSX.Element {
  const KEYS = ['tools', 'json_schema', 'vision', 'caching', 'reasoning'];
  return (
    <span className="row" style={{ gap: 4 }}>
      {KEYS.filter((k) => caps[k]).map((k) => (
        <span key={k} className="chip on">
          {k}
        </span>
      ))}
    </span>
  );
}
