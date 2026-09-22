import { describe, expect, it } from 'vitest';

import {
  evaluationNodeNameMap,
  evaluationTraceToolNames,
} from './workflow-utils';

describe('evaluationTraceToolNames', () => {
  it('uses the frozen tool-call display name for a process-prefixed tool id', () => {
    expect(
      evaluationTraceToolNames({
        nodeOutputs: [
          {
            output: {
              toolCalls: [
                {
                  tool: 'process_01a0c6d6_f253_7621_adf3_234c8929d2b0',
                  name: '取消订单',
                },
              ],
            },
          },
        ],
      }),
    ).toEqual({
      process_01a0c6d6_f253_7621_adf3_234c8929d2b0: '取消订单',
    });
  });
});

describe('evaluationNodeNameMap', () => {
  it('uses friendly labels for the runtime start and end markers', () => {
    expect(evaluationNodeNameMap([])).toMatchObject({
      __start__: 'Start',
      __end__: 'End',
    });
  });
});
