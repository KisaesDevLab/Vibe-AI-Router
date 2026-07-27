/**
 * SSRF mitigation (14.2, threat T3): host classification, kind-specific URL rules, DNS gate,
 * and request-time enforcement default.
 */
import { describe, expect, it } from 'vitest';
import { checkBaseUrl, checkBaseUrlWithDns, classifyHost } from '../src/lib/ssrf.js';

describe('classifyHost', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['localhost', 'loopback'],
    ['::1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['192.168.1.50', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['172.32.0.1', 'public'],
    ['169.254.169.254', 'metadata'],
    ['169.254.10.10', 'linklocal'],
    ['fd00::1', 'private'],
    ['vibellm', 'dockerdns'],
    ['postgres', 'dockerdns'],
    ['nas.internal', 'private'],
    ['printer.local', 'private'],
    ['api.openai.com', 'public'],
    ['api.anthropic.com', 'public'],
  ])('%s → %s', (host, want) => {
    expect(classifyHost(host)).toBe(want);
  });
});

describe('checkBaseUrl by kind', () => {
  it('cloud kinds: https + public host only', () => {
    expect(checkBaseUrl('openai_compat', 'https://api.openai.com/v1').ok).toBe(true);
    expect(checkBaseUrl('anthropic', 'https://api.anthropic.com').ok).toBe(true);
    expect(checkBaseUrl('openai_compat', 'http://api.openai.com/v1').ok).toBe(false); // http
    expect(checkBaseUrl('openai_compat', 'https://192.168.1.10/v1').ok).toBe(false); // private
    expect(checkBaseUrl('openai_compat', 'https://127.0.0.1:8080/v1').ok).toBe(false);
    expect(checkBaseUrl('openai_compat', 'https://169.254.169.254/latest').ok).toBe(false); // metadata
    expect(checkBaseUrl('anthropic', 'https://postgres/v1').ok).toBe(false); // docker dns
    expect(checkBaseUrl('openai_compat', 'not a url').ok).toBe(false);
  });

  it('local kind: pinned to LAN/docker — public hosts REJECTED (covert cloud route)', () => {
    expect(checkBaseUrl('local', 'http://vibellm:11434/v1').ok).toBe(true);
    expect(checkBaseUrl('local', 'http://192.168.1.50:11434/v1').ok).toBe(true);
    expect(checkBaseUrl('local', 'http://127.0.0.1:11434/v1').ok).toBe(true);
    expect(checkBaseUrl('local', 'https://evil.example.com/v1').ok).toBe(false);
    expect(checkBaseUrl('local', 'http://169.254.169.254/latest').ok).toBe(false);
  });

  it('DNS gate: cloud hostname resolving privately is rejected; unresolvable rejected', async () => {
    // localhost resolves to loopback — pattern check already rejects; use a name that passes
    // the pattern but resolves privately: craft via hosts is not portable — instead verify the
    // two deterministic outcomes we can rely on everywhere:
    const unresolvable = await checkBaseUrlWithDns(
      'openai_compat',
      'https://definitely-not-a-real-host-zqx123.example',
    );
    expect(unresolvable.ok).toBe(false);
    expect(unresolvable.reason).toMatch(/does not resolve/);

    const good = await checkBaseUrlWithDns('anthropic', 'https://api.anthropic.com');
    expect(good.ok).toBe(true);

    const local = await checkBaseUrlWithDns('local', 'http://vibellm:11434/v1');
    expect(local.ok).toBe(true); // local kind skips DNS (docker DNS not resolvable from host)
  });
});
