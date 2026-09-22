import { describe, expect, it } from 'vitest';

import { toolTrajectoryDraft, trajectoryAssertion } from './assertion-utils';

const translate = ((key: string) => key) as never;

describe('tool trajectory assertion persistence', () => {
  it('uses the Rust contract and restores strict args and expected response after save', () => {
    const saved = trajectoryAssertion(
      {
        id: 'tool-trajectory-id',
        strictOrder: true,
        strictArgs: true,
        calls: [
          {
            id: 'call-1',
            name: 'lookup_order',
            args: JSON.stringify({ orderId: '42' }),
            count: 1,
            assertResult: true,
            expectedResult: JSON.stringify({ status: 'high_risk' }),
          },
        ],
      },
      translate,
    );

    expect(saved).toMatchObject({
      kind: 'tool_trajectory',
      id: 'tool-trajectory-id',
      config: { strict_order: true, strict_args: true },
      tools: [
        {
          name: 'lookup_order',
          args: { orderId: '42' },
          expected_response: { status: 'high_risk' },
        },
      ],
    });

    const draft = toolTrajectoryDraft({ assertions: [saved] });

    expect(draft.strictOrder).toBe(true);
    expect(draft.id).toBe('tool-trajectory-id');
    expect(draft.strictArgs).toBe(true);
    expect(draft.calls[0]).toMatchObject({
      name: 'lookup_order',
      assertResult: true,
      expectedResult: JSON.stringify({ status: 'high_risk' }, null, 2),
    });
  });

  it('does not enable a response assertion for a persisted null response', () => {
    const draft = toolTrajectoryDraft({
      assertions: [
        {
          kind: 'tool_trajectory',
          config: { strict_order: true, strict_args: false },
          tools: [{ name: 'lookup_order', args: {}, expected_response: null }],
        },
      ],
    });

    expect(draft.calls[0]?.assertResult).toBe(false);
  });
});
